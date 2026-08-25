//! Structured patch parsing — PRD §12.5.
//!
//! `fs.apply_patch` never hands unified diff text to a shell. The parser
//! validates every operation, then the runtime applies it. Parsing is separate
//! from application so a malformed patch is rejected before any file is opened.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchParseError {
    MissingFileHeader,
    MalformedHunkHeader {
        line: usize,
        text: String,
    },
    HunkOutsideFile {
        line: usize,
    },
    UnexpectedLinePrefix {
        line: usize,
        text: String,
    },
    EmptyPatch,
    HunkLineCountMismatch {
        line: usize,
        expected: usize,
        actual: usize,
    },
    PathTraversal {
        path: String,
    },
}

impl std::fmt::Display for PatchParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PatchParseError::MissingFileHeader => {
                write!(
                    f,
                    "patch has no file header (expected '--- a/path' / '+++ b/path')"
                )
            }
            PatchParseError::MalformedHunkHeader { line, text } => {
                write!(f, "line {line}: malformed hunk header: {text:?} (use '@@ -<start>,<lines> +<start>,<lines> @@', e.g. '@@ -0,0 +1,3 @@', or bare '@@' with exact old-side context)")
            }
            PatchParseError::HunkOutsideFile { line } => {
                write!(f, "line {line}: hunk appears before any file header")
            }
            PatchParseError::UnexpectedLinePrefix { line, text } => {
                write!(f, "line {line}: unexpected line prefix: {text:?}")
            }
            PatchParseError::EmptyPatch => write!(f, "patch contains no operations"),
            PatchParseError::HunkLineCountMismatch {
                line,
                expected,
                actual,
            } => write!(
                f,
                "line {line}: hunk declares {expected} lines but contains {actual}"
            ),
            PatchParseError::PathTraversal { path } => {
                write!(f, "patch path {path:?} attempts traversal")
            }
        }
    }
}

impl std::error::Error for PatchParseError {}

/// One change region within a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// 1-based start line in the original file.
    pub old_start: usize,
    pub old_lines: usize,
    /// 1-based start line in the new file.
    pub new_start: usize,
    pub new_lines: usize,
    /// Resolve the old-side lines against the current file instead of trusting
    /// a model-authored line number. This is used for a bare `@@` header and is
    /// accepted only when the complete old-side context has one exact match.
    #[serde(default, skip_serializing_if = "is_false")]
    pub locate_by_context: bool,
    /// Context and change lines, in order, each tagged with its operation.
    pub lines: Vec<HunkLine>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum HunkLine {
    Context { text: String },
    Removed { text: String },
    Added { text: String },
}

impl HunkLine {
    pub fn text(&self) -> &str {
        match self {
            HunkLine::Context { text } | HunkLine::Removed { text } | HunkLine::Added { text } => {
                text
            }
        }
    }

    pub fn in_old(&self) -> bool {
        matches!(self, HunkLine::Context { .. } | HunkLine::Removed { .. })
    }

