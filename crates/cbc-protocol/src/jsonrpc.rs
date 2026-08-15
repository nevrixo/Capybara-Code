//! JSON-RPC 2.0 message model — PRD §20.1/§20.4.
//!
//! The runtime treats every incoming message as untrusted (§19.7), so parsing
//! is depth- and size-checked before any handler sees it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::limits::{MAX_JSON_DEPTH, MAX_STRING_BYTES};

pub const JSONRPC_VERSION: &str = "2.0";

/// Standard JSON-RPC error codes plus Capybara runtime codes.
pub mod error_codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;

    // Capybara runtime domain codes (server-defined range).
    pub const PATH_OUTSIDE_WORKSPACE: i32 = -32000;
    pub const HASH_MISMATCH: i32 = -32001;
    pub const PATH_CHANGED: i32 = -32002;
    pub const NOT_FOUND: i32 = -32003;
    pub const ALREADY_EXISTS: i32 = -32004;
    pub const UNSUPPORTED_ENCODING: i32 = -32005;
    pub const OUTPUT_LIMIT: i32 = -32006;
    pub const TIMEOUT: i32 = -32007;
    pub const CANCELLED: i32 = -32008;
    pub const PROCESS_EXIT_NONZERO: i32 = -32009;
    pub const SANDBOX_UNAVAILABLE: i32 = -32010;
    pub const NETWORK_DENIED: i32 = -32011;
    pub const TRANSACTION_CONFLICT: i32 = -32012;
    pub const PROTOCOL_INCOMPATIBLE: i32 = -32013;
    pub const LEASE_VIOLATION: i32 = -32014;
    pub const RESOURCE_LIMIT: i32 = -32015;
    pub const NOT_INITIALIZED: i32 = -32016;
    pub const TOO_MANY_REQUESTS: i32 = -32017;
    pub const INVALID_ARGUMENT: i32 = -32018;
    pub const PERMISSION_DENIED: i32 = -32019;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RequestId::Number(n) => write!(f, "{n}"),
            RequestId::String(s) => write!(f, "{s}"),
        }
    }
}

/// An inbound JSON-RPC message: request (has `id`) or notification (no `id`).
#[derive(Debug, Clone, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<RequestId>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

impl RpcRequest {
    pub fn is_notification(&self) -> bool {
        self.id.is_none()
    }

    pub fn params_or_null(&self) -> Value {
        self.params.clone().unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(code: i32, message: impl Into<String>, data: Value) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(data),
        }
    }

    /// Attach a stable Capybara tool error taxonomy code (§12.10) so the
    /// TypeScript side can map runtime failures onto model observations without
    /// string matching.
    pub fn taxonomy(code: i32, taxonomy: &str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(serde_json::json!({ "taxonomy": taxonomy })),
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            error_codes::METHOD_NOT_FOUND,
            format!("unknown method: {method}"),
        )
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::taxonomy(error_codes::INVALID_PARAMS, "INVALID_ARGUMENT", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::taxonomy(error_codes::INTERNAL_ERROR, "INTERNAL", message)
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Outbound message: response or notification.
#[derive(Debug, Clone, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: &'static str,
    pub id: RequestId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: RequestId, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION,
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: RequestId, error: RpcError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION,
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcNotification {
    pub jsonrpc: &'static str,
    pub method: String,
    pub params: Value,
}

impl RpcNotification {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION,
            method: method.into(),
            params,
        }
    }
}

/// Reasons a payload can be rejected before dispatch.
#[derive(Debug)]
pub enum ParseError {
    Json(serde_json::Error),
    DepthExceeded { max: usize },
    StringTooLong { len: usize, max: usize },
    WrongVersion { found: String },
    EmptyMethod,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Json(e) => write!(f, "invalid JSON: {e}"),
            ParseError::DepthExceeded { max } => {
                write!(f, "JSON nesting depth exceeds maximum of {max}")
            }
            ParseError::StringTooLong { len, max } => {
                write!(f, "JSON string of {len} bytes exceeds maximum of {max}")
            }
            ParseError::WrongVersion { found } => {
                write!(f, "expected jsonrpc \"2.0\", found \"{found}\"")
            }
            ParseError::EmptyMethod => write!(f, "method must be a non-empty string"),
        }
    }
}

impl From<ParseError> for RpcError {
    fn from(value: ParseError) -> Self {
        let code = match value {
            ParseError::Json(_) => error_codes::PARSE_ERROR,
            _ => error_codes::INVALID_REQUEST,
        };
        RpcError::new(code, value.to_string())
    }
}

