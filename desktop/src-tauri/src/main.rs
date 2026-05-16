use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::State;

struct AppState {
    proxy: Mutex<Option<Child>>,
    last_listen: Mutex<String>,
    root: PathBuf,
}

#[derive(Serialize)]
struct AppInfo {
    root: String,
    binary: String,
    captures_dir: String,
    ca_cert: String,
}

#[derive(Serialize)]
struct ProxyStatus {
    running: bool,
    pid: Option<u32>,
    external: bool,
    message: String,
}

#[derive(Serialize)]
struct CaptureFile {
    name: String,
    size: u64,
    modified: Option<u64>,
}

#[derive(Serialize)]
struct ToolStatus {
    id: String,
    label: String,
    wrapper: String,
    command: String,
    wrapper_exists: bool,
    command_path: Option<String>,
}

#[derive(Serialize)]
struct EnvironmentStatus {
    proxy_binary: String,
    proxy_binary_exists: bool,
    ca_cert: String,
    ca_cert_exists: bool,
    ca_key: String,
    ca_key_exists: bool,
    tools: Vec<ToolStatus>,
}

#[derive(Serialize, Clone)]
struct FlowSummary {
    id: String,
    method: String,
    url: String,
    host: String,
    path: String,
    provider: String,
    status: Option<u64>,
    reason: Option<String>,
    chunk_count: usize,
    total_chunk_bytes: u64,
    request_size: Option<u64>,
    started_at: Option<String>,
    updated_at: Option<String>,
    semantic: SemanticInfo,
}

#[derive(Serialize, Clone)]
struct SemanticInfo {
    category: String,
    client: Option<String>,
    rpc_method: Option<String>,
    mcp_server: Option<String>,
    tool_names: Vec<String>,
    skill_names: Vec<String>,
    model: Option<String>,
    event_type: Option<String>,
    token_usage: TokenUsage,
    redaction_hits: usize,
}

#[derive(Serialize, Clone, Default)]
struct TokenUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

#[derive(Serialize)]
struct CaptureIndex {
    file: Option<CaptureFile>,
    flows: Vec<FlowSummary>,
    last_flow_id: Option<String>,
}

#[derive(Serialize)]
struct FlowDetail {
    request: Option<Value>,
    response_start: Option<Value>,
    chunks: Vec<Value>,
    summary: FlowSummary,
    reconstructed_response: String,
}

#[derive(Default)]
struct FlowGroup {
    request: Option<Value>,
    response_start: Option<Value>,
    chunks: Vec<Value>,
}

#[derive(Serialize, Clone)]
struct ClaudeSessionSummary {
    file_name: String,
    session_id: Option<String>,
    slug: Option<String>,
    size: u64,
    modified: Option<u64>,
    message_count: usize,
    user_messages: usize,
    assistant_messages: usize,
    tool_uses: usize,
    tool_results: usize,
    thinking_blocks: usize,
    models: Vec<String>,
    token_usage: TokenUsage,
}

#[derive(Serialize)]
struct ClaudeSessionIndex {
    project_dir: String,
    storage_dir: String,
    sessions: Vec<ClaudeSessionSummary>,
    latest_session_id: Option<String>,
}

#[derive(Serialize)]
struct ClaudeToolUse {
    id: String,
    name: String,
    input_preview: String,
    input: Value,
}

#[derive(Serialize)]
struct ClaudeToolResult {
    tool_use_id: String,
    is_error: bool,
    content_preview: String,
    content: Value,
}

#[derive(Serialize)]
struct ClaudeSessionMessage {
    uuid: Option<String>,
    parent_uuid: Option<String>,
    timestamp: Option<String>,
    type_name: Option<String>,
    subtype: Option<String>,
    role: String,
    model: Option<String>,
    stop_reason: Option<String>,
    text_preview: String,
    thinking_count: usize,
    tool_uses: Vec<ClaudeToolUse>,
    tool_results: Vec<ClaudeToolResult>,
    token_usage: TokenUsage,
    raw: Value,
}

#[derive(Serialize)]
struct ClaudeSessionDetail {
    session: Option<ClaudeSessionSummary>,
    messages: Vec<ClaudeSessionMessage>,
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        root: display_path(&state.root),
        binary: display_path(&proxy_binary(&state.root)),
        captures_dir: display_path(&state.root.join("captures")),
        ca_cert: display_path(&state.root.join("ca/cc-capture-ca.pem")),
    }
}

#[tauri::command]
fn proxy_status(state: State<'_, AppState>) -> Result<ProxyStatus, String> {
    status_from_state(&state)
}

#[tauri::command]
fn start_proxy(
    state: State<'_, AppState>,
    listen: String,
    body_limit: String,
    capture_all: bool,
    force_new_capture: Option<bool>,
) -> Result<ProxyStatus, String> {
    let force_new_capture = force_new_capture.unwrap_or(false);
    *state.last_listen.lock().map_err(|err| err.to_string())? = listen.clone();
    let mut proxy = state.proxy.lock().map_err(|err| err.to_string())?;
    if let Some(child) = proxy.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            if force_new_capture {
                let _ = child.kill();
                let _ = child.wait();
                *proxy = None;
            } else {
                return Ok(ProxyStatus {
                    running: true,
                    pid: Some(child.id()),
                    external: false,
                    message: "Proxy running from desktop app".to_owned(),
                });
            }
        }
    }

    let binary = proxy_binary(&state.root);
    if !binary.exists() {
        return Err(format!(
            "proxy binary not found: {}. Run `cargo build --release` in the native project first.",
            binary.display()
        ));
    }

    if port_is_open(&listen) {
        *proxy = None;
        if force_new_capture {
            if recycle_orphan_proxy_on_port(&listen, &binary)? && !port_is_open(&listen) {
                // Continue below and spawn a fresh proxy, which creates a new capture file.
            } else {
                return Err(format!(
                    "{listen} is already used by an external proxy. Stop that process or choose another port before opening a fresh capture."
                ));
            }
        } else {
            return Ok(ProxyStatus {
                running: true,
                pid: None,
                external: true,
                message: format!("{listen} is already listening"),
            });
        }
    }

    fs::create_dir_all(state.root.join("captures")).map_err(|err| err.to_string())?;
    let log_path = state.root.join("desktop-proxy.log");
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| err.to_string())?;
    let log_err = log.try_clone().map_err(|err| err.to_string())?;

    let child = Command::new(binary)
        .arg("run")
        .current_dir(&state.root)
        .env("CCC_LISTEN", listen)
        .env("CCC_OUTPUT_DIR", state.root.join("captures"))
        .env("CCC_CA_CERT", state.root.join("ca/cc-capture-ca.pem"))
        .env("CCC_CA_KEY", state.root.join("ca/cc-capture-ca.key"))
        .env("CCC_BODY_LIMIT", body_limit)
        .env(
            "CCC_CAPTURE_ALL",
            if capture_all { "true" } else { "false" },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|err| err.to_string())?;

    let pid = child.id();
    *proxy = Some(child);
    Ok(ProxyStatus {
        running: true,
        pid: Some(pid),
        external: false,
        message: format!("Proxy started, logs: {}", log_path.display()),
    })
}

