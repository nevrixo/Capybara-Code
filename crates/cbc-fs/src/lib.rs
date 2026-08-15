//! `cbc-fs` — atomic filesystem operations, optimistic concurrency, listing,
//! glob, and content search for the trusted execution plane.
//!
//! PRD references: §12.2, §12.4–§12.6, §14.3, §18.3–§18.5, AC-13, AC-14, RT-003.

pub mod atomic;
pub mod beneath;
pub mod search;

pub use atomic::{
    atomic_write, delete_path, fsync_dir, hash_bytes, hash_file, hashes_match, is_probably_binary,
    move_path, read_text, short_hash, FsError, NewlineStyle, WriteIntent, WriteOutcome,
    DEFAULT_MAX_FILE_BYTES,
};
pub use beneath::{
    atomic_write_beneath, delete_path_beneath, file_len_beneath, hash_file_beneath,
    is_probably_binary_beneath, move_path_beneath, path_exists_beneath, preview_text_range_beneath,
    read_text_beneath, read_text_range_beneath, revision_token_beneath, TextRangeRead,
};
pub use search::{
    glob_search, glob_search_bounded, list_dir, search_literal, walk_files, walk_files_bounded,
    DirEntryInfo, EntryKind, GlobResult, ListResult, SearchMatch, SearchOptions, SearchResult,
    WalkOptions, WalkResult, DEFAULT_IGNORED_DIRS,
};

use serde::Serialize;

/// Default number of source lines returned by a filesystem read.
///
/// Keep this value aligned with `packages/protocol-ts/src/rpc.ts` and the
/// protocol schema. The context engine's promotion default is the same value,
/// so a normal read and an exact promotion do not disagree about their budget.
pub const DEFAULT_READ_MAX_LINES: usize = 400;

/// A bounded file excerpt for model context — PRD §18.5.
///
/// Requirements from §18.5: include line numbers, source path and checksum,
/// mark omitted ranges when not the full file, refresh on stale checksum, and
/// de-duplicate identical excerpts.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileExcerpt {
    pub path: String,
    pub checksum: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub text: String,
    /// True when lines were omitted before or after this range.
    pub partial: bool,
    pub omitted_before: usize,
    pub omitted_after: usize,
}

impl FileExcerpt {
    /// Render with line numbers, the form the model sees.
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "--- {} (sha256:{}, lines {}-{} of {}) ---\n",
            self.path,
            &self.checksum[..self.checksum.len().min(12)],
            self.start_line,
            self.end_line,
            self.total_lines
        ));
        if self.omitted_before > 0 {
            out.push_str(&format!(
                "… {} earlier lines omitted\n",
                self.omitted_before
            ));
        }
        for (offset, line) in self.text.lines().enumerate() {
            out.push_str(&format!("{:>6} | {}\n", self.start_line + offset, line));
        }
        if self.omitted_after > 0 {
            out.push_str(&format!("… {} later lines omitted\n", self.omitted_after));
        }
        out
    }

    /// Stable identity for de-duplication (§18.5).
    pub fn dedupe_key(&self) -> String {
        format!(
            "{}:{}:{}-{}",
            self.path, self.checksum, self.start_line, self.end_line
        )
    }
}

/// Build an excerpt from full file content.
pub fn make_excerpt(
    path: &str,
    content: &str,
    checksum: &str,
    start_line: usize,
    max_lines: usize,
) -> FileExcerpt {
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let start = start_line.max(1);
    let start_idx = (start - 1).min(total);
    let end_idx = (start_idx + max_lines).min(total);
    let slice = &lines[start_idx..end_idx];
    let omitted_before = start_idx;
    let omitted_after = total.saturating_sub(end_idx);

    FileExcerpt {
        path: path.to_string(),
        checksum: checksum.to_string(),
        start_line: start_idx + 1,
        end_line: end_idx.max(start_idx + 1),
        total_lines: total,
        text: slice.join("\n"),
        partial: omitted_before > 0 || omitted_after > 0,
        omitted_before,
        omitted_after,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "line1\nline2\nline3\nline4\nline5\nline6\n";

    #[test]
    fn full_file_excerpt_is_not_partial() {
        let excerpt = make_excerpt("a.txt", SAMPLE, "abc123def456789", 1, 100);
        assert!(!excerpt.partial);
        assert_eq!(excerpt.start_line, 1);
        assert_eq!(excerpt.end_line, 6);
        assert_eq!(excerpt.total_lines, 6);
        assert_eq!(excerpt.omitted_before, 0);
        assert_eq!(excerpt.omitted_after, 0);
    }

    #[test]
    fn partial_excerpt_marks_omitted_ranges() {
        let excerpt = make_excerpt("a.txt", SAMPLE, "abc123def456789", 3, 2);
        assert!(excerpt.partial);
        assert_eq!(excerpt.start_line, 3);
        assert_eq!(excerpt.end_line, 4);
        assert_eq!(excerpt.omitted_before, 2);
        assert_eq!(excerpt.omitted_after, 2);
        assert_eq!(excerpt.text, "line3\nline4");
    }

    #[test]
    fn render_includes_line_numbers_path_and_checksum() {
        let excerpt = make_excerpt("src/main.rs", SAMPLE, "deadbeefcafebabe", 2, 2);
        let rendered = excerpt.render();
        assert!(rendered.contains("src/main.rs"));
        assert!(rendered.contains("sha256:deadbeefcafe"));
        assert!(rendered.contains("     2 | line2"));
        assert!(rendered.contains("     3 | line3"));
        assert!(rendered.contains("1 earlier lines omitted"));
        assert!(rendered.contains("3 later lines omitted"));
    }

    #[test]
    fn dedupe_key_distinguishes_ranges_and_versions() {
        let a = make_excerpt("a.txt", SAMPLE, "hash1", 1, 2);
        let b = make_excerpt("a.txt", SAMPLE, "hash1", 3, 2);
        let c = make_excerpt("a.txt", SAMPLE, "hash2", 1, 2);
        assert_ne!(a.dedupe_key(), b.dedupe_key());
        assert_ne!(a.dedupe_key(), c.dedupe_key());
        assert_eq!(
            a.dedupe_key(),
            make_excerpt("a.txt", SAMPLE, "hash1", 1, 2).dedupe_key()
        );
    }

    #[test]
    fn start_beyond_eof_is_clamped() {
        let excerpt = make_excerpt("a.txt", SAMPLE, "h", 999, 10);
        assert_eq!(excerpt.total_lines, 6);
        assert!(excerpt.text.is_empty());
    }

    #[test]
    fn empty_file_produces_empty_excerpt() {
        let excerpt = make_excerpt("empty.txt", "", "h", 1, 10);
        assert_eq!(excerpt.total_lines, 0);
        assert!(excerpt.text.is_empty());
        assert!(!excerpt.partial);
    }
}