/// Recursively measure JSON depth and the longest string, rejecting payloads
/// that exceed §20.4 limits. Runs before handler dispatch so a hostile payload
/// cannot reach domain logic.
pub fn validate_value(value: &Value) -> Result<(), ParseError> {
    fn walk(value: &Value, depth: usize) -> Result<(), ParseError> {
        if depth > MAX_JSON_DEPTH {
            return Err(ParseError::DepthExceeded {
                max: MAX_JSON_DEPTH,
            });
        }
        match value {
            Value::String(s) => {
                if s.len() > MAX_STRING_BYTES {
                    return Err(ParseError::StringTooLong {
                        len: s.len(),
                        max: MAX_STRING_BYTES,
                    });
                }
                Ok(())
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, depth + 1)?;
                }
                Ok(())
            }
            Value::Object(map) => {
                for (key, item) in map {
                    if key.len() > MAX_STRING_BYTES {
                        return Err(ParseError::StringTooLong {
                            len: key.len(),
                            max: MAX_STRING_BYTES,
                        });
                    }
                    walk(item, depth + 1)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    walk(value, 1)
}

/// Parse and validate an inbound frame payload.
pub fn parse_request(payload: &str) -> Result<RpcRequest, ParseError> {
    let value: Value = serde_json::from_str(payload).map_err(ParseError::Json)?;
    validate_value(&value)?;

    let request: RpcRequest = serde_json::from_value(value).map_err(ParseError::Json)?;
    if request.jsonrpc != JSONRPC_VERSION {
        return Err(ParseError::WrongVersion {
            found: request.jsonrpc,
        });
    }
    if request.method.trim().is_empty() {
        return Err(ParseError::EmptyMethod);
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_initialize_request() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"method":"runtime.initialize","params":{"protocolVersion":"1.0"}}"#;
        let req = parse_request(payload).expect("parse");
        assert_eq!(req.method, "runtime.initialize");
        assert_eq!(req.id, Some(RequestId::Number(1)));
        assert!(!req.is_notification());
    }

    #[test]
    fn parses_string_ids_and_notifications() {
        let req = parse_request(r#"{"jsonrpc":"2.0","id":"a-1","method":"fs.read"}"#).unwrap();
        assert_eq!(req.id, Some(RequestId::String("a-1".into())));

        let note = parse_request(r#"{"jsonrpc":"2.0","method":"runtime.heartbeat"}"#).unwrap();
        assert!(note.is_notification());
    }

    #[test]
    fn rejects_wrong_jsonrpc_version() {
        let err = parse_request(r#"{"jsonrpc":"1.0","id":1,"method":"x"}"#).unwrap_err();
        assert!(matches!(err, ParseError::WrongVersion { .. }));
    }

    #[test]
    fn rejects_empty_method() {
        let err = parse_request(r#"{"jsonrpc":"2.0","id":1,"method":"  "}"#).unwrap_err();
        assert!(matches!(err, ParseError::EmptyMethod));
    }

    #[test]
    fn rejects_excessive_depth() {
        // 100 levels: within serde_json's own 128-deep recursion limit, so this
        // exercises *our* 64-deep check rather than the parser's.
        let mut payload = String::from(r#"{"jsonrpc":"2.0","id":1,"method":"x","params":"#);
        payload.push_str(&"[".repeat(100));
        payload.push_str(&"]".repeat(100));
        payload.push('}');
        let err = parse_request(&payload).unwrap_err();
        assert!(
            matches!(err, ParseError::DepthExceeded { max: 64 }),
            "expected DepthExceeded, got {err}"
        );
    }

    #[test]
    fn rejects_pathologically_deep_payload_without_stack_overflow() {
        // Far beyond both limits: must be rejected, not crash.
        let mut payload = String::from(r#"{"jsonrpc":"2.0","id":1,"method":"x","params":"#);
        payload.push_str(&"[".repeat(5_000));
        payload.push_str(&"]".repeat(5_000));
        payload.push('}');
        assert!(parse_request(&payload).is_err());
    }

    #[test]
    fn rejects_deeply_nested_objects_too() {
        let mut payload = String::from(r#"{"jsonrpc":"2.0","id":1,"method":"x","params":"#);
        for _ in 0..80 {
            payload.push_str(r#"{"a":"#);
        }
        payload.push('1');
        payload.push_str(&"}".repeat(80));
        payload.push('}');
        let err = parse_request(&payload).unwrap_err();
        assert!(
            matches!(err, ParseError::DepthExceeded { max: 64 }),
            "{err}"
        );
    }

    #[test]
    fn accepts_depth_at_limit() {
        let mut value = Value::Null;
        for _ in 0..50 {
            value = Value::Array(vec![value]);
        }
        assert!(validate_value(&value).is_ok());
    }

    #[test]
    fn method_not_found_maps_to_standard_code() {
        let err = RpcError::method_not_found("nope");
        assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
        assert!(err.message.contains("nope"));
    }

    #[test]
    fn error_serialization_omits_absent_data() {
        let json = serde_json::to_string(&RpcError::new(-1, "boom")).unwrap();
        assert_eq!(json, r#"{"code":-1,"message":"boom"}"#);
    }

    #[test]
    fn response_serializes_without_null_error() {
        let resp = RpcResponse::ok(RequestId::Number(7), serde_json::json!({"ok": true}));
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains(r#""id":7"#));
        assert!(!json.contains("error"));
    }

    #[test]
    fn taxonomy_errors_carry_stable_code() {
        let err = RpcError::taxonomy(
            error_codes::PATH_OUTSIDE_WORKSPACE,
            "PATH_OUTSIDE_WORKSPACE",
            "denied",
        );
        let data = err.data.expect("data");
        assert_eq!(data["taxonomy"], "PATH_OUTSIDE_WORKSPACE");
    }
}