#[tauri::command]
fn stop_proxy(state: State<'_, AppState>) -> Result<ProxyStatus, String> {
    let mut proxy = state.proxy.lock().map_err(|err| err.to_string())?;
    if let Some(mut child) = proxy.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(ProxyStatus {
        running: false,
        pid: None,
        external: false,
        message: "Proxy stopped".to_owned(),
    })
}

#[tauri::command]
fn list_capture_files(state: State<'_, AppState>) -> Result<Vec<CaptureFile>, String> {
    capture_files(&state.root.join("captures"))
}

fn capture_files(dir: &Path) -> Result<Vec<CaptureFile>, String> {
    let mut files = Vec::new();
    if !dir.exists() {
        return Ok(files);
    }

    for entry in fs::read_dir(dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        files.push(CaptureFile {
            name: entry.file_name().to_string_lossy().to_string(),
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs()),
        });
    }
    files.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(files)
}

#[tauri::command]
fn read_capture_file(state: State<'_, AppState>, name: String) -> Result<Value, String> {
    let path = safe_capture_path(&state.root.join("captures"), &name)?;
    let records = read_records(&path)?;
    Ok(json!({ "records": records }))
}

#[tauri::command]
fn read_capture_index(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<CaptureIndex, String> {
    capture_index_for_root(&state.root, name)
}

fn capture_index_for_root(root: &Path, name: Option<String>) -> Result<CaptureIndex, String> {
    let captures_dir = root.join("captures");
    let files = capture_files(&captures_dir)?;
    let file = match name {
        Some(name) => files.into_iter().find(|file| file.name == name),
        None => files.into_iter().next(),
    };
    let Some(file) = file else {
        return Ok(CaptureIndex {
            file: None,
            flows: Vec::new(),
            last_flow_id: None,
        });
    };

    let path = safe_capture_path(&captures_dir, &file.name)?;
    let groups = group_records(read_records(&path)?);
    let mut flows: Vec<FlowSummary> = groups
        .iter()
        .map(|(id, group)| summarize_flow(id, group))
        .collect();
    infer_clients_from_connection(&groups, &mut flows);
    flows.sort_by(|a, b| flow_sort_key(&a.id).cmp(&flow_sort_key(&b.id)));
    let last_flow_id = flows.last().map(|flow| flow.id.clone());

    Ok(CaptureIndex {
        file: Some(file),
        flows,
        last_flow_id,
    })
}

#[tauri::command]
fn read_flow_detail(
    state: State<'_, AppState>,
    name: String,
    flow_id: String,
) -> Result<FlowDetail, String> {
    let path = safe_capture_path(&state.root.join("captures"), &name)?;
    let groups = group_records(read_records(&path)?);
    let group = groups
        .get(&flow_id)
        .ok_or_else(|| format!("flow not found: {flow_id}"))?;
    let mut summary = summarize_flow(&flow_id, group);
    infer_client_for_summary(&groups, group, &mut summary);

    Ok(FlowDetail {
        request: group.request.clone(),
        response_start: group.response_start.clone(),
        chunks: group.chunks.clone(),
        summary,
        reconstructed_response: reconstruct_response(group),
    })
}

#[tauri::command]
fn environment_status(state: State<'_, AppState>) -> EnvironmentStatus {
    let proxy_binary = proxy_binary(&state.root);
    let ca_cert = state.root.join("ca/cc-capture-ca.pem");
    let ca_key = state.root.join("ca/cc-capture-ca.key");
    EnvironmentStatus {
        proxy_binary: display_path(&proxy_binary),
        proxy_binary_exists: proxy_binary.exists(),
        ca_cert: display_path(&ca_cert),
        ca_cert_exists: ca_cert.exists(),
        ca_key: display_path(&ca_key),
        ca_key_exists: ca_key.exists(),
        tools: ["claude", "codex"]
            .iter()
            .map(|tool| tool_status(&state.root, tool))
            .collect(),
    }
}

#[tauri::command]
fn run_helper(state: State<'_, AppState>, helper: String) -> Result<String, String> {
    let allowed = match helper.as_str() {
        "trust-ca" => "bin/trust-ca-macos.sh",
        "untrust-ca" => "bin/untrust-ca-macos.sh",
        "gen-ca" => "bin/gen-ca.sh",
        _ => return Err("unknown helper".to_owned()),
    };
    let output = Command::new(state.root.join(allowed))
        .current_dir(&state.root)
        .output()
        .map_err(|err| err.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        Ok(format!("{stdout}{stderr}"))
    } else {
        Err(format!("{stdout}{stderr}"))
    }
}

#[tauri::command]
fn tool_statuses(state: State<'_, AppState>) -> Vec<ToolStatus> {
    ["claude", "codex"]
        .iter()
        .map(|tool| tool_status(&state.root, tool))
        .collect()
}

#[tauri::command]
fn read_claude_session_index(state: State<'_, AppState>) -> Result<ClaudeSessionIndex, String> {
    let storage_dir = claude_project_dir(&state.root)?;
    let mut sessions = Vec::new();
    if storage_dir.exists() {
        for entry in fs::read_dir(&storage_dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let metadata = entry.metadata().map_err(|err| err.to_string())?;
            let records = read_records(&path)?;
            sessions.push(summarize_claude_session(
                entry.file_name().to_string_lossy().as_ref(),
                metadata.len(),
                metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs()),
                &records,
            ));
        }
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    let latest_session_id = sessions.first().map(|session| session.file_name.clone());
    Ok(ClaudeSessionIndex {
        project_dir: display_path(&state.root),
        storage_dir: display_path(&storage_dir),
        sessions,
        latest_session_id,
    })
}

#[tauri::command]
fn read_claude_session_detail(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<ClaudeSessionDetail, String> {
    claude_session_detail_for_root(&state.root, session_id)
}

fn claude_session_detail_for_root(
    root: &Path,
    session_id: Option<String>,
) -> Result<ClaudeSessionDetail, String> {
    let storage_dir = claude_project_dir(root)?;
    let mut sessions = Vec::new();
    if storage_dir.exists() {
        for entry in fs::read_dir(&storage_dir).map_err(|err| err.to_string())? {
            let entry = entry.map_err(|err| err.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let metadata = entry.metadata().map_err(|err| err.to_string())?;
            let records = read_records(&path)?;
            sessions.push(summarize_claude_session(
                entry.file_name().to_string_lossy().as_ref(),
                metadata.len(),
                metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs()),
                &records,
            ));
        }
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    let session = match session_id {
        Some(id) => sessions.into_iter().find(|session| {
            session.file_name == id || session.session_id.as_deref() == Some(id.as_str())
        }),
        None => sessions.into_iter().next(),
    };
    let Some(session) = session else {
        return Ok(ClaudeSessionDetail {
            session: None,
            messages: Vec::new(),
        });
    };
    let path = safe_session_path(&claude_project_dir(root)?, &session.file_name)?;
    let records = read_records(&path)?;
    Ok(ClaudeSessionDetail {
        session: Some(session),
        messages: records
            .iter()
            .filter_map(summarize_claude_message)
            .collect(),
    })
}

#[tauri::command]
fn read_loop_index(
    state: State<'_, AppState>,
    capture_name: Option<String>,
    session_id: Option<String>,
) -> Result<Value, String> {
    let capture = capture_index_for_root(&state.root, capture_name)?;
    let session = claude_session_detail_for_root(&state.root, session_id)?;
    let session_summary = session.session.as_ref();
    let flow_count = capture.flows.len();
    let message_count = session.messages.len();
    let step_count = flow_count
        + message_count
        + session_summary
            .map(|item| item.tool_uses + item.tool_results)
            .unwrap_or(0);
    let diagnostics = loop_diagnostics(&capture, &session);

    Ok(json!({
        "loop_id": format!(
            "{}::{}",
            capture.file.as_ref().map(|file| file.name.as_str()).unwrap_or("no-capture"),
            session_summary.map(|item| item.file_name.as_str()).unwrap_or("no-session")
        ),
        "capture_file": capture.file,
        "session": session_summary,
        "turn_count": session_summary.map(|item| item.user_messages).unwrap_or(0),
        "step_count": step_count,
        "flow_count": flow_count,
        "message_count": message_count,
        "last_step": capture.last_flow_id,
        "totals": {
            "tokens": session_summary.map(|item| &item.token_usage),
            "tool_uses": session_summary.map(|item| item.tool_uses).unwrap_or(0),
            "tool_results": session_summary.map(|item| item.tool_results).unwrap_or(0),
        },
        "diagnostics": diagnostics,
    }))
}

#[tauri::command]
fn read_loop_detail(state: State<'_, AppState>, loop_id: String) -> Result<Value, String> {
    let capture = capture_index_for_root(&state.root, None)?;
    let session = claude_session_detail_for_root(&state.root, None)?;
    Ok(json!({
        "loop_id": loop_id,
        "capture_index": capture,
        "claude_session": session,
        "note": "Loop semantics are assembled in the frontend loopModel layer from this raw detail payload."
    }))
}

#[tauri::command]
fn read_loop_step_detail(
    state: State<'_, AppState>,
    loop_id: String,
    step_id: String,
) -> Result<Value, String> {
    let detail = read_loop_detail(state, loop_id)?;
    Ok(json!({
        "step_id": step_id,
        "detail": detail,
        "note": "v1 exposes raw loop detail; frontend selects the matching step locally."
    }))
}

fn loop_diagnostics(capture: &CaptureIndex, session: &ClaudeSessionDetail) -> Vec<String> {
    let mut diagnostics = Vec::new();
    if capture.file.is_none() {
        diagnostics.push("No capture file selected.".to_owned());
    }
    if capture.flows.is_empty() {
        diagnostics.push("No proxy flows available for network correlation.".to_owned());
    }
    if session.session.is_none() {
        diagnostics.push("No Claude session sidecar found.".to_owned());
    }
    if session.messages.is_empty() {
        diagnostics.push("No Claude session messages parsed.".to_owned());
    }
    if diagnostics.is_empty() {
        diagnostics.push("Loop index ready.".to_owned());
    }
    diagnostics
}

fn summarize_claude_session(
    file_name: &str,
    size: u64,
    modified: Option<u64>,
    records: &[Value],
) -> ClaudeSessionSummary {
    let mut summary = ClaudeSessionSummary {
        file_name: file_name.to_owned(),
        session_id: None,
        slug: None,
        size,
        modified,
        message_count: records.len(),
        user_messages: 0,
        assistant_messages: 0,
        tool_uses: 0,
        tool_results: 0,
        thinking_blocks: 0,
        models: Vec::new(),
        token_usage: TokenUsage::default(),
    };

    for record in records {
        summary.session_id = summary
            .session_id
            .or_else(|| string_field(record, "sessionId"));
        summary.slug = summary.slug.or_else(|| string_field(record, "slug"));
        let role = record["message"]["role"]
            .as_str()
            .unwrap_or(record["type"].as_str().unwrap_or(""));
        if role == "user" {
            summary.user_messages += 1;
        } else if role == "assistant" {
            summary.assistant_messages += 1;
        }
        if let Some(model) = string_field(&record["message"], "model") {
            push_unique_string(&mut summary.models, model);
        }
        let usage = token_usage_from_claude_usage(&record["message"]["usage"]);
        add_token_usage(&mut summary.token_usage, &usage);
        let blocks = claude_content_blocks(record);
        for block in blocks {
            match block["type"].as_str().unwrap_or("") {
                "tool_use" => summary.tool_uses += 1,
                "tool_result" => summary.tool_results += 1,
                "thinking" | "redacted_thinking" => summary.thinking_blocks += 1,
                _ => {}
            }
        }
    }
    summary
}

fn summarize_claude_message(record: &Value) -> Option<ClaudeSessionMessage> {
    if record.get("message").is_none() && record.get("type").is_none() {
        return None;
    }
    let role = record["message"]["role"]
        .as_str()
        .or_else(|| record["type"].as_str())
        .unwrap_or("event")
        .to_owned();
    let mut text_preview = String::new();
    let mut thinking_count = 0;
    let mut tool_uses = Vec::new();
    let mut tool_results = Vec::new();

    for block in claude_content_blocks(record) {
        match block["type"].as_str().unwrap_or("") {
            "text" => {
                if text_preview.is_empty() {
                    text_preview = preview_text(block["text"].as_str().unwrap_or(""));
                }
            }
            "thinking" | "redacted_thinking" => thinking_count += 1,
            "tool_use" => tool_uses.push(ClaudeToolUse {
                id: string_field(block, "id").unwrap_or_default(),
                name: string_field(block, "name").unwrap_or_else(|| "unknown".to_owned()),
                input_preview: preview_json(&block["input"]),
                input: block["input"].clone(),
            }),
            "tool_result" => tool_results.push(ClaudeToolResult {
                tool_use_id: string_field(block, "tool_use_id").unwrap_or_default(),
                is_error: block["is_error"].as_bool().unwrap_or(false),
                content_preview: preview_claude_content(&block["content"]),
                content: block["content"].clone(),
            }),
            _ => {}
        }
    }

    if text_preview.is_empty() {
        if let Some(content) = record["message"]["content"].as_str() {
            text_preview = preview_text(content);
        }
    }

    Some(ClaudeSessionMessage {
        uuid: string_field(record, "uuid"),
        parent_uuid: string_field(record, "parentUuid"),
        timestamp: string_field(record, "timestamp"),
        type_name: string_field(record, "type"),
        subtype: string_field(record, "subtype"),
        role,
        model: string_field(&record["message"], "model"),
        stop_reason: string_field(&record["message"], "stop_reason")
            .or_else(|| string_field(record, "stop_reason")),
        text_preview,
        thinking_count,
        tool_uses,
        tool_results,
        token_usage: token_usage_from_claude_usage(&record["message"]["usage"]),
        raw: record.clone(),
    })
}

fn claude_content_blocks(record: &Value) -> Vec<&Value> {
    record["message"]["content"]
        .as_array()
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn token_usage_from_claude_usage(usage: &Value) -> TokenUsage {
    let input_tokens = usage["input_tokens"].as_u64();
    let output_tokens = usage["output_tokens"].as_u64();
    let cache_creation = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
    let cache_read = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
    let cached_input_tokens =
        (cache_creation + cache_read > 0).then_some(cache_creation + cache_read);
    let total_tokens = match (input_tokens, output_tokens, cached_input_tokens) {
        (Some(input), Some(output), Some(cached)) => Some(input + output + cached),
        (Some(input), Some(output), None) => Some(input + output),
        _ => None,
    };
    TokenUsage {
        input_tokens,
        output_tokens,
        cached_input_tokens,
        reasoning_output_tokens: None,
        total_tokens,
    }
}

fn add_token_usage(total: &mut TokenUsage, next: &TokenUsage) {
    total.input_tokens = add_optional(total.input_tokens, next.input_tokens);
    total.output_tokens = add_optional(total.output_tokens, next.output_tokens);
    total.cached_input_tokens = add_optional(total.cached_input_tokens, next.cached_input_tokens);
    total.reasoning_output_tokens =
        add_optional(total.reasoning_output_tokens, next.reasoning_output_tokens);
    total.total_tokens = add_optional(total.total_tokens, next.total_tokens);
}

fn add_optional(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left + right),
        (Some(left), None) => Some(left),
        (None, Some(right)) => Some(right),
        (None, None) => None,
    }
}

fn push_unique_string(items: &mut Vec<String>, value: String) {
    if !items.contains(&value) {
        items.push(value);
    }
}

fn preview_claude_content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return preview_text(text);
    }
    preview_json(value)
}

