//! Length-prefixed frame codec — PRD §20.1 "Transport".
//!
//! Wire format:
//! ```text
//! 4-byte unsigned big-endian payload length
//! UTF-8 JSON payload
//! ```
//!
//! Chosen because it is safe for embedded newlines and binary-like strings,
//! has explicit packet boundaries, works over cross-platform stdio, needs no
//! local port, and replays deterministically from fixtures.

use std::io::{self, Read, Write};

use crate::limits::{LENGTH_PREFIX_BYTES, MAX_FRAME_BYTES};

#[derive(Debug)]
pub enum FrameError {
    /// The stream ended cleanly on a frame boundary.
    Eof,
    /// The stream ended mid-frame.
    TruncatedFrame {
        expected: usize,
        got: usize,
    },
    /// Declared length exceeds `MAX_FRAME_BYTES`.
    FrameTooLarge {
        declared: usize,
        max: usize,
    },
    /// Declared length of zero is never valid.
    EmptyFrame,
    /// Payload was not valid UTF-8.
    InvalidUtf8,
    Io(io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Eof => write!(f, "stream closed on frame boundary"),
            FrameError::TruncatedFrame { expected, got } => {
                write!(f, "truncated frame: expected {expected} bytes, got {got}")
            }
            FrameError::FrameTooLarge { declared, max } => {
                write!(f, "frame too large: declared {declared} bytes, max {max}")
            }
            FrameError::EmptyFrame => write!(f, "zero-length frame is not valid"),
            FrameError::InvalidUtf8 => write!(f, "frame payload is not valid UTF-8"),
            FrameError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(value: io::Error) -> Self {
        if value.kind() == io::ErrorKind::UnexpectedEof {
            FrameError::Eof
        } else {
            FrameError::Io(value)
        }
    }
}

/// Encode a UTF-8 payload into a length-prefixed frame.
pub fn encode_frame(payload: &str) -> Result<Vec<u8>, FrameError> {
    let bytes = payload.as_bytes();
    if bytes.is_empty() {
        return Err(FrameError::EmptyFrame);
    }
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::FrameTooLarge {
            declared: bytes.len(),
            max: MAX_FRAME_BYTES,
        });
    }
    let mut out = Vec::with_capacity(LENGTH_PREFIX_BYTES + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(out)
}

/// Write a frame and flush it. Flushing per frame keeps latency bounded, which
/// matters for the `< 75 ms` provider-event-to-render budget in §22.2.
pub fn write_frame<W: Write>(writer: &mut W, payload: &str) -> Result<(), FrameError> {
    let frame = encode_frame(payload)?;
    writer.write_all(&frame)?;
    writer.flush()?;
    Ok(())
}

/// Read exactly one frame. Returns `FrameError::Eof` when the peer closed the
/// stream on a clean boundary.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<String, FrameError> {
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    match read_exact_or_eof(reader, &mut prefix)? {
        ReadOutcome::Eof => return Err(FrameError::Eof),
        ReadOutcome::Partial(got) => {
            return Err(FrameError::TruncatedFrame {
                expected: LENGTH_PREFIX_BYTES,
                got,
            })
        }
        ReadOutcome::Full => {}
    }

    let declared = u32::from_be_bytes(prefix) as usize;
    if declared == 0 {
        return Err(FrameError::EmptyFrame);
    }
    if declared > MAX_FRAME_BYTES {
        // Do not attempt to allocate an attacker-controlled length (§19.7).
        return Err(FrameError::FrameTooLarge {
            declared,
            max: MAX_FRAME_BYTES,
        });
    }

    let mut payload = vec![0u8; declared];
    match read_exact_or_eof(reader, &mut payload)? {
        ReadOutcome::Full => {}
        ReadOutcome::Eof => {
            return Err(FrameError::TruncatedFrame {
                expected: declared,
                got: 0,
            })
        }
        ReadOutcome::Partial(got) => {
            return Err(FrameError::TruncatedFrame {
                expected: declared,
                got,
            })
        }
    }

    String::from_utf8(payload).map_err(|_| FrameError::InvalidUtf8)
}

