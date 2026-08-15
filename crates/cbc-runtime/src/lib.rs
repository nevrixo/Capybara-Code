//! `cbc-runtime` library surface.
//!
//! The sidecar binary is a thin stdio loop around [`server::dispatch`].
//! Exposing the dispatcher as a library lets the RPC contract tests in §25.7
//! drive every namespace in-process without spawning a child.

pub mod handlers;
pub mod server;

pub use server::{default_data_dir, dispatch, respond, Outbound, RuntimeState, RUNTIME_VERSION};

use cbc_protocol::{RequestId, RpcError, RpcResponse};
use serde_json::Value;

/// Convenience for tests and embedders: build a request, dispatch it, and
/// return the result.
pub fn call(state: &RuntimeState, method: &str, params: Value) -> Result<Value, RpcError> {
    let payload = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    let request =
        cbc_protocol::parse_request(&payload.to_string()).map_err(|e| -> RpcError { e.into() })?;
    match dispatch(state, &request) {
        Some(result) => result,
        None => Ok(Value::Null),
    }
}

/// Dispatch and wrap in a full JSON-RPC response, mirroring the wire behaviour.
pub fn call_response(state: &RuntimeState, id: i64, method: &str, params: Value) -> RpcResponse {
    let outcome = call(state, method, params);
    respond(RequestId::Number(id), outcome)
}
