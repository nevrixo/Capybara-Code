//! Terminal escape sanitization — PRD §6.20, §24.4 T6, AC-33, RT-004.
//!
//! Threat: tool, MCP, or Skill output containing OSC/DCS/APC/PM sequences can
//! set the terminal title, write the clipboard (OSC 52), or emit hyperlinks.
//! Mitigation per §24.4: strip OSC/DCS/APC/PM entirely, sanitize CSI except a
//! safe SGR subset, escape remaining control characters, and cap line length.

/// Default maximum rendered line length before truncation (§24.4 "cap line
/// length"). Long single lines are also capped by the observation discipline in
/// §11.6 (single line 8 KiB).
pub const DEFAULT_MAX_LINE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SgrPolicy {
    /// Drop every SGR sequence. Used for journal payloads and model-bound text.
    Strip,
    /// Keep colour/attribute SGR sequences with validated numeric parameters.
    /// Used for the dedicated PTY view (§12.7).
    AllowSafe,
}

#[derive(Debug, Clone)]
pub struct SanitizeOptions {
    pub sgr: SgrPolicy,
    pub max_line_bytes: usize,
    /// Replace tab with spaces so width calculations stay stable in the TUI.
    pub expand_tabs: Option<usize>,
}

impl Default for SanitizeOptions {
    fn default() -> Self {
        Self {
            sgr: SgrPolicy::Strip,
            max_line_bytes: DEFAULT_MAX_LINE_BYTES,
            expand_tabs: None,
        }
    }
}

impl SanitizeOptions {
    /// Policy for text that will be embedded in journal events, model prompts,
    /// logs, or debug bundles: no escapes at all.
    pub fn for_model_and_journal() -> Self {
        Self {
            sgr: SgrPolicy::Strip,
            max_line_bytes: DEFAULT_MAX_LINE_BYTES,
            expand_tabs: Some(4),
        }
    }

