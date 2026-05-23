use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    env, fs,
    fs::OpenOptions,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

struct AppState {
    proxies: Mutex<HashMap<String, ProxyRun>>,
    run_contexts: Arc<Mutex<Vec<RunContext>>>,
    gateway: Mutex<Option<Child>>,
    last_listen: Mutex<String>,
    last_gateway_listen: Mutex<String>,
    last_gateway_capture: Mutex<Option<String>>,
    hook_receiver: Mutex<HookReceiverStatus>,
    root: PathBuf,
}

struct ProxyRun {
    child: Child,
    listen: String,
    capture_file: Option<String>,
    source: String,
    started_at: f64,
}

#[derive(Clone)]
struct RunContext {
    source: String,
    capture_file: String,
    listen: String,
    started_at: f64,
}

const HOOK_LISTEN: &str = "127.0.0.1:37917";
const DEFAULT_GATEWAY_LISTEN: &str = "127.0.0.1:37918";
const HOOK_EVENTS_FILE: &str = "hook-events.jsonl";
const LOOPLENS_HOOK_BEGIN: &str = "# BEGIN LOOPLENS HOOKS";
const LOOPLENS_HOOK_END: &str = "# END LOOPLENS HOOKS";
const CLAUDE_HOOK_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PermissionRequest",
    "PermissionDenied",
    "Setup",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "Elicitation",
    "ElicitationResult",
    "ConfigChange",
    "WorktreeCreate",
    "WorktreeRemove",
    "InstructionsLoaded",
    "CwdChanged",
    "FileChanged",
];
const CODEX_HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "Stop",
];

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
    listen: String,
    message: String,
    capture_file: Option<String>,
}

#[derive(Serialize)]
struct GatewayStatus {
    running: bool,
    pid: Option<u32>,
    external: bool,
    listen: String,
    capture_file: Option<String>,
    message: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct GatewaySettingsFile {
    listen: String,
    openai_api_key: Option<String>,
    openai_base_url: String,
    anthropic_api_key: Option<String>,
    anthropic_base_url: String,
    default_provider: String,
    routing_rules: Vec<String>,
    max_retries: u32,
    redaction_enabled: bool,
}

#[derive(Serialize)]
struct GatewaySettingsView {
    listen: String,
    openai_key_masked: Option<String>,
    openai_base_url: String,
    anthropic_key_masked: Option<String>,
    anthropic_base_url: String,
    default_provider: String,
    routing_rules: Vec<String>,
    max_retries: u32,
    redaction_enabled: bool,
    settings_path: String,
}

#[derive(Deserialize)]
struct GatewaySettingsInput {
    listen: Option<String>,
    openai_api_key: Option<String>,
    openai_base_url: Option<String>,
    anthropic_api_key: Option<String>,
    anthropic_base_url: Option<String>,
    default_provider: Option<String>,
    routing_rules: Option<Vec<String>>,
    max_retries: Option<u32>,
    redaction_enabled: Option<bool>,
}

#[derive(Serialize)]
struct ProviderTestResult {
    provider: String,
    ok: bool,
    message: String,
    base_url: String,
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
    ca_trusted: bool,
    tools: Vec<ToolStatus>,
}

#[derive(Serialize, Clone)]
struct HookReceiverStatus {
    listen: String,
    url_base: String,
    running: bool,
    message: String,
    event_file: String,
}

#[derive(Serialize)]
struct HookInstallState {
    target: String,
    installed: bool,
    path: String,
    message: String,
}

#[derive(Serialize)]
struct HookStatus {
    receiver: HookReceiverStatus,
    claude: HookInstallState,
    codex: HookInstallState,
    total_events: usize,
    last_event: Option<HookEventRecord>,
}

#[derive(Serialize, Deserialize, Clone)]
struct HookEventRecord {
    id: String,
    source: String,
    event_name: String,
    received_at: f64,
    #[serde(default)]
    capture_file: Option<String>,
    #[serde(default)]
    run_source: Option<String>,
    #[serde(default)]
    run_listen: Option<String>,
    #[serde(default)]
    run_started_at: Option<f64>,
    session_id: Option<String>,
    turn_id: Option<String>,
    transcript_path: Option<String>,
    cwd: Option<String>,
    hook_source: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    agent_id: Option<String>,
    agent_type: Option<String>,
    tool_name: Option<String>,
    tool_use_id: Option<String>,
    tool_input: Option<Value>,
    tool_response: Option<Value>,
    permission_suggestions: Option<Value>,
    prompt: Option<String>,
    message: Option<String>,
    last_assistant_message: Option<String>,
    title: Option<String>,
    error: Option<String>,
    reason: Option<String>,
    decision: Option<String>,
    trigger: Option<String>,
    custom_instructions: Option<String>,
    compact_summary: Option<String>,
    action: Option<String>,
    notification_type: Option<String>,
    mcp_server_name: Option<String>,
    elicitation_id: Option<String>,
    file_path: Option<String>,
    file_event: Option<String>,
    trigger_file_path: Option<String>,
    parent_file_path: Option<String>,
    memory_type: Option<String>,
    load_reason: Option<String>,
    old_cwd: Option<String>,
    new_cwd: Option<String>,
    worktree_path: Option<String>,
    worktree_name: Option<String>,
    task_id: Option<String>,
    task_subject: Option<String>,
    teammate_name: Option<String>,
    team_name: Option<String>,
    stop_hook_active: Option<bool>,
    is_interrupt: Option<bool>,
    #[serde(default)]
    payload_size: usize,
    #[serde(default)]
    payload_preview: String,
    #[serde(default)]
    extracted: Value,
    raw: Value,
}

#[derive(Serialize)]
struct HookEventsIndex {
    file: String,
    total: usize,
    events: Vec<HookEventRecord>,
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
    gateway_provider: Option<String>,
    upstream_url: Option<String>,
    gateway_route_reason: Option<String>,
    retry_count: Option<u64>,
    attempt_count: Option<u64>,
    retry_reasons: Vec<String>,
    rpc_method: Option<String>,
    mcp_server: Option<String>,
    tool_names: Vec<String>,
    skill_names: Vec<String>,
    model: Option<String>,
    event_type: Option<String>,
    token_usage: TokenUsage,
    redaction_hits: usize,
    low_signal: bool,
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

#[derive(Serialize)]
struct CaptureHealth {
    file: String,
    total_lines: usize,
    valid_lines: usize,
    invalid_lines: usize,
    flow_count: usize,
    duplicate_flow_ids: Vec<String>,
    request_count: usize,
    response_start_count: usize,
    chunk_count: usize,
    orphan_chunks: usize,
    pending_flows: usize,
    error_flows: usize,
    connect_flows: usize,
    low_signal_flows: usize,
    status: String,
    diagnostics: Vec<CaptureDiagnostic>,
}

#[derive(Serialize)]
struct CaptureDiagnostic {
    severity: String,
    code: String,
    message: String,
    flow_id: Option<String>,
    line: Option<usize>,
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
        ca_cert: display_path(&state.root.join("ca/looplens-ca.pem")),
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
    capture_source: Option<String>,
) -> Result<ProxyStatus, String> {
    let force_new_capture = force_new_capture.unwrap_or(false);
    let source_kind = capture_source_kind(capture_source.as_deref())?;
    let is_tool_launch = matches!(source_kind, "codex" | "claude-code");
    let proxy_listen = if force_new_capture && is_tool_launch {
        allocate_ephemeral_listen(&listen)?
    } else {
        listen.clone()
    };
    *state.last_listen.lock().map_err(|err| err.to_string())? = proxy_listen.clone();

    let mut proxies = state.proxies.lock().map_err(|err| err.to_string())?;
    prune_proxy_runs(&mut proxies)?;
    if force_new_capture && is_tool_launch {
        stop_proxy_runs(&mut proxies);
    }
    let mut remove_existing_proxy = false;
    if let Some(run) = proxies.get_mut(&proxy_listen) {
        if run
            .child
            .try_wait()
            .map_err(|err| err.to_string())?
            .is_none()
        {
            if force_new_capture {
                let _ = run.child.kill();
                let _ = run.child.wait();
                remove_existing_proxy = true;
            } else {
                return Ok(ProxyStatus {
                    running: true,
                    pid: Some(run.child.id()),
                    external: false,
                    listen: run.listen.clone(),
                    message: format!("{} proxy running from desktop app", run.source),
                    capture_file: run.capture_file.clone(),
                });
            }
        } else {
            remove_existing_proxy = true;
        }
    }
    if remove_existing_proxy {
        proxies.remove(&proxy_listen);
    }

    let binary = proxy_binary(&state.root);
    if !binary.exists() {
        return Err(format!(
            "proxy binary not found: {}. Run `cargo build -p looplens-proxy --release` in the native project first.",
            binary.display()
        ));
    }

    if port_is_open(&proxy_listen) {
        if force_new_capture && !is_tool_launch {
            if recycle_orphan_proxy_on_port(&proxy_listen, &binary)? && !port_is_open(&proxy_listen)
            {
                // Continue below and spawn a fresh proxy, which creates a new capture file.
            } else {
                return Err(format!(
                    "{proxy_listen} is already used by an external proxy. Stop that process or choose another port before opening a fresh capture."
                ));
            }
        } else {
            return Ok(ProxyStatus {
                running: true,
                pid: None,
                external: true,
                listen: proxy_listen.clone(),
                message: format!("{proxy_listen} is already listening"),
                capture_file: None,
            });
        }
    }

    let captures_dir = state.root.join("captures");
    fs::create_dir_all(&captures_dir).map_err(|err| err.to_string())?;
    let capture_prefix = capture_prefix_for_kind(source_kind);
    let capture_path = reserve_capture_file_with_prefix(&captures_dir, capture_prefix)?;
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
        .env("CCC_LISTEN", &proxy_listen)
        .env("CCC_OUTPUT_DIR", &captures_dir)
        .env("CCC_OUTPUT_FILE", &capture_path)
        .env("CCC_CA_CERT", state.root.join("ca/looplens-ca.pem"))
        .env("CCC_CA_KEY", state.root.join("ca/looplens-ca.key"))
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
    let capture_file = capture_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string());
    let started_at = current_epoch_seconds()?;
    proxies.insert(
        proxy_listen.clone(),
        ProxyRun {
            child,
            listen: proxy_listen.clone(),
            capture_file: capture_file.clone(),
            source: source_kind.to_owned(),
            started_at,
        },
    );
    if let Some(file) = capture_file.as_ref() {
        remember_run_context(
            &state.run_contexts,
            source_kind,
            file,
            &proxy_listen,
            started_at,
        )?;
    }
    Ok(ProxyStatus {
        running: true,
        pid: Some(pid),
        external: false,
        listen: proxy_listen,
        message: format!("Proxy started, capture: {}", capture_path.display()),
        capture_file,
    })
}

fn current_epoch_seconds() -> Result<f64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_secs_f64())
}