fn preview_json(value: &Value) -> String {
    preview_text(&serde_json::to_string(value).unwrap_or_default())
}

fn preview_text(value: &str) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > 260 {
        format!("{}...", clean.chars().take(260).collect::<String>())
    } else {
        clean
    }
}

fn read_records(path: &Path) -> Result<Vec<Value>, String> {
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut records = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            records.push(value);
        }
    }
    Ok(records)
}

fn group_records(records: Vec<Value>) -> HashMap<String, FlowGroup> {
    let mut groups: HashMap<String, FlowGroup> = HashMap::new();
    for (index, record) in records.into_iter().enumerate() {
        let id = record["flow_id"]
            .as_u64()
            .map(|value| value.to_string())
            .or_else(|| record["flow_id"].as_str().map(str::to_owned))
            .unwrap_or_else(|| format!("no-flow-{index}"));
        let direction = record["direction"].as_str().unwrap_or("");
        let group = groups.entry(id).or_default();
        match direction {
            "request" => group.request = Some(record),
            "response_start" => group.response_start = Some(record),
            "response_chunk" => group.chunks.push(record),
            _ => {}
        }
    }
    for group in groups.values_mut() {
        group.chunks.sort_by_key(chunk_index);
    }
    groups
}

fn summarize_flow(id: &str, group: &FlowGroup) -> FlowSummary {
    let base = group
        .request
        .as_ref()
        .or(group.response_start.as_ref())
        .or(group.chunks.first())
        .unwrap_or(&Value::Null);
    let url = string_field(base, "url").unwrap_or_else(|| "-".to_owned());
    let (host, path) = split_url(&url);
    let semantic = parse_semantics(group, &host, &path);
    let request_size = group
        .request
        .as_ref()
        .and_then(|record| record["body"]["size_bytes"].as_u64());

    FlowSummary {
        id: id.to_owned(),
        method: string_field(base, "method").unwrap_or_else(|| "-".to_owned()),
        url,
        host: host.clone(),
        path,
        provider: provider_from_host(&host),
        status: group
            .response_start
            .as_ref()
            .and_then(|record| record["status"].as_u64()),
        reason: group
            .response_start
            .as_ref()
            .and_then(|record| string_field(record, "reason")),
        chunk_count: group.chunks.len(),
        total_chunk_bytes: group
            .chunks
            .iter()
            .filter_map(|chunk| chunk["body"]["size_bytes"].as_u64())
            .sum(),
        request_size,
        started_at: first_timestamp(group),
        updated_at: last_timestamp(group),
        semantic,
    }
}

