//! Protocol limits — PRD §20.4 "Message and rate limits".
//!
//! These are hard invariants of the trust boundary. The Rust runtime enforces
//! them independently of anything the TypeScript client claims, per §19.7.

/// Maximum single frame payload size: 8 MiB.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Maximum JSON nesting depth: 64.
pub const MAX_JSON_DEPTH: usize = 64;

/// Maximum length of a single JSON string value: 4 MiB.
pub const MAX_STRING_BYTES: usize = 4 * 1024 * 1024;

/// Default maximum event payload size: 1 MiB. Larger content must travel as an
/// artifact handle (§18.17).
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Default maximum outstanding in-flight requests.
pub const MAX_OUTSTANDING_REQUESTS: usize = 128;

/// Length prefix width in bytes (unsigned big-endian).
pub const LENGTH_PREFIX_BYTES: usize = 4;

/// Heartbeat cadence in milliseconds (§20.5).
pub const HEARTBEAT_INTERVAL_MS: u64 = 5_000;

/// Silence after which the UI must show a degraded indicator (§20.5).
pub const HEARTBEAT_DEGRADED_MS: u64 = 15_000;

/// Silence after which a controlled restart / session abort decision is made.
pub const HEARTBEAT_FATAL_MS: u64 = 30_000;

/// Protocol version implemented by this crate. `cbc` refuses to run against a
/// runtime whose *major* version differs (§19.12).
pub const PROTOCOL_VERSION: &str = "1.0";

/// Parsed protocol version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
}

impl ProtocolVersion {
    pub fn current() -> Self {
        Self::parse(PROTOCOL_VERSION).expect("PROTOCOL_VERSION is well formed")
    }

    pub fn parse(raw: &str) -> Option<Self> {
        let mut parts = raw.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().unwrap_or("0").parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self { major, minor })
    }

    /// §19.12: differing major versions must refuse to run. Equal major with a
    /// runtime minor >= client minor is compatible.
    pub fn is_compatible_with(&self, other: &Self) -> bool {
        self.major == other.major
    }

    pub fn to_string_lossy(&self) -> String {
        format!("{}.{}", self.major, self.minor)
    }
}
