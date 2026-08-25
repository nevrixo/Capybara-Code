//! 3-way merge analysis that never touches the working tree.
//!
//! Prefers modern `git merge-tree -z --write-tree`; falls back to the deprecated
//! trivial `git merge-tree <base> <ours> <theirs>` form when `-z` is unavailable.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::{GitError, GitService};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergedFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentConflict {
    pub path: String,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameConflict {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteModifyConflict {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeAnalysis {
    pub auto_files: Vec<MergedFile>,
    pub conflicts: Vec<ContentConflict>,
    pub rename_conflicts: Vec<RenameConflict>,
    pub delete_modify: Vec<DeleteModifyConflict>,
}

impl GitService {
    /// Analyze a 3-way merge without writing conflict markers to any files.
    pub fn merge_preview(
        &self,
        base_commit: &str,
        ours_commit: &str,
        theirs_commit: &str,
    ) -> Result<MergeAnalysis, GitError> {
        if !self.is_repository() {
            return Err(GitError::NotARepository {
                path: self.root.display().to_string(),
            });
        }
        let base = validate_revision(base_commit)?;
        let ours = validate_revision(ours_commit)?;
        let theirs = validate_revision(theirs_commit)?;

        match self.merge_tree_modern(&base, &ours, &theirs) {
            Ok(analysis) => Ok(analysis),
            Err(GitError::CommandFailed { stderr, .. })
                if looks_like_unsupported_merge_tree(&stderr) =>
            {
                self.merge_tree_trivial(&base, &ours, &theirs)
            }
            Err(error) => Err(error),
        }
    }

    fn merge_tree_modern(
        &self,
        base: &str,
        ours: &str,
        theirs: &str,
    ) -> Result<MergeAnalysis, GitError> {
        let merge_base = format!("--merge-base={base}");
        let (status, stdout, stderr) = self.run_raw(&[
            "merge-tree",
            "-z",
            "--write-tree",
            &merge_base,
            ours,
            theirs,
        ])?;
        if !status.success()
            && stdout.trim().is_empty()
            && looks_like_unsupported_merge_tree(&stderr)
        {
            return Err(GitError::CommandFailed {
                argv: vec![
                    "merge-tree".into(),
                    "-z".into(),
                    "--write-tree".into(),
                    merge_base,
                    ours.to_string(),
                    theirs.to_string(),
                ],
                stderr,
            });
        }
        // Exit 1 with a tree OID is a conflicted merge, not a hard failure.
        if !status.success() && !stdout.contains('\0') && stdout.lines().next().is_none() {
            return Err(GitError::CommandFailed {
                argv: vec!["merge-tree".into(), "-z".into(), "--write-tree".into()],
                stderr: if stderr.is_empty() {
                    stdout
                } else {
                    stderr
                },
            });
        }
        parse_modern_merge_tree(self, base, &stdout)
    }

    fn merge_tree_trivial(
        &self,
        base: &str,
        ours: &str,
        theirs: &str,
    ) -> Result<MergeAnalysis, GitError> {
        let (status, stdout, stderr) = self.run_raw(&["merge-tree", base, ours, theirs])?;
        if !status.success() && stdout.trim().is_empty() {
            return Err(GitError::CommandFailed {
                argv: vec![
                    "merge-tree".into(),
                    base.to_string(),
                    ours.to_string(),
                    theirs.to_string(),
                ],
                stderr,
            });
        }
        parse_trivial_merge_tree(self, &stdout)
    }

    pub(crate) fn cat_blob(&self, oid: &str) -> Result<String, GitError> {
        self.run(&["cat-file", "-p", oid])
    }

    pub(crate) fn show_path_at_tree(&self, tree: &str, path: &str) -> Result<String, GitError> {
        let spec = format!("{tree}:{path}");
        self.run(&["cat-file", "-p", &spec])
    }
}

fn validate_revision(value: &str) -> Result<String, GitError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('-')
        || trimmed.contains('\0')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
    {
        return Err(GitError::InvalidArgument {
            message: "invalid merge revision".into(),
        });
    }
    Ok(trimmed.to_string())
}

fn looks_like_unsupported_merge_tree(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("unknown option")
        || lower.contains("invalid option")
        || lower.contains("usage:")
        || lower.contains("is not a valid option")
        || (lower.contains("merge-tree") && lower.contains("unrecognized"))
}

fn parse_modern_merge_tree(
    git: &GitService,
    base: &str,
    raw: &str,
) -> Result<MergeAnalysis, GitError> {
    let bytes = raw.as_bytes();
    let mut cursor = 0usize;
    let tree_oid = read_cstr(bytes, &mut cursor)?.to_string();
    if tree_oid.is_empty() {
        return Err(GitError::InvalidArgument {
            message: "merge-tree returned an empty tree oid".into(),
        });
    }

    // Conflicted file info: mode oid stage\tpath\0 … then an extra \0.
    let mut stages: BTreeMap<String, BTreeMap<u32, String>> = BTreeMap::new();
    while cursor < bytes.len() {
        if bytes[cursor] == 0 {
            cursor += 1;
            break;
        }
        let entry = read_cstr(bytes, &mut cursor)?;
        let (meta, path) = entry.split_once('\t').ok_or_else(|| GitError::InvalidArgument {
            message: format!("malformed merge-tree conflict entry: {entry}"),
        })?;
        let mut parts = meta.split_whitespace();
        let _mode = parts.next();
        let oid = parts
            .next()
            .ok_or_else(|| GitError::InvalidArgument {
                message: format!("merge-tree conflict entry missing oid: {entry}"),
            })?
            .to_string();
        let stage: u32 = parts
            .next()
            .ok_or_else(|| GitError::InvalidArgument {
                message: format!("merge-tree conflict entry missing stage: {entry}"),
            })?
            .parse()
            .map_err(|_| GitError::InvalidArgument {
                message: format!("merge-tree conflict entry bad stage: {entry}"),
            })?;
        stages.entry(path.to_string()).or_default().insert(stage, oid);
    }

    let messages = String::from_utf8_lossy(&bytes[cursor..]).to_string();
    let mut rename_conflicts = Vec::new();
    let mut delete_modify = Vec::new();
    for message in messages.split('\0') {
        let lower = message.to_ascii_lowercase();
        if lower.contains("conflict (rename") {
            rename_conflicts.push(RenameConflict {
                path: extract_conflict_path(message).unwrap_or_default(),
                message: message.trim().to_string(),
            });
        } else if lower.contains("modify/delete") || lower.contains("delete/modify") {
            delete_modify.push(DeleteModifyConflict {
                path: extract_conflict_path(message).unwrap_or_default(),
                message: message.trim().to_string(),
            });
        }
    }

    let conflict_paths: BTreeSet<String> = stages.keys().cloned().collect();
    let mut conflicts = Vec::new();
    for (path, by_stage) in &stages {
        // Content conflicts typically have stages 1/2/3. Delete/modify often
        // only has 1+2 or 1+3; those are tracked separately via messages.
        let has_ours = by_stage.contains_key(&2);
        let has_theirs = by_stage.contains_key(&3);
        if !(has_ours && has_theirs) {
            continue;
        }
        conflicts.push(ContentConflict {
            path: path.clone(),
            base: blob_at(git, by_stage.get(&1).map(String::as_str))?,
            ours: blob_at(git, by_stage.get(&2).map(String::as_str))?,
            theirs: blob_at(git, by_stage.get(&3).map(String::as_str))?,
        });
    }

    let base_tree = git
        .run(&["rev-parse", &format!("{base}^{{tree}}")])?
        .trim()
        .to_string();
    let changed = git.run(&["diff-tree", "-r", "--name-only", "-z", &base_tree, &tree_oid])?;
    let mut auto_files = Vec::new();
    for path in changed.split('\0').filter(|p| !p.is_empty()) {
        if conflict_paths.contains(path) {
            continue;
        }
        if delete_modify.iter().any(|entry| entry.path == path)
            || rename_conflicts.iter().any(|entry| entry.path == path)
        {
            continue;
        }
        // A path deleted on the result tree is not an auto-merged file body.
        match git.show_path_at_tree(&tree_oid, path) {
            Ok(content) => auto_files.push(MergedFile {
                path: path.to_string(),
                content,
            }),
            Err(GitError::CommandFailed { .. }) => continue,
            Err(error) => return Err(error),
        }
    }

    Ok(MergeAnalysis {
        auto_files,
        conflicts,
        rename_conflicts,
        delete_modify,
    })
}

fn parse_trivial_merge_tree(git: &GitService, raw: &str) -> Result<MergeAnalysis, GitError> {
    let mut analysis = MergeAnalysis::default();
    let mut lines = raw.lines().peekable();

    while let Some(header) = lines.next() {
        let header = header.trim();
        if header.is_empty() {
            continue;
        }
        if header.starts_with("@@") {
            // Skip conflict-marker hunks — never materialize them as content.
            while matches!(lines.peek(), Some(line) if line.starts_with('+') || line.starts_with('-') || line.starts_with(' ') || line.starts_with('\\'))
            {
                lines.next();
            }
            continue;
        }

        match header {
            "merged" => {
                let mut result_oid = None;
                let mut path = None;
                while matches!(lines.peek(), Some(line) if line.starts_with(' ')) {
                    let line = lines.next().unwrap().trim();
                    if let Some(rest) = line.strip_prefix("result ") {
                        let (oid, file) = split_mode_oid_path(rest)?;
                        result_oid = Some(oid);
                        path = Some(file);
                    }
                }
                if let (Some(oid), Some(path)) = (result_oid, path) {
                    analysis.auto_files.push(MergedFile {
                        path,
                        content: git.cat_blob(&oid)?,
                    });
                }
            }
            "added in remote" | "added in local" | "added in both" => {
                let mut oid = None;
                let mut path = None;
                while matches!(lines.peek(), Some(line) if line.starts_with(' ')) {
                    let line = lines.next().unwrap().trim();
                    for prefix in ["their ", "our ", "result "] {
                        if let Some(rest) = line.strip_prefix(prefix) {
                            let (blob, file) = split_mode_oid_path(rest)?;
                            oid = Some(blob);
                            path = Some(file);
                        }
                    }
                }
                // Consume any following unified hunk without treating markers as content.
                while matches!(lines.peek(), Some(line) if line.starts_with("@@") || line.starts_with('+') || line.starts_with('-') || line.starts_with(' ') || line.starts_with('\\'))
                {
                    let line = lines.next().unwrap();
                    if line.starts_with("@@") {
                        while matches!(lines.peek(), Some(next) if next.starts_with('+') || next.starts_with('-') || next.starts_with(' ') || next.starts_with('\\'))
                        {
                            lines.next();
                        }
                    }
                }
                if let (Some(oid), Some(path)) = (oid, path) {
                    if !analysis.auto_files.iter().any(|file| file.path == path) {
                        analysis.auto_files.push(MergedFile {
                            path,
                            content: git.cat_blob(&oid)?,
                        });
                    }
                }
            }
            "changed in both" => {
                let mut base = None;
                let mut ours = None;
                let mut theirs = None;
                let mut path = None;
                while matches!(lines.peek(), Some(line) if line.starts_with(' ')) {
                    let line = lines.next().unwrap().trim();
                    if let Some(rest) = line.strip_prefix("base ") {
                        let (oid, file) = split_mode_oid_path(rest)?;
                        base = Some(oid);
                        path = Some(file);
                    } else if let Some(rest) = line.strip_prefix("our ") {
                        let (oid, file) = split_mode_oid_path(rest)?;
                        ours = Some(oid);
                        path = Some(file);
                    } else if let Some(rest) = line.strip_prefix("their ") {
                        let (oid, file) = split_mode_oid_path(rest)?;
                        theirs = Some(oid);
                        path = Some(file);
                    }
                }
                while matches!(lines.peek(), Some(line) if line.starts_with("@@") || line.starts_with('+') || line.starts_with('-') || line.starts_with(' ') || line.starts_with('\\'))
                {
                    let line = lines.next().unwrap();
                    if line.starts_with("@@") {
                        while matches!(lines.peek(), Some(next) if next.starts_with('+') || next.starts_with('-') || next.starts_with(' ') || next.starts_with('\\'))
                        {
                            lines.next();
                        }
                    }
                }
                if let Some(path) = path {
                    analysis.conflicts.push(ContentConflict {
                        path,
                        base: blob_at(git, base.as_deref())?,
                        ours: blob_at(git, ours.as_deref())?,
                        theirs: blob_at(git, theirs.as_deref())?,
                    });
                }
            }
            "removed in local" | "removed in remote" => {
                let mut path = String::new();
                while matches!(lines.peek(), Some(line) if line.starts_with(' ')) {
                    let line = lines.next().unwrap().trim();
                    for prefix in ["base ", "our ", "their "] {
                        if let Some(rest) = line.strip_prefix(prefix) {
                            let (_oid, file) = split_mode_oid_path(rest)?;
                            path = file;
                        }
                    }
                }
                analysis.delete_modify.push(DeleteModifyConflict {
                    path: path.clone(),
                    message: format!("{header}: {path}"),
                });
            }
            other if other.to_ascii_lowercase().contains("rename") => {
                analysis.rename_conflicts.push(RenameConflict {
                    path: extract_conflict_path(other).unwrap_or_default(),
                    message: other.to_string(),
                });
            }
            _ => {}
        }
    }

    Ok(analysis)
}

fn split_mode_oid_path(rest: &str) -> Result<(String, String), GitError> {
    let mut parts = rest.split_whitespace();
    let _mode = parts.next().ok_or_else(|| GitError::InvalidArgument {
        message: format!("malformed merge-tree entry: {rest}"),
    })?;
    let oid = parts
        .next()
        .ok_or_else(|| GitError::InvalidArgument {
            message: format!("malformed merge-tree entry: {rest}"),
        })?
        .to_string();
    let path = parts.collect::<Vec<_>>().join(" ");
    if path.is_empty() {
        return Err(GitError::InvalidArgument {
            message: format!("malformed merge-tree entry: {rest}"),
        });
    }
    Ok((oid, path))
}

fn blob_at(git: &GitService, oid: Option<&str>) -> Result<Option<String>, GitError> {
    match oid {
        Some(oid) => Ok(Some(git.cat_blob(oid)?)),
        None => Ok(None),
    }
}

fn read_cstr<'a>(bytes: &'a [u8], cursor: &mut usize) -> Result<&'a str, GitError> {
    if *cursor >= bytes.len() {
        return Ok("");
    }
    if let Some(rel) = bytes[*cursor..].iter().position(|b| *b == 0) {
        let slice = &bytes[*cursor..*cursor + rel];
        *cursor += rel + 1;
        std::str::from_utf8(slice).map_err(|_| GitError::InvalidArgument {
            message: "merge-tree output was not valid UTF-8".into(),
        })
    } else {
        let slice = &bytes[*cursor..];
        *cursor = bytes.len();
        std::str::from_utf8(slice).map_err(|_| GitError::InvalidArgument {
            message: "merge-tree output was not valid UTF-8".into(),
        })
    }
}