fn infer_clients_from_connection(groups: &HashMap<String, FlowGroup>, flows: &mut [FlowSummary]) {
    let clients_by_addr = clients_by_addr(groups);
    for flow in flows {
        if flow.semantic.client.is_some() {
            continue;
        }
        if let Some(group) = groups.get(&flow.id) {
            if let Some(addr) = group_client_addr(group) {
                if let Some(client) = clients_by_addr.get(&addr) {
                    flow.semantic.client = Some(client.clone());
                }
            }
        }
    }
}

fn infer_client_for_summary(
    groups: &HashMap<String, FlowGroup>,
    group: &FlowGroup,
    summary: &mut FlowSummary,
) {
    if summary.semantic.client.is_some() {
        return;
    }
    let Some(addr) = group_client_addr(group) else {
        return;
    };
    if let Some(client) = clients_by_addr(groups).get(&addr) {
        summary.semantic.client = Some(client.clone());
    }
}

fn clients_by_addr(groups: &HashMap<String, FlowGroup>) -> HashMap<String, String> {
    let mut clients = HashMap::new();
    for group in groups.values() {
        let Some(addr) = group_client_addr(group) else {
            continue;
        };
        let summary = summarize_flow("", group);
        if let Some(client) = summary.semantic.client {
            clients.entry(addr).or_insert(client);
        }
    }
    clients
}