fn remember_run_context(
    run_contexts: &Arc<Mutex<Vec<RunContext>>>,
    source: &str,
    capture_file: &str,
    listen: &str,
    started_at: f64,
) -> Result<(), String> {
    let mut contexts = run_contexts.lock().map_err(|err| err.to_string())?;
    contexts.push(RunContext {
        source: source.to_owned(),
        capture_file: capture_file.to_owned(),
        listen: listen.to_owned(),
        started_at,
    });
    if contexts.len() > 80 {
        let drop_count = contexts.len() - 80;
        contexts.drain(0..drop_count);
    }
    Ok(())
}

fn capture_source_kind(source: Option<&str>) -> Result<&'static str, String> {
    match source.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "" | "manual" | "proxy" => Ok("proxy"),
        "codex" => Ok("codex"),
        "claude" | "claude-code" | "claude_code" => Ok("claude-code"),
        value => Err(format!("unknown capture source: {value}")),
    }
}

fn capture_prefix_for_kind(kind: &str) -> &'static str {
    match kind {
        "codex" => "capture-codex",
        "claude-code" => "capture-claude-code",
        _ => "capture",
    }
}

fn allocate_ephemeral_listen(requested: &str) -> Result<String, String> {
    let addr = requested
        .parse::<SocketAddr>()
        .map_err(|_| format!("invalid listen address: {requested}"))?;
    let listener = TcpListener::bind((addr.ip(), 0)).map_err(|err| err.to_string())?;
    let local = listener.local_addr().map_err(|err| err.to_string())?;
    drop(listener);
    Ok(local.to_string())
}

fn prune_proxy_runs(proxies: &mut HashMap<String, ProxyRun>) -> Result<(), String> {
    let mut finished = Vec::new();
    for (listen, run) in proxies.iter_mut() {
        if run
            .child
            .try_wait()
            .map_err(|err| err.to_string())?
            .is_some()
        {
            finished.push(listen.clone());
        }
    }
    for listen in finished {
        proxies.remove(&listen);
    }
    Ok(())
}

fn reserve_capture_file_with_prefix(captures_dir: &Path, prefix: &str) -> Result<PathBuf, String> {
    for suffix in 0..1000 {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| err.to_string())?
            .as_millis();
        let name = if suffix == 0 {
            format!("{prefix}-{millis}.jsonl")
        } else {
            format!("{prefix}-{millis}-{suffix}.jsonl")
        };
        let path = captures_dir.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.to_string()),
        }
    }
    Err("failed to reserve a unique capture file".to_owned())
}

#[tauri::command]
fn stop_proxy(state: State<'_, AppState>) -> Result<ProxyStatus, String> {
    let mut proxies = state.proxies.lock().map_err(|err| err.to_string())?;
    let stopped = stop_proxy_runs(&mut proxies);
    let listen = state
        .last_listen
        .lock()
        .map_err(|err| err.to_string())?
        .clone();
    Ok(ProxyStatus {
        running: false,
        pid: None,
        external: false,
        listen,
        message: if stopped == 1 {
            "Proxy stopped".to_owned()
        } else {
            format!("{stopped} proxy runs stopped")
        },
        capture_file: None,
    })
}

fn stop_proxy_runs(proxies: &mut HashMap<String, ProxyRun>) -> usize {
    let stopped = proxies.len();
    for (_, mut run) in proxies.drain() {
        let _ = run.child.kill();
        let _ = run.child.wait();
    }
    stopped
}

#[tauri::command]
fn gateway_status(state: State<'_, AppState>) -> Result<GatewayStatus, String> {
    gateway_status_from_state(&state)
}

#[tauri::command]
fn read_gateway_settings(state: State<'_, AppState>) -> Result<GatewaySettingsView, String> {
    gateway_settings_view(&state.root)
}

#[tauri::command]
fn save_gateway_settings(
    state: State<'_, AppState>,
    settings: GatewaySettingsInput,
) -> Result<GatewaySettingsView, String> {
    save_gateway_settings_for_root(&state.root, settings)?;
    gateway_settings_view(&state.root)
}

#[tauri::command]
fn start_gateway(
    state: State<'_, AppState>,
    settings: Option<GatewaySettingsInput>,
    force_new_capture: Option<bool>,
) -> Result<GatewayStatus, String> {
    if let Some(settings) = settings {
        save_gateway_settings_for_root(&state.root, settings)?;
    }
    let force_new_capture = force_new_capture.unwrap_or(false);
    let gateway_settings = read_gateway_settings_file(&state.root)?;
    *state
        .last_gateway_listen
        .lock()
        .map_err(|err| err.to_string())? = gateway_settings.listen.clone();

    let mut gateway = state.gateway.lock().map_err(|err| err.to_string())?;
    if let Some(child) = gateway.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            if force_new_capture {
                let _ = child.kill();
                let _ = child.wait();
                *gateway = None;
            } else {
                return Ok(GatewayStatus {
                    running: true,
                    pid: Some(child.id()),
                    external: false,
                    listen: gateway_settings.listen,
                    capture_file: state
                        .last_gateway_capture
                        .lock()
                        .map_err(|err| err.to_string())?
                        .clone(),
                    message: "Gateway running from desktop app".to_owned(),
                });
            }
        }
    }

    let binary = proxy_binary(&state.root);
    if !binary.exists() {
        return Err(format!(
            "gateway binary not found: {}. Run `cargo build -p looplens-proxy --release` in the native project first.",
            binary.display()
        ));
    }

    if port_is_open(&gateway_settings.listen) {
        *gateway = None;
        if force_new_capture {
            if recycle_orphan_proxy_on_port(&gateway_settings.listen, &binary)?
                && !port_is_open(&gateway_settings.listen)
            {
                // Continue below and spawn a fresh gateway, which creates a new capture file.
            } else {
                return Err(format!(
                    "{} is already used by an external process. Stop it or choose another Gateway port.",
                    gateway_settings.listen
                ));
            }
        } else {
            return Ok(GatewayStatus {
                running: true,
                pid: None,
                external: true,
                listen: gateway_settings.listen.clone(),
                capture_file: None,
                message: format!("{} is already listening", gateway_settings.listen),
            });
        }
    }

    let captures_dir = state.root.join("captures");
    fs::create_dir_all(&captures_dir).map_err(|err| err.to_string())?;
    let capture_path = reserve_capture_file_with_prefix(&captures_dir, "capture-gateway")?;
    let log_path = state.root.join("desktop-gateway.log");
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| err.to_string())?;
    let log_err = log.try_clone().map_err(|err| err.to_string())?;

    let child = Command::new(binary)
        .arg("gateway")
        .current_dir(&state.root)
        .env("LL_GATEWAY_LISTEN", &gateway_settings.listen)
        .env("LL_GATEWAY_OUTPUT_DIR", &captures_dir)
        .env("LL_GATEWAY_OUTPUT_FILE", &capture_path)
        .env("LL_GATEWAY_BODY_LIMIT", "20000")
        .env(
            "LL_GATEWAY_OPENAI_BASE_URL",
            &gateway_settings.openai_base_url,
        )
        .env(
            "LL_GATEWAY_ANTHROPIC_BASE_URL",
            &gateway_settings.anthropic_base_url,
        )
        .env(
            "LL_GATEWAY_OPENAI_API_KEY",
            gateway_settings.openai_api_key.clone().unwrap_or_default(),
        )
        .env(
            "LL_GATEWAY_ANTHROPIC_API_KEY",
            gateway_settings
                .anthropic_api_key
                .clone()
                .unwrap_or_default(),
        )
        .env(
            "LL_GATEWAY_MAX_RETRIES",
            gateway_settings.max_retries.to_string(),
        )
        .env(
            "LL_GATEWAY_REDACT",
            if gateway_settings.redaction_enabled {
                "true"
            } else {
                "false"
            },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|err| err.to_string())?;

    let pid = child.id();
    let capture_file = capture_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string());
    *state
        .last_gateway_capture
        .lock()
        .map_err(|err| err.to_string())? = capture_file.clone();
    *gateway = Some(child);
    Ok(GatewayStatus {
        running: true,
        pid: Some(pid),
        external: false,
        listen: gateway_settings.listen,
        capture_file,
        message: format!("Gateway started, capture: {}", capture_path.display()),
    })
}

