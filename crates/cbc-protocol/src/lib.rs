//! `cbc-protocol` — the versioned local RPC boundary between the TypeScript
//! `cbc` control plane and the Rust `cbc-runtime` trusted execution plane.
//!
//! PRD references: §19.7 (internal trust boundary), §20.1–§20.5 (transport,
//! handshake, namespaces, limits, liveness), §19.12 (versioning).

pub mod frame;
pub mod handshake;
pub mod jsonrpc;
pub mod limits;
pub mod methods;

pub use frame::{encode_frame, read_frame, write_frame, FrameError};
pub use handshake::{ClientCapabilities, InitializeParams, InitializeResult, RuntimeCapabilities};
pub use jsonrpc::{
    error_codes, parse_request, ParseError, RequestId, RpcError, RpcNotification, RpcRequest,
    RpcResponse, JSONRPC_VERSION,
};
pub use limits::{
    ProtocolVersion, HEARTBEAT_DEGRADED_MS, HEARTBEAT_FATAL_MS, HEARTBEAT_INTERVAL_MS,
    LENGTH_PREFIX_BYTES, MAX_EVENT_PAYLOAD_BYTES, MAX_FRAME_BYTES, MAX_JSON_DEPTH,
    MAX_OUTSTANDING_REQUESTS, MAX_STRING_BYTES, PROTOCOL_VERSION,
};
pub use methods::{
    is_known_notification, is_known_request, is_mutating, requires_initialization,
    NOTIFICATION_METHODS, REQUEST_METHODS,
};

use std::io::{Read, Write};

/// A blocking framed transport over any reader/writer pair. The runtime uses
/// stdin/stdout; tests use in-memory pipes.
pub struct FramedTransport<R: Read, W: Write> {
    reader: R,
    writer: W,
}

impl<R: Read, W: Write> FramedTransport<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }

    pub fn recv(&mut self) -> Result<String, FrameError> {
        read_frame(&mut self.reader)
    }

    pub fn send_raw(&mut self, payload: &str) -> Result<(), FrameError> {
        write_frame(&mut self.writer, payload)
    }

    pub fn send_response(&mut self, response: &RpcResponse) -> Result<(), FrameError> {
        let payload = serde_json::to_string(response)
            .map_err(|e| FrameError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
        self.send_raw(&payload)
    }

    pub fn send_notification(&mut self, note: &RpcNotification) -> Result<(), FrameError> {
        let payload = serde_json::to_string(note)
            .map_err(|e| FrameError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
        self.send_raw(&payload)
    }

    pub fn into_parts(self) -> (R, W) {
        (self.reader, self.writer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn transport_round_trips_response_and_notification() {
        let mut out: Vec<u8> = Vec::new();
        {
            let mut transport = FramedTransport::new(Cursor::new(Vec::new()), &mut out);
            transport
                .send_response(&RpcResponse::ok(
                    RequestId::Number(1),
                    serde_json::json!({"protocolVersion": "1.0"}),
                ))
                .expect("send response");
            transport
                .send_notification(&RpcNotification::new(
                    "runtime.heartbeat",
                    serde_json::json!({"uptimeMs": 5000}),
                ))
                .expect("send notification");
        }

        let mut reader = Cursor::new(out);
        let first = read_frame(&mut reader).expect("frame 1");
        let second = read_frame(&mut reader).expect("frame 2");
        assert!(first.contains("\"protocolVersion\":\"1.0\""));
        assert!(second.contains("runtime.heartbeat"));
        assert!(matches!(read_frame(&mut reader), Err(FrameError::Eof)));
    }

    #[test]
    fn protocol_version_major_mismatch_is_incompatible() {
        let current = ProtocolVersion::current();
        assert_eq!(current.major, 1);
        assert!(current.is_compatible_with(&ProtocolVersion::parse("1.4").unwrap()));
        assert!(!current.is_compatible_with(&ProtocolVersion::parse("2.0").unwrap()));
    }

    #[test]
    fn protocol_version_rejects_malformed() {
        assert!(ProtocolVersion::parse("1.2.3").is_none());
        assert!(ProtocolVersion::parse("x").is_none());
        assert_eq!(ProtocolVersion::parse("3").unwrap().minor, 0);
    }
}
