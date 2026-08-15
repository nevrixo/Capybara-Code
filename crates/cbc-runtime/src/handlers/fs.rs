//! `fs.*` read handlers — PRD §12.2, §12.4, §18.5, §20.3.
//!
//! Every path is re-resolved through the guard here, independent of any
//! TypeScript-side decision (§19.7).

use std::collections::HashSet;

use cbc_fs::{SearchOptions, WalkOptions};
use cbc_protocol::RpcError;
use cbc_workspace::{PathIntent, ResolveOptions};
use serde_json::{json, Value};

use crate::server::{
    fs_error, guard_error, optional_bool, optional_str, optional_u64, optional_usize, required_str,
    string_array, RuntimeState,
};

fn walk_options(params: &Value) -> WalkOptions {
    // The TypeScript schema is a convenience boundary; these clamps are the
    // trusted-plane backstop for direct or compromised RPC callers.
    WalkOptions {
        max_entries: optional_usize(params, "maxEntries", 5_000).clamp(1, 5_000),
        max_depth: optional_usize(params, "maxDepth", 32).clamp(1, 64),
        include_ignored: optional_bool(params, "includeIgnored", false),
        extra_ignored: string_array(params, "ignore"),
    }
}

fn is_sensitive_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        ".env",
        ".pem",
        ".key",
        "id_rsa",
        "id_ed25519",
        ".ssh/",
        ".aws/",
        ".npmrc",
        ".netrc",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn sensitive_read_allowed(state: &RuntimeState, path: &str, params: &Value) -> bool {
    let Some(receipt_id) = optional_str(params, "capabilityReceipt") else {
        return false;
    };
    let guard = state.capabilities.lock().expect("capability lock");
    guard.get(&receipt_id).is_some_and(|receipt| {
        !receipt.consumed
            && receipt.expires_at_ms > crate::server::now_ms_for_handler()
            && receipt.operation == "fs.read"
            && receipt.resources.iter().any(|resource| resource == path)
    })
}

fn resolve_read(
    state: &RuntimeState,
    ws: &cbc_workspace::Workspace,
    path: &str,
    params: &Value,
) -> Result<cbc_workspace::ResolvedPath, RpcError> {
    let _ = state;
    let options = ResolveOptions {
        allow_absolute: optional_bool(params, "allowAbsolute", false),
        allow_missing: false,
        lease_globs: None,
        allow_sensitive: sensitive_read_allowed(state, path, params),
        allowed_roots: Vec::new(),
    };
    ws.resolve(path, PathIntent::Read, &options)
        .map_err(guard_error)
}

pub fn list(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let requested = optional_str(&params, "path").unwrap_or_else(|| ".".to_string());
    let options = ResolveOptions {
        allow_absolute: optional_bool(&params, "allowAbsolute", false),
        allow_missing: false,
        lease_globs: None,
        allow_sensitive: true, // listing a directory reveals no file contents
        allowed_roots: Vec::new(),
    };
    let resolved = ws
        .resolve(&requested, PathIntent::List, &options)
        .map_err(guard_error)?;

    if !resolved.exists {
        return Err(RpcError::with_data(
            cbc_protocol::error_codes::NOT_FOUND,
            format!("{} was not found", resolved.relative),
            json!({
                "taxonomy": "NOT_FOUND",
                "path": resolved.relative,
                "action": "confirm the directory with fs.list or fs.glob",
            }),
        ));
    }
    if !resolved.absolute.is_dir() {
        return Err(RpcError::with_data(
            cbc_protocol::error_codes::INVALID_ARGUMENT,
            format!("{} is not a directory", resolved.relative),
            json!({
                "taxonomy": "INVALID_ARGUMENT",
                "path": resolved.relative,
                "action": "use fs.read for a file or provide a directory path",
            }),
        ));
    }

    let result =
        cbc_fs::list_dir(&ws, &resolved.absolute, &walk_options(&params)).map_err(|error| {
            let (code, taxonomy) = match error.kind() {
                std::io::ErrorKind::NotFound => (cbc_protocol::error_codes::NOT_FOUND, "NOT_FOUND"),
                std::io::ErrorKind::PermissionDenied => (
                    cbc_protocol::error_codes::PERMISSION_DENIED,
                    "PERMISSION_DENIED",
                ),
                _ => (cbc_protocol::error_codes::INTERNAL_ERROR, "INTERNAL"),
            };
            RpcError::with_data(
                code,
                format!("could not list {}: {error}", resolved.relative),
                json!({
                    "taxonomy": taxonomy,
                    "path": resolved.relative,
                    "action": "retry after confirming the directory still exists and is readable",
                }),
            )
        })?;
    Ok(json!({
        "path": resolved.relative,
        "entries": result.entries,
        "truncated": result.truncated,
        "totalScanned": result.total_scanned,
    }))
}

