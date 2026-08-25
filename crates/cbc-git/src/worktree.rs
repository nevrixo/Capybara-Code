//! Safe Git worktree create/list/remove primitives.
//!
//! Paths are caller-generated but must stay under a provided `data_root`. The
//! backend never accepts an arbitrary project-supplied checkout location.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::{GitError, GitService};

const WINDOWS_PATH_BYTE_LIMIT: usize = 240;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: PathBuf,
    pub head: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct WorktreeCreateOptions<'a> {
    pub data_root: &'a Path,
    pub path: &'a Path,
    pub commit: &'a str,
    pub require_clean: bool,
    /// When true, skip the Windows MAX_PATH-ish guard (caller supplies `\\?\`).
    pub allow_long_path: bool,
}

impl GitService {
    /// Create a detached worktree at `options.path` pointing at `options.commit`.
    pub fn worktree_create(
        &self,
        options: WorktreeCreateOptions<'_>,
    ) -> Result<WorktreeInfo, GitError> {
        if !self.is_repository() {
            return Err(GitError::NotARepository {
                path: self.root.display().to_string(),
            });
        }
        if options.require_clean {
            let status = self.status()?;
            if status.dirty {
                return Err(GitError::DirtyBase);
            }
        }

        let absolute = validate_worktree_path(
            options.data_root,
            options.path,
            options.allow_long_path,
            true,
        )?;
        let commit = validate_commitish(options.commit)?;
        // Ensure the commit resolves before creating directories.
        let resolved_commit = self
            .run(&["rev-parse", "--verify", &format!("{commit}^{{commit}}")])?
            .trim()
            .to_string();

        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|error| GitError::Io {
                path: parent.display().to_string(),
                message: error.to_string(),
            })?;
        }

        let path_arg = absolute.to_string_lossy().to_string();
        self.run(&[
            "worktree",
            "add",
            "--detach",
            &path_arg,
            &resolved_commit,
        ])?;

        match self.verify_worktree_identity(&absolute) {
            Ok(()) => {}
            Err(error) => {
                let _ = self.run(&["worktree", "remove", "--force", &path_arg]);
                return Err(error);
            }
        }

        let head = worktree_head(&absolute)?;
        if !heads_match(&head, &resolved_commit) {
            let _ = self.run(&["worktree", "remove", "--force", &path_arg]);
            return Err(GitError::HeadMismatch {
                expected: resolved_commit,
                actual: head,
            });
        }

        Ok(WorktreeInfo {
            path: absolute,
            head,
            branch: None,
            locked: false,
            prunable: false,
        })
    }

    /// List registered worktrees (`git worktree list --porcelain`).
    pub fn worktree_list(&self) -> Result<Vec<WorktreeInfo>, GitError> {
        if !self.is_repository() {
            return Err(GitError::NotARepository {
                path: self.root.display().to_string(),
            });
        }
        let raw = self.run(&["worktree", "list", "--porcelain"])?;
        Ok(parse_worktree_porcelain(&raw))
    }

    /// Inspect a single worktree path, verifying it belongs to this repository.
    pub fn worktree_inspect(&self, data_root: &Path, path: &Path) -> Result<WorktreeInfo, GitError> {
        if !self.is_repository() {
            return Err(GitError::NotARepository {
                path: self.root.display().to_string(),
            });
        }
        let absolute = validate_worktree_path(data_root, path, true, false)?;
        self.verify_worktree_identity(&absolute)?;
        let entries = self.worktree_list()?;
        entries
            .into_iter()
            .find(|entry| paths_equal(&entry.path, &absolute))
            .ok_or_else(|| GitError::NotARepository {
                path: absolute.display().to_string(),
            })
    }

    /// Remove a worktree. Refuses when the caller reports an active writer.
    pub fn worktree_remove(
        &self,
        data_root: &Path,
        path: &Path,
        has_active_writer: bool,
    ) -> Result<(), GitError> {
        if !self.is_repository() {
            return Err(GitError::NotARepository {
                path: self.root.display().to_string(),
            });
        }
        if has_active_writer {
            return Err(GitError::ActiveWriter {
                path: path.display().to_string(),
            });
        }
        let absolute = validate_worktree_path(data_root, path, true, false)?;
        if absolute.exists() {
            self.verify_worktree_identity(&absolute)?;
            let path_arg = absolute.to_string_lossy().to_string();
            self.run(&["worktree", "remove", "--force", &path_arg])?;
        }
        // Drop stale registrations for missing directories.
        let _ = self.run(&["worktree", "prune", "--expire", "now"]);
        Ok(())
    }

    /// Prune worktree registrations whose directories are gone.
    pub fn worktree_prune(&self) -> Result<(), GitError> {
        if !self.is_repository() {
            return Err(GitError::NotARepository {
                path: self.root.display().to_string(),
            });
        }
        self.run(&["worktree", "prune", "--expire", "now"])?;
        Ok(())
    }

    fn verify_worktree_identity(&self, worktree_path: &Path) -> Result<(), GitError> {
        let expected = self.common_git_dir()?;
        let actual = common_git_dir_at(worktree_path)?;
        if !paths_equal(&expected, &actual) {
            return Err(GitError::IdentityMismatch {
                expected: expected.display().to_string(),
                actual: actual.display().to_string(),
            });
        }
        Ok(())
    }

    fn common_git_dir(&self) -> Result<PathBuf, GitError> {
        let raw = self.run(&["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
        Ok(PathBuf::from(raw.trim()))
    }
}

fn common_git_dir_at(worktree_path: &Path) -> Result<PathBuf, GitError> {
    let output = std::process::Command::new("git")
        .args([
            "--no-pager",
            "-c",
            "core.hooksPath=/dev/null",
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ])
        .current_dir(worktree_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| GitError::GitUnavailable {
            message: error.to_string(),
        })?;
    if !output.status.success() {
        return Err(GitError::CommandFailed {
            argv: vec![
                "rev-parse".into(),
                "--path-format=absolute".into(),
                "--git-common-dir".into(),
            ],
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

fn worktree_head(worktree_path: &Path) -> Result<String, GitError> {
    let output = std::process::Command::new("git")
        .args(["--no-pager", "rev-parse", "HEAD"])
        .current_dir(worktree_path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| GitError::GitUnavailable {
            message: error.to_string(),
        })?;
    if !output.status.success() {
        return Err(GitError::CommandFailed {
            argv: vec!["rev-parse".into(), "HEAD".into()],
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn validate_commitish(commit: &str) -> Result<String, GitError> {
    let trimmed = commit.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('-')
        || trimmed.contains('\0')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
        || trimmed.contains("..")
    {
        return Err(GitError::InvalidArgument {
            message: "invalid worktree commit".into(),
        });
    }
    Ok(trimmed.to_string())
}

/// Ensure `path` resolves strictly beneath `data_root`.
pub fn validate_worktree_path(
    data_root: &Path,
    path: &Path,
    allow_long_path: bool,
    allow_missing: bool,
) -> Result<PathBuf, GitError> {
    if path.as_os_str().is_empty() {
        return Err(GitError::InvalidArgument {
            message: "worktree path must not be empty".into(),
        });
    }
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(GitError::PathEscapesDataRoot {
                    path: path.display().to_string(),
                });
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) | Component::CurDir => {
            }
        }
    }

    let data_root = normalize_existing(data_root).unwrap_or_else(|_| data_root.to_path_buf());
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        data_root.join(path)
    };

    reject_symlink_ancestors(&absolute)?;

    if !allow_long_path {
        let rendered = absolute.to_string_lossy();
        let bytes = rendered.as_bytes().len();
        let has_long_prefix = rendered.starts_with(r"\\?\") || rendered.starts_with("//?/");
        if bytes > WINDOWS_PATH_BYTE_LIMIT && !has_long_prefix {
            return Err(GitError::PathTooLong {
                path: absolute.display().to_string(),
                bytes,
            });
        }
    }

    let check_path = if absolute.exists() || !allow_missing {
        normalize_existing(&absolute).unwrap_or(absolute.clone())
    } else if let Some(parent) = absolute.parent() {
        let normalized_parent = if parent.exists() {
            normalize_existing(parent).unwrap_or_else(|_| parent.to_path_buf())
        } else {
            // Walk up to the first existing ancestor under data_root.
            let mut cursor = parent.to_path_buf();
            while !cursor.exists() {
                match cursor.parent() {
                    Some(next) => cursor = next.to_path_buf(),
                    None => break,
                }
            }
            normalize_existing(&cursor).unwrap_or(cursor)
        };
        let name = absolute
            .file_name()
            .ok_or_else(|| GitError::InvalidArgument {
                message: "worktree path must include a final component".into(),
            })?;
        // Reconstruct under the normalized parent when only the leaf is missing.
        if parent.exists() {
            normalized_parent.join(name)
        } else {
            // Keep the full absolute spelling; containment still uses strip_prefix.
            absolute.clone()
        }
    } else {
        absolute.clone()
    };

    if !is_beneath(&data_root, &check_path) && !is_beneath(&data_root, &absolute) {
        return Err(GitError::PathEscapesDataRoot {
            path: absolute.display().to_string(),
        });
    }
    Ok(absolute)
}

fn reject_symlink_ancestors(path: &Path) -> Result<(), GitError> {
    let mut cursor = PathBuf::new();
    for component in path.components() {
        cursor.push(component.as_os_str());
        let meta = match fs::symlink_metadata(&cursor) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            // The leaf may not exist yet; a symlink anywhere on the parent chain
            // is enough to refuse containment.
            if cursor != path {
                return Err(GitError::SymlinkParent {
                    path: cursor.display().to_string(),
                });
            }
        }
    }
    Ok(())
}

fn is_beneath(root: &Path, candidate: &Path) -> bool {
    if root == candidate {
        return true;
    }
    candidate.starts_with(root)
}

fn normalize_existing(path: &Path) -> Result<PathBuf, std::io::Error> {
    fs::canonicalize(path).map(strip_verbatim)
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let left_n = normalize_existing(left).unwrap_or_else(|_| left.to_path_buf());
    let right_n = normalize_existing(right).unwrap_or_else(|_| right.to_path_buf());
    left_n == right_n
}

fn heads_match(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

/// Parse `git worktree list --porcelain`.
pub fn parse_worktree_porcelain(raw: &str) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut current: Option<WorktreeInfo> = None;

    let flush = |current: &mut Option<WorktreeInfo>, out: &mut Vec<WorktreeInfo>| {
        if let Some(entry) = current.take() {
            out.push(entry);
        }
    };

    for line in raw.lines() {
        if line.is_empty() {
            flush(&mut current, &mut out);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut current, &mut out);
            current = Some(WorktreeInfo {
                path: PathBuf::from(path),
                head: String::new(),
                branch: None,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            entry.head = head.trim().to_string();
        } else if let Some(branch) = line.strip_prefix("branch ") {
            entry.branch = Some(branch.trim().to_string());
        } else if line == "detached" {
            entry.branch = None;
        } else if line.starts_with("locked") {
            entry.locked = true;
        } else if line.starts_with("prunable") {
            entry.prunable = true;
        }
    }
    flush(&mut current, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::GitService;

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
            let status = std::process::Command::new("git")
                .args(&args)
                .current_dir(dir)
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        }
    }

    #[test]
    fn porcelain_parser_reads_locked_and_prunable() {
        let raw = "\
worktree /repo
HEAD abcdef
branch refs/heads/main

worktree /repo/wt
HEAD 123456
detached
locked reason
prunable gitdir file points to non-existent location
";
        let entries = parse_worktree_porcelain(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].branch.as_deref(), Some("refs/heads/main"));
        assert!(entries[1].locked);
        assert!(entries[1].prunable);
        assert!(entries[1].branch.is_none());
    }

    #[test]
    fn rejects_parent_dir_components() {
        let tmp = tempfile::TempDir::new().unwrap();
        let err = validate_worktree_path(tmp.path(), Path::new("a/../../outside"), false, true)
            .expect_err("parent components");
        assert!(matches!(err, GitError::PathEscapesDataRoot { .. }));
    }

    #[test]
    fn refuses_non_git_repository() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let git = GitService::open(tmp.path());
        let err = git
            .worktree_create(WorktreeCreateOptions {
                data_root: tmp.path(),
                path: Path::new("worktrees/x/repo"),
                commit: "HEAD",
                require_clean: true,
                allow_long_path: true,
            })
            .expect_err("not a repo");
        assert!(matches!(err, GitError::NotARepository { .. }));
    }

    #[test]
    fn refuses_dirty_base_when_required() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let data = tmp.path().join("data");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&data).unwrap();
        init_repo(&repo);
        fs::write(repo.join("f.txt"), "v1\n").unwrap();
        assert!(std::process::Command::new("git")
            .args(["add", "-A"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .args(["commit", "-q", "-m", "seed"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
        fs::write(repo.join("f.txt"), "dirty\n").unwrap();

        let git = GitService::open(&repo);
        let err = git
            .worktree_create(WorktreeCreateOptions {
                data_root: &data,
                path: Path::new("worktrees/wt/repo"),
                commit: "HEAD",
                require_clean: true,
                allow_long_path: true,
            })
            .expect_err("dirty base");
        assert!(matches!(err, GitError::DirtyBase));
    }

    #[test]
    fn refuses_path_outside_data_root() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let data = tmp.path().join("data");
        let outside = tmp.path().join("outside-wt");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&data).unwrap();
        init_repo(&repo);
        fs::write(repo.join("f.txt"), "v1\n").unwrap();
        assert!(std::process::Command::new("git")
            .args(["add", "-A"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .args(["commit", "-q", "-m", "seed"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());

        let git = GitService::open(&repo);
        let err = git
            .worktree_create(WorktreeCreateOptions {
                data_root: &data,
                path: &outside,
                commit: "HEAD",
                require_clean: true,
                allow_long_path: true,
            })
            .expect_err("outside data root");
        assert!(matches!(err, GitError::PathEscapesDataRoot { .. }));
    }
}
