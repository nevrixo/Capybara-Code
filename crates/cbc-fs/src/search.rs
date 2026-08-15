//! Directory listing, glob, and content search — PRD §12.2 (fs.list, fs.glob,
//! fs.search) and §18.3 (fast directory walk, ripgrep-compatible search).
//!
//! All results are workspace-relative and bounded: §12.4 makes output limits
//! mandatory, and §11.6 caps what may reach the model.

use std::collections::VecDeque;
use std::path::Path;

use cbc_workspace::{glob_match, Workspace};
use serde::Serialize;

/// Directories skipped by default during walks. §18.4 penalises generated and
/// vendor trees; skipping them at walk time keeps latency inside the §22.2
/// budget on large repositories.
pub const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".mypy_cache",
    ".pytest_cache",
    ".gradle",
    ".idea",
    ".cache",
    "coverage",
    ".turbo",
    ".svelte-kit",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub bytes: u64,
    pub binary: bool,
    /// True when the entry itself is a symlink (not followed).
    pub symlink: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone)]
pub struct WalkOptions {
    pub max_entries: usize,
    pub max_depth: usize,
    pub include_ignored: bool,
    pub extra_ignored: Vec<String>,
}

impl Default for WalkOptions {
    fn default() -> Self {
        Self {
            max_entries: 5_000,
            max_depth: 32,
            include_ignored: false,
            extra_ignored: Vec::new(),
        }
    }
}

impl WalkOptions {
    fn is_ignored(&self, name: &str) -> bool {
        if self.include_ignored {
            return false;
        }
        DEFAULT_IGNORED_DIRS.contains(&name) || self.extra_ignored.iter().any(|d| d == name)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
    pub total_scanned: usize,
}

/// Non-recursive listing of one directory.
pub fn list_dir(ws: &Workspace, dir: &Path, options: &WalkOptions) -> std::io::Result<ListResult> {
    let mut entries = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;

    let read = std::fs::read_dir(dir)?;
    let mut collected: Vec<_> = read.flatten().collect();
    collected.sort_by_key(|e| e.file_name());

    for entry in collected {
        scanned += 1;
        let name = entry.file_name().to_string_lossy().to_string();
        if options.is_ignored(&name) {
            continue;
        }
        if entries.len() >= options.max_entries {
            truncated = true;
            break;
        }
        entries.push(describe(ws, &entry.path(), &name));
    }

    Ok(ListResult {
        entries,
        truncated,
        total_scanned: scanned,
    })
}

/// Result of a bounded recursive walk. `truncated` is explicit so callers can
/// distinguish "no matches" from "the walk stopped at its safety budget".
#[derive(Debug, Clone)]
pub struct WalkResult {
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
}

/// Breadth-first recursive walk with an explicit truncation signal.
pub fn walk_files_bounded(ws: &Workspace, root: &Path, options: &WalkOptions) -> WalkResult {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut queue: VecDeque<(std::path::PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));