#[tauri::command]
fn stop_gateway(state: State<'_, AppState>) -> Result<GatewayStatus, String> {
    let mut gateway = state.gateway.lock().map_err(|err| err.to_string())?;
    if let Some(mut child) = gateway.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let listen = state
        .last_gateway_listen
        .lock()
        .map_err(|err| err.to_string())?
        .clone();
    *state
        .last_gateway_capture
        .lock()
        .map_err(|err| err.to_string())? = None;
    Ok(GatewayStatus {
        running: false,
        pid: None,
        external: false,
        listen,
        capture_file: None,
        message: "Gateway stopped".to_owned(),
    })
}

#[tauri::command]
fn test_gateway_provider(
    state: State<'_, AppState>,
    provider: String,
) -> Result<ProviderTestResult, String> {
    let settings = read_gateway_settings_file(&state.root)?;
    let provider = provider.to_ascii_lowercase();
    let (key, base_url, label) = match provider.as_str() {
        "openai" => (
            settings.openai_api_key,
            settings.openai_base_url,
            "OpenAI".to_owned(),
        ),
        "anthropic" => (
            settings.anthropic_api_key,
            settings.anthropic_base_url,
            "Anthropic".to_owned(),
        ),
        _ => return Err("unknown gateway provider".to_owned()),
    };
    let ok = key.as_deref().is_some_and(|value| !value.trim().is_empty());
    Ok(ProviderTestResult {
        provider,
        ok,
        base_url,
        message: if ok {
            format!(
                "{label} key is configured. LoopLens will verify it on the first gateway request."
            )
        } else {
            format!("{label} key is missing. Add a key or send pass-through credentials.")
        },
    })
}

#[tauri::command]
fn list_capture_files(state: State<'_, AppState>) -> Result<Vec<CaptureFile>, String> {
    capture_files(&state.root.join("captures"))
}

#[tauri::command]
fn clear_capture_history(
    state: State<'_, AppState>,
    keep_name: Option<String>,
) -> Result<usize, String> {
    let captures_dir = state.root.join("captures");
    if !captures_dir.exists() {
        return Ok(0);
    }

    let keep_name = keep_name.unwrap_or_default();
    let mut removed = 0;
    for file in capture_files(&captures_dir)? {
        if !keep_name.is_empty() && file.name == keep_name {
            continue;
        }
        let path = safe_capture_path(&captures_dir, &file.name)?;
        fs::remove_file(path).map_err(|err| err.to_string())?;
        removed += 1;
    }
    Ok(removed)
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
    files.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| b.name.cmp(&a.name))
    });
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
fn validate_capture(state: State<'_, AppState>, name: String) -> Result<CaptureHealth, String> {
    let captures_dir = state.root.join("captures");
    let path = safe_capture_path(&captures_dir, &name)?;
    validate_capture_file(&path, &name)
}