    /// Policy for the dedicated PTY viewport, which may retain colour.
    pub fn for_pty_view() -> Self {
        Self {
            sgr: SgrPolicy::AllowSafe,
            max_line_bytes: DEFAULT_MAX_LINE_BYTES,
            expand_tabs: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SanitizeReport {
    pub osc_stripped: usize,
    pub dcs_stripped: usize,
    pub apc_pm_stripped: usize,
    pub csi_stripped: usize,
    pub sgr_kept: usize,
    pub control_chars_escaped: usize,
    pub lines_truncated: usize,
}

impl SanitizeReport {
    pub fn changed(&self) -> bool {
        self.osc_stripped
            + self.dcs_stripped
            + self.apc_pm_stripped
            + self.csi_stripped
            + self.control_chars_escaped
            + self.lines_truncated
            > 0
    }
}

#[derive(Debug, Clone)]
pub struct Sanitized {
    pub text: String,
    pub report: SanitizeReport,
}

const ESC: char = '\u{1b}';

/// Sanitize arbitrary process/tool output for safe display and storage.
pub fn sanitize(input: &str, options: &SanitizeOptions) -> Sanitized {
    let mut out = String::with_capacity(input.len());
    let mut report = SanitizeReport::default();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];

        if c == ESC {
            i += 1;
            if i >= chars.len() {
                // Lone ESC at end of input: drop it.
                report.control_chars_escaped += 1;
                break;
            }
            match chars[i] {
                // OSC — Operating System Command. Terminates at BEL or ST.
                ']' => {
                    i += 1;
                    i = skip_string_terminated(&chars, i);
                    report.osc_stripped += 1;
                }
                // DCS — Device Control String.
                'P' => {
                    i += 1;
                    i = skip_string_terminated(&chars, i);
                    report.dcs_stripped += 1;
                }
                // APC / PM — Application Program Command / Privacy Message.
                '_' | '^' => {
                    i += 1;
                    i = skip_string_terminated(&chars, i);
                    report.apc_pm_stripped += 1;
                }
                // CSI — Control Sequence Introducer.
                '[' => {
                    i += 1;
                    let (next, params, final_byte) = scan_csi(&chars, i);
                    i = next;
                    match final_byte {
                        Some('m') if options.sgr == SgrPolicy::AllowSafe => {
                            if let Some(safe) = safe_sgr(&params) {
                                out.push(ESC);
                                out.push('[');
                                out.push_str(&safe);
                                out.push('m');
                                report.sgr_kept += 1;
                            } else {
                                report.csi_stripped += 1;
                            }
                        }
                        _ => report.csi_stripped += 1,
                    }
                }
                // Two-character escapes such as ESC c (full reset) and charset
                // selection: always dropped.
                _ => {
                    i += 1;
                    report.csi_stripped += 1;
                }
            }
            continue;
        }

        i += 1;

        match c {
            '\n' => out.push('\n'),
            '\r' => {
                // Normalize CRLF; a lone CR would let output overwrite a line.
                if chars.get(i) == Some(&'\n') {
                    i += 1;
                }
                out.push('\n');
            }
            '\t' => match options.expand_tabs {
                Some(width) => out.push_str(&" ".repeat(width.max(1))),
                None => out.push('\t'),
            },
            // BEL, backspace, vertical tab, form feed, and every other C0/C1
            // control: render as a visible escape so nothing executes.
            c if is_forbidden_control(c) => {
                report.control_chars_escaped += 1;
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => out.push(c),
        }
    }

    let text = if options.max_line_bytes > 0 {
        cap_lines(&out, options.max_line_bytes, &mut report)
    } else {
        out
    };

    Sanitized { text, report }
}

/// Convenience wrapper for the common "safe for journal and model" case.
pub fn sanitize_for_model(input: &str) -> String {
    sanitize(input, &SanitizeOptions::for_model_and_journal()).text
}

fn is_forbidden_control(c: char) -> bool {
    let cp = c as u32;
    // C0 controls except the newline handled above.
    if cp < 0x20 {
        return true;
    }
    if cp == 0x7f {
        return true;
    }
    // C1 controls (0x80–0x9f) include 8-bit CSI/OSC/ST forms.
    (0x80..=0x9f).contains(&cp)
}

/// Skip a string-terminated sequence body (OSC/DCS/APC/PM) up to BEL or ST.
fn skip_string_terminated(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() {
        let c = chars[i];
        if c == '\u{7}' {
            return i + 1;
        }
        if c == ESC && chars.get(i + 1) == Some(&'\\') {
            return i + 2;
        }
        // 8-bit ST.
        if c == '\u{9c}' {
            return i + 1;
        }
        i += 1;
    }
    i
}

/// Scan a CSI body, returning (next index, parameter string, final byte).
fn scan_csi(chars: &[char], mut i: usize) -> (usize, String, Option<char>) {
    let mut params = String::new();
    while i < chars.len() {
        let c = chars[i];
        // Parameter bytes 0x30–0x3f and intermediate bytes 0x20–0x2f.
        if ('\u{30}'..='\u{3f}').contains(&c) || ('\u{20}'..='\u{2f}').contains(&c) {
            params.push(c);
            i += 1;
            continue;
        }
        // Final byte 0x40–0x7e.
        if ('\u{40}'..='\u{7e}').contains(&c) {
            return (i + 1, params, Some(c));
        }
        // Malformed: stop without consuming.
        return (i, params, None);
    }
    (i, params, None)
}

/// Validate SGR parameters. Only plain numeric parameters within the known
/// range are preserved; anything else (including sub-parameter colon syntax
/// with unexpected content) is dropped.
fn safe_sgr(params: &str) -> Option<String> {
    if params.is_empty() {
        return Some(String::new());
    }
    if params.starts_with('?') || params.starts_with('>') || params.starts_with('<') {
        return None; // private mode sequences
    }
    let mut kept: Vec<String> = Vec::new();
    for part in params.split(';') {
        if part.is_empty() {
            kept.push(String::new());
            continue;
        }
        // Allow 38:5:n / 38:2:r:g:b extended colour forms.
        let mut segments = Vec::new();
        for seg in part.split(':') {
            if seg.is_empty() {
                segments.push(String::new());
                continue;
            }
            let n: u32 = seg.parse().ok()?;
            if n > 255 {
                return None;
            }
            segments.push(n.to_string());
        }
        kept.push(segments.join(":"));
    }
    if kept.len() > 16 {
        return None;
    }
    Some(kept.join(";"))
}

fn cap_lines(input: &str, max_bytes: usize, report: &mut SanitizeReport) -> String {
    let mut out = String::with_capacity(input.len());
    for (idx, line) in input.split('\n').enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        if line.len() <= max_bytes {
            out.push_str(line);
            continue;
        }
        report.lines_truncated += 1;
        let mut end = max_bytes;
        while end > 0 && !line.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&line[..end]);
        out.push_str(&format!(
            " …[line truncated: {} of {} bytes shown]",
            end,
            line.len()
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_osc_title_change() {
        // RT-004: process output must not change the terminal title.
        let input = "\u{1b}]0;PWNED\u{7}hello";
        let result = sanitize(input, &SanitizeOptions::default());
        assert_eq!(result.text, "hello");
        assert_eq!(result.report.osc_stripped, 1);
        assert!(!result.text.contains("PWNED") || !result.text.contains('\u{1b}'));
    }

    #[test]
    fn strips_osc52_clipboard_write() {
        // AC-33: OSC clipboard sequences must not execute.
        let input = "before\u{1b}]52;c;bWFsaWNpb3Vz\u{1b}\\after";
        let result = sanitize(input, &SanitizeOptions::default());
        assert_eq!(result.text, "beforeafter");
        assert!(!result.text.contains("52;c"));
    }

    #[test]
    fn strips_dcs_apc_and_pm() {
        for (input, field) in [
            ("a\u{1b}Pq#0;2;0;0;0\u{1b}\\b", "dcs"),
            ("a\u{1b}_payload\u{1b}\\b", "apc"),
            ("a\u{1b}^privacy\u{1b}\\b", "pm"),
        ] {
            let result = sanitize(input, &SanitizeOptions::default());
            assert_eq!(result.text, "ab", "failed for {field}");
        }
    }

    #[test]
    fn strips_cursor_movement_csi_but_can_keep_sgr() {
        let input = "\u{1b}[2J\u{1b}[H\u{1b}[31mred\u{1b}[0m";
        let stripped = sanitize(input, &SanitizeOptions::default());
        assert_eq!(stripped.text, "red");
        assert_eq!(stripped.report.csi_stripped, 4);

        let kept = sanitize(input, &SanitizeOptions::for_pty_view());
        assert_eq!(kept.text, "\u{1b}[31mred\u{1b}[0m");
        assert_eq!(kept.report.sgr_kept, 2);
        assert_eq!(kept.report.csi_stripped, 2);
    }

    #[test]
    fn rejects_private_mode_sequences_even_in_pty_view() {
        let input = "\u{1b}[?1049h\u{1b}[?25l";
        let result = sanitize(input, &SanitizeOptions::for_pty_view());
        assert_eq!(result.text, "");
    }

    #[test]
    fn escapes_bell_and_backspace() {
        let result = sanitize("a\u{7}b\u{8}c", &SanitizeOptions::default());
        assert_eq!(result.text, "a\\x07b\\x08c");
        assert_eq!(result.report.control_chars_escaped, 2);
    }

    #[test]
    fn escapes_eight_bit_c1_controls() {
        // 0x9b is 8-bit CSI; 0x9d is 8-bit OSC.
        let result = sanitize("a\u{9b}0mb\u{9d}0;x\u{9c}", &SanitizeOptions::default());
        assert!(!result.text.contains('\u{9b}'));
        assert!(!result.text.contains('\u{9d}'));
    }

    #[test]
    fn normalizes_crlf_and_lone_cr() {
        let result = sanitize("a\r\nb\rc", &SanitizeOptions::default());
        assert_eq!(result.text, "a\nb\nc");
    }

    #[test]
    fn caps_long_lines() {
        let long = "x".repeat(20_000);
        let result = sanitize(
            &long,
            &SanitizeOptions {
                sgr: SgrPolicy::Strip,
                max_line_bytes: 100,
                expand_tabs: None,
            },
        );
        assert_eq!(result.report.lines_truncated, 1);
        assert!(result.text.starts_with(&"x".repeat(100)));
        assert!(result.text.contains("line truncated"));
        assert!(result.text.len() < 200);
    }

    #[test]
    fn preserves_unicode_and_cjk() {
        let input = "한국어 테스트 🐹 done";
        let result = sanitize(input, &SanitizeOptions::default());
        assert_eq!(result.text, input);
        assert!(!result.report.changed());
    }

    #[test]
    fn expands_tabs_for_model_policy() {
        let result = sanitize("a\tb", &SanitizeOptions::for_model_and_journal());
        assert_eq!(result.text, "a    b");
    }

    #[test]
    fn unterminated_osc_does_not_leak_payload() {
        let result = sanitize("\u{1b}]0;never-terminated", &SanitizeOptions::default());
        assert_eq!(result.text, "");
    }

    #[test]
    fn property_output_never_contains_escape_when_stripping() {
        // §25.4: "terminal sanitizer output has no forbidden escape".
        let mut state: u64 = 0x9E3779B97F4A7C15;
        for _ in 0..2000 {
            let mut s = String::new();
            for _ in 0..40 {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                let pick = (state >> 30) % 8;
                match pick {
                    0 => s.push(ESC),
                    1 => s.push_str("]0;title\u{7}"),
                    2 => s.push_str("[31m"),
                    3 => s.push('\u{7}'),
                    4 => s.push('\n'),
                    5 => s.push('a'),
                    6 => s.push('한'),
                    _ => s.push_str("[?1049h"),
                }
            }
            let out = sanitize(&s, &SanitizeOptions::default()).text;
            assert!(!out.contains(ESC), "escape leaked: {out:?}");
            assert!(!out.contains('\u{7}'), "BEL leaked: {out:?}");
        }
    }

    #[test]
    fn fuzz_sanitizer_never_panics() {
        let mut state: u64 = 12345;
        for _ in 0..3000 {
            let mut s = String::new();
            for _ in 0..32 {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                let cp = ((state >> 20) % 0x2000) as u32;
                if let Some(c) = char::from_u32(cp) {
                    s.push(c);
                }
            }
            let _ = sanitize(&s, &SanitizeOptions::default());
            let _ = sanitize(&s, &SanitizeOptions::for_pty_view());
        }
    }
}