    'directories: while let Some((dir, depth)) = queue.pop_front() {
        if depth > options.max_depth {
            truncated = true;
            continue;
        }
        if out.len() >= options.max_entries {
            truncated = true;
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            // A directory can disappear or become unreadable during a walk. It
            // is safer to report that the result is incomplete than to claim a
            // complete inventory from a partial read.
            truncated = true;
            continue;
        };
        let mut children: Vec<_> = read.flatten().collect();
        children.sort_by_key(|e| e.file_name());
        for entry in children {
            let name = entry.file_name().to_string_lossy().to_string();
            if options.is_ignored(&name) {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                truncated = true;
                continue;
            };
            if meta.file_type().is_symlink() {
                // Symlinks are reported but never traversed during a walk; the
                // path guard decides whether following one is legal.
                if out.len() >= options.max_entries {
                    truncated = true;
                    break 'directories;
                }
                out.push(describe(ws, &path, &name));
                continue;
            }
            if meta.is_dir() {
                if depth >= options.max_depth {
                    truncated = true;
                } else {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            if out.len() >= options.max_entries {
                truncated = true;
                break 'directories;
            }
            out.push(describe(ws, &path, &name));
        }
    }

    if !queue.is_empty() {
        truncated = true;
    }
    WalkResult {
        entries: out,
        truncated,
    }
}

/// Backwards-compatible walk helper for callers that only need entries.
pub fn walk_files(ws: &Workspace, root: &Path, options: &WalkOptions) -> Vec<DirEntryInfo> {
    walk_files_bounded(ws, root, options).entries
}
fn describe(ws: &Workspace, path: &Path, name: &str) -> DirEntryInfo {
    let meta = std::fs::symlink_metadata(path);
    let (kind, bytes, symlink) = match &meta {
        Ok(m) if m.file_type().is_symlink() => (EntryKind::Symlink, 0, true),
        Ok(m) if m.is_dir() => (EntryKind::Dir, 0, false),
        Ok(m) if m.is_file() => (EntryKind::File, m.len(), false),
        Ok(_) => (EntryKind::Other, 0, false),
        Err(_) => (EntryKind::Other, 0, false),
    };
    DirEntryInfo {
        path: ws.relativize(path),
        name: name.to_string(),
        kind,
        bytes,
        binary: kind == EntryKind::File && crate::atomic::is_probably_binary(path),
        symlink,
    }
}

/// Result of a bounded glob search. The walk flag is kept separate from the
/// match limit so callers never report a partial inventory as complete.
#[derive(Debug, Clone)]
pub struct GlobResult {
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
}

pub fn glob_search_bounded(ws: &Workspace, pattern: &str, options: &WalkOptions) -> GlobResult {
    let walked = walk_files_bounded(ws, ws.root(), options);
    let entries = walked
        .entries
        .into_iter()
        .filter(|e| glob_match(pattern, &e.path))
        .collect();
    GlobResult {
        entries,
        truncated: walked.truncated,
    }
}

/// Glob search across the workspace, preserving the historical entries-only API.
pub fn glob_search(ws: &Workspace, pattern: &str, options: &WalkOptions) -> Vec<DirEntryInfo> {
    glob_search_bounded(ws, pattern, options).entries
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    pub files_searched: usize,
    pub files_with_matches: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub max_matches: usize,
    pub max_matches_per_file: usize,
    pub case_sensitive: bool,
    /// Restrict to paths matching this glob.
    pub include_glob: Option<String>,
    pub max_file_bytes: u64,
    pub max_line_bytes: usize,
    pub walk: WalkOptions,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            max_matches: 200,
            max_matches_per_file: 20,
            case_sensitive: false,
            include_glob: None,
            max_file_bytes: 2 * 1024 * 1024,
            max_line_bytes: 1000,
            walk: WalkOptions::default(),
        }
    }
}

fn is_sensitive_search_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let components: Vec<&str> = lower.split('/').collect();
    let file = components.last().copied().unwrap_or("");
    file == ".npmrc"
        || file == ".netrc"
        || file == ".pypirc"
        || file == "id_rsa"
        || file == "id_ed25519"
        || file == "credentials"
        || file == "secrets"
        || file == ".env"
        || file.starts_with(".env.")
        || file.ends_with(".pem")
        || file.ends_with(".key")
        || components
            .iter()
            .any(|part| matches!(*part, ".ssh" | ".aws" | ".gnupg" | ".kube"))
}