fn validate_capture_file(path: &Path, name: &str) -> Result<CaptureHealth, String> {
    let file = fs::File::open(path).map_err(|err| err.to_string())?;
    let reader = BufReader::new(file);
    let mut total_lines = 0;
    let mut valid_lines = 0;
    let mut invalid_lines = 0;
    let mut diagnostics = Vec::new();
    let mut records = Vec::new();
    let mut first_request_lines: HashMap<String, usize> = HashMap::new();

    for (index, line) in reader.lines().enumerate() {
        let line_number = index + 1;
        let line = line.map_err(|err| err.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        total_lines += 1;
        match serde_json::from_str::<Value>(&line) {
            Ok(value) => {
                valid_lines += 1;
                if value["direction"].as_str() == Some("request") {
                    let id = flow_id_from_record(&value, line_number);
                    if let Some(first_line) = first_request_lines.insert(id.clone(), line_number) {
                        diagnostics.push(CaptureDiagnostic {
                            severity: "error".to_owned(),
                            code: "duplicate_flow_id".to_owned(),
                            message: format!(
                                "flow {id} has multiple request records (first line {first_line}, duplicate line {line_number})"
                            ),
                            flow_id: Some(id),
                            line: Some(line_number),
                        });
                    }
                }
                records.push(value);
            }
            Err(err) => {
                invalid_lines += 1;
                diagnostics.push(CaptureDiagnostic {
                    severity: "error".to_owned(),
                    code: "invalid_json_line".to_owned(),
                    message: format!("line {line_number} is not valid JSON: {err}"),
                    flow_id: None,
                    line: Some(line_number),
                });
            }
        }
    }

    let groups = group_records(records);
    let mut request_count = 0;
    let mut response_start_count = 0;
    let mut chunk_count = 0;
    let mut orphan_chunks = 0;
    let mut pending_flows = 0;
    let mut error_flows = 0;
    let mut connect_flows = 0;
    let mut low_signal_flows = 0;

    for (id, group) in &groups {
        if group.request.is_some() {
            request_count += 1;
        }
        if group.response_start.is_some() {
            response_start_count += 1;
        }
        chunk_count += group.chunks.len();

        let summary = summarize_flow(id, group);
        if group.request.is_none() && !group.chunks.is_empty() {
            orphan_chunks += group.chunks.len();
            diagnostics.push(CaptureDiagnostic {
                severity: "error".to_owned(),
                code: "orphan_chunks".to_owned(),
                message: format!("flow {id} has response chunks but no request record"),
                flow_id: Some(id.clone()),
                line: None,
            });
        }
        if group.request.is_some() && group.response_start.is_none() && group.chunks.is_empty() {
            pending_flows += 1;
            diagnostics.push(CaptureDiagnostic {
                severity: "warning".to_owned(),
                code: "pending_flow".to_owned(),
                message: format!("flow {id} has a request but no response yet"),
                flow_id: Some(id.clone()),
                line: None,
            });
        }
        if summary.status.is_some_and(|status| status >= 400) {
            error_flows += 1;
            diagnostics.push(CaptureDiagnostic {
                severity: "warning".to_owned(),
                code: "http_error".to_owned(),
                message: format!(
                    "flow {id} returned HTTP {}",
                    summary.status.unwrap_or_default()
                ),
                flow_id: Some(id.clone()),
                line: None,
            });
        }
        if summary.method.eq_ignore_ascii_case("CONNECT") {
            connect_flows += 1;
        }
        if summary.semantic.low_signal {
            low_signal_flows += 1;
        }
    }

    let duplicate_flow_ids = diagnostics
        .iter()
        .filter(|item| item.code == "duplicate_flow_id")
        .filter_map(|item| item.flow_id.clone())
        .collect::<Vec<_>>();
    let has_error = invalid_lines > 0 || !duplicate_flow_ids.is_empty() || orphan_chunks > 0;
    let has_warning =
        pending_flows > 0 || error_flows > 0 || connect_flows > 0 || low_signal_flows > 0;
    let status = if has_error {
        "broken"
    } else if has_warning {
        "warnings"
    } else {
        "healthy"
    }
    .to_owned();

    Ok(CaptureHealth {
        file: name.to_owned(),
        total_lines,
        valid_lines,
        invalid_lines,
        flow_count: groups.len(),
        duplicate_flow_ids,
        request_count,
        response_start_count,
        chunk_count,
        orphan_chunks,
        pending_flows,
        error_flows,
        connect_flows,
        low_signal_flows,
        status,
        diagnostics,
    })
}

#[tauri::command]
fn environment_status(state: State<'_, AppState>) -> EnvironmentStatus {
    let proxy_binary = proxy_binary(&state.root);
    let ca_cert = state.root.join("ca/looplens-ca.pem");
    let ca_key = state.root.join("ca/looplens-ca.key");
    EnvironmentStatus {
        proxy_binary: display_path(&proxy_binary),
        proxy_binary_exists: proxy_binary.exists(),
        ca_cert: display_path(&ca_cert),
        ca_cert_exists: ca_cert.exists(),
        ca_key: display_path(&ca_key),
        ca_key_exists: ca_key.exists(),
        ca_trusted: ca_is_trusted(&ca_cert),
        tools: ["claude", "codex"]
            .iter()
            .map(|tool| tool_status(&state.root, tool))
            .collect(),
    }
}

fn ca_is_trusted(ca_cert: &Path) -> bool {
    if !ca_cert.exists() {
        return false;
    }

    #[cfg(target_os = "macos")]
    {
        let keychain = env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Library/Keychains/login.keychain-db"));
        let Some(keychain) = keychain else {
            return false;
        };
        Command::new("security")
            .arg("find-certificate")
            .arg("-c")
            .arg("LoopLens local CA")
            .arg(keychain)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(not(target_os = "macos"))]
    {
        false
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
fn hook_status(state: State<'_, AppState>) -> Result<HookStatus, String> {
    let receiver = state
        .hook_receiver
        .lock()
        .map_err(|err| err.to_string())?
        .clone();
    let events = read_hook_events_for_root(&state.root, Some(1))?;
    Ok(HookStatus {
        receiver,
        claude: claude_hook_state(&state.root),
        codex: codex_hook_state(&state.root),
        total_events: events.total,
        last_event: events.events.into_iter().last(),
    })
}

#[tauri::command]
fn read_hook_events(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<HookEventsIndex, String> {
    read_hook_events_for_root(&state.root, limit)
}

#[tauri::command]
fn install_hooks(
    state: State<'_, AppState>,
    target: String,
) -> Result<Vec<HookInstallState>, String> {
    ensure_codex_hook_bridge(&state.root)?;
    let mut results = Vec::new();
    for target in expand_hook_targets(&target)? {
        let result = match target {
            "claude" => install_claude_hooks(&state.root),
            "codex" => install_codex_hooks(&state.root),
            _ => unreachable!(),
        }?;
        results.push(result);
    }
    Ok(results)
}

#[tauri::command]
fn remove_hooks(
    state: State<'_, AppState>,
    target: String,
) -> Result<Vec<HookInstallState>, String> {
    let mut results = Vec::new();
    for target in expand_hook_targets(&target)? {
        let result = match target {
            "claude" => remove_claude_hooks(&state.root),
            "codex" => remove_codex_hooks(&state.root),
            _ => unreachable!(),
        }?;
        results.push(result);
    }
    Ok(results)
}

#[tauri::command]
fn test_hooks(state: State<'_, AppState>, target: String) -> Result<Vec<HookEventRecord>, String> {
    let mut records = Vec::new();
    for target in expand_hook_targets(&target)? {
        let payload = json!({
            "hook_event_name": "LoopLensTest",
            "session_id": "looplens-test",
            "turn_id": "looplens-test",
            "transcript_path": display_path(&state.root.join("hooks/looplens-test-transcript.jsonl")),
            "cwd": display_path(&state.root),
            "source": "manual-test",
            "model": "looplens-test-model",
            "permission_mode": "test",
            "agent_id": "looplens-agent",
            "agent_type": "debugger",
            "tool_name": "LoopLensHookTest",
            "tool_use_id": "toolu_looplens_test",
            "tool_input": {
                "command": "echo looplens",
                "description": "Synthetic hook payload used to verify field extraction"
            },
            "tool_response": {
                "ok": true,
                "output": "looplens"
            },
            "permission_suggestions": [{ "permission": "allow LoopLensHookTest" }],
            "prompt": "LoopLens hook extraction smoke test",
            "message": format!("LoopLens {target} hook test"),
            "last_assistant_message": "Synthetic assistant final message",
            "reason": "manual verification",
            "trigger": "manual",
            "custom_instructions": "Preserve debugging context",
            "compact_summary": "Synthetic compact summary",
            "notification_type": "test",
            "memory_type": "Project",
            "load_reason": "session_start",
            "file_path": display_path(&state.root.join("README.md")),
            "event": "change",
            "trigger_file_path": display_path(&state.root.join("crates/looplens-proxy/src/main.rs")),
            "parent_file_path": display_path(&state.root.join("AGENTS.md")),
        });
        let record = post_or_record_hook_event(&state.root, target, payload)?;
        records.push(record);
    }
    Ok(records)
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
        let id = flow_id_from_record(&record, index);
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

fn flow_id_from_record(record: &Value, fallback: usize) -> String {
    record["flow_id"]
        .as_u64()
        .map(|value| value.to_string())
        .or_else(|| record["flow_id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("no-flow-{fallback}"))
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
    let method = string_field(base, "method").unwrap_or_else(|| "-".to_owned());
    let semantic = parse_semantics(group, &host, &path, &method);
    let provider = semantic
        .gateway_provider
        .as_deref()
        .map(provider_from_gateway)
        .unwrap_or_else(|| provider_from_host(&host));
    let request_size = group
        .request
        .as_ref()
        .and_then(|record| record["body"]["size_bytes"].as_u64());

    FlowSummary {
        id: id.to_owned(),
        method,
        url,
        host: host.clone(),
        path,
        provider,
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

fn parse_semantics(group: &FlowGroup, host: &str, path: &str, method: &str) -> SemanticInfo {
    let request_json = group.request.as_ref().and_then(|record| {
        record["body"]["json"]
            .as_object()
            .map(|_| &record["body"]["json"])
    });
    let gateway = gateway_meta_from_group(group);
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
        .or_else(|| {
            gateway
                .as_ref()
                .and_then(|meta| string_field(meta, "client"))
        })
        .or_else(|| group.request.as_ref().and_then(client_from_headers));
    let model = request_json
        .and_then(|json| find_string_key(json, "model"))
        .or_else(|| {
            gateway
                .as_ref()
                .and_then(|meta| string_field(meta, "model"))
        });
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
    let low_signal = is_low_signal_flow(method, host, path, &category, group);
    let gateway_provider = gateway
        .as_ref()
        .and_then(|meta| string_field(meta, "provider"));
    let upstream_url = gateway
        .as_ref()
        .and_then(|meta| string_field(meta, "upstream_url"));
    let gateway_route_reason = gateway
        .as_ref()
        .and_then(|meta| string_field(meta, "gateway_route_reason"));
    let retry_count = gateway
        .as_ref()
        .and_then(|meta| meta["retry_count"].as_u64());
    let attempt_count = gateway
        .as_ref()
        .and_then(|meta| meta["attempt_count"].as_u64());
    let retry_reasons = gateway
        .as_ref()
        .and_then(|meta| meta["retry_reasons"].as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToOwned::to_owned))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    SemanticInfo {
        category,
        client,
        gateway_provider,
        upstream_url,
        gateway_route_reason,
        retry_count,
        attempt_count,
        retry_reasons,
        rpc_method,
        mcp_server,
        tool_names,
        skill_names,
        model,
        event_type,
        token_usage,
        redaction_hits,
        low_signal,
    }
}

fn gateway_meta_from_group(group: &FlowGroup) -> Option<Value> {
    group
        .request
        .as_ref()
        .and_then(|record| {
            record["body"]["gateway"]
                .as_object()
                .map(|_| record["body"]["gateway"].clone())
        })
        .or_else(|| {
            group.response_start.as_ref().and_then(|record| {
                record["body"]["gateway"]
                    .as_object()
                    .map(|_| record["body"]["gateway"].clone())
            })
        })
        .or_else(|| {
            group.chunks.iter().find_map(|chunk| {
                chunk["body"]["gateway"]
                    .as_object()
                    .map(|_| chunk["body"]["gateway"].clone())
            })
        })
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

fn is_low_signal_flow(
    method: &str,
    host: &str,
    path: &str,
    category: &str,
    group: &FlowGroup,
) -> bool {
    let host = host.to_ascii_lowercase();
    let path = path.to_ascii_lowercase();
    let method = method.to_ascii_uppercase();
    let tunnel_only = method == "CONNECT" && group.chunks.is_empty();
    if tunnel_only && category != "Model" && category != "MCP" && category != "Tool call" {
        return true;
    }
    if category == "Telemetry" {
        return true;
    }
    if (host == "127.0.0.1"
        || host == "localhost"
        || host.starts_with("127.0.0.1:")
        || host.starts_with("localhost:"))
        && path.contains("/hooks/")
    {
        return true;
    }
    if host.contains("registry.npm")
        || host.contains("npmjs")
        || host.contains("npmmirror")
        || host.contains("yarnpkg")
        || host.contains("sentry")
        || host.contains("telemetry")
    {
        return true;
    }
    path.ends_with(".js")
        || path.ends_with(".css")
        || path.ends_with(".png")
        || path.ends_with(".jpg")
        || path.ends_with(".jpeg")
        || path.ends_with(".gif")
        || path.ends_with(".svg")
        || path.ends_with(".ico")
        || path.contains("/favicon")
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

fn provider_from_gateway(provider: &str) -> String {
    match provider {
        "openai" => "OpenAI".to_owned(),
        "anthropic" => "Anthropic".to_owned(),
        other => other.to_owned(),
    }
}

fn start_hook_receiver(
    root: &Path,
    listen: &str,
    run_contexts: Arc<Mutex<Vec<RunContext>>>,
) -> HookReceiverStatus {
    let event_file = hook_events_path(root);
    let url_base = format!("http://{listen}/hooks");
    let listener = match TcpListener::bind(listen) {
        Ok(listener) => listener,
        Err(err) => {
            return HookReceiverStatus {
                listen: listen.to_owned(),
                url_base,
                running: false,
                message: format!("Hook receiver unavailable: {err}"),
                event_file: display_path(&event_file),
            };
        }
    };

    let root = root.to_path_buf();
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let root = root.clone();
                    let run_contexts = run_contexts.clone();
                    thread::spawn(move || {
                        let _ = handle_hook_http_stream(stream, &root, &run_contexts);
                    });
                }
                Err(_) => break,
            }
        }
    });

    HookReceiverStatus {
        listen: listen.to_owned(),
        url_base,
        running: true,
        message: "Hook receiver is listening".to_owned(),
        event_file: display_path(&event_file),
    }
}

fn handle_hook_http_stream(
    mut stream: TcpStream,
    root: &Path,
    run_contexts: &Arc<Mutex<Vec<RunContext>>>,
) -> Result<(), String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 8192];
    let mut header_end = None;
    let mut content_length = 0_usize;

    loop {
        let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..read]);
        if header_end.is_none() {
            header_end = find_header_end(&buffer);
            if let Some(end) = header_end {
                let headers = String::from_utf8_lossy(&buffer[..end]);
                content_length = parse_content_length(&headers).unwrap_or(0);
            }
        }
        if let Some(end) = header_end {
            if buffer.len() >= end + 4 + content_length {
                break;
            }
        }
        if buffer.len() > 20 * 1024 * 1024 {
            write_http_json(
                &mut stream,
                413,
                &json!({ "ok": false, "error": "payload too large" }),
            )?;
            return Ok(());
        }
    }

    let Some(end) = header_end else {
        write_http_json(
            &mut stream,
            400,
            &json!({ "ok": false, "error": "missing headers" }),
        )?;
        return Ok(());
    };
    let headers = String::from_utf8_lossy(&buffer[..end]);
    let mut lines = headers.lines();
    let request_line = lines.next().unwrap_or_default();
    let parts = request_line.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 2 {
        write_http_json(
            &mut stream,
            400,
            &json!({ "ok": false, "error": "bad request" }),
        )?;
        return Ok(());
    }

    let method = parts[0];
    let path = parts[1];
    if method == "GET" && path == "/hooks/status" {
        write_http_json(&mut stream, 200, &json!({ "ok": true, "status": "ready" }))?;
        return Ok(());
    }

    if method != "POST" || !path.starts_with("/hooks/") {
        write_http_json(
            &mut stream,
            404,
            &json!({ "ok": false, "error": "not found" }),
        )?;
        return Ok(());
    }

    let source = path
        .trim_start_matches("/hooks/")
        .split(['?', '/'])
        .next()
        .unwrap_or("unknown");
    let body_start = end + 4;
    let body_end = body_start.saturating_add(content_length).min(buffer.len());
    let body = &buffer[body_start..body_end];
    let payload = serde_json::from_slice::<Value>(body).unwrap_or_else(
        |_| json!({ "hook_event_name": "InvalidJson", "body": String::from_utf8_lossy(body) }),
    );
    let record = record_hook_event(root, source, payload, Some(run_contexts))?;
    write_http_json(
        &mut stream,
        200,
        &json!({
            "ok": true,
            "continue": true,
            "record_id": record.id,
        }),
    )?;
    Ok(())
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(headers: &str) -> Option<usize> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    })
}

