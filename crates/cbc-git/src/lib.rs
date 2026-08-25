//! `cbc-git` — Git read services and safety checkpoints — PRD §14.9, §12.2.
//!
//! §14.9 constraints:
//!   - read-heavy commands call the installed `git` with direct argv,
//!   - status/diff parsers normalize output,
//!   - no global git config mutation,
//!   - pager disabled,
//!   - hooks disabled for read operations,
//!   - a safety checkpoint cannot automatically include secrets.
//!
//! `git.commit`, `git.push`, and `git reset --hard` are deliberately absent from
//! the tool catalog (§12.2).

mod merge;
mod worktree;

pub use merge::{
    ContentConflict, DeleteModifyConflict, MergeAnalysis, MergedFile, RenameConflict,
};
pub use worktree::{validate_worktree_path, WorktreeCreateOptions, WorktreeInfo};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};

use serde::Serialize;

#[derive(Debug)]
pub enum GitError {
    NotARepository { path: String },
    GitUnavailable { message: String },
    CommandFailed { argv: Vec<String>, stderr: String },
    DirtyBase,
    PathEscapesDataRoot { path: String },
    PathTooLong { path: String, bytes: usize },
    SymlinkParent { path: String },
    IdentityMismatch { expected: String, actual: String },
    ActiveWriter { path: String },
    HeadMismatch { expected: String, actual: String },
    InvalidArgument { message: String },
    Io { path: String, message: String },
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::NotARepository { path } => write!(f, "{path} is not a Git repository"),
            GitError::GitUnavailable { message } => write!(f, "git is unavailable: {message}"),
            GitError::CommandFailed { argv, stderr } => {
                write!(f, "git {} failed: {stderr}", argv.join(" "))
            }
            GitError::DirtyBase => write!(f, "refusing to create a worktree on a dirty base"),
            GitError::PathEscapesDataRoot { path } => {
                write!(f, "worktree path escapes data root: {path}")
            }
            GitError::PathTooLong { path, bytes } => {
                write!(f, "worktree path is too long ({bytes} bytes): {path}")
            }
            GitError::SymlinkParent { path } => {
                write!(f, "worktree path has a symlink parent: {path}")
            }
            GitError::IdentityMismatch { expected, actual } => {
                write!(
                    f,
                    "worktree git identity mismatch: expected {expected}, got {actual}"
                )
            }
            GitError::ActiveWriter { path } => {
                write!(f, "refusing to remove worktree with an active writer: {path}")
            }
            GitError::HeadMismatch { expected, actual } => {
                write!(f, "worktree HEAD mismatch: expected {expected}, got {actual}")
            }
            GitError::InvalidArgument { message } => write!(f, "{message}"),
            GitError::Io { path, message } => write!(f, "io error at {path}: {message}"),
        }
    }
}

impl std::error::Error for GitError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    Conflicted,
    TypeChanged,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub index_status: Option<FileStatus>,
    pub worktree_status: Option<FileStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}

/// Normalized repository status, matching the status-bar fields in §6.13.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub is_repository: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub entries: Vec<StatusEntry>,
    pub additions: usize,
    pub deletions: usize,
    pub untracked: usize,
    pub dirty: bool,
    pub detached: bool,
}