fn group_client_addr(group: &FlowGroup) -> Option<String> {
    group
        .request
        .as_ref()
        .or(group.response_start.as_ref())
        .or(group.chunks.first())
        .and_then(|record| string_field(record, "client_addr"))
}

fn parse_semantics(group: &FlowGroup, host: &str, path: &str) -> SemanticInfo {
    let request_json = group.request.as_ref().and_then(|record| {
        record["body"]["json"]
            .as_object()
            .map(|_| &record["body"]["json"])
    });
    let rpc_method = request_json.and_then(|json| string_field(json, "method"));
    let mcp_server = mcp_server_from_path(path);
    let mut tool_names = Vec::new();
    let mut skill_names = Vec::new();

    if let Some(json) = request_json {
        collect_named_values(json, "skills", &mut skill_names);
        collect_named_values(json, "skill", &mut skill_names);
        collect_tool_names_from_request(json, &mut tool_names);
    }

    for chunk in &group.chunks {
        if let Some(text) = body_text(&chunk["body"]) {
            collect_sse_tool_names(&text, &mut tool_names);
            collect_sse_skill_names(&text, &mut skill_names);
        }
    }

    dedupe(&mut tool_names);
    dedupe(&mut skill_names);

    let client = request_json
        .and_then(client_from_json)
        .or_else(|| group.request.as_ref().and_then(client_from_headers));
    let model = request_json.and_then(|json| find_string_key(json, "model"));
    let token_usage = token_usage_from_group(group);
    let event_type = request_json
        .and_then(|json| json["events"].as_array())
        .and_then(|events| events.first())
        .and_then(|event| string_field(event, "event_type"));
    let redaction_hits = count_redactions(group);

    let category = semantic_category(
        host,
        path,
        rpc_method.as_deref(),
        !tool_names.is_empty(),
        !skill_names.is_empty(),
        model.as_deref(),
        event_type.as_deref(),
    );

    SemanticInfo {
        category,
        client,
        rpc_method,
        mcp_server,
        tool_names,
        skill_names,
        model,
        event_type,
        token_usage,
        redaction_hits,
    }
}

fn token_usage_from_json(json: &Value) -> TokenUsage {
    let input_tokens = find_u64_key(json, "input_tokens")
        .or_else(|| find_u64_key(json, "inputTokens"))
        .or_else(|| find_u64_key(json, "prompt_tokens"))
        .or_else(|| find_u64_key(json, "promptTokens"));
    let output_tokens = find_u64_key(json, "output_tokens")
        .or_else(|| find_u64_key(json, "outputTokens"))
        .or_else(|| find_u64_key(json, "completion_tokens"))
        .or_else(|| find_u64_key(json, "completionTokens"));
    let cached_input_tokens = find_u64_key(json, "cached_input_tokens")
        .or_else(|| find_u64_key(json, "cachedInputTokens"))
        .or_else(|| find_u64_key(json, "cached_tokens"))
        .or_else(|| find_u64_key(json, "cache_read_input_tokens"));
    let reasoning_output_tokens = find_u64_key(json, "reasoning_output_tokens")
        .or_else(|| find_u64_key(json, "reasoningOutputTokens"))
        .or_else(|| find_u64_key(json, "reasoning_tokens"));
    let total_tokens = find_u64_key(json, "total_tokens")
        .or_else(|| find_u64_key(json, "totalTokens"))
        .or_else(|| find_u64_key(json, "total_tokens_count"))
        .or_else(|| {
            input_tokens
                .zip(output_tokens)
                .map(|(input, output)| input + output)
        });
    let mut usage = TokenUsage {
        input_tokens,
        output_tokens,
        cached_input_tokens,
        reasoning_output_tokens,
        total_tokens,
    };
    add_token_usage(&mut usage, &token_usage_from_otel_metrics(json));
    usage
}