enum ReadOutcome {
    Full,
    Eof,
    Partial(usize),
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<ReadOutcome, FrameError> {
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = match reader.read(&mut buf[filled..]) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FrameError::Io(e)),
        };
        if n == 0 {
            return Ok(if filled == 0 {
                ReadOutcome::Eof
            } else {
                ReadOutcome::Partial(filled)
            });
        }
        filled += n;
    }
    Ok(ReadOutcome::Full)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_payload() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"method":"runtime.initialize"}"#;
        let frame = encode_frame(payload).expect("encode");
        let mut cursor = io::Cursor::new(frame);
        assert_eq!(read_frame(&mut cursor).expect("decode"), payload);
    }

    #[test]
    fn round_trips_embedded_newlines_and_unicode() {
        // §20.1 rationale: framing must be safe for embedded newlines.
        let payload = "{\"text\":\"line1\nline2\t한국어 🐹\"}";
        let frame = encode_frame(payload).expect("encode");
        let mut cursor = io::Cursor::new(frame);
        assert_eq!(read_frame(&mut cursor).expect("decode"), payload);
    }

    #[test]
    fn reads_multiple_frames_in_sequence() {
        let mut buf = Vec::new();
        for i in 0..5 {
            buf.extend_from_slice(&encode_frame(&format!("{{\"n\":{i}}}")).unwrap());
        }
        let mut cursor = io::Cursor::new(buf);
        for i in 0..5 {
            assert_eq!(read_frame(&mut cursor).unwrap(), format!("{{\"n\":{i}}}"));
        }
        assert!(matches!(read_frame(&mut cursor), Err(FrameError::Eof)));
    }

    #[test]
    fn rejects_oversized_declared_length_without_allocating() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(u32::MAX).to_be_bytes());
        buf.extend_from_slice(b"tiny");
        let mut cursor = io::Cursor::new(buf);
        match read_frame(&mut cursor) {
            Err(FrameError::FrameTooLarge { declared, max }) => {
                assert_eq!(declared, u32::MAX as usize);
                assert_eq!(max, MAX_FRAME_BYTES);
            }
            other => panic!("expected FrameTooLarge, got {other:?}"),
        }
    }

    #[test]
    fn rejects_zero_length_frame() {
        let buf = 0u32.to_be_bytes().to_vec();
        let mut cursor = io::Cursor::new(buf);
        assert!(matches!(
            read_frame(&mut cursor),
            Err(FrameError::EmptyFrame)
        ));
    }

    #[test]
    fn detects_truncated_payload() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&64u32.to_be_bytes());
        buf.extend_from_slice(b"only-ten-b");
        let mut cursor = io::Cursor::new(buf);
        match read_frame(&mut cursor) {
            Err(FrameError::TruncatedFrame { expected, got }) => {
                assert_eq!(expected, 64);
                assert_eq!(got, 10);
            }
            other => panic!("expected TruncatedFrame, got {other:?}"),
        }
    }

    #[test]
    fn detects_truncated_prefix() {
        let mut cursor = io::Cursor::new(vec![0u8, 0u8]);
        assert!(matches!(
            read_frame(&mut cursor),
            Err(FrameError::TruncatedFrame {
                expected: 4,
                got: 2
            })
        ));
    }

    #[test]
    fn rejects_invalid_utf8_payload() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&2u32.to_be_bytes());
        buf.extend_from_slice(&[0xffu8, 0xfeu8]);
        let mut cursor = io::Cursor::new(buf);
        assert!(matches!(
            read_frame(&mut cursor),
            Err(FrameError::InvalidUtf8)
        ));
    }

    // §25.4 property-style: encode/decode round-trips for arbitrary sizes.
    #[test]
    fn property_round_trip_many_sizes() {
        for size in [1usize, 2, 3, 255, 256, 257, 4096, 65535, 65536, 100_000] {
            let payload = "x".repeat(size);
            let frame = encode_frame(&payload).expect("encode");
            assert_eq!(frame.len(), LENGTH_PREFIX_BYTES + size);
            let mut cursor = io::Cursor::new(frame);
            assert_eq!(read_frame(&mut cursor).expect("decode").len(), size);
        }
    }

    // §25.5 fuzz target surface: the decoder must never panic on random bytes.
    #[test]
    fn fuzz_random_bytes_never_panics() {
        let mut state: u64 = 0x2545_F491_4F6C_DD1D;
        for _ in 0..3000 {
            let mut bytes = Vec::new();
            let len = {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                (state >> 33) as usize % 64
            };
            for _ in 0..len {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                bytes.push((state >> 24) as u8);
            }
            let mut cursor = io::Cursor::new(bytes);
            let _ = read_frame(&mut cursor);
        }
    }
}