fn write_http_json(stream: &mut TcpStream, status: u16, value: &Value) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        _ => "OK",
    };
    let body = serde_json::to_string(value).map_err(|err| err.to_string())?;
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|err| err.to_string())
}

fn hook_events_dir(root: &Path) -> PathBuf {
    root.join("hooks")
}

fn hook_events_path(root: &Path) -> PathBuf {
    hook_events_dir(root).join(HOOK_EVENTS_FILE)
}

fn hook_url(source: &str) -> String {
    format!("http://{HOOK_LISTEN}/hooks/{source}")
}

fn record_hook_event(
    root: &Path,
    source: &str,
    raw: Value,
    run_contexts: Option<&Arc<Mutex<Vec<RunContext>>>>,
) -> Result<HookEventRecord, String> {
    fs::create_dir_all(hook_events_dir(root)).map_err(|err| err.to_string())?;
    let source = normalized_hook_source(source);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?;
    let received_at = now.as_secs_f64();
    let run_context =
        run_contexts.and_then(|contexts| match_hook_run_context(contexts, &source, received_at));
    let event_name =
        hook_value_string_any(&raw, &["hook_event_name", "hookEventName", "event_name"])
            .unwrap_or_else(|| "unknown".to_owned());
    let session_id =
        hook_value_string_any(&raw, &["session_id", "sessionId", "thread_id", "threadId"]);
    let turn_id = hook_value_string_any(&raw, &["turn_id", "turnId"]);
    let transcript_path = hook_value_string_any(&raw, &["transcript_path", "transcriptPath"]);
    let cwd = hook_value_string_any(
        &raw,
        &[
            "cwd",
            "current_working_directory",
            "currentWorkingDirectory",
        ],
    );
    let hook_source = hook_value_string(&raw, &["source"]);
    let model = hook_value_string_any(&raw, &["model"]);
    let permission_mode = hook_value_string_any(&raw, &["permission_mode", "permissionMode"]);
    let agent_id = hook_value_string_any(&raw, &["agent_id", "agentId"]);
    let agent_type = hook_value_string_any(&raw, &["agent_type", "agentType"]);
    let tool_name = hook_value_string_any(&raw, &["tool_name", "toolName", "tool"]);
    let tool_use_id = hook_value_string_any(
        &raw,
        &[
            "tool_use_id",
            "toolUseId",
            "tool_call_id",
            "toolCallId",
            "call_id",
            "callId",
        ],
    );
    let tool_input = hook_value_any(
        &raw,
        &[
            "tool_input",
            "toolInput",
            "tool_args",
            "toolArgs",
            "arguments",
            "input",
        ],
    );
    let tool_response = hook_value_any(
        &raw,
        &[
            "tool_response",
            "toolResponse",
            "tool_result",
            "toolResult",
            "response",
            "result",
            "output",
        ],
    );
    let permission_suggestions =
        hook_value_any(&raw, &["permission_suggestions", "permissionSuggestions"]);
    let prompt = hook_value_string_any(&raw, &["prompt", "user_prompt", "userPrompt"]);
    let message = hook_value_string_any(&raw, &["message"]);
    let last_assistant_message =
        hook_value_string_any(&raw, &["last_assistant_message", "lastAssistantMessage"]);
    let title = hook_value_string_any(&raw, &["title"]);
    let error = hook_value_string_any(
        &raw,
        &[
            "error",
            "error_message",
            "errorMessage",
            "error_details",
            "errorDetails",
        ],
    );
    let reason = hook_value_string_any(
        &raw,
        &[
            "reason",
            "stop_reason",
            "stopReason",
            "permission_decision_reason",
            "permissionDecisionReason",
            "block_reason",
            "blockReason",
        ],
    );
    let decision = hook_value_string_any(
        &raw,
        &[
            "decision",
            "permission_decision",
            "permissionDecision",
            "behavior",
            "action",
        ],
    );
    let trigger = hook_value_string_any(&raw, &["trigger"]);
    let custom_instructions =
        hook_value_string_any(&raw, &["custom_instructions", "customInstructions"]);
    let compact_summary = hook_value_string_any(&raw, &["compact_summary", "compactSummary"]);
    let action = hook_value_string_any(&raw, &["action"]);
    let notification_type = hook_value_string_any(&raw, &["notification_type", "notificationType"]);
    let mcp_server_name = hook_value_string_any(
        &raw,
        &[
            "mcp_server_name",
            "mcpServerName",
            "server_name",
            "serverName",
        ],
    );
    let elicitation_id = hook_value_string_any(&raw, &["elicitation_id", "elicitationId"]);
    let file_path = hook_value_string_any(&raw, &["file_path", "filePath"]);
    let file_event = hook_value_string_any(&raw, &["event", "file_event", "fileEvent"]);
    let trigger_file_path = hook_value_string_any(&raw, &["trigger_file_path", "triggerFilePath"]);
    let parent_file_path = hook_value_string_any(&raw, &["parent_file_path", "parentFilePath"]);
    let memory_type = hook_value_string_any(&raw, &["memory_type", "memoryType"]);
    let load_reason = hook_value_string_any(&raw, &["load_reason", "loadReason"]);
    let old_cwd = hook_value_string_any(&raw, &["old_cwd", "oldCwd"]);
    let new_cwd = hook_value_string_any(&raw, &["new_cwd", "newCwd"]);
    let worktree_path = hook_value_string_any(&raw, &["worktree_path", "worktreePath"]);
    let worktree_name = hook_value_string_any(&raw, &["name", "worktree_name", "worktreeName"]);
    let task_id = hook_value_string_any(&raw, &["task_id", "taskId"]);
    let task_subject = hook_value_string_any(&raw, &["task_subject", "taskSubject"]);
    let teammate_name = hook_value_string_any(&raw, &["teammate_name", "teammateName"]);
    let team_name = hook_value_string_any(&raw, &["team_name", "teamName"]);
    let stop_hook_active = hook_value_bool_any(&raw, &["stop_hook_active", "stopHookActive"]);
    let is_interrupt = hook_value_bool_any(&raw, &["is_interrupt", "isInterrupt", "interrupt"]);
    let payload_size = serde_json::to_vec(&raw).map(|body| body.len()).unwrap_or(0);
    let payload_preview = hook_preview(&raw, 900);
    let extracted = hook_extracted_summary(
        &[
            ("session_id", session_id.as_ref()),
            ("turn_id", turn_id.as_ref()),
            ("transcript_path", transcript_path.as_ref()),
            ("cwd", cwd.as_ref()),
            ("hook_source", hook_source.as_ref()),
            ("model", model.as_ref()),
            ("permission_mode", permission_mode.as_ref()),
            ("agent_id", agent_id.as_ref()),
            ("agent_type", agent_type.as_ref()),
            ("tool_name", tool_name.as_ref()),
            ("tool_use_id", tool_use_id.as_ref()),
            ("prompt", prompt.as_ref()),
            ("message", message.as_ref()),
            ("last_assistant_message", last_assistant_message.as_ref()),
            ("title", title.as_ref()),
            ("error", error.as_ref()),
            ("reason", reason.as_ref()),
            ("decision", decision.as_ref()),
            ("trigger", trigger.as_ref()),
            ("custom_instructions", custom_instructions.as_ref()),
            ("compact_summary", compact_summary.as_ref()),
            ("action", action.as_ref()),
            ("notification_type", notification_type.as_ref()),
            ("mcp_server_name", mcp_server_name.as_ref()),
            ("elicitation_id", elicitation_id.as_ref()),
            ("file_path", file_path.as_ref()),
            ("file_event", file_event.as_ref()),
            ("trigger_file_path", trigger_file_path.as_ref()),
            ("parent_file_path", parent_file_path.as_ref()),
            ("memory_type", memory_type.as_ref()),
            ("load_reason", load_reason.as_ref()),
            ("old_cwd", old_cwd.as_ref()),
            ("new_cwd", new_cwd.as_ref()),
            ("worktree_path", worktree_path.as_ref()),
            ("worktree_name", worktree_name.as_ref()),
            ("task_id", task_id.as_ref()),
            ("task_subject", task_subject.as_ref()),
            ("teammate_name", teammate_name.as_ref()),
            ("team_name", team_name.as_ref()),
        ],
        &[
            ("tool_input", tool_input.as_ref()),
            ("tool_response", tool_response.as_ref()),
            ("permission_suggestions", permission_suggestions.as_ref()),
        ],
        &[
            ("stop_hook_active", stop_hook_active),
            ("is_interrupt", is_interrupt),
        ],
    );
    let record = HookEventRecord {
        id: format!("hook:{source}:{}:{event_name}", now.as_nanos()),
        source,
        event_name,
        received_at,
        capture_file: run_context
            .as_ref()
            .map(|context| context.capture_file.clone()),
        run_source: run_context.as_ref().map(|context| context.source.clone()),
        run_listen: run_context.as_ref().map(|context| context.listen.clone()),
        run_started_at: run_context.as_ref().map(|context| context.started_at),
        session_id,
        turn_id,
        transcript_path,
        cwd,
        hook_source,
        model,
        permission_mode,
        agent_id,
        agent_type,
        tool_name,
        tool_use_id,
        tool_input,
        tool_response,
        permission_suggestions,
        prompt,
        message,
        last_assistant_message,
        title,
        error,
        reason,
        decision,
        trigger,
        custom_instructions,
        compact_summary,
        action,
        notification_type,
        mcp_server_name,
        elicitation_id,
        file_path,
        file_event,
        trigger_file_path,
        parent_file_path,
        memory_type,
        load_reason,
        old_cwd,
        new_cwd,
        worktree_path,
        worktree_name,
        task_id,
        task_subject,
        teammate_name,
        team_name,
        stop_hook_active,
        is_interrupt,
        payload_size,
        payload_preview,
        extracted,
        raw,
    };
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(hook_events_path(root))
        .map_err(|err| err.to_string())?;
    serde_json::to_writer(&mut file, &record).map_err(|err| err.to_string())?;
    file.write_all(b"\n").map_err(|err| err.to_string())?;
    Ok(record)
}

