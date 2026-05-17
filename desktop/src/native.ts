import { invoke } from "@tauri-apps/api/core";

export function isNativeRuntime() {
  return Boolean(window.__TAURI_INTERNALS__?.invoke);
}

const previewTools = [
  {
    id: "claude",
    label: "Claude Code",
    wrapper: "",
    command: "claude",
    wrapper_exists: false,
    command_path: null,
  },
  {
    id: "codex",
    label: "Codex",
    wrapper: "",
    command: "codex",
    wrapper_exists: false,
    command_path: null,
  },
];

const previewFallbacks = {
  app_info: () => ({
    root: "Preview mode",
    binary: "",
    captures_dir: "",
    ca_cert: "",
  }),
  proxy_status: () => ({
    running: false,
    pid: null,
    external: false,
    listen: "127.0.0.1:8899",
    message: "Native runtime unavailable in browser preview",
    capture_file: null,
  }),
  start_proxy: (args) => ({
    running: false,
    pid: null,
    external: false,
    listen: args?.listen || "127.0.0.1:8899",
    message: "Native runtime unavailable in browser preview",
    capture_file: null,
  }),
  stop_proxy: () => ({
    running: false,
    pid: null,
    external: false,
    listen: "127.0.0.1:8899",
    message: "Native runtime unavailable in browser preview",
    capture_file: null,
  }),
  gateway_status: () => ({
    running: false,
    pid: null,
    external: false,
    listen: "127.0.0.1:37918",
    capture_file: null,
    message: "Native runtime unavailable in browser preview",
  }),
  read_gateway_settings: () => ({
    listen: "127.0.0.1:37918",
    openai_key_masked: null,
    openai_base_url: "https://api.openai.com",
    anthropic_key_masked: null,
    anthropic_base_url: "https://api.anthropic.com",
    default_provider: "openai",
    routing_rules: [],
    max_retries: 2,
    redaction_enabled: true,
    settings_path: "Preview mode",
  }),
  save_gateway_settings: (args) => ({
    listen: args?.settings?.listen || "127.0.0.1:37918",
    openai_key_masked: args?.settings?.openai_api_key ? "sk-••••preview" : null,
    openai_base_url: args?.settings?.openai_base_url || "https://api.openai.com",
    anthropic_key_masked: args?.settings?.anthropic_api_key ? "sk-••••preview" : null,
    anthropic_base_url: args?.settings?.anthropic_base_url || "https://api.anthropic.com",
    default_provider: args?.settings?.default_provider || "openai",
    routing_rules: args?.settings?.routing_rules || [],
    max_retries: Number(args?.settings?.max_retries ?? 2),
    redaction_enabled: args?.settings?.redaction_enabled ?? true,
    settings_path: "Preview mode",
  }),
  start_gateway: () => ({
    running: false,
    pid: null,
    external: false,
    listen: "127.0.0.1:37918",
    capture_file: null,
    message: "Native runtime unavailable in browser preview",
  }),
  stop_gateway: () => ({
    running: false,
    pid: null,
    external: false,
    listen: "127.0.0.1:37918",
    capture_file: null,
    message: "Native runtime unavailable in browser preview",
  }),
  test_gateway_provider: (args) => ({
    provider: args?.provider || "openai",
    ok: false,
    base_url: args?.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com",
    message: "Native runtime unavailable in browser preview",
  }),
  list_capture_files: () => [],
  clear_capture_history: () => 0,
  read_capture_file: () => ({ records: [] }),
  read_capture_index: () => ({
    file: null,
    flows: [],
    last_flow_id: null,
  }),
  read_flow_detail: () => null,
  validate_capture: () => ({
    file: "",
    total_lines: 0,
    valid_lines: 0,
    invalid_lines: 0,
    flow_count: 0,
    duplicate_flow_ids: [],
    request_count: 0,
    response_start_count: 0,
    chunk_count: 0,
    orphan_chunks: 0,
    pending_flows: 0,
    error_flows: 0,
    connect_flows: 0,
    low_signal_flows: 0,
    status: "healthy",
    diagnostics: [],
  }),
  read_claude_session_index: () => ({
    project_dir: "Preview mode",
    storage_dir: "",
    sessions: [],
    latest_session_id: null,
  }),
  read_claude_session_detail: () => ({
    session: null,
    messages: [],
  }),
  read_loop_index: () => ({
    loop_id: "preview::no-session",
    capture_file: null,
    session: null,
    turn_count: 0,
    step_count: 0,
    flow_count: 0,
    message_count: 0,
    last_step: null,
    totals: { tokens: null, tool_uses: 0, tool_results: 0 },
    diagnostics: ["Preview mode: native loop APIs are disabled."],
  }),
  read_loop_detail: () => ({
    loop_id: "preview::no-session",
    capture_index: { file: null, flows: [], last_flow_id: null },
    claude_session: { session: null, messages: [] },
  }),
  read_loop_step_detail: () => ({
    step_id: null,
    detail: null,
  }),
  hook_status: () => ({
    receiver: {
      listen: "127.0.0.1:37917",
      url_base: "http://127.0.0.1:37917/hooks",
      running: false,
      message: "Native runtime unavailable in browser preview",
      event_file: "",
    },
    claude: { target: "claude", installed: false, path: "", message: "Preview mode" },
    codex: { target: "codex", installed: false, path: "", message: "Preview mode" },
    total_events: 0,
    last_event: null,
  }),
  read_hook_events: () => ({
    file: "",
    total: 0,
    events: [],
  }),
  install_hooks: () => [],
  remove_hooks: () => [],
  test_hooks: () => [],
  tool_statuses: () => previewTools,
  environment_status: () => ({
    proxy_binary: "",
    proxy_binary_exists: false,
    ca_cert: "",
    ca_cert_exists: false,
    ca_key: "",
    ca_key_exists: false,
    ca_trusted: false,
    tools: previewTools,
  }),
};

export async function nativeInvoke(command: string, args?: Record<string, any>) {
  if (isNativeRuntime()) {
    return invoke(command, args);
  }
  const fallback = previewFallbacks[command];
  if (fallback) return fallback(args);
  throw new Error("Native runtime is only available inside the Tauri app.");
}