pub fn glob(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let pattern = required_str(&params, "pattern")?;
    let limit = optional_usize(&params, "limit", 500).clamp(1, 2_000);
    let walked = cbc_fs::glob_search_bounded(&ws, &pattern, &walk_options(&params));
    let truncated = walked.truncated || walked.entries.len() > limit;
    Ok(json!({
        "pattern": pattern,
        "entries": walked.entries.into_iter().take(limit).collect::<Vec<_>>(),
        "truncated": truncated,
    }))
}

pub fn search(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let query = required_str(&params, "query")?;
    let options = SearchOptions {
        max_matches: optional_usize(&params, "maxMatches", 200).clamp(1, 500),
        max_matches_per_file: optional_usize(&params, "maxMatchesPerFile", 20).clamp(1, 100),
        case_sensitive: optional_bool(&params, "caseSensitive", false),
        include_glob: optional_str(&params, "include"),
        max_file_bytes: optional_usize(&params, "maxFileBytes", 2 * 1024 * 1024)
            .clamp(1, 8 * 1024 * 1024) as u64,
        max_line_bytes: optional_usize(&params, "maxLineBytes", 1000).clamp(1, 8_000),
        walk: walk_options(&params),
    };
    let result = cbc_fs::search_literal(&ws, &query, &options);

    // Matched lines are workspace content, but they can still contain secrets
    // (§9.8 covers model-bound excerpts).
    let matches: Vec<Value> = result
        .matches
        .iter()
        .map(|m| {
            json!({
                "path": m.path,
                "line": m.line,
                "column": m.column,
                "text": state.safe_text(&m.text),
            })
        })
        .collect();

    Ok(json!({
        "query": query,
        "matches": matches,
        "filesSearched": result.files_searched,
        "filesWithMatches": result.files_with_matches,
        "truncated": result.truncated,
    }))
}