fn token_usage_from_group(group: &FlowGroup) -> TokenUsage {
    let mut usage = TokenUsage::default();
    if let Some(request) = &group.request {
        add_token_usage(&mut usage, &token_usage_from_body(&request["body"]));
    }
    if let Some(response) = &group.response_start {
        add_token_usage(&mut usage, &token_usage_from_body(&response["body"]));
    }
    for chunk in &group.chunks {
        add_token_usage(&mut usage, &token_usage_from_body(&chunk["body"]));
    }
    usage
}

fn token_usage_from_body(body: &Value) -> TokenUsage {
    let mut usage = TokenUsage::default();
    if body["json"].is_object() {
        add_token_usage(&mut usage, &token_usage_from_json(&body["json"]));
    }
    if let Some(text) = body_text(body) {
        for value in sse_data_values(&text) {
            add_token_usage(&mut usage, &token_usage_from_json(&value));
        }
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            add_token_usage(&mut usage, &token_usage_from_json(&value));
        }
    }
    usage
}

fn token_usage_from_otel_metrics(value: &Value) -> TokenUsage {
    let mut usage = TokenUsage::default();
    collect_otel_token_usage(value, &mut usage);
    usage
}

fn collect_otel_token_usage(value: &Value, usage: &mut TokenUsage) {
    match value {
        Value::Object(map) => {
            if map
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.contains("token_usage"))
            {
                if let Some(data_points) = map
                    .get("histogram")
                    .and_then(|item| item["dataPoints"].as_array())
                {
                    for point in data_points {
                        add_otel_token_point(point, usage);
                    }
                }
                if let Some(data_points) = map
                    .get("sum")
                    .and_then(|item| item["dataPoints"].as_array())
                {
                    for point in data_points {
                        add_otel_token_point(point, usage);
                    }
                }
            }
            for child in map.values() {
                collect_otel_token_usage(child, usage);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_otel_token_usage(item, usage);
            }
        }
        _ => {}
    }
}

fn add_otel_token_point(point: &Value, usage: &mut TokenUsage) {
    let Some(token_type) = otel_attribute(point, "token_type") else {
        return;
    };
    let Some(value) = point["sum"]
        .as_u64()
        .or_else(|| point["asInt"].as_u64())
        .or_else(|| point["max"].as_u64())
        .or_else(|| point["sum"].as_f64().map(|value| value.round() as u64))
        .or_else(|| point["asDouble"].as_f64().map(|value| value.round() as u64))
        .or_else(|| point["max"].as_f64().map(|value| value.round() as u64))
    else {
        return;
    };

    match token_type.as_str() {
        "input" => usage.input_tokens = add_optional(usage.input_tokens, Some(value)),
        "output" => usage.output_tokens = add_optional(usage.output_tokens, Some(value)),
        "cached_input" => {
            usage.cached_input_tokens = add_optional(usage.cached_input_tokens, Some(value))
        }
        "reasoning_output" => {
            usage.reasoning_output_tokens = add_optional(usage.reasoning_output_tokens, Some(value))
        }
        "total" => usage.total_tokens = add_optional(usage.total_tokens, Some(value)),
        _ => {}
    }
}

fn otel_attribute(point: &Value, target_key: &str) -> Option<String> {
    point["attributes"].as_array().and_then(|attributes| {
        attributes.iter().find_map(|attribute| {
            if attribute["key"].as_str() == Some(target_key) {
                string_field(&attribute["value"], "stringValue")
            } else {
                None
            }
        })
    })
}

fn count_redactions(group: &FlowGroup) -> usize {
    let mut count = 0;
    if let Some(request) = &group.request {
        count += count_redactions_in_value(request);
    }
    if let Some(response) = &group.response_start {
        count += count_redactions_in_value(response);
    }
    for chunk in &group.chunks {
        count += count_redactions_in_value(chunk);
    }
    count
}

fn count_redactions_in_value(value: &Value) -> usize {
    match value {
        Value::String(text) => usize::from(text.contains("[REDACTED]")),
        Value::Array(items) => items.iter().map(count_redactions_in_value).sum(),
        Value::Object(map) => map.values().map(count_redactions_in_value).sum(),
        _ => 0,
    }
}

fn semantic_category(
    host: &str,
    path: &str,
    rpc_method: Option<&str>,
    has_tools: bool,
    has_skills: bool,
    model: Option<&str>,
    event_type: Option<&str>,
) -> String {
    if has_skills {
        return "Skill".to_owned();
    }
    if matches!(rpc_method, Some("tools/call")) {
        return "Tool call".to_owned();
    }
    if matches!(rpc_method, Some("tools/list")) || has_tools {
        return "Tool list".to_owned();
    }
    if rpc_method.is_some() || path.contains("/mcp") || path.contains("/wham/apps") {
        return "MCP".to_owned();
    }
    if path.contains("/codex/responses")
        || path.contains("/responses")
        || path.contains("/messages")
        || model.is_some()
    {
        return "Model".to_owned();
    }
    if event_type.is_some() || path.contains("analytics-events") || path.contains("/otlp/") {
        return "Telemetry".to_owned();
    }
    if host.contains("chatgpt.com") && path.contains("/plugins/") {
        return "Plugin".to_owned();
    }
    "HTTP".to_owned()
}

fn mcp_server_from_path(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    for window in parts.windows(3) {
        if window[0] == "api" && window[1] == "mcp" {
            return Some(window[2].to_owned());
        }
    }
    if path.contains("/wham/apps") {
        return Some("Codex WHAM".to_owned());
    }
    None
}

fn client_from_json(json: &Value) -> Option<String> {
    let info = &json["params"]["clientInfo"];
    string_field(info, "title")
        .or_else(|| string_field(info, "name"))
        .or_else(|| string_field(info, "description"))
}

fn client_from_headers(record: &Value) -> Option<String> {
    record["headers"]["user-agent"].as_str().map(|value| {
        let lower = value.to_ascii_lowercase();
        if lower.contains("claude-code") || lower.contains("claude") {
            "Claude Code".to_owned()
        } else if lower.contains("codex") {
            "Codex".to_owned()
        } else {
            value.to_owned()
        }
    })
}