fn extract_conflict_path(message: &str) -> Option<String> {
    // Examples:
    // CONFLICT (content): Merge conflict in f.txt
    // CONFLICT (modify/delete): dm.txt deleted in ...
    // CONFLICT (rename/rename): r/a.txt renamed to ...
    let lower = message.to_ascii_lowercase();
    if let Some(idx) = lower.find("merge conflict in ") {
        return Some(message[idx + "merge conflict in ".len()..].trim().to_string());
    }
    if let Some(idx) = lower.find("): ") {
        let rest = message[idx + 3..].trim();
        let token = rest.split_whitespace().next()?;
        return Some(token.trim_matches(':').to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use crate::GitService;
    use std::path::Path;

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn init_repo(dir: &Path) {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", "Test"],
            vec!["config", "user.email", "test@example.com"],
        ] {
            assert!(std::process::Command::new("git")
                .args(&args)
                .current_dir(dir)
                .status()
                .unwrap()
                .success());
        }
    }

    fn commit_all(dir: &Path, message: &str) -> String {
        assert!(std::process::Command::new("git")
            .args(["add", "-A"])
            .current_dir(dir)
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .args(["commit", "-q", "-m", message])
            .current_dir(dir)
            .status()
            .unwrap()
            .success());
        String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(dir)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string()
    }

    #[test]
    fn merge_preview_reports_content_conflict_without_writing_files() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path();
        init_repo(repo);
        std::fs::write(repo.join("f.txt"), "base\n").unwrap();
        let base = commit_all(repo, "base");
        std::fs::write(repo.join("f.txt"), "ours\n").unwrap();
        let ours = commit_all(repo, "ours");
        assert!(std::process::Command::new("git")
            .args(["checkout", "-q", &base])
            .current_dir(repo)
            .status()
            .unwrap()
            .success());
        std::fs::write(repo.join("f.txt"), "theirs\n").unwrap();
        assert!(std::process::Command::new("git")
            .args(["checkout", "-q", "-b", "theirs"])
            .current_dir(repo)
            .status()
            .unwrap()
            .success());
        let theirs = commit_all(repo, "theirs");

        let before = std::fs::read_to_string(repo.join("f.txt")).unwrap();
        let git = GitService::open(repo);
        let analysis = git.merge_preview(&base, &ours, &theirs).expect("preview");
        assert_eq!(std::fs::read_to_string(repo.join("f.txt")).unwrap(), before);
        assert!(
            analysis
                .conflicts
                .iter()
                .any(|c| c.path == "f.txt" && c.ours.as_deref() == Some("ours\n")),
            "{analysis:?}"
        );
        assert!(!analysis.conflicts.is_empty());
    }
}