pub fn read(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    read_one(state, &params, false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadMode {
    Preview,
    Exact,
}

impl ReadMode {
    fn parse(params: &Value) -> Result<Self, RpcError> {
        match optional_str(params, "mode").as_deref() {
            None | Some("exact") => Ok(Self::Exact),
            Some("preview") => Ok(Self::Preview),
            Some(other) => Err(RpcError::invalid_params(format!(
                "mode must be 'preview' or 'exact', got '{other}'"
            ))),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Exact => "exact",
        }
    }

    fn authoritative_for_write(self) -> bool {
        matches!(self, Self::Exact)
    }
}

fn read_limits(params: &Value) -> (usize, u64) {
    let max_lines =
        optional_usize(params, "maxLines", cbc_fs::DEFAULT_READ_MAX_LINES).clamp(1, 5_000);
    // `maxBytes` bounds retained/output text. Exact reads still scan and hash
    // the complete file, so a long file does not become a large memory buffer.
    let max_bytes = optional_u64(params, "maxBytes")
        .unwrap_or(cbc_fs::DEFAULT_MAX_FILE_BYTES)
        .clamp(1, 8 * cbc_fs::DEFAULT_MAX_FILE_BYTES);
    (max_lines, max_bytes)
}

fn read_error_value(path: &str, error: &RpcError) -> Value {
    json!({
        "path": path,
        "code": error.code,
        "message": error.message,
        "taxonomy": error.data.as_ref().and_then(|data| data.get("taxonomy").cloned()),
        "details": error.data.clone(),
    })
}

fn range_response(
    state: &RuntimeState,
    path: &str,
    mode: ReadMode,
    range: cbc_fs::TextRangeRead,
    traversed_symlink: bool,
) -> Value {
    let total_lines = range.total_lines;
    let omitted_before = range.start_line.saturating_sub(1);
    let omitted_after = total_lines
        .map(|total| total.saturating_sub(range.end_line))
        .unwrap_or(0);
    let partial =
        omitted_before > 0 || omitted_after > 0 || !range.end_of_file || range.truncated_by_bytes;
    let display_checksum = range.checksum.as_deref().unwrap_or(&range.revision_token);
    let display_total_lines = total_lines.unwrap_or_else(|| {
        range
            .end_line
            .max(range.start_line)
            .saturating_add(if range.end_of_file { 0 } else { 1 })
    });
    let excerpt = cbc_fs::FileExcerpt {
        path: path.to_string(),
        checksum: display_checksum.to_string(),
        start_line: range.start_line,
        end_line: range.end_line,
        total_lines: display_total_lines,
        text: range.text.clone(),
        partial,
        omitted_before,
        omitted_after,
    };
    let mut rendered = state.safe_text(&excerpt.render());
    if mode == ReadMode::Preview && (!range.end_of_file || range.truncated_by_bytes) {
        rendered.push_str("[preview incomplete: request an exact range before writing]");
    }
    let excerpt_text = state.safe_text(&excerpt.text);

    let mut excerpt_value = json!({
        "path": excerpt.path.clone(),
        "startLine": excerpt.start_line,
        "endLine": excerpt.end_line,
        "text": excerpt_text,
        "partial": excerpt.partial,
        "omittedBefore": excerpt.omitted_before,
        "omittedAfter": excerpt.omitted_after,
        "endOfFile": range.end_of_file,
        "truncatedByBytes": range.truncated_by_bytes,
    });
    if let Some(total) = total_lines {
        excerpt_value["totalLines"] = json!(total);
    }
    if let Some(checksum) = &range.checksum {
        excerpt_value["checksum"] = json!(checksum);
    }

    let mut result = json!({
        "path": path,
        "binary": false,
        "mode": mode.label(),
        "revisionToken": range.revision_token,
        "authoritativeForWrite": mode.authoritative_for_write(),
        "excerpt": excerpt_value,
        "rendered": rendered,
        "traversedSymlink": traversed_symlink,
        "bytes": range.bytes,
        "selectedLines": range.selected_lines,
        "truncatedByBytes": range.truncated_by_bytes,
        "truncated": !range.end_of_file || range.truncated_by_bytes,
    });
    if let Some(checksum) = range.checksum {
        result["checksum"] = json!(checksum);
    }
    result
}

fn read_one(
    state: &RuntimeState,
    params: &Value,
    capability_already_consumed: bool,
) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let path = required_str(params, "path")?;
    let mode = ReadMode::parse(params)?;
    let resolved = resolve_read(state, &ws, &path, params)?;
    if !capability_already_consumed && sensitive_read_allowed(state, &resolved.relative, params) {
        let resources = vec![resolved.relative.clone()];
        state.consume_capability(params, "fs.read", None, &[], None, &resources, None)?;
    }

    let relative_path = std::path::Path::new(&resolved.relative);
    if cbc_fs::is_probably_binary_beneath(ws.root(), relative_path).map_err(fs_error)? {
        let bytes = cbc_fs::file_len_beneath(ws.root(), relative_path).map_err(fs_error)?;
        let metadata_token =
            cbc_fs::revision_token_beneath(ws.root(), relative_path).map_err(fs_error)?;
        let checksum = if mode.authoritative_for_write() {
            Some(cbc_fs::hash_file_beneath(ws.root(), relative_path).map_err(fs_error)?)
        } else {
            None
        };
        let revision_token = checksum.clone().unwrap_or(metadata_token);
        let mut result = json!({
            "path": resolved.relative,
            "binary": true,
            "bytes": bytes,
            "text": Value::Null,
            "mode": mode.label(),
            "revisionToken": revision_token,
            "authoritativeForWrite": mode.authoritative_for_write(),
            "excerpt": {
                "startLine": 1,
                "endLine": 1,
                "endOfFile": true,
                "text": "",
                "truncatedByBytes": false,
            },
            "truncated": false,
        });
        if let Some(checksum) = checksum {
            result["checksum"] = json!(checksum);
        }
        return Ok(result);
    }

    let start_line = optional_usize(&params, "startLine", 1);
    if start_line == 0 {
        return Err(RpcError::invalid_params("startLine must be at least 1"));
    }
    let (max_lines, max_bytes) = read_limits(params);
    let range = match mode {
        ReadMode::Preview => cbc_fs::preview_text_range_beneath(
            ws.root(),
            relative_path,
            start_line,
            max_lines,
            max_bytes,
        ),
        ReadMode::Exact => cbc_fs::read_text_range_beneath(
            ws.root(),
            relative_path,
            start_line,
            max_lines,
            max_bytes,
        ),
    }
    .map_err(fs_error)?;

    Ok(range_response(
        state,
        &resolved.relative,
        mode,
        range,
        resolved.traversed_symlink,
    ))
}

pub fn read_many(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let has_items = params.get("items").is_some();
    let mut item_params = Vec::new();
    let requested;
    let legacy_paths;
    if has_items {
        let Some(items) = params.get("items").and_then(Value::as_array) else {
            return Err(RpcError::invalid_params("items must be an array"));
        };
        if items.is_empty() {
            return Err(RpcError::invalid_params("items must be a non-empty array"));
        }
        requested = items.len();
        legacy_paths = false;
        for item in items {
            let Some(object) = item.as_object() else {
                return Err(RpcError::invalid_params(
                    "each read_many item must be an object",
                ));
            };
            let Some(path) = object.get("path").and_then(Value::as_str) else {
                return Err(RpcError::invalid_params("each read_many item needs a path"));
            };
            let mut single = params.clone();
            single["path"] = Value::String(path.to_string());
            for key in ["startLine", "maxLines", "mode", "maxBytes", "allowAbsolute"] {
                if let Some(value) = object.get(key) {
                    single[key] = value.clone();
                }
            }
            item_params.push(single);
        }
    } else {
        let paths = string_array(&params, "paths");
        if paths.is_empty() {
            return Err(RpcError::invalid_params(
                "paths or items must be a non-empty array",
            ));
        }
        requested = paths.len();
        legacy_paths = true;
        item_params = paths
            .into_iter()
            .map(|path| {
                let mut single = params.clone();
                single["path"] = Value::String(path);
                single
            })
            .collect();
    }

    // Keep the batch bounded and preserve the legacy path de-duplication. V2
    // items intentionally are not de-duplicated: two ranges of one file are two
    // distinct requests.
    let limit = optional_usize(&params, "limit", 20).clamp(1, 50);
    let mut truncated = requested > limit;
    let mut seen = HashSet::new();
    let mut selected = Vec::new();
    for single in item_params.into_iter().take(limit) {
        let path = required_str(&single, "path")?;
        if legacy_paths && !seen.insert(path) {
            continue;
        }
        selected.push(single);
    }

    let mut unique_paths = Vec::new();
    let mut unique_path_set = HashSet::new();
    for path in selected
        .iter()
        .filter_map(|single| single.get("path").and_then(Value::as_str))
    {
        if unique_path_set.insert(path.to_string()) {
            unique_paths.push(path.to_string());
        }
    }
    let sensitive_batch = unique_paths.iter().any(|path| is_sensitive_path(path));
    if sensitive_batch {
        state.consume_capability(&params, "fs.read", None, &[], None, &unique_paths, None)?;
    }

    let default_total_lines = selected.len().saturating_mul(5_000).max(1);
    let max_total_lines =
        optional_usize(&params, "maxTotalLines", default_total_lines).clamp(1, 10_000);
    let default_total_bytes = (selected.len() as u64)
        .saturating_mul(8 * cbc_fs::DEFAULT_MAX_FILE_BYTES)
        .max(1);
    let max_total_bytes = optional_u64(&params, "maxTotalBytes")
        .unwrap_or(default_total_bytes)
        .clamp(1, 16 * cbc_fs::DEFAULT_MAX_FILE_BYTES);
    // Accepted for protocol compatibility and future parallel readers. Running
    // in request order keeps capability consumption and errors deterministic.
    let concurrency = optional_usize(&params, "concurrency", 4).clamp(1, 8);

    let mut results = Vec::new();
    let mut errors = Vec::new();
    let mut total_lines = 0usize;
    let mut total_bytes = 0u64;
    for mut single in selected {
        let path = required_str(&single, "path")?;
        let remaining_lines = max_total_lines.saturating_sub(total_lines);
        let remaining_bytes = max_total_bytes.saturating_sub(total_bytes);
        if remaining_lines == 0 || remaining_bytes == 0 {
            truncated = true;
            break;
        }
        let (requested_lines, requested_bytes) = read_limits(&single);
        single["maxLines"] = json!(requested_lines.min(remaining_lines));
        single["maxBytes"] = json!(requested_bytes.min(remaining_bytes));

        match read_one(state, &single, sensitive_batch) {
            Ok(value) => {
                let item_lines = value
                    .get("selectedLines")
                    .and_then(Value::as_u64)
                    .unwrap_or_else(|| {
                        value
                            .get("excerpt")
                            .and_then(|excerpt| {
                                Some((
                                    excerpt.get("startLine")?.as_u64()?,
                                    excerpt.get("endLine")?.as_u64()?,
                                ))
                            })
                            .map(|(start, end)| end.saturating_sub(start).saturating_add(1))
                            .unwrap_or(0)
                    }) as usize;
                let item_bytes = value
                    .get("excerpt")
                    .and_then(|excerpt| excerpt.get("text"))
                    .and_then(Value::as_str)
                    .map(|text| text.len() as u64)
                    .unwrap_or(0);
                total_lines = total_lines.saturating_add(item_lines);
                total_bytes = total_bytes.saturating_add(item_bytes);
                if value
                    .get("truncated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    truncated = true;
                }
                results.push(value);
            }
            Err(error) => errors.push(read_error_value(&path, &error)),
        }
    }

    Ok(json!({
        "files": results,
        "errors": errors,
        "truncated": truncated,
        "requested": requested,
        "limit": limit,
        "totalLines": total_lines,
        "totalBytes": total_bytes,
        "maxTotalLines": max_total_lines,
        "maxTotalBytes": max_total_bytes,
        "concurrency": concurrency,
    }))
}

pub fn fingerprint(state: &RuntimeState, params: Value) -> Result<Value, RpcError> {
    let ws = state.require_workspace()?;
    let path = required_str(&params, "path")?;
    let resolved = resolve_read(state, &ws, &path, &params)?;
    if sensitive_read_allowed(state, &resolved.relative, &params) {
        let resources = vec![resolved.relative.clone()];
        state.consume_capability(&params, "fs.read", None, &[], None, &resources, None)?;
    }
    let relative = std::path::Path::new(&resolved.relative);
    let bytes = cbc_fs::file_len_beneath(ws.root(), relative).map_err(fs_error)?;
    let include_checksum = optional_bool(&params, "includeChecksum", false);
    let metadata_token = cbc_fs::revision_token_beneath(ws.root(), relative).map_err(fs_error)?;
    let checksum = if include_checksum {
        Some(cbc_fs::hash_file_beneath(ws.root(), relative).map_err(fs_error)?)
    } else {
        None
    };
    let revision_token = checksum.clone().unwrap_or(metadata_token);
    let mut result = json!({
        "path": resolved.relative,
        "revisionToken": revision_token.clone(),
        "fingerprint": revision_token.clone(),
        "bytes": bytes,
        "authoritativeForWrite": include_checksum,
    });
    if let Some(checksum) = checksum {
        result["checksum"] = json!(checksum);
    }
    Ok(result)
}