fn collect_tool_names_from_request(json: &Value, result: &mut Vec<String>) {
    if json["method"].as_str() == Some("tools/call") {
        if let Some(name) = json["params"]["name"].as_str() {
            result.push(name.to_owned());
        }
    }
    collect_named_values(json, "tools", result);
}

fn collect_sse_tool_names(text: &str, result: &mut Vec<String>) {
    for value in sse_data_values(text) {
        collect_named_values(&value, "tools", result);
        if value["method"].as_str() == Some("tools/call") {
            if let Some(name) = value["params"]["name"].as_str() {
                result.push(name.to_owned());
            }
        }
    }
}

fn collect_sse_skill_names(text: &str, result: &mut Vec<String>) {
    for value in sse_data_values(text) {
        collect_named_values(&value, "skills", result);
        collect_named_values(&value, "skill", result);
    }
}

fn sse_data_values(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .filter(|line| !line.is_empty() && *line != "[DONE]")
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn collect_named_values(value: &Value, target_key: &str, result: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == target_key {
                    collect_names_from_value(child, result);
                }
                collect_named_values(child, target_key, result);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_named_values(item, target_key, result);
            }
        }
        _ => {}
    }
}

fn collect_names_from_value(value: &Value, result: &mut Vec<String>) {
    match value {
        Value::String(name) => result.push(name.to_owned()),
        Value::Array(items) => {
            for item in items {
                collect_names_from_value(item, result);
            }
        }
        Value::Object(map) => {
            if let Some(name) = map.get("name").and_then(Value::as_str) {
                result.push(name.to_owned());
            }
            if let Some(name) = map.get("id").and_then(Value::as_str) {
                result.push(name.to_owned());
            }
        }
        _ => {}
    }
}

fn find_string_key(value: &Value, target_key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == target_key {
                    if let Some(found) = child.as_str() {
                        return Some(found.to_owned());
                    }
                }
                if let Some(found) = find_string_key(child, target_key) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| find_string_key(item, target_key)),
        _ => None,
    }
}

fn find_u64_key(value: &Value, target_key: &str) -> Option<u64> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == target_key {
                    if let Some(found) = child.as_u64() {
                        return Some(found);
                    }
                    if let Some(found) = child.as_f64() {
                        return Some(found.round() as u64);
                    }
                    if let Some(found) = child.as_str().and_then(|text| text.parse::<u64>().ok()) {
                        return Some(found);
                    }
                }
                if let Some(found) = find_u64_key(child, target_key) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(|item| find_u64_key(item, target_key)),
        _ => None,
    }
}

fn dedupe(items: &mut Vec<String>) {
    let mut seen = Vec::new();
    items.retain(|item| {
        if item.is_empty() || seen.contains(item) {
            false
        } else {
            seen.push(item.clone());
            true
        }
    });
}

fn first_timestamp(group: &FlowGroup) -> Option<String> {
    group
        .request
        .as_ref()
        .or(group.response_start.as_ref())
        .or(group.chunks.first())
        .and_then(|record| string_field(record, "timestamp"))
}

fn last_timestamp(group: &FlowGroup) -> Option<String> {
    group
        .chunks
        .last()
        .or(group.response_start.as_ref())
        .or(group.request.as_ref())
        .and_then(|record| string_field(record, "timestamp"))
}

fn reconstruct_response(group: &FlowGroup) -> String {
    let text = group
        .chunks
        .iter()
        .filter_map(|chunk| body_text(&chunk["body"]))
        .collect::<Vec<_>>()
        .join("");
    if text.contains("data:") {
        return text
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim))
            .filter(|line| !line.is_empty() && *line != "[DONE]")
            .collect::<Vec<_>>()
            .join("\n");
    }
    text
}

fn body_text(body: &Value) -> Option<String> {
    body["text"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| body["stream"].as_str().map(str::to_owned))
        .or_else(|| body["binary"].as_str().map(str::to_owned))
        .or_else(|| {
            (!body["json"].is_null())
                .then(|| serde_json::to_string_pretty(&body["json"]).ok())
                .flatten()
        })
}

fn chunk_index(record: &Value) -> u64 {
    record["body"]["chunk_index"].as_u64().unwrap_or(u64::MAX)
}

fn string_field(record: &Value, field: &str) -> Option<String> {
    record[field].as_str().map(str::to_owned)
}

fn flow_sort_key(id: &str) -> (u8, u64, String) {
    id.parse::<u64>()
        .map(|value| (0, value, String::new()))
        .unwrap_or_else(|_| (1, 0, id.to_owned()))
}

fn split_url(url: &str) -> (String, String) {
    if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        let mut parts = rest.splitn(2, '/');
        let host = parts.next().unwrap_or("-").to_owned();
        let path = parts
            .next()
            .map(|value| format!("/{value}"))
            .unwrap_or_else(|| "/".to_owned());
        return (host, path);
    }
    if url.contains(':') && !url.contains('/') {
        return (url.to_owned(), String::new());
    }
    ("-".to_owned(), url.to_owned())
}

fn provider_from_host(host: &str) -> String {
    let host = host.to_ascii_lowercase();
    if host.contains("anthropic") || host.contains("claude") {
        "Claude".to_owned()
    } else if host.contains("openai") {
        "OpenAI".to_owned()
    } else if host.contains("bigmodel") || host.contains("zhipu") {
        "BigModel".to_owned()
    } else if host == "-" || host.is_empty() {
        "Unknown".to_owned()
    } else {
        host.split('.').rev().nth(1).unwrap_or(&host).to_owned()
    }
}

#[tauri::command]
fn open_tool(state: State<'_, AppState>, tool: String, listen: String) -> Result<String, String> {
    let tool = normalize_tool(&tool)?;
    let wrapper = state.root.join("bin").join(format!("run-{tool}"));
    if !wrapper.exists() {
        return Err(format!("wrapper not found: {}", wrapper.display()));
    }

    let port = listen_port(&listen)?;
    open_terminal(&state.root, &tool, &port)?;
    Ok(format!("{tool} opened with proxy port {port}"))
}

