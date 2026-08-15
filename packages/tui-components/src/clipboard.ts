/**
 * Clipboard access via OSC 52.
 *
 * OSC 52 is the terminal-clipboard escape sequence supported by xterm, iTerm2,
 * Kitty, WezTerm, Windows Terminal, and others. Writing `\e]52;c;<base64>\e\\`
 * sets the system clipboard, which is how the TUI can copy a mouse selection to
 * the clipboard after the terminal's native selection was disabled by mouse
 * tracking.
 *
 * The sequence is deliberately safe: it is a one-shot write, it never reads the
 * clipboard (that would require the terminal to echo contents back into stdin),
 * and the base64 payload is the only user data that leaves the process this way.
 */

/**
 * Encode `text` as an OSC 52 clipboard-write sequence targeting the system
 * clipboard (`c`). Returns the raw bytes to write to stdout.
 */
export function osc52Copy(text: string): string {
  const payload = base64Encode(text);
  return `\u001B]52;c;${payload}\u001B\\`;
}

/**
 * Base64 encoder. Implemented here rather than reaching for `Buffer` so the
 * module stays usable from a renderer-independent test path and produces the
 * same bytes in every environment.
 *
 * Latin-1 is used for the encoding because OSC 52 payloads are byte strings;
 * a multi-byte UTF-8 sequence is encoded as bytes, not characters.
 */
export function base64Encode(text: string): string {
  const bytes = new Uint8Array(text.length * 4);
  let written = 0;
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    // Decode surrogate pairs to a code point.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes[written++] = code;
    } else if (code < 0x800) {
      bytes[written++] = 0xc0 | (code >> 6);
      bytes[written++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      bytes[written++] = 0xe0 | (code >> 12);
      bytes[written++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[written++] = 0x80 | (code & 0x3f);
    } else {
      bytes[written++] = 0xf0 | (code >> 18);
      bytes[written++] = 0x80 | ((code >> 12) & 0x3f);
      bytes[written++] = 0x80 | ((code >> 6) & 0x3f);
      bytes[written++] = 0x80 | (code & 0x3f);
    }
  }
  return base64EncodeBytes(bytes.subarray(0, written));
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64EncodeBytes(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out.push(
      BASE64_ALPHABET[(b0 >> 2) & 0x3f] as string,
      BASE64_ALPHABET[((b0 << 4) | (b1 >> 4)) & 0x3f] as string,
      BASE64_ALPHABET[((b1 << 2) | (b2 >> 6)) & 0x3f] as string,
      BASE64_ALPHABET[b2 & 0x3f] as string,
    );
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i] ?? 0;
    out.push(
      BASE64_ALPHABET[(b0 >> 2) & 0x3f] as string,
      BASE64_ALPHABET[(b0 << 4) & 0x3f] as string,
      "==",
    );
  } else if (remaining === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    out.push(
      BASE64_ALPHABET[(b0 >> 2) & 0x3f] as string,
      BASE64_ALPHABET[((b0 << 4) | (b1 >> 4)) & 0x3f] as string,
      BASE64_ALPHABET[(b1 << 2) & 0x3f] as string,
      "=",
    );
  }
  return out.join("");
}