fn match_hook_run_context(
    run_contexts: &Arc<Mutex<Vec<RunContext>>>,
    source: &str,
    received_at: f64,
) -> Option<RunContext> {
    let contexts = run_contexts.lock().ok()?;
    contexts
        .iter()
        .rev()
        .find(|context| {
            context.source == source
                && received_at + 5.0 >= context.started_at
                && received_at - context.started_at <= 12.0 * 60.0 * 60.0
        })
        .cloned()
}

fn post_or_record_hook_event(
    root: &Path,
    target: &str,
    payload: Value,
) -> Result<HookEventRecord, String> {
    let source = hook_source_for_target(target);
    let body = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    if let Ok(mut stream) = TcpStream::connect(HOOK_LISTEN) {
        let path = format!("/hooks/{source}");
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: {HOOK_LISTEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        if stream.write_all(request.as_bytes()).is_ok() {
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            let _ = response;
            return read_hook_events_for_root(root, Some(1))?
                .events
                .into_iter()
                .last()
                .ok_or_else(|| "hook receiver accepted test but no event was recorded".to_owned());
        }
    }
    record_hook_event(root, source, payload, None)
}

fn read_hook_events_for_root(root: &Path, limit: Option<usize>) -> Result<HookEventsIndex, String> {
    let path = hook_events_path(root);
    if !path.exists() {
        return Ok(HookEventsIndex {
            file: display_path(&path),
            total: 0,
            events: Vec::new(),
        });
    }

    let file = fs::File::open(&path).map_err(|err| err.to_string())?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();
    let mut total = 0_usize;
    for line in reader.lines() {
        let line = line.map_err(|err| err.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        total += 1;
        if let Ok(record) = serde_json::from_str::<HookEventRecord>(&line) {
            events.push(record);
        }
    }
    if let Some(limit) = limit {
        if events.len() > limit {
            events = events.split_off(events.len() - limit);
        }
    }
    Ok(HookEventsIndex {
        file: display_path(&path),
        total,
        events,
    })
}

fn hook_value_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(value_to_hook_string))
}

fn hook_value_string_any(value: &Value, keys: &[&str]) -> Option<String> {
    hook_value_string(value, keys).or_else(|| {
        keys.iter()
            .find_map(|key| find_value_key(value, key).and_then(value_to_hook_string))
    })
}

fn hook_value_any(value: &Value, keys: &[&str]) -> Option<Value> {
    keys.iter()
        .find_map(|key| value.get(*key).filter(|item| !item.is_null()).cloned())
        .or_else(|| {
            keys.iter().find_map(|key| {
                find_value_key(value, key)
                    .filter(|item| !item.is_null())
                    .cloned()
            })
        })
}

fn hook_value_bool_any(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_bool))
        .or_else(|| {
            keys.iter()
                .find_map(|key| find_value_key(value, key).and_then(Value::as_bool))
        })
}

fn value_to_hook_string(item: &Value) -> Option<String> {
    item.as_str()
        .map(ToOwned::to_owned)
        .or_else(|| item.as_i64().map(|number| number.to_string()))
        .or_else(|| item.as_u64().map(|number| number.to_string()))
        .or_else(|| item.as_f64().map(|number| number.to_string()))
        .or_else(|| item.as_bool().map(|value| value.to_string()))
}

fn find_value_key<'a>(value: &'a Value, target_key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => {
            if let Some(found) = map.get(target_key) {
                return Some(found);
            }
            map.values()
                .find_map(|item| find_value_key(item, target_key))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| find_value_key(item, target_key)),
        _ => None,
    }
}

fn hook_preview(value: &Value, max_chars: usize) -> String {
    let text = serde_json::to_string(value).unwrap_or_else(|_| value.to_string());
    truncate_chars(&text, max_chars)
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars {
            output.push_str("...");
            return output;
        }
        output.push(ch);
    }
    output
}

fn hook_extracted_summary(
    strings: &[(&str, Option<&String>)],
    values: &[(&str, Option<&Value>)],
    bools: &[(&str, Option<bool>)],
) -> Value {
    let mut map = Map::new();
    for (key, value) in strings {
        if let Some(value) = value {
            map.insert((*key).to_owned(), Value::String((*value).clone()));
        }
    }
    for (key, value) in values {
        if let Some(value) = value {
            map.insert((*key).to_owned(), (*value).clone());
        }
    }
    for (key, value) in bools {
        if let Some(value) = value {
            map.insert((*key).to_owned(), Value::Bool(*value));
        }
    }
    Value::Object(map)
}

fn expand_hook_targets(target: &str) -> Result<Vec<&'static str>, String> {
    match target {
        "all" => Ok(vec!["claude", "codex"]),
        "claude" | "claude-code" => Ok(vec!["claude"]),
        "codex" => Ok(vec!["codex"]),
        _ => Err("unknown hook target".to_owned()),
    }
}

fn hook_source_for_target(target: &str) -> &'static str {
    match target {
        "claude" | "claude-code" => "claude-code",
        "codex" => "codex",
        _ => "unknown",
    }
}

fn normalized_hook_source(source: &str) -> String {
    match source {
        "claude" => "claude-code".to_owned(),
        other => other.to_owned(),
    }
}

fn claude_settings_path(root: &Path) -> PathBuf {
    root.join(".claude/settings.local.json")
}

fn codex_config_path(root: &Path) -> PathBuf {
    root.join(".codex/config.toml")
}

fn codex_hook_bridge_path(root: &Path) -> PathBuf {
    root.join("bin/looplens-hook")
}

fn codex_hook_command(root: &Path) -> String {
    format!(
        "bash {} codex",
        shell_quote(&display_path(&codex_hook_bridge_path(root)))
    )
}

fn claude_hook_state(root: &Path) -> HookInstallState {
    let path = claude_settings_path(root);
    let installed = fs::read_to_string(&path)
        .map(|content| content.contains(&hook_url("claude-code")))
        .unwrap_or(false);
    HookInstallState {
        target: "claude".to_owned(),
        installed,
        path: display_path(&path),
        message: if installed {
            "Claude Code HTTP hooks installed".to_owned()
        } else {
            "Claude Code hooks not installed".to_owned()
        },
    }
}

