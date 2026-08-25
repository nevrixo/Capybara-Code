//! `cbc-runtime` — the Capybara Code trusted execution plane.
//!
//! Reads length-prefixed JSON-RPC 2.0 frames from stdin, writes responses and
//! notifications to stdout, and emits redacted diagnostics to stderr (§19.1,
//! §19.7, §20.1).

use std::io::{self, Write};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use cbc_protocol::{error_codes, FrameError, RequestId, RpcError, RpcResponse};

use cbc_runtime::server::{dispatch, respond, Outbound, RuntimeState, RUNTIME_VERSION};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // A tiny non-RPC surface so `cbc doctor` can verify the binary without
    // performing a handshake, and so packaging checks can assert the version.
    match args.first().map(String::as_str) {
        Some("--version") | Some("-V") => {
            println!("cbc-runtime {RUNTIME_VERSION}");
            println!("protocol {}", cbc_protocol::PROTOCOL_VERSION);
            return;
        }
        Some("--capabilities") => {
            let sandbox = cbc_sandbox::detect(cbc_sandbox::SandboxLevel::Standard);
            let value = serde_json::json!({
                "runtimeVersion": RUNTIME_VERSION,
                "protocolVersion": cbc_protocol::PROTOCOL_VERSION,
                "platform": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "sandbox": sandbox,
                "maxFrameBytes": cbc_protocol::MAX_FRAME_BYTES,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            );
            return;
        }
        Some("--help") | Some("-h") => {
            eprintln!(
                "cbc-runtime {RUNTIME_VERSION}\n\n\
                 The Capybara Code trusted execution sidecar. It speaks framed\n\
                 JSON-RPC 2.0 over stdin/stdout and is launched by `cbc`.\n\n\
                 Options:\n\
                 \x20 --version        print version and protocol version\n\
                 \x20 --capabilities   print detected host capabilities as JSON\n\
                 \x20 --help           show this message\n"
            );
            return;
        }
        _ => {}
    }

    let state = Arc::new(RuntimeState::new());
    // Owned `Stdout` rather than a lock guard: the heartbeat and process-event
    // threads both write frames, so the sink must be `Send`.
    let outbound = Arc::new(Mutex::new(Outbound::new(io::stdout())));

    // Forward process output/exit/limit events as notifications (§20.3).
    let supervisor_events = state.supervisor.attach_events();
    {
        let outbound = Arc::clone(&outbound);
        let state = Arc::clone(&state);
        std::thread::spawn(move || {
            for event in supervisor_events {
                let (method, params) = match event {
                    cbc_process::SupervisorEvent::Output(chunk) => {
                        let protocol_stdout = chunk.protocol_channel.is_some()
                            && chunk.stream == cbc_process::OutputStream::Stdout;
                        let lsp_protocol_stdout = chunk
                            .protocol_channel
                            .as_deref()
                            .map(|channel| channel.starts_with("lsp_"))
                            .unwrap_or(false);
                        let method = if protocol_stdout {
                            if lsp_protocol_stdout {
                                "lsp.stdio.output"
                            } else {
                                "mcp.stdio.output"
                            }
                        } else {
                            "process.output"
                        };
                        let text = if protocol_stdout {
                            chunk.text
                        } else {
                            state.safe_text(&chunk.text)
                        };
                        (
                            method,
                            serde_json::json!({
                                "jobId": chunk.job_id,
                                "stream": match chunk.stream {
                                    cbc_process::OutputStream::Stdout => "stdout",
                                    cbc_process::OutputStream::Stderr => "stderr",
                                },
                                "sequence": chunk.sequence,
                                "text": text,
                                "protocolChannel": chunk.protocol_channel,
                            }),
                        )
                    }
                    cbc_process::SupervisorEvent::Exited {
                        job_id,
                        state: job_state,
                        exit_code,
                        signal,
                        duration_ms,
                    } => (
                        "process.exited",
                        serde_json::json!({
                            "jobId": job_id,
                            "state": job_state,
                            "exitCode": exit_code,
                            "signal": signal,
                            "durationMs": duration_ms,
                        }),
                    ),
                    cbc_process::SupervisorEvent::LimitWarning {
                        job_id,
                        resource,
                        detail,
                    } => (
                        "process.limit_warning",
                        serde_json::json!({
                            "jobId": job_id,
                            "resource": resource,
                            "detail": state.redact(&detail),
                        }),
                    ),
                };
                let mut guard = outbound.lock().expect("outbound lock");
                if guard.notify(method, params).is_err() {
                    break;
                }
            }
        });
    }

    // Heartbeat (§20.5).
    {
        let outbound = Arc::clone(&outbound);
        let state = Arc::clone(&state);
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(
                cbc_protocol::HEARTBEAT_INTERVAL_MS,
            ));
            let params = serde_json::json!({
                "uptimeMs": state.started_at.elapsed().as_millis() as u64,
                "activeProcesses": state.supervisor.active_count(),
                "openTransactions": state.transactions.lock().expect("lock").len(),
            });
            let mut guard = outbound.lock().expect("outbound lock");
            if guard.notify("runtime.heartbeat", params).is_err() {
                break;
            }
        });
    }

    let mut stdin = io::stdin().lock();
    let exit_code = loop {
        let payload = match cbc_protocol::read_frame(&mut stdin) {
            Ok(payload) => payload,
            Err(FrameError::Eof) => break 0,
            Err(e) => {
                // A malformed frame is fatal for the stream: we cannot know where
                // the next boundary is (§20.4).
                let mut guard = outbound.lock().expect("outbound lock");
                let _ = guard.notify(
                    "runtime.fatal",
                    serde_json::json!({
                        "reason": "frame_decode_failed",
                        "detail": e.to_string(),
                    }),
                );
                eprintln!("cbc-runtime: fatal frame error: {e}");
                break 10;
            }
        };

        let request = match cbc_protocol::parse_request(&payload) {
            Ok(request) => request,
            Err(parse_error) => {
                let error: RpcError = parse_error.into();
                // Without a parseable id we still answer with id 0 so the client
                // can surface the protocol error rather than hanging.
                let mut guard = outbound.lock().expect("outbound lock");
                let _ = guard.response(&RpcResponse::err(RequestId::Number(0), error));
                continue;
            }
        };

        let in_flight = state.outstanding.fetch_add(1, Ordering::SeqCst) + 1;
        if in_flight as usize > cbc_protocol::MAX_OUTSTANDING_REQUESTS {
            state.outstanding.fetch_sub(1, Ordering::SeqCst);
            if let Some(id) = request.id.clone() {
                let mut guard = outbound.lock().expect("outbound lock");
                let _ = guard.response(&RpcResponse::err(
                    id,
                    RpcError::new(
                        error_codes::TOO_MANY_REQUESTS,
                        format!(
                            "outstanding request limit of {} exceeded",
                            cbc_protocol::MAX_OUTSTANDING_REQUESTS
                        ),
                    ),
                ));
            }
            continue;
        }

        let is_shutdown = request.method == "runtime.shutdown";

        // P0-04: the reader and the executors are decoupled. Every request runs on
        // its own thread with a cancel token registered under its request id, so a
        // `runtime.cancel` (or a second request such as `process.stop`) can land
        // while a long `process.run` is still blocking its own response.
        let request_token = cbc_process::CancelToken::new();
        if let Some(id) = request.id.as_ref() {
            state
                .cancel_tokens
                .lock()
                .expect("cancel lock")
                .insert(format!("req:{id}"), request_token.clone());
        }

        if is_shutdown {
            // Shutdown stays inline: it must observe every response written so far
            // and terminate the loop deterministically.
            let outcome = dispatch(&state, &request);
            state.outstanding.fetch_sub(1, Ordering::SeqCst);
            if let Some(id) = request.id.clone() {
                state
                    .cancel_tokens
                    .lock()
                    .expect("cancel lock")
                    .remove(&format!("req:{id}"));
                let response =
                    respond(id, outcome.unwrap_or(Ok(serde_json::json!({ "ok": true }))));
                let mut guard = outbound.lock().expect("outbound lock");
                if guard.response(&response).is_err() {
                    break 10;
                }
            }
            break 0;
        }

        let thread_state = Arc::clone(&state);
        let thread_outbound = Arc::clone(&outbound);
        std::thread::spawn(move || {
            let outcome = dispatch(&thread_state, &request);
            if let Some(id) = request.id.as_ref() {
                thread_state
                    .cancel_tokens
                    .lock()
                    .expect("cancel lock")
                    .remove(&format!("req:{id}"));
            }
            thread_state.outstanding.fetch_sub(1, Ordering::SeqCst);
            if let (Some(id), Some(outcome)) = (request.id.clone(), outcome) {
                let response = respond(id, outcome);
                let mut guard = thread_outbound.lock().expect("outbound lock");
                let _ = guard.response(&response);
            }
        });
    };

    // §14.6 / §24.1 invariant 6: never leave an orphan behind.
    state.supervisor.terminate_all(1_500);
    let _ = io::stdout().flush();
    std::process::exit(exit_code);
}