    pub fn in_new(&self) -> bool {
        matches!(self, HunkLine::Context { .. } | HunkLine::Added { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileOperationKind {
    Modify,
    Create,
    Delete,
    Rename,
}

/// A single-file operation inside a patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePatch {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    pub kind: FileOperationKind,
    pub hunks: Vec<Hunk>,
    /// Expected SHA-256 of the current content, when the caller supplied one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,
}

/// A parsed multi-file patch. §12.5: partial application is forbidden — either
/// the whole transaction commits or it rolls back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub files: Vec<FilePatch>,
}

impl Patch {
    pub fn paths(&self) -> Vec<&str> {
        self.files.iter().map(|f| f.path.as_str()).collect()
    }
}

/// Parse a unified diff into structured operations.
pub fn parse_unified_diff(input: &str) -> Result<Patch, PatchParseError> {
    let mut files: Vec<FilePatch> = Vec::new();
    let mut current: Option<FilePatch> = None;
    let mut pending_old_path: Option<String> = None;
    // Model output frequently crosses a Windows/Unix boundary. Keeping the
    // carriage return in a hunk line makes otherwise valid context fail to
    // match the LF-normalized workspace content, and used to turn every CRLF
    // patch into a misleading PATH_CHANGED error. Normalize line endings at
    // the parser boundary; a unified diff's line ending is framing, not file
    // content.
    let normalized = input.replace("\r\n", "\n").replace(char::from(13), "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut i = 0usize;

    while i < lines.len() {
        let raw = lines[i];
        let lineno = i + 1;

        if raw.starts_with("diff --git ") {
            if let Some(file) = current.take() {
                files.push(file);
            }
            pending_old_path = None;
            i += 1;
            continue;
        }

        // Ignore index / mode metadata lines.
        if raw.starts_with("index ")
            || raw.starts_with("old mode ")
            || raw.starts_with("new mode ")
            || raw.starts_with("similarity index ")
        {
            i += 1;
            continue;
        }

        if let Some(rest) = raw.strip_prefix("--- ") {
            if let Some(file) = current.take() {
                files.push(file);
            }
            pending_old_path = Some(strip_diff_prefix(rest.trim()));
            i += 1;
            continue;
        }

        if let Some(rest) = raw.strip_prefix("+++ ") {
            let new_path = strip_diff_prefix(rest.trim());
            let old_path = pending_old_path.take();
            let (path, kind, new_path_field) = match (old_path.as_deref(), new_path.as_str()) {
                (Some("/dev/null"), np) => (np.to_string(), FileOperationKind::Create, None),
                (Some(op), "/dev/null") => (op.to_string(), FileOperationKind::Delete, None),
                (Some(op), np) if op != np => (
                    op.to_string(),
                    FileOperationKind::Rename,
                    Some(np.to_string()),
                ),
                (Some(op), _) => (op.to_string(), FileOperationKind::Modify, None),
                (None, np) => (np.to_string(), FileOperationKind::Create, None),
            };
            reject_traversal(&path)?;
            if let Some(np) = &new_path_field {
                reject_traversal(np)?;
            }
            current = Some(FilePatch {
                path,
                new_path: new_path_field,
                kind,
                hunks: Vec::new(),
                expected_hash: None,
            });
            i += 1;
            continue;
        }

        if raw.starts_with("@@") {
            let header = parse_hunk_header(raw, lineno)?;
            let file = current
                .as_mut()
                .ok_or(PatchParseError::HunkOutsideFile { line: lineno })?;
            let mut hunk_lines = Vec::new();
            let mut old_count = 0usize;
            let mut new_count = 0usize;
            i += 1;

            while i < lines.len() {
                let body = lines[i];
                // Blank final line of the input terminates the hunk.
                if body.is_empty() && i == lines.len() - 1 {
                    break;
                }
                if body.starts_with("@@")
                    || body.starts_with("--- ")
                    || body.starts_with("+++ ")
                    || body.starts_with("diff --git ")
                    || body == "*** End Patch"
                {
                    break;
                }
                if body == "\\ No newline at end of file" {
                    i += 1;
                    continue;
                }
                let (prefix, text) = match body.chars().next() {
                    Some(c) => (c, body[c.len_utf8()..].to_string()),
                    // A completely empty line inside a hunk is a context line
                    // whose single space was stripped by an editor.
                    None => (' ', String::new()),
                };
                match prefix {
                    ' ' => {
                        hunk_lines.push(HunkLine::Context { text });
                        old_count += 1;
                        new_count += 1;
                    }
                    '-' => {
                        hunk_lines.push(HunkLine::Removed { text });
                        old_count += 1;
                    }
                    '+' => {
                        hunk_lines.push(HunkLine::Added { text });
                        new_count += 1;
                    }
                    _ => {
                        return Err(PatchParseError::UnexpectedLinePrefix {
                            line: i + 1,
                            text: body.to_string(),
                        })
                    }
                }
                i += 1;
            }

            file.hunks.push(Hunk {
                old_start: header.old_start,
                old_lines: old_count,
                new_start: header.new_start,
                new_lines: new_count,
                locate_by_context: header.locate_by_context,
                lines: hunk_lines,
            });
            continue;
        }

        // Anything else outside a hunk is preamble noise; skip it.
        i += 1;
    }

    if let Some(file) = current.take() {
        files.push(file);
    }
    if files.is_empty() {
        return Err(PatchParseError::MissingFileHeader);
    }
    if files
        .iter()
        .all(|f| f.hunks.is_empty() && f.kind == FileOperationKind::Modify)
    {
        return Err(PatchParseError::EmptyPatch);
    }
    Ok(Patch { files })
}

fn reject_traversal(path: &str) -> Result<(), PatchParseError> {
    if path == "/dev/null" {
        return Ok(());
    }
    if path.split('/').any(|c| c == "..") || path.starts_with('/') || path.contains('\0') {
        return Err(PatchParseError::PathTraversal {
            path: path.to_string(),
        });
    }
    Ok(())
}

fn strip_diff_prefix(path: &str) -> String {
    // Strip a trailing timestamp column if present.
    let path = path.split('\t').next().unwrap_or(path).trim();
    if path == "/dev/null" {
        return path.to_string();
    }
    for prefix in ["a/", "b/", "./"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    path.to_string()
}

struct HunkHeader {
    old_start: usize,
    new_start: usize,
    locate_by_context: bool,
}

fn parse_hunk_header(raw: &str, lineno: usize) -> Result<HunkHeader, PatchParseError> {
    let malformed = || PatchParseError::MalformedHunkHeader {
        line: lineno,
        text: raw.to_string(),
    };
    if raw.trim() == "@@" {
        return Ok(HunkHeader {
            old_start: 0,
            new_start: 0,
            locate_by_context: true,
        });
    }
    let body = raw.strip_prefix("@@").ok_or_else(malformed)?;
    let end = body.find("@@").ok_or_else(malformed)?;
    let ranges = body[..end].trim();
    let mut parts = ranges.split(' ').filter(|p| !p.is_empty());
    let old = parts.next().ok_or_else(malformed)?;
    let new = parts.next().ok_or_else(malformed)?;
    let old = old.strip_prefix('-').ok_or_else(malformed)?;
    let new = new.strip_prefix('+').ok_or_else(malformed)?;
    let (old_start, _) = parse_range(old).ok_or_else(malformed)?;
    let (new_start, _) = parse_range(new).ok_or_else(malformed)?;
    Ok(HunkHeader {
        old_start,
        new_start,
        locate_by_context: false,
    })
}

fn parse_range(raw: &str) -> Option<(usize, usize)> {
    match raw.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((raw.parse().ok()?, 1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_hunk_modification() {
        let diff = "--- a/src/main.rs\n+++ b/src/main.rs\n@@ -1,3 +1,4 @@\n fn main() {\n-    old();\n+    new();\n+    extra();\n }\n";
        let patch = parse_unified_diff(diff).expect("parse");
        assert_eq!(patch.files.len(), 1);
        let file = &patch.files[0];
        assert_eq!(file.path, "src/main.rs");
        assert_eq!(file.kind, FileOperationKind::Modify);
        assert_eq!(file.hunks.len(), 1);
        let hunk = &file.hunks[0];
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.old_lines, 3);
        assert_eq!(hunk.new_start, 1);
        assert_eq!(hunk.new_lines, 4);
        assert_eq!(hunk.lines.len(), 5);
    }

    #[test]
    fn parses_multi_file_patch() {
        let diff = concat!(
            "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n",
            "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-two\n+TWO\n"
        );
        let patch = parse_unified_diff(diff).expect("parse");
        assert_eq!(patch.files.len(), 2);
        assert_eq!(patch.paths(), vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn detects_create_via_dev_null() {
        let diff =
            "--- /dev/null\n+++ b/scripts/demo.py\n@@ -0,0 +1,2 @@\n+print('hi')\n+print('bye')\n";
        let patch = parse_unified_diff(diff).expect("parse");
        assert_eq!(patch.files[0].kind, FileOperationKind::Create);
        assert_eq!(patch.files[0].path, "scripts/demo.py");
    }

    #[test]
    fn detects_delete_via_dev_null() {
        let diff = "--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
        let patch = parse_unified_diff(diff).expect("parse");
        assert_eq!(patch.files[0].kind, FileOperationKind::Delete);
        assert_eq!(patch.files[0].path, "old.txt");
    }

    #[test]
    fn detects_rename() {
        let diff = "--- a/old/name.txt\n+++ b/new/name.txt\n@@ -1 +1 @@\n-x\n+y\n";
        let patch = parse_unified_diff(diff).expect("parse");
        assert_eq!(patch.files[0].kind, FileOperationKind::Rename);
        assert_eq!(patch.files[0].path, "old/name.txt");
        assert_eq!(patch.files[0].new_path.as_deref(), Some("new/name.txt"));
    }

    #[test]
    fn rejects_path_traversal_in_patch_header() {
        let diff = "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n";
        let err = parse_unified_diff(diff).unwrap_err();
        assert!(matches!(err, PatchParseError::PathTraversal { .. }));
    }

    #[test]
    fn rejects_absolute_path_in_patch_header() {
        let diff = "--- /etc/hosts\n+++ /etc/hosts\n@@ -1 +1 @@\n-a\n+b\n";
        let err = parse_unified_diff(diff).unwrap_err();
        assert!(matches!(err, PatchParseError::PathTraversal { .. }));
    }

    #[test]
    fn rejects_malformed_hunk_header() {
        let diff = "--- a/a.txt\n+++ b/a.txt\n@@ garbage @@\n-a\n+b\n";
        let err = parse_unified_diff(diff).unwrap_err();
        assert!(matches!(err, PatchParseError::MalformedHunkHeader { .. }));
    }

    #[test]
    fn derives_hunk_counts_from_the_body() {
        // Counts are redundant metadata and are easy for a model to miscount.
        // The transaction still verifies every old-side line against the file.
        let diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,1 @@\n-a\n+b\n";
        let patch = parse_unified_diff(diff).expect("parse");
        let hunk = &patch.files[0].hunks[0];
        assert_eq!(hunk.old_lines, 1);
        assert_eq!(hunk.new_lines, 1);
    }

    #[test]
    fn accepts_bare_hunk_header_for_context_location() {
        let diff = "--- a/a.txt\n+++ b/a.txt\n@@\n before\n-old\n+new\n after\n";
        let patch = parse_unified_diff(diff).expect("parse");
        let hunk = &patch.files[0].hunks[0];
        assert!(hunk.locate_by_context);
        assert_eq!(hunk.old_start, 0);
        assert_eq!(hunk.old_lines, 3);
        assert_eq!(hunk.new_lines, 3);
    }

    #[test]
    fn accepts_apply_patch_end_marker() {
        let diff = concat!(
            "*** Begin Patch\n",
            "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
            "*** End Patch\n",
        );
        let patch = parse_unified_diff(diff).expect("parse");
        assert_eq!(patch.files[0].hunks[0].lines.len(), 2);
    }

    #[test]
    fn rejects_hunk_without_file_header() {
        let diff = "@@ -1 +1 @@\n-a\n+b\n";
        let err = parse_unified_diff(diff).unwrap_err();
        assert!(
            matches!(err, PatchParseError::HunkOutsideFile { line: 1 }),
            "{err:?}"
        );
    }

    #[test]
    fn rejects_input_with_no_headers_at_all() {
        let err = parse_unified_diff("just some text\nnot a diff\n").unwrap_err();
        assert!(matches!(err, PatchParseError::MissingFileHeader), "{err:?}");
    }

    #[test]
    fn rejects_unknown_line_prefix() {
        let diff = "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n?bogus\n";
        let err = parse_unified_diff(diff).unwrap_err();
        assert!(matches!(err, PatchParseError::UnexpectedLinePrefix { .. }));
    }

    #[test]
    fn handles_git_style_headers_and_index_lines() {
        let diff = concat!(
            "diff --git a/x.txt b/x.txt\n",
            "index 8f1c7c2..a12b880 100644\n",
            "--- a/x.txt\n+++ b/x.txt\n",
            "@@ -1 +1 @@\n-old\n+new\n"
        );
        let patch = parse_unified_diff(diff).expect("parse");
        assert_eq!(patch.files.len(), 1);
        assert_eq!(patch.files[0].path, "x.txt");
    }

    #[test]
    fn handles_no_newline_marker() {
        let diff =
            "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n";
        let patch = parse_unified_diff(diff).expect("parse");
        assert_eq!(patch.files[0].hunks[0].lines.len(), 2);
    }

    #[test]
    fn single_line_range_defaults_to_count_one() {
        let diff = "--- a/x.txt\n+++ b/x.txt\n@@ -5 +5 @@\n-old\n+new\n";
        let patch = parse_unified_diff(diff).expect("parse");
        let hunk = &patch.files[0].hunks[0];
        assert_eq!(hunk.old_start, 5);
        assert_eq!(hunk.old_lines, 1);
        assert_eq!(hunk.new_lines, 1);
    }

    #[test]
    fn preserves_cjk_and_unicode_in_hunks() {
        let diff = "--- a/ko.txt\n+++ b/ko.txt\n@@ -1 +1 @@\n-안녕\n+안녕하세요 🐹\n";
        let patch = parse_unified_diff(diff).expect("parse");
        let lines = &patch.files[0].hunks[0].lines;
        assert_eq!(lines[0].text(), "안녕");
        assert_eq!(lines[1].text(), "안녕하세요 🐹");
    }

    #[test]
    fn fuzz_parser_never_panics() {
        let pieces = [
            "--- a/x\n",
            "+++ b/y\n",
            "@@ -1,1 +1,1 @@\n",
            "-a\n",
            "+b\n",
            " c\n",
            "@@\n",
            "diff --git\n",
            "\\ No newline at end of file\n",
            "??\n",
            "\n",
            "--- /dev/null\n",
        ];
        let mut state: u64 = 424242;
        for _ in 0..3000 {
            let mut input = String::new();
            for _ in 0..12 {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                input.push_str(pieces[(state >> 33) as usize % pieces.len()]);
            }
            let _ = parse_unified_diff(&input);
        }
    }
}