/// Literal substring search across text files. Regex is deliberately excluded
/// from the runtime: §12.2 exposes `fs.search` for literal/regex search, and the
/// regex flavour is compiled and bounded in the TypeScript layer before being
/// lowered to literal candidates, so the trusted plane never runs an unbounded
/// backtracking engine on model-supplied input.
pub fn search_literal(ws: &Workspace, needle: &str, options: &SearchOptions) -> SearchResult {
    let mut result = SearchResult {
        matches: Vec::new(),
        files_searched: 0,
        files_with_matches: 0,
        truncated: false,
    };
    if needle.is_empty() {
        return result;
    }

    let needle_cmp = if options.case_sensitive {
        needle.to_string()
    } else {
        needle.to_lowercase()
    };

    let walked = walk_files_bounded(ws, ws.root(), &options.walk);
    result.truncated = walked.truncated;
    for entry in walked.entries {
        if entry.kind != EntryKind::File || entry.binary {
            continue;
        }
        if is_sensitive_search_path(&entry.path) {
            continue;
        }
        if entry.bytes > options.max_file_bytes {
            continue;
        }
        if let Some(glob) = &options.include_glob {
            if !glob_match(glob, &entry.path) {
                continue;
            }
        }
        let abs = ws.root().join(&entry.path);
        let Ok(content) = std::fs::read_to_string(&abs) else {
            // A file can disappear or become unreadable after the walk.
            // Keep the result explicitly incomplete instead of silently
            // presenting a partial search as authoritative.
            result.truncated = true;
            continue;
        };
        result.files_searched += 1;
        let mut file_matches = 0usize;

        for (idx, line) in content.lines().enumerate() {
            let haystack = if options.case_sensitive {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            if let Some(col) = haystack.find(&needle_cmp) {
                if file_matches == 0 {
                    result.files_with_matches += 1;
                }
                file_matches += 1;
                let text = if line.len() > options.max_line_bytes {
                    let mut end = options.max_line_bytes;
                    while end > 0 && !line.is_char_boundary(end) {
                        end -= 1;
                    }
                    format!("{}…", &line[..end])
                } else {
                    line.to_string()
                };
                result.matches.push(SearchMatch {
                    path: entry.path.clone(),
                    line: idx + 1,
                    column: col + 1,
                    text,
                });
                if result.matches.len() >= options.max_matches {
                    result.truncated = true;
                    return result;
                }
                if file_matches >= options.max_matches_per_file {
                    break;
                }
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, Workspace) {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src/deep")).unwrap();
        fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(dir.path().join("tests")).unwrap();
        fs::write(
            dir.path().join("src/main.rs"),
            "fn parseConfig() {}\n// TODO\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("src/deep/util.rs"),
            "fn helper() { parseConfig(); }\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("tests/it.rs"),
            "assert!(parseconfig_works());\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("node_modules/pkg/index.js"),
            "parseConfig\n",
        )
        .unwrap();
        fs::write(dir.path().join("README.md"), "# Project\n").unwrap();
        fs::write(dir.path().join("blob.bin"), [0u8, 1, 2, 3]).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        (dir, ws)
    }

    #[test]
    fn lists_directory_non_recursively() {
        let (_d, ws) = fixture();
        let result = list_dir(&ws, ws.root(), &WalkOptions::default()).unwrap();
        let names: Vec<_> = result.entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"README.md".to_string()));
        assert!(names.contains(&"src".to_string()));
        // Ignored directories are excluded.
        assert!(!names.contains(&"node_modules".to_string()));
    }

    #[test]
    fn identifies_binary_entries() {
        let (_d, ws) = fixture();
        let result = list_dir(&ws, ws.root(), &WalkOptions::default()).unwrap();
        let blob = result
            .entries
            .iter()
            .find(|e| e.name == "blob.bin")
            .unwrap();
        assert!(blob.binary);
        let readme = result
            .entries
            .iter()
            .find(|e| e.name == "README.md")
            .unwrap();
        assert!(!readme.binary);
    }

    #[test]
    fn walks_recursively_skipping_ignored_dirs() {
        let (_d, ws) = fixture();
        let files = walk_files(&ws, ws.root(), &WalkOptions::default());
        let paths: Vec<_> = files.iter().map(|e| e.path.clone()).collect();
        assert!(paths.contains(&"src/deep/util.rs".to_string()));
        assert!(!paths.iter().any(|p| p.starts_with("node_modules")));
    }

    #[test]
    fn walk_honours_max_entries() {
        let (_d, ws) = fixture();
        let opts = WalkOptions {
            max_entries: 2,
            ..WalkOptions::default()
        };
        let files = walk_files(&ws, ws.root(), &opts);
        assert!(files.len() <= 2);
    }

    #[test]
    fn search_reports_walk_truncation() {
        let (_d, ws) = fixture();
        let result = search_literal(
            &ws,
            "parseConfig",
            &SearchOptions {
                walk: WalkOptions {
                    max_entries: 1,
                    ..WalkOptions::default()
                },
                ..SearchOptions::default()
            },
        );
        assert!(result.truncated);
    }

    #[test]
    fn glob_finds_matching_files() {
        let (_d, ws) = fixture();
        let hits = glob_search(&ws, "src/**", &WalkOptions::default());
        let paths: Vec<_> = hits.iter().map(|e| e.path.clone()).collect();
        assert!(paths.contains(&"src/main.rs".to_string()));
        assert!(paths.contains(&"src/deep/util.rs".to_string()));
        assert!(!paths.contains(&"README.md".to_string()));
    }

    #[test]
    fn searches_case_insensitively_by_default() {
        let (_d, ws) = fixture();
        let result = search_literal(&ws, "parseConfig", &SearchOptions::default());
        // src/main.rs, src/deep/util.rs, tests/it.rs (parseconfig_works)
        assert_eq!(result.files_with_matches, 3, "{:?}", result.matches);
        assert!(result
            .matches
            .iter()
            .all(|m| !m.path.starts_with("node_modules")));
    }

    #[test]
    fn case_sensitive_search_narrows_results() {
        let (_d, ws) = fixture();
        let result = search_literal(
            &ws,
            "parseConfig",
            &SearchOptions {
                case_sensitive: true,
                ..SearchOptions::default()
            },
        );
        assert_eq!(result.files_with_matches, 2);
    }

    #[test]
    fn search_reports_line_and_column() {
        let (_d, ws) = fixture();
        let result = search_literal(&ws, "TODO", &SearchOptions::default());
        let m = result.matches.first().expect("one match");
        assert_eq!(m.path, "src/main.rs");
        assert_eq!(m.line, 2);
        assert_eq!(m.column, 4);
    }

    #[test]
    fn search_respects_include_glob() {
        let (_d, ws) = fixture();
        let result = search_literal(
            &ws,
            "parseConfig",
            &SearchOptions {
                include_glob: Some("tests/**".into()),
                ..SearchOptions::default()
            },
        );
        assert_eq!(result.files_with_matches, 1);
        assert_eq!(result.matches[0].path, "tests/it.rs");
    }

    #[test]
    fn search_truncates_at_max_matches() {
        let dir = TempDir::new().unwrap();
        let mut content = String::new();
        for _ in 0..500 {
            content.push_str("needle here\n");
        }
        fs::write(dir.path().join("many.txt"), &content).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        let result = search_literal(
            &ws,
            "needle",
            &SearchOptions {
                max_matches: 10,
                max_matches_per_file: 1000,
                ..SearchOptions::default()
            },
        );
        assert!(result.truncated);
        assert_eq!(result.matches.len(), 10);
    }

    #[test]
    fn search_caps_matches_per_file() {
        let dir = TempDir::new().unwrap();
        let content = "needle\n".repeat(100);
        fs::write(dir.path().join("a.txt"), &content).unwrap();
        fs::write(dir.path().join("b.txt"), &content).unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        let result = search_literal(
            &ws,
            "needle",
            &SearchOptions {
                max_matches: 1000,
                max_matches_per_file: 3,
                ..SearchOptions::default()
            },
        );
        assert_eq!(result.matches.len(), 6);
        assert_eq!(result.files_with_matches, 2);
    }

    #[test]
    fn search_truncates_long_lines() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join("long.txt"),
            format!("needle{}", "x".repeat(5000)),
        )
        .unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        let result = search_literal(
            &ws,
            "needle",
            &SearchOptions {
                max_line_bytes: 40,
                ..SearchOptions::default()
            },
        );
        let m = &result.matches[0];
        assert!(m.text.len() < 60, "line not truncated: {}", m.text.len());
        assert!(m.text.ends_with('…'));
    }

    #[test]
    fn search_skips_binary_files() {
        let (_d, ws) = fixture();
        // Write a needle inside a binary file; it must be skipped.
        let mut bytes = b"needle".to_vec();
        bytes.push(0);
        fs::write(ws.root().join("bin2.bin"), bytes).unwrap();
        let result = search_literal(&ws, "needle", &SearchOptions::default());
        assert_eq!(result.matches.len(), 0);
    }

    #[test]
    fn empty_needle_returns_nothing() {
        let (_d, ws) = fixture();
        let result = search_literal(&ws, "", &SearchOptions::default());
        assert!(result.matches.is_empty());
    }

    #[test]
    fn search_handles_cjk_content() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("ko.txt"), "안녕하세요 세계\n테스트\n").unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        let result = search_literal(&ws, "세계", &SearchOptions::default());
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].line, 1);
    }

    #[test]
    fn search_never_reads_sensitive_files() {
        let (dir, ws) = fixture();
        fs::write(dir.path().join(".env"), "AUDIT_NEEDLE=secret\n").unwrap();
        fs::create_dir_all(dir.path().join(".ssh")).unwrap();
        fs::write(dir.path().join(".ssh").join("id_rsa"), "AUDIT_NEEDLE\n").unwrap();
        fs::write(dir.path().join("safe.txt"), "AUDIT_NEEDLE\n").unwrap();

        let result = search_literal(&ws, "AUDIT_NEEDLE", &SearchOptions::default());
        assert_eq!(result.files_with_matches, 1);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].path, "safe.txt");
    }
}