fn codex_hook_state(root: &Path) -> HookInstallState {
    let path = codex_config_path(root);
    let expected_command = codex_hook_command(root);
    let expected_bridge = display_path(&codex_hook_bridge_path(root));
    let (installed, message) = match fs::read_to_string(&path) {
        Ok(content) => {
            let has_looplens_block = content.contains(LOOPLENS_HOOK_BEGIN);
            let has_current_bridge =
                content.contains(&expected_command) || content.contains(&expected_bridge);
            let hooks_enabled = codex_hooks_feature_enabled(&content);
            if has_looplens_block && has_current_bridge && hooks_enabled {
                (true, "Codex command hooks installed")
            } else if has_looplens_block && !has_current_bridge {
                (
                    false,
                    "Codex hooks point to another LoopLens checkout; enable Hooks again",
                )
            } else if has_looplens_block && !hooks_enabled {
                (
                    false,
                    "Codex hooks are present but disabled; enable Hooks again",
                )
            } else {
                (false, "Codex hooks not installed")
            }
        }
        Err(_) => (false, "Codex hooks not installed"),
    };
    HookInstallState {
        target: "codex".to_owned(),
        installed,
        path: display_path(&path),
        message: message.to_owned(),
    }
}

fn install_claude_hooks(root: &Path) -> Result<HookInstallState, String> {
    let path = claude_settings_path(root);
    fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|err| err.to_string())?;
    let mut settings = read_json_object_or_empty(&path)?;
    let root_object = settings
        .as_object_mut()
        .ok_or_else(|| "Claude settings root is not an object".to_owned())?;
    ensure_allowed_http_hook_url(root_object, &hook_url("claude-code"));
    let hooks = root_object
        .entry("hooks".to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(Map::new());
    }
    let hooks_object = hooks.as_object_mut().unwrap();
    for event in CLAUDE_HOOK_EVENTS {
        ensure_claude_event_hook(hooks_object, event, &hook_url("claude-code"));
    }
    write_json_pretty(&path, &settings)?;
    Ok(claude_hook_state(root))
}

fn remove_claude_hooks(root: &Path) -> Result<HookInstallState, String> {
    let path = claude_settings_path(root);
    if !path.exists() {
        return Ok(claude_hook_state(root));
    }
    let mut settings = read_json_object_or_empty(&path)?;
    let Some(root_object) = settings.as_object_mut() else {
        return Ok(claude_hook_state(root));
    };
    remove_allowed_http_hook_url(root_object, &hook_url("claude-code"));
    if let Some(hooks) = root_object.get_mut("hooks").and_then(Value::as_object_mut) {
        for event in CLAUDE_HOOK_EVENTS {
            remove_claude_event_hook(hooks, event, &hook_url("claude-code"));
        }
        hooks.retain(|_, value| !value.as_array().map(Vec::is_empty).unwrap_or(false));
    }
    write_json_pretty(&path, &settings)?;
    Ok(claude_hook_state(root))
}

fn read_json_object_or_empty(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    if content.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    let value = serde_json::from_str::<Value>(&content).map_err(|err| err.to_string())?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!(
            "settings file is not a JSON object: {}",
            path.display()
        ))
    }
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    fs::write(path, format!("{content}\n")).map_err(|err| err.to_string())
}

fn ensure_allowed_http_hook_url(settings: &mut Map<String, Value>, url: &str) {
    let allowed = settings
        .entry("allowedHttpHookUrls".to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !allowed.is_array() {
        *allowed = Value::Array(Vec::new());
    }
    let values = allowed.as_array_mut().unwrap();
    if !values.iter().any(|value| value.as_str() == Some(url)) {
        values.push(Value::String(url.to_owned()));
    }
}

fn remove_allowed_http_hook_url(settings: &mut Map<String, Value>, url: &str) {
    if let Some(values) = settings
        .get_mut("allowedHttpHookUrls")
        .and_then(Value::as_array_mut)
    {
        values.retain(|value| value.as_str() != Some(url));
    }
}

fn ensure_claude_event_hook(hooks: &mut Map<String, Value>, event: &str, url: &str) {
    let entry = hooks
        .entry(event.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        *entry = Value::Array(Vec::new());
    }
    let matchers = entry.as_array_mut().unwrap();
    if claude_event_has_http_hook(matchers, url) {
        return;
    }
    matchers.push(json!({
        "hooks": [{
            "type": "http",
            "url": url,
            "timeout": 2,
            "statusMessage": "LoopLens capture"
        }]
    }));
}

fn claude_event_has_http_hook(matchers: &[Value], url: &str) -> bool {
    matchers.iter().any(|matcher| {
        matcher
            .get("hooks")
            .and_then(Value::as_array)
            .map(|hooks| {
                hooks.iter().any(|hook| {
                    hook.get("type").and_then(Value::as_str) == Some("http")
                        && hook.get("url").and_then(Value::as_str) == Some(url)
                })
            })
            .unwrap_or(false)
    })
}

fn remove_claude_event_hook(hooks: &mut Map<String, Value>, event: &str, url: &str) {
    let Some(matchers) = hooks.get_mut(event).and_then(Value::as_array_mut) else {
        return;
    };
    for matcher in matchers.iter_mut() {
        if let Some(hook_list) = matcher.get_mut("hooks").and_then(Value::as_array_mut) {
            hook_list.retain(|hook| {
                !(hook.get("type").and_then(Value::as_str) == Some("http")
                    && hook.get("url").and_then(Value::as_str) == Some(url))
            });
        }
    }
    matchers.retain(|matcher| {
        matcher
            .get("hooks")
            .and_then(Value::as_array)
            .map(|hooks| !hooks.is_empty())
            .unwrap_or(true)
    });
}

fn ensure_codex_hook_bridge(root: &Path) -> Result<(), String> {
    let path = codex_hook_bridge_path(root);
    fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|err| err.to_string())?;
    let content = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail

SOURCE="${{1:-codex}}"
URL="${{LOOPLENS_HOOK_URL:-http://{HOOK_LISTEN}/hooks/${{SOURCE}}}}"
TIMEOUT="${{LOOPLENS_HOOK_TIMEOUT:-2}}"

if command -v curl >/dev/null 2>&1; then
  curl --silent --show-error --max-time "$TIMEOUT" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$URL" >/dev/null || true
fi

exit 0
"#
    );
    fs::write(path, content).map_err(|err| err.to_string())
}

fn codex_hooks_feature_enabled(content: &str) -> bool {
    let mut in_features = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_features = trimmed == "[features]";
            continue;
        }
        if !in_features {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        if key.trim() == "hooks" {
            return value.trim_start().starts_with("true");
        }
    }
    false
}

fn install_codex_hooks(root: &Path) -> Result<HookInstallState, String> {
    ensure_codex_hook_bridge(root)?;
    let path = codex_config_path(root);
    fs::create_dir_all(path.parent().unwrap_or(root)).map_err(|err| err.to_string())?;
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let trimmed = remove_looplens_toml_block(&existing);
    let trimmed = ensure_codex_hooks_feature_enabled(&trimmed);
    let block = codex_hooks_toml_block(root);
    let next = if trimmed.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", trimmed.trim_end())
    };
    fs::write(&path, next).map_err(|err| err.to_string())?;
    Ok(codex_hook_state(root))
}

fn ensure_codex_hooks_feature_enabled(content: &str) -> String {
    let lines = content.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    let Some(features_start) = lines.iter().position(|line| line.trim() == "[features]") else {
        let trimmed = content.trim_start_matches('\n');
        if trimmed.trim().is_empty() {
            return "[features]\nhooks = true\n".to_owned();
        }
        return format!("[features]\nhooks = true\n\n{trimmed}");
    };

    let features_end = lines
        .iter()
        .enumerate()
        .skip(features_start + 1)
        .find_map(|(index, line)| {
            let trimmed = line.trim();
            (trimmed.starts_with('[') && trimmed.ends_with(']')).then_some(index)
        })
        .unwrap_or(lines.len());
    let mut output = Vec::new();
    output.extend_from_slice(&lines[..=features_start]);

    let mut feature_lines = Vec::new();
    let mut found_hooks = false;
    for line in &lines[(features_start + 1)..features_end] {
        let key = line
            .split_once('=')
            .map(|(key, _)| key.trim())
            .unwrap_or_default();
        if key == "hooks" {
            if !found_hooks {
                feature_lines.push("hooks = true".to_owned());
                found_hooks = true;
            }
        } else if key == "codex_hooks" {
            continue;
        } else {
            feature_lines.push(line.clone());
        }
    }
    if !found_hooks {
        feature_lines.insert(0, "hooks = true".to_owned());
    }
    output.extend(feature_lines);
    output.extend_from_slice(&lines[features_end..]);
    output.join("\n")
}

fn remove_codex_hooks(root: &Path) -> Result<HookInstallState, String> {
    let path = codex_config_path(root);
    if !path.exists() {
        return Ok(codex_hook_state(root));
    }
    let existing = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let next = remove_looplens_toml_block(&existing);
    fs::write(&path, next.trim_start_matches('\n')).map_err(|err| err.to_string())?;
    Ok(codex_hook_state(root))
}

fn codex_hooks_toml_block(root: &Path) -> String {
    let command = codex_hook_command(root);
    let command = toml_string(&command);
    let mut lines = vec![LOOPLENS_HOOK_BEGIN.to_owned()];
    for event in CODEX_HOOK_EVENTS {
        lines.push(format!("[[hooks.{event}]]"));
        lines.push(format!("[[hooks.{event}.hooks]]"));
        lines.push("type = \"command\"".to_owned());
        lines.push(format!("command = {command}"));
        lines.push("timeout = 2".to_owned());
        lines.push("statusMessage = \"LoopLens capture\"".to_owned());
        lines.push(String::new());
    }
    lines.push(LOOPLENS_HOOK_END.to_owned());
    lines.join("\n")
}