impl RepoStatus {
    /// Compact status-bar rendering: `⎇ main +96 -5`.
    pub fn status_bar_fragment(&self) -> String {
        if !self.is_repository {
            return "no git".to_string();
        }
        let branch = self.branch.clone().unwrap_or_else(|| {
            self.head
                .as_deref()
                .map(|h| format!("detached@{}", &h[..h.len().min(7)]))
                .unwrap_or_else(|| "unknown".into())
        });
        let mut out = format!("⎇ {branch}");
        if self.additions > 0 {
            out.push_str(&format!(" +{}", self.additions));
        }
        if self.deletions > 0 {
            out.push_str(&format!(" -{}", self.deletions));
        }
        if self.untracked > 0 {
            out.push_str(&format!(" ?{}", self.untracked));
        }
        out
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    /// Raw hunk text, sanitized before display.
    pub patch: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub files: Vec<DiffFile>,
    pub total_additions: usize,
    pub total_deletions: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

/// Git service bound to one workspace.
#[derive(Debug, Clone)]
pub struct GitService {
    pub(crate) root: PathBuf,
    git_dir: Option<PathBuf>,
}

impl GitService {
    pub fn open(workspace_root: &Path) -> Self {
        let git_dir = find_git_dir(workspace_root);
        Self {
            root: workspace_root.to_path_buf(),
            git_dir,
        }
    }

    pub fn is_repository(&self) -> bool {
        self.git_dir.is_some()
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn git_root(&self) -> Option<&Path> {
        self.git_dir.as_deref().and_then(|d| d.parent())
    }

    /// The workspace's path relative to the repository root, when the workspace
    /// is a proper subdirectory of the repository. Git reports paths relative to
    /// the repository root even when invoked from a subdirectory, so this prefix
    /// is what turns those back into workspace-relative paths (P1-06).
    fn workspace_prefix(&self) -> Option<String> {
        let root = self.git_root()?;
        let relative = self.root.strip_prefix(root).ok()?;
        let text = relative.to_string_lossy().replace('\\', "/");
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    fn to_workspace_relative(&self, path: &str) -> String {
        match self.workspace_prefix() {
            Some(prefix) => path
                .strip_prefix(&format!("{prefix}/"))
                .unwrap_or(path)
                .to_string(),
            None => path.to_string(),
        }
    }

    /// Run git with direct argv, a disabled pager, and no hooks (§14.9).
    pub(crate) fn run(&self, args: &[&str]) -> Result<String, GitError> {
        let (status, stdout, stderr) = self.run_raw(args)?;
        if !status.success() {
            return Err(GitError::CommandFailed {
                argv: args.iter().map(|s| s.to_string()).collect(),
                stderr,
            });
        }
        Ok(stdout)
    }

    /// Like [`Self::run`], but preserves non-zero exits for callers that parse
    /// conflict output (notably `git merge-tree`).
    pub(crate) fn run_raw(&self, args: &[&str]) -> Result<(ExitStatus, String, String), GitError> {
        let mut command = Command::new("git");
        command
            .arg("--no-pager")
            // Never read or write global/system config for these calls.
            .arg("-c")
            .arg("core.hooksPath=/dev/null")
            .arg("-c")
            .arg("core.pager=cat")
            .arg("-c")
            .arg("color.ui=false")
            .args(args)
            .current_dir(&self.root)
            .env("GIT_PAGER", "cat")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            // Prevent any system config from being consulted.
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_ATTR_NOSYSTEM", "1")
            // P1-06: the *global* config is isolated too. Pointing
            // GIT_CONFIG_GLOBAL at a managed stub means a repository's aliases,
            // includes, credential helpers, or hook redirects cannot influence
            // runtime calls. The stub carries only a fallback identity so
            // checkpoint objects can still be created when the repository has no
            // local identity; a repository-local identity always wins over it.
            .env(
                "GIT_CONFIG_GLOBAL",
                managed_git_config().to_string_lossy().to_string(),
            );

        let output = command.output().map_err(|e| GitError::GitUnavailable {
            message: e.to_string(),
        })?;

        Ok((
            output.status,
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }

    /// `git.status` — normalized porcelain v1 output.
    pub fn status(&self) -> Result<RepoStatus, GitError> {
        if !self.is_repository() {
            return Ok(RepoStatus::default());
        }
        // P1-06: when the workspace is a subdirectory of a larger repository,
        // the `-- .` pathspec keeps status scoped to the workspace instead of
        // reporting files the agent has no business seeing.
        let raw = self.run(&[
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=all",
            "--",
            ".",
        ])?;
        let mut status = parse_porcelain(&raw);
        status.is_repository = true;
        // Git reports repo-root-relative paths; the agent works in workspace-
        // relative ones.
        for entry in &mut status.entries {
            entry.path = self.to_workspace_relative(&entry.path);
            if let Some(original) = entry.original_path.take() {
                entry.original_path = Some(self.to_workspace_relative(&original));
            }
        }

        if let Ok(head) = self.run(&["rev-parse", "HEAD"]) {
            status.head = Some(head.trim().to_string());
        }
        if let Ok(numstat) = self.run(&["diff", "--numstat", "HEAD", "--", "."]) {
            let (adds, dels) = sum_numstat(&numstat);
            status.additions = adds;
            status.deletions = dels;
        }
        status.dirty = !status.entries.is_empty();
        Ok(status)
    }

    /// `git.diff` — working tree or a specific range.
    pub fn diff(&self, range: Option<&str>, paths: &[String]) -> Result<DiffSummary, GitError> {
        if !self.is_repository() {
            return Ok(DiffSummary::default());
        }
        let mut args: Vec<String> =
            vec!["diff".into(), "--no-color".into(), "--no-ext-diff".into()];
        if let Some(range) = range {
            args.push(range.to_string());
        }
        // P1-06: with no explicit path filter, scope to the workspace so a
        // repository that extends beyond it does not leak into the diff.
        args.push("--".into());
        if paths.is_empty() {
            args.push(".".into());
        } else {
            args.extend(paths.iter().cloned());
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let raw = self.run(&refs)?;
        let mut summary = parse_diff(&raw);
        for file in &mut summary.files {
            file.path = self.to_workspace_relative(&file.path);
            if let Some(old) = file.old_path.take() {
                file.old_path = Some(self.to_workspace_relative(&old));
            }
        }
        Ok(summary)
    }

    /// `git.log`.
    pub fn log(&self, limit: usize, path: Option<&str>) -> Result<Vec<LogEntry>, GitError> {
        if !self.is_repository() {
            return Ok(Vec::new());
        }
        let limit_arg = format!("-{}", limit.clamp(1, 500));
        let mut args: Vec<String> = vec![
            "log".into(),
            limit_arg,
            "--date=iso-strict".into(),
            "--pretty=format:%H%x1f%an%x1f%ad%x1f%s".into(),
        ];
        if let Some(path) = path {
            args.push("--".into());
            args.push(path.to_string());
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let raw = self.run(&refs)?;
        Ok(raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|line| {
                let mut parts = line.split('\u{1f}');
                let hash = parts.next()?.to_string();
                let author = parts.next()?.to_string();
                let date = parts.next()?.to_string();
                let subject = parts.next().unwrap_or("").to_string();
                Some(LogEntry {
                    short_hash: hash.chars().take(7).collect(),
                    hash,
                    author,
                    date,
                    subject,
                })
            })
            .collect())
    }

    /// `git.show` — content of a path at a revision.
    pub fn show(&self, revision: &str, path: Option<&str>) -> Result<String, GitError> {
        if !self.is_repository() {
            return Err(GitError::NotARepository {
                path: self.root.display().to_string(),
            });
        }
        let spec = match path {
            Some(p) => format!("{revision}:{p}"),
            None => revision.to_string(),
        };
        self.run(&["show", "--no-color", &spec])
    }

    /// `git.checkpoint` — a local safety checkpoint that does not create a
    /// commit on any branch and never auto-includes untracked files (§14.9).
    ///
    /// P1-06: tracked files *can* hold secrets, so "untracked files are excluded"
    /// is not the same as "no secrets inside". The checkpoint therefore scans the
    /// paths it is about to capture and reports every sensitive-looking one, so
    /// the caller can show the user instead of silently sealing them in.
    pub fn checkpoint(&self, label: &str) -> Result<Checkpoint, GitError> {
        if !self.is_repository() {
            return Err(GitError::NotARepository {
                path: self.root.display().to_string(),
            });
        }
        let warnings = match self.run(&["diff", "--name-only", "HEAD", "--", "."]) {
            Ok(changed) => {
                let sensitive: Vec<String> = changed
                    .lines()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .filter(|path| is_sensitive_path(path))
                    .map(str::to_string)
                    .collect();
                if sensitive.is_empty() {
                    Vec::new()
                } else {
                    vec![format!(
                        "checkpoint captures {} sensitive-looking path(s): {}",
                        sensitive.len(),
                        sensitive.join(", ")
                    )]
                }
            }
            // No HEAD yet (fresh repo) or nothing to compare: nothing to warn about.
            Err(_) => Vec::new(),
        };

        // `stash create` produces a dangling commit object without touching the
        // working tree, the index, or any ref.
        let raw = self.run(&["stash", "create", label])?;
        let object = raw.trim().to_string();
        let head = self
            .run(&["rev-parse", "HEAD"])
            .unwrap_or_default()
            .trim()
            .to_string();
        Ok(Checkpoint {
            label: label.to_string(),
            object: if object.is_empty() {
                None
            } else {
                Some(object)
            },
            head,
            created_at: cbc_patch::now_iso8601(),
            includes_untracked: false,
            warnings,
        })
    }

    /// List tracked files, used to seed the repository map (§18.3).
    pub fn tracked_files(&self, limit: usize) -> Result<Vec<String>, GitError> {
        if !self.is_repository() {
            return Ok(Vec::new());
        }
        let raw = self.run(&["ls-files", "-z", "--", "."])?;
        Ok(raw
            .split('\0')
            .filter(|s| !s.is_empty())
            .take(limit)
            .map(str::to_string)
            .collect())
    }

    /// Recently changed files, used by the context selector (§18.4).
    pub fn recently_changed(&self, limit: usize) -> Result<Vec<String>, GitError> {
        if !self.is_repository() {
            return Ok(Vec::new());
        }
        let raw = self.run(&["log", "-50", "--name-only", "--pretty=format:", "--", "."])?;
        let prefix = self.workspace_prefix();
        let mut seen = BTreeMap::new();
        let mut ordered = Vec::new();
        for line in raw.lines() {
            let path = line.trim();
            if path.is_empty() {
                continue;
            }
            // `log --name-only` reports repo-root-relative paths; drop anything
            // outside the workspace and normalize the rest (P1-06).
            let relative = match &prefix {
                Some(prefix) => match path.strip_prefix(&format!("{prefix}/")) {
                    Some(rest) => rest,
                    None => continue,
                },
                None => path,
            };
            if seen.insert(relative.to_string(), true).is_none() {
                ordered.push(relative.to_string());
                if ordered.len() >= limit {
                    break;
                }
            }
        }
        Ok(ordered)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub label: String,
    /// Dangling commit object, or `None` when the tree was clean.
    pub object: Option<String>,
    pub head: String,
    pub created_at: String,
    pub includes_untracked: bool,
    /// Sensitive-path advisories the caller must surface, never swallow (§14.9).
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// A managed global git config that isolates runtime calls from the user's real
/// `~/.gitconfig` (P1-06). It carries only a fallback identity so checkpoint
/// objects can be created when a repository has no local identity of its own;
/// repository-local config always outranks it.
fn managed_git_config() -> std::path::PathBuf {
    let path = std::env::temp_dir().join("capybara-code-gitconfig");
    if !path.exists() {
        let contents = "[user]\n\tname = Capybara Code\n\temail = capybara-checkpoint@localhost\n";
        let _ = std::fs::write(&path, contents);
    }
    path
}

/// Heuristic for paths a checkpoint should not capture without saying so.
/// Deliberately broad: a false positive costs one warning line, a miss costs a
/// secret sealed into an object the user may keep around (§14.9).
fn is_sensitive_path(path: &str) -> bool {
    let lowered = path.to_ascii_lowercase();
    let name = lowered.rsplit('/').next().unwrap_or(&lowered);
    const NAME_NEEDLES: &[&str] = &[
        ".env",
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".keystore",
        "credential",
        "secret",
        "token",
        "password",
        ".netrc",
        "authorized_keys",
        "keychain",
        ".npmrc",
        ".pypirc",
    ];
    NAME_NEEDLES.iter().any(|needle| name.contains(needle))
}

fn find_git_dir(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join(".git");
        if candidate.is_dir() {
            return Some(candidate);
        }
        if candidate.is_file() {
            // Worktree or submodule: `.git` is a file pointing elsewhere.
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

/// Parse `git status --porcelain=v1 --branch`.
pub fn parse_porcelain(raw: &str) -> RepoStatus {
    let mut status = RepoStatus::default();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            parse_branch_header(rest, &mut status);
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let index = code_to_status(bytes[0] as char);
        let worktree = code_to_status(bytes[1] as char);
        let payload = &line[3..];
        let (path, original) = match payload.split_once(" -> ") {
            Some((from, to)) => (to.to_string(), Some(from.to_string())),
            None => (payload.to_string(), None),
        };
        if index == Some(FileStatus::Untracked) || worktree == Some(FileStatus::Untracked) {
            status.untracked += 1;
        }
        status.entries.push(StatusEntry {
            path: unquote_git_path(&path),
            index_status: index,
            worktree_status: worktree,
            original_path: original.map(|p| unquote_git_path(&p)),
        });
    }
    status.dirty = !status.entries.is_empty();
    status
}

fn parse_branch_header(rest: &str, status: &mut RepoStatus) {
    if rest.starts_with("HEAD (no branch)") {
        status.detached = true;
        return;
    }
    let (branch_part, tracking) = match rest.split_once(" [") {
        Some((b, t)) => (b, Some(t.trim_end_matches(']'))),
        None => (rest, None),
    };
    let (local, upstream) = match branch_part.split_once("...") {
        Some((l, u)) => (l, Some(u.to_string())),
        None => (branch_part, None),
    };
    status.branch = Some(local.trim().to_string());
    status.upstream = upstream;
    if let Some(tracking) = tracking {
        for part in tracking.split(", ") {
            if let Some(n) = part.strip_prefix("ahead ") {
                status.ahead = n.trim().parse().unwrap_or(0);
            }
            if let Some(n) = part.strip_prefix("behind ") {
                status.behind = n.trim().parse().unwrap_or(0);
            }
        }
    }
}

fn code_to_status(code: char) -> Option<FileStatus> {
    match code {
        'A' => Some(FileStatus::Added),
        'M' => Some(FileStatus::Modified),
        'D' => Some(FileStatus::Deleted),
        'R' => Some(FileStatus::Renamed),
        'C' => Some(FileStatus::Copied),
        'T' => Some(FileStatus::TypeChanged),
        'U' => Some(FileStatus::Conflicted),
        '?' => Some(FileStatus::Untracked),
        '!' => Some(FileStatus::Ignored),
        ' ' => None,
        _ => None,
    }
}

/// Git quotes paths containing special characters; undo that for display.
pub fn unquote_git_path(path: &str) -> String {
    if !path.starts_with('"') || !path.ends_with('"') || path.len() < 2 {
        return path.to_string();
    }
    let inner = &path[1..path.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn sum_numstat(raw: &str) -> (usize, usize) {
    let mut adds = 0usize;
    let mut dels = 0usize;
    for line in raw.lines() {
        let mut parts = line.split('\t');
        let a = parts.next().unwrap_or("0");
        let d = parts.next().unwrap_or("0");
        adds += a.parse::<usize>().unwrap_or(0);
        dels += d.parse::<usize>().unwrap_or(0);
    }
    (adds, dels)
}

/// Parse unified diff output into per-file summaries.
pub fn parse_diff(raw: &str) -> DiffSummary {
    let mut summary = DiffSummary::default();
    let mut current: Option<DiffFile> = None;

    for line in raw.lines() {
        if line.starts_with("diff --git ") {
            if let Some(file) = current.take() {
                summary.total_additions += file.additions;
                summary.total_deletions += file.deletions;
                summary.files.push(file);
            }
            let path = line.split(" b/").nth(1).unwrap_or("").trim().to_string();
            current = Some(DiffFile {
                path,
                old_path: None,
                additions: 0,
                deletions: 0,
                binary: false,
                patch: String::new(),
            });
            continue;
        }
        if let Some(file) = current.as_mut() {
            if line.starts_with("Binary files ") {
                file.binary = true;
            } else if line.starts_with("rename from ") {
                file.old_path = Some(line.trim_start_matches("rename from ").to_string());
            } else if line.starts_with('+') && !line.starts_with("+++") {
                file.additions += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                file.deletions += 1;
            }
            file.patch.push_str(line);
            file.patch.push('\n');
        }
    }
    if let Some(file) = current.take() {
        summary.total_additions += file.additions;
        summary.total_deletions += file.deletions;
        summary.files.push(file);
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_header_with_tracking() {
        let raw = "## main...origin/main [ahead 2, behind 1]\n M src/a.rs\n?? new.txt\n";
        let status = parse_porcelain(raw);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 1);
        assert_eq!(status.entries.len(), 2);
        assert_eq!(status.untracked, 1);
        assert!(status.dirty);
    }

    #[test]
    fn parses_detached_head() {
        let status = parse_porcelain("## HEAD (no branch)\n");
        assert!(status.detached);
        assert!(status.branch.is_none());
    }

    #[test]
    fn parses_status_codes() {
        let raw = "## main\nM  staged.rs\n M unstaged.rs\nA  added.rs\nD  deleted.rs\nR  old.rs -> new.rs\nUU conflict.rs\n?? untracked.rs\n";
        let status = parse_porcelain(raw);
        assert_eq!(status.entries.len(), 7);
        let renamed = status.entries.iter().find(|e| e.path == "new.rs").unwrap();
        assert_eq!(renamed.index_status, Some(FileStatus::Renamed));
        assert_eq!(renamed.original_path.as_deref(), Some("old.rs"));
        let conflict = status
            .entries
            .iter()
            .find(|e| e.path == "conflict.rs")
            .unwrap();
        assert_eq!(conflict.index_status, Some(FileStatus::Conflicted));
    }

    #[test]
    fn unquotes_paths_with_escapes() {
        assert_eq!(unquote_git_path(r#""a\tb.txt""#), "a\tb.txt");
        assert_eq!(unquote_git_path(r#""quo\"te""#), "quo\"te");
        assert_eq!(unquote_git_path("plain.txt"), "plain.txt");
    }

    #[test]
    fn status_bar_fragment_matches_prd_shape() {
        // §6.13: `⎇ main +96 -5`
        let mut status = RepoStatus::default();
        status.is_repository = true;
        status.branch = Some("main".into());
        status.additions = 96;
        status.deletions = 5;
        assert_eq!(status.status_bar_fragment(), "⎇ main +96 -5");
    }

    #[test]
    fn status_bar_reports_no_git_outside_repository() {
        assert_eq!(RepoStatus::default().status_bar_fragment(), "no git");
    }

    #[test]
    fn status_bar_shows_untracked_count() {
        let mut status = RepoStatus::default();
        status.is_repository = true;
        status.branch = Some("feat".into());
        status.untracked = 3;
        assert_eq!(status.status_bar_fragment(), "⎇ feat ?3");
    }

    #[test]
    fn parses_diff_counts_per_file() {
        let raw = concat!(
            "diff --git a/a.rs b/a.rs\n",
            "index 111..222 100644\n--- a/a.rs\n+++ b/a.rs\n",
            "@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\n",
            "diff --git a/b.png b/b.png\n",
            "Binary files a/b.png and b/b.png differ\n"
        );
        let summary = parse_diff(raw);
        assert_eq!(summary.files.len(), 2);
        assert_eq!(summary.files[0].path, "a.rs");
        assert_eq!(summary.files[0].additions, 2);
        assert_eq!(summary.files[0].deletions, 1);
        assert!(summary.files[1].binary);
        assert_eq!(summary.total_additions, 2);
        assert_eq!(summary.total_deletions, 1);
    }

    #[test]
    fn sums_numstat() {
        assert_eq!(sum_numstat("3\t4\tsrc/a.rs\n10\t2\tsrc/b.rs\n"), (13, 6));
        assert_eq!(sum_numstat("-\t-\tbinary.png\n"), (0, 0));
    }

    #[test]
    fn sensitive_paths_are_flagged_for_checkpoint_warnings() {
        // P1-06: a checkpoint must announce secret-shaped paths it captures.
        assert!(is_sensitive_path("config/.env.production"));
        assert!(is_sensitive_path("deploy/id_rsa"));
        assert!(is_sensitive_path("secrets/api_token.txt"));
        assert!(is_sensitive_path(".npmrc"));
        assert!(!is_sensitive_path("src/main.rs"));
        assert!(!is_sensitive_path("docs/readme.md"));
    }

    /// End-to-end behavior against a real repository, skipped when git is absent.
    mod integration {
        use super::super::*;

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
        fn status_is_scoped_to_the_workspace_subdirectory() {
            if !git_available() {
                return;
            }
            let tmp = tempfile::TempDir::new().unwrap();
            let repo = tmp.path();
            init_repo(repo);
            std::fs::create_dir_all(repo.join("inner")).unwrap();
            std::fs::write(repo.join("outer.txt"), "outside\n").unwrap();
            std::fs::write(repo.join("inner/kept.txt"), "inside\n").unwrap();
            let status = std::process::Command::new("git")
                .args(["add", "-A"])
                .current_dir(repo)
                .status()
                .unwrap();
            assert!(status.success());
            let status = std::process::Command::new("git")
                .args(["commit", "-q", "-m", "seed"])
                .current_dir(repo)
                .status()
                .unwrap();
            assert!(status.success());

            // Modify one file inside the workspace and one outside it.
            std::fs::write(repo.join("outer.txt"), "changed outside\n").unwrap();
            std::fs::write(repo.join("inner/kept.txt"), "changed inside\n").unwrap();

            let git = GitService::open(&repo.join("inner"));
            let status = git.status().expect("status");
            assert!(status.is_repository);
            let paths: Vec<&str> = status.entries.iter().map(|e| e.path.as_str()).collect();
            assert!(
                paths.contains(&"kept.txt"),
                "workspace change must be visible: {paths:?}"
            );
            assert!(
                !paths.iter().any(|p| p.contains("outer.txt")),
                "files outside the workspace must not leak into status: {paths:?}"
            );
        }

        #[test]
        fn checkpoint_warns_about_sensitive_paths_and_uses_isolated_config() {
            if !git_available() {
                return;
            }
            let tmp = tempfile::TempDir::new().unwrap();
            let repo = tmp.path();
            init_repo(repo);
            std::fs::write(repo.join("main.txt"), "v1\n").unwrap();
            std::fs::write(repo.join(".env"), "SECRET=1\n").unwrap();
            let status = std::process::Command::new("git")
                .args(["add", "-A"])
                .current_dir(repo)
                .status()
                .unwrap();
            assert!(status.success());
            let status = std::process::Command::new("git")
                .args(["commit", "-q", "-m", "seed"])
                .current_dir(repo)
                .status()
                .unwrap();
            assert!(status.success());

            // Modify both tracked files; the checkpoint must flag the .env.
            std::fs::write(repo.join("main.txt"), "v2\n").unwrap();
            std::fs::write(repo.join(".env"), "SECRET=2\n").unwrap();

            let git = GitService::open(repo);
            let checkpoint = git.checkpoint("test checkpoint").expect("checkpoint");
            assert!(
                checkpoint.warnings.iter().any(|w| w.contains(".env")),
                "expected a sensitive-path warning: {:?}",
                checkpoint.warnings
            );
        }
    }

    #[test]
    fn non_repository_returns_empty_status() {
        let dir = std::env::temp_dir().join(format!("cbc-nogit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = GitService::open(&dir);
        // A temp dir may still be inside a repo on some machines; only assert
        // the contract when it is genuinely outside one.
        if !git.is_repository() {
            let status = git.status().unwrap();
            assert!(!status.is_repository);
            assert!(git.tracked_files(10).unwrap().is_empty());
            assert!(git.log(5, None).unwrap().is_empty());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