fn status_from_state(state: &State<'_, AppState>) -> Result<ProxyStatus, String> {
    let mut proxy = state.proxy.lock().map_err(|err| err.to_string())?;
    if let Some(child) = proxy.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(ProxyStatus {
                running: true,
                pid: Some(child.id()),
                external: false,
                message: "Proxy running from desktop app".to_owned(),
            });
        }
    }
    *proxy = None;
    let listen = state
        .last_listen
        .lock()
        .map_err(|err| err.to_string())?
        .clone();
    if port_is_open(&listen) {
        return Ok(ProxyStatus {
            running: true,
            pid: None,
            external: true,
            message: format!("{listen} is already listening"),
        });
    }
    Ok(ProxyStatus {
        running: false,
        pid: None,
        external: false,
        message: "Proxy stopped".to_owned(),
    })
}

fn tool_status(root: &Path, tool: &str) -> ToolStatus {
    let label = match tool {
        "claude" => "Claude Code",
        "codex" => "Codex",
        _ => tool,
    };
    let wrapper = root.join("bin").join(format!("run-{tool}"));
    ToolStatus {
        id: tool.to_owned(),
        label: label.to_owned(),
        wrapper: display_path(&wrapper),
        command: tool.to_owned(),
        wrapper_exists: wrapper.exists(),
        command_path: command_path(tool),
    }
}

fn normalize_tool(tool: &str) -> Result<String, String> {
    match tool {
        "claude" | "codex" => Ok(tool.to_owned()),
        _ => Err("unknown tool".to_owned()),
    }
}

fn listen_port(listen: &str) -> Result<String, String> {
    let addr = listen
        .parse::<SocketAddr>()
        .map_err(|_| format!("invalid listen address: {listen}"))?;
    Ok(addr.port().to_string())
}

fn command_path(command: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/bin/zsh")
            .arg("-lc")
            .arg(format!("command -v {}", shell_quote(command)))
            .output()
            .ok()?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            return (!path.is_empty()).then_some(path);
        }
    }

    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(display_path(&candidate));
        }
    }
    None
}

fn open_terminal(root: &Path, tool: &str, port: &str) -> Result<(), String> {
    let command = format!(
        "cd {} && CCC_PROXY_PORT={} ./bin/run-{}",
        shell_quote(&display_path(root)),
        shell_quote(port),
        tool,
    );

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
            applescript_escape(&command),
        );
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|err| err.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Command::new(root.join("bin").join(format!("run-{tool}")))
            .current_dir(root)
            .env("CCC_PROXY_PORT", port)
            .spawn()
            .map(|_| ())
            .map_err(|err| err.to_string())
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn port_is_open(listen: &str) -> bool {
    let Ok(addr) = listen.parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(120)).is_ok()
}

#[cfg(target_os = "macos")]
fn recycle_orphan_proxy_on_port(listen: &str, binary: &Path) -> Result<bool, String> {
    let port = listen_port(listen)?;
    let output = Command::new("lsof")
        .args(["-nP", &format!("-tiTCP:{port}"), "-sTCP:LISTEN"])
        .output()
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Ok(false);
    }

    let binary = binary
        .canonicalize()
        .unwrap_or_else(|_| binary.to_path_buf());
    let binary = display_path(&binary);
    let mut killed = false;

    for pid in String::from_utf8_lossy(&output.stdout).lines() {
        let pid = pid.trim();
        if pid.is_empty() {
            continue;
        }

        let command = Command::new("ps")
            .args(["-p", pid, "-o", "command="])
            .output()
            .map_err(|err| err.to_string())?;
        if !command.status.success() {
            continue;
        }

        let command = String::from_utf8_lossy(&command.stdout);
        if command.contains(&binary) {
            let _ = Command::new("kill").args(["-TERM", pid]).status();
            killed = true;
        }
    }

    if killed {
        for _ in 0..20 {
            if !port_is_open(listen) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }

    Ok(killed)
}

#[cfg(not(target_os = "macos"))]
fn recycle_orphan_proxy_on_port(_listen: &str, _binary: &Path) -> Result<bool, String> {
    Ok(false)
}

fn safe_capture_path(captures_dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name.contains('/') || name.contains('\\') || !name.ends_with(".jsonl") {
        return Err("invalid capture file name".to_owned());
    }
    Ok(captures_dir.join(name))
}

fn safe_session_path(storage_dir: &Path, name: &str) -> Result<PathBuf, String> {
    if name.contains('/') || name.contains('\\') || !name.ends_with(".jsonl") {
        return Err("invalid session file name".to_owned());
    }
    Ok(storage_dir.join(name))
}

fn claude_project_dir(project: &Path) -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_owned())?;
    Ok(home
        .join(".claude/projects")
        .join(normalized_claude_project_name(project)))
}

fn normalized_claude_project_name(project: &Path) -> String {
    let mut name = display_path(project).replace('\\', "/");
    name = name
        .chars()
        .map(|ch| match ch {
            '/' | ':' | '.' | '_' => '-',
            _ => ch,
        })
        .collect();
    #[cfg(target_os = "windows")]
    {
        name
    }
    #[cfg(not(target_os = "windows"))]
    {
        if name.starts_with('-') {
            name
        } else {
            format!("-{name}")
        }
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn proxy_binary(root: &Path) -> PathBuf {
    let release = root.join("target/release/cc-capture-native");
    if release.exists() {
        release
    } else {
        root.join("target/debug/cc-capture-native")
    }
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .expect("desktop/src-tauri should live under native project root")
        .to_path_buf()
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            proxy: Mutex::new(None),
            last_listen: Mutex::new("127.0.0.1:8899".to_owned()),
            root: project_root(),
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            proxy_status,
            start_proxy,
            stop_proxy,
            list_capture_files,
            read_capture_file,
            read_capture_index,
            read_flow_detail,
            environment_status,
            run_helper,
            tool_statuses,
            read_claude_session_index,
            read_claude_session_detail,
            read_loop_index,
            read_loop_detail,
            read_loop_step_detail,
            open_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