fn remove_looplens_toml_block(content: &str) -> String {
    let mut output = Vec::new();
    let mut skipping = false;
    for line in content.lines() {
        if line.trim() == LOOPLENS_HOOK_BEGIN {
            skipping = true;
            continue;
        }
        if line.trim() == LOOPLENS_HOOK_END {
            skipping = false;
            continue;
        }
        if !skipping {
            output.push(line);
        }
    }
    output.join("\n")
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
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

fn gateway_status_from_state(state: &State<'_, AppState>) -> Result<GatewayStatus, String> {
    let mut gateway = state.gateway.lock().map_err(|err| err.to_string())?;
    let listen = state
        .last_gateway_listen
        .lock()
        .map_err(|err| err.to_string())?
        .clone();
    if let Some(child) = gateway.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(GatewayStatus {
                running: true,
                pid: Some(child.id()),
                external: false,
                listen,
                capture_file: state
                    .last_gateway_capture
                    .lock()
                    .map_err(|err| err.to_string())?
                    .clone(),
                message: "Gateway running from desktop app".to_owned(),
            });
        }
    }
    *gateway = None;
    if port_is_open(&listen) {
        return Ok(GatewayStatus {
            running: true,
            pid: None,
            external: true,
            listen: listen.clone(),
            capture_file: None,
            message: format!("{listen} is already listening"),
        });
    }
    Ok(GatewayStatus {
        running: false,
        pid: None,
        external: false,
        listen,
        capture_file: None,
        message: "Gateway stopped".to_owned(),
    })
}

fn status_from_state(state: &State<'_, AppState>) -> Result<ProxyStatus, String> {
    let mut proxies = state.proxies.lock().map_err(|err| err.to_string())?;
    prune_proxy_runs(&mut proxies)?;
    if let Some(run) = proxies
        .values()
        .max_by(|left, right| left.started_at.total_cmp(&right.started_at))
    {
        let active_count = proxies.len();
        return Ok(ProxyStatus {
            running: true,
            pid: Some(run.child.id()),
            external: false,
            listen: run.listen.clone(),
            message: if active_count == 1 {
                format!("{} proxy running from desktop app", run.source)
            } else {
                format!("{active_count} proxy runs active")
            },
            capture_file: run.capture_file.clone(),
        });
    }
    drop(proxies);
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
            listen: listen.clone(),
            message: format!("{listen} is already listening"),
            capture_file: None,
        });
    }
    Ok(ProxyStatus {
        running: false,
        pid: None,
        external: false,
        listen,
        message: "Proxy stopped".to_owned(),
        capture_file: None,
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
    #[cfg(target_os = "windows")]
    let candidates = [
        root.join("target/release/looplens-proxy.exe"),
        root.join("target/debug/looplens-proxy.exe"),
        root.join("target/release/cc-capture-native.exe"),
        root.join("target/debug/cc-capture-native.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates = [
        root.join("target/release/looplens-proxy"),
        root.join("target/debug/looplens-proxy"),
        root.join("target/release/cc-capture-native"),
        root.join("target/debug/cc-capture-native"),
    ];
    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or_else(|| {
            root.join(if cfg!(target_os = "windows") {
                "target/release/looplens-proxy.exe"
            } else {
                "target/release/looplens-proxy"
            })
        })
}

fn gateway_settings_path() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_owned())?;
    #[cfg(target_os = "macos")]
    {
        Ok(home
            .join("Library/Application Support/LoopLens")
            .join("gateway-settings.json"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(home.join(".looplens").join("gateway-settings.json"))
    }
}

fn default_gateway_settings() -> GatewaySettingsFile {
    GatewaySettingsFile {
        listen: DEFAULT_GATEWAY_LISTEN.to_owned(),
        openai_api_key: None,
        openai_base_url: "https://api.openai.com".to_owned(),
        anthropic_api_key: None,
        anthropic_base_url: "https://api.anthropic.com".to_owned(),
        default_provider: "openai".to_owned(),
        routing_rules: Vec::new(),
        max_retries: 2,
        redaction_enabled: true,
    }
}

fn read_gateway_settings_file(_root: &Path) -> Result<GatewaySettingsFile, String> {
    let path = gateway_settings_path()?;
    if !path.exists() {
        return Ok(default_gateway_settings());
    }
    let content = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    if content.trim().is_empty() {
        return Ok(default_gateway_settings());
    }
    let mut settings = serde_json::from_str::<GatewaySettingsFile>(&content)
        .map_err(|err| format!("invalid gateway settings {}: {err}", path.display()))?;
    normalize_gateway_settings(&mut settings);
    Ok(settings)
}

fn save_gateway_settings_for_root(
    root: &Path,
    input: GatewaySettingsInput,
) -> Result<GatewaySettingsFile, String> {
    let mut settings = read_gateway_settings_file(root)?;
    if let Some(value) = clean_setting_string(input.listen) {
        settings.listen = value;
    }
    if let Some(value) = clean_setting_string(input.openai_base_url) {
        settings.openai_base_url = value;
    }
    if let Some(value) = clean_setting_string(input.anthropic_base_url) {
        settings.anthropic_base_url = value;
    }
    if let Some(value) = input.openai_api_key {
        apply_key_update(&mut settings.openai_api_key, value);
    }
    if let Some(value) = input.anthropic_api_key {
        apply_key_update(&mut settings.anthropic_api_key, value);
    }
    if let Some(value) = clean_setting_string(input.default_provider) {
        settings.default_provider = value;
    }
    if let Some(value) = input.routing_rules {
        settings.routing_rules = value;
    }
    if let Some(value) = input.max_retries {
        settings.max_retries = value.min(5);
    }
    if let Some(value) = input.redaction_enabled {
        settings.redaction_enabled = value;
    }
    normalize_gateway_settings(&mut settings);

    let path = gateway_settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let content = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
    fs::write(&path, content).map_err(|err| err.to_string())?;
    lock_down_settings_file(&path)?;
    Ok(settings)
}

fn gateway_settings_view(root: &Path) -> Result<GatewaySettingsView, String> {
    let settings = read_gateway_settings_file(root)?;
    let path = gateway_settings_path()?;
    Ok(GatewaySettingsView {
        listen: settings.listen,
        openai_key_masked: settings.openai_api_key.as_deref().map(mask_key),
        openai_base_url: settings.openai_base_url,
        anthropic_key_masked: settings.anthropic_api_key.as_deref().map(mask_key),
        anthropic_base_url: settings.anthropic_base_url,
        default_provider: settings.default_provider,
        routing_rules: settings.routing_rules,
        max_retries: settings.max_retries,
        redaction_enabled: settings.redaction_enabled,
        settings_path: display_path(&path),
    })
}

fn normalize_gateway_settings(settings: &mut GatewaySettingsFile) {
    if settings.listen.trim().is_empty() {
        settings.listen = DEFAULT_GATEWAY_LISTEN.to_owned();
    }
    if settings.openai_base_url.trim().is_empty() {
        settings.openai_base_url = "https://api.openai.com".to_owned();
    }
    if settings.anthropic_base_url.trim().is_empty() {
        settings.anthropic_base_url = "https://api.anthropic.com".to_owned();
    }
    if !matches!(settings.default_provider.as_str(), "openai" | "anthropic") {
        settings.default_provider = "openai".to_owned();
    }
    settings.max_retries = settings.max_retries.min(5);
}

fn clean_setting_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}

fn apply_key_update(slot: &mut Option<String>, value: String) {
    let value = value.trim();
    if value == "__CLEAR__" {
        *slot = None;
    } else if !value.is_empty() && !value.contains('•') {
        *slot = Some(value.to_owned());
    }
}

fn mask_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.len() <= 8 {
        return "••••".to_owned();
    }
    let prefix = trimmed.chars().take(3).collect::<String>();
    let suffix = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{prefix}••••{suffix}")
}

fn lock_down_settings_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, permissions).map_err(|err| err.to_string())?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .expect("desktop/src-tauri should live under native project root")
        .to_path_buf()
}

fn main() {
    let root = project_root();
    let run_contexts = Arc::new(Mutex::new(Vec::new()));
    let hook_receiver = start_hook_receiver(&root, HOOK_LISTEN, run_contexts.clone());
    tauri::Builder::default()
        .manage(AppState {
            proxies: Mutex::new(HashMap::new()),
            run_contexts,
            gateway: Mutex::new(None),
            last_listen: Mutex::new("127.0.0.1:8899".to_owned()),
            last_gateway_listen: Mutex::new(DEFAULT_GATEWAY_LISTEN.to_owned()),
            last_gateway_capture: Mutex::new(None),
            hook_receiver: Mutex::new(hook_receiver),
            root,
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            proxy_status,
            start_proxy,
            stop_proxy,
            gateway_status,
            start_gateway,
            stop_gateway,
            read_gateway_settings,
            save_gateway_settings,
            test_gateway_provider,
            list_capture_files,
            clear_capture_history,
            read_capture_file,
            read_capture_index,
            read_flow_detail,
            validate_capture,
            environment_status,
            run_helper,
            hook_status,
            read_hook_events,
            install_hooks,
            remove_hooks,
            test_hooks,
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
