use anyhow::{Context, Result};
use bytes::Bytes;
use clap::{Parser, Subcommand};
use chrono::Utc;
use http_body_util::{BodyExt, Full};
use hudsucker::{
    futures::TryStreamExt,
    certificate_authority::RcgenAuthority,
    hyper::{header::HeaderMap, Request, Response, Uri},
    rcgen::{Issuer, KeyPair},
    rustls::crypto::aws_lc_rs,
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse,
};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    net::SocketAddr,
    sync::atomic::{AtomicU64, Ordering},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tiny_http::{Header, Response as TinyResponse, Server};
use tracing::{error, info, warn};

#[derive(Parser, Debug)]
#[command(name = "cc-capture-native")]
#[command(about = "Native local MITM capture proxy for Codex and Claude Code")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg(long, env = "CCC_LISTEN", default_value = "127.0.0.1:8899")]
    listen: SocketAddr,

    #[arg(long, env = "CCC_OUTPUT_DIR", default_value = "captures")]
    output_dir: PathBuf,

    #[arg(long, env = "CCC_CA_CERT", default_value = "ca/cc-capture-ca.pem")]
    ca_cert: PathBuf,

    #[arg(long, env = "CCC_CA_KEY", default_value = "ca/cc-capture-ca.key")]
    ca_key: PathBuf,

    #[arg(long, env = "CCC_BODY_LIMIT", default_value_t = 20000)]
    body_limit: usize,

    #[arg(long, env = "CCC_CAPTURE_ALL", default_value_t = true)]
    capture_all: bool,

    #[arg(long, env = "CCC_HOST_PATTERNS", value_delimiter = ',')]
    host_patterns: Option<Vec<String>>,
}

#[derive(Subcommand, Debug)]
enum Command {
    Run,
    Summary { file: PathBuf },
    Serve {
        #[arg(long, default_value = "127.0.0.1:8877")]
        listen: String,
        #[arg(long, default_value = "captures")]
        captures_dir: PathBuf,
    },
}

#[derive(Clone)]
struct CaptureHandler {
    output: Arc<Mutex<BufWriter<File>>>,
    host_patterns: Arc<Vec<Regex>>,
    flows: Arc<Mutex<HashMap<String, VecDeque<FlowMeta>>>>,
    next_flow_id: Arc<AtomicU64>,
    body_limit: usize,
    capture_all: bool,
}

#[derive(Serialize)]
struct FlowRecord {
    timestamp: String,
    direction: &'static str,
    flow_id: Option<u64>,
    client_addr: String,
    method: Option<String>,
    url: Option<String>,
    status: Option<u16>,
    reason: Option<String>,
    headers: HashMap<String, String>,
    body: Value,
}

#[derive(Clone, Debug)]
struct FlowMeta {
    id: u64,
    capture: bool,
    method: String,
    url: String,
}

impl CaptureHandler {
    fn matches_uri(&self, uri: &Uri, headers: &HeaderMap) -> bool {
        if self.capture_all {
            return true;
        }
        let host = uri
            .host()
            .map(str::to_owned)
            .or_else(|| {
                headers
                    .get("host")
                    .and_then(|value| value.to_str().ok())
                    .map(|value| value.split(':').next().unwrap_or(value).to_owned())
            })
            .unwrap_or_default();
        self.host_patterns.iter().any(|re| re.is_match(&host))
    }

    fn write_record(&self, record: &FlowRecord) {
        let Ok(line) = serde_json::to_string(record) else {
            return;
        };
        let Ok(mut writer) = self.output.lock() else {
            return;
        };
        let _ = writeln!(writer, "{line}");
        let _ = writer.flush();
    }
}

impl HttpHandler for CaptureHandler {
    async fn handle_request(
        &mut self,
        ctx: &HttpContext,
        req: Request<Body>,
    ) -> RequestOrResponse {
        let should_capture = self.matches_uri(req.uri(), req.headers());
        let flow_id = self.next_flow_id.fetch_add(1, Ordering::Relaxed);
        let (mut parts, body) = req.into_parts();
        if is_websocket_upgrade(&parts.headers) {
            parts.headers.remove("sec-websocket-extensions");
        }
        let method = parts.method.to_string();
        let url = parts.uri.to_string();
        remember_flow(
            &self.flows,
            ctx,
            FlowMeta {
                id: flow_id,
                capture: should_capture,
                method: method.clone(),
                url: url.clone(),
            },
        );
        let bytes = collect_body(body).await;

        if should_capture {
            let record = FlowRecord {
                timestamp: Utc::now().to_rfc3339(),
                direction: "request",
                flow_id: Some(flow_id),
                client_addr: ctx.client_addr.to_string(),
                method: Some(method),
                url: Some(url),
                status: None,
                reason: None,
                headers: redact_headers(&parts.headers),
                body: describe_body(&parts.headers, &bytes, self.body_limit),
            };
            self.write_record(&record);
        }

        Request::from_parts(parts, body_from_bytes(bytes)).into()
    }

    async fn handle_response(
        &mut self,
        ctx: &HttpContext,
        res: Response<Body>,
    ) -> Response<Body> {
        let flow = take_flow(&self.flows, ctx);
        let Some(flow) = flow else {
            return res;
        };
        if !flow.capture {
            return res;
        }
        let (parts, body) = res.into_parts();

        let record = FlowRecord {
            timestamp: Utc::now().to_rfc3339(),
            direction: "response_start",
            flow_id: Some(flow.id),
            client_addr: ctx.client_addr.to_string(),
            method: Some(flow.method.clone()),
            url: Some(flow.url.clone()),
            status: Some(parts.status.as_u16()),
            reason: parts.status.canonical_reason().map(str::to_owned),
            headers: redact_headers(&parts.headers),
            body: json!({
                "size_bytes": null,
                "content_type": parts.headers
                    .get("content-type")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or(""),
                "stream": "[capturing chunks]"
            }),
        };
        self.write_record(&record);

        let output = self.output.clone();
        let body_limit = self.body_limit;
        let client_addr = ctx.client_addr.to_string();
        let flow_for_chunks = flow.clone();
        let headers_for_chunks = parts.headers.clone();
        let mut chunk_index: u64 = 0;
        let stream = body.into_data_stream().inspect_ok(move |chunk| {
            let record = FlowRecord {
                timestamp: Utc::now().to_rfc3339(),
                direction: "response_chunk",
                flow_id: Some(flow_for_chunks.id),
                client_addr: client_addr.clone(),
                method: Some(flow_for_chunks.method.clone()),
                url: Some(flow_for_chunks.url.clone()),
                status: None,
                reason: None,
                headers: HashMap::new(),
                body: describe_chunk(&headers_for_chunks, chunk, body_limit, chunk_index),
            };
            chunk_index += 1;
            write_record_to(&output, &record);
        });

        Response::from_parts(parts, Body::from_stream(stream))
    }
}

fn remember_flow(
    flows: &Arc<Mutex<HashMap<String, VecDeque<FlowMeta>>>>,
    ctx: &HttpContext,
    value: FlowMeta,
) {
    if let Ok(mut map) = flows.lock() {
        map.entry(ctx.client_addr.to_string())
            .or_default()
            .push_back(value);
    }
}

fn take_flow(
    flows: &Arc<Mutex<HashMap<String, VecDeque<FlowMeta>>>>,
    ctx: &HttpContext,
) -> Option<FlowMeta> {
    if let Ok(mut map) = flows.lock() {
        if let Some(queue) = map.get_mut(&ctx.client_addr.to_string()) {
            return queue.pop_front();
        }
    }
    None
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get("upgrade")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

async fn collect_body(body: Body) -> Bytes {
    match body.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(err) => {
            warn!("failed to collect body: {err}");
            Bytes::new()
        }
    }
}

fn body_from_bytes(bytes: Bytes) -> Body {
    Body::from(Full::new(bytes))
}

fn redact_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let sensitive = sensitive_regex();
    let mut result = HashMap::new();
    for (name, value) in headers {
        let key = name.as_str().to_owned();
        let value = if sensitive.is_match(&key) {
            "[REDACTED]".to_owned()
        } else {
            value.to_str().unwrap_or("<non-utf8>").to_owned()
        };
        result.insert(key, value);
    }
    result
}

fn describe_body(headers: &HeaderMap, bytes: &Bytes, limit: usize) -> Value {
    let content_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();

    let mut base = json!({
        "size_bytes": bytes.len(),
        "content_type": content_type,
    });

    if bytes.is_empty() {
        base["text"] = json!("");
        return base;
    }

    if content_type.contains("application/json") {
        if let Ok(mut value) = serde_json::from_slice::<Value>(bytes) {
            redact_json(&mut value);
            base["json"] = value;
            return base;
        }
    }

    if content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("x-www-form-urlencoded")
    {
        let text = String::from_utf8_lossy(bytes);
        base["text"] = json!(truncate(&text, limit));
    } else {
        base["binary"] = json!("[omitted]");
    }

    base
}

fn describe_chunk(headers: &HeaderMap, bytes: &Bytes, limit: usize, chunk_index: u64) -> Value {
    let mut value = describe_body(headers, bytes, limit);
    value["chunk_index"] = json!(chunk_index);
    value
}

fn redact_json(value: &mut Value) {
    let sensitive = sensitive_regex();
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if sensitive.is_match(key) {
                    *child = Value::String("[REDACTED]".to_owned());
                } else {
                    redact_json(child);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_json(item);
            }
        }
        _ => {}
    }
}

fn sensitive_regex() -> Regex {
    Regex::new("(?i)(authorization|proxy-authorization|api[_-]?key|token|secret|password|session|cookie|access[_-]?token|refresh[_-]?token)").unwrap()
}

fn truncate(value: &str, limit: usize) -> String {
    if limit == 0 || value.len() <= limit {
        value.to_owned()
    } else {
        let mut end = limit;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}...[truncated {} bytes]", &value[..end], value.len() - end)
    }
}

fn default_host_patterns() -> Vec<String> {
    vec![
        r"(^|\.)anthropic\.com$".to_owned(),
        r"(^|\.)claude\.ai$".to_owned(),
        r"^open\.bigmodel\.cn$".to_owned(),
        r"(^|\.)chatgpt\.com$".to_owned(),
        r"(^|\.)openai\.com$".to_owned(),
        r"(^|\.)api\.openai\.com$".to_owned(),
        r"(^|\.)statsigapi\.net$".to_owned(),
        r"(^|\.)sentry\.io$".to_owned(),
    ]
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "cc_capture_native=info,hudsucker=info".to_owned()),
        )
        .init();

    let cli = Cli::parse();
    let command = cli.command.as_ref().unwrap_or(&Command::Run);
    match command {
        Command::Run => run_proxy(cli).await,
        Command::Summary { file } => summary(file.clone()),
        Command::Serve {
            listen,
            captures_dir,
        } => serve_viewer(listen.clone(), captures_dir.clone()),
    }
}

async fn run_proxy(cli: Cli) -> Result<()> {
    fs::create_dir_all(&cli.output_dir).context("creating output dir")?;
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let output_path = cli.output_dir.join(format!("capture-{stamp}.jsonl"));
    let output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&output_path)
        .with_context(|| format!("opening {}", output_path.display()))?;

    let ca_cert = fs::read_to_string(&cli.ca_cert)
        .with_context(|| format!("reading CA cert {}", cli.ca_cert.display()))?;
    let ca_key = fs::read_to_string(&cli.ca_key)
        .with_context(|| format!("reading CA key {}", cli.ca_key.display()))?;
    let key_pair = KeyPair::from_pem(&ca_key).context("parsing CA key")?;
    let issuer = Issuer::from_ca_cert_pem(&ca_cert, key_pair).context("parsing CA cert")?;
    let ca = RcgenAuthority::new(issuer, 1_000, aws_lc_rs::default_provider());

    let pattern_strings = cli.host_patterns.unwrap_or_else(default_host_patterns);
    let host_patterns = pattern_strings
        .iter()
        .map(|pattern| Regex::new(pattern).with_context(|| format!("invalid regex {pattern}")))
        .collect::<Result<Vec<_>>>()?;

    info!("listening on {}", cli.listen);
    info!("writing {}", output_path.display());
    info!("CA cert {}", cli.ca_cert.display());

    let handler = CaptureHandler {
        output: Arc::new(Mutex::new(BufWriter::new(output))),
        host_patterns: Arc::new(host_patterns),
        flows: Arc::new(Mutex::new(HashMap::new())),
        next_flow_id: Arc::new(AtomicU64::new(1)),
        body_limit: cli.body_limit,
        capture_all: cli.capture_all,
    };

    let proxy = Proxy::builder()
        .with_addr(cli.listen)
        .with_ca(ca)
        .with_rustls_connector(aws_lc_rs::default_provider())
        .with_http_handler(handler)
        .with_graceful_shutdown(shutdown_signal())
        .build()
        .context("building proxy")?;

    if let Err(err) = proxy.start().await {
        error!("{err}");
    }
    Ok(())
}

fn summary(path: PathBuf) -> Result<()> {
    let content = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    for (idx, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .with_context(|| format!("parsing {} line {}", path.display(), idx + 1))?;
        let direction = value["direction"].as_str().unwrap_or("?");
        let flow_id = value["flow_id"].as_u64().map(|v| v.to_string()).unwrap_or_else(|| "-".to_owned());
        let status = value["status"].as_u64().map(|v| v.to_string()).unwrap_or_else(|| "-".to_owned());
        let method = value["method"].as_str().unwrap_or("-");
        let url = value["url"].as_str().unwrap_or("-");
        let size = value["body"]["size_bytes"].as_u64().unwrap_or(0);
        let chunk = value["body"]["chunk_index"].as_u64().map(|v| format!("#{v}")).unwrap_or_default();
        println!("{direction:14} flow={flow_id:6} {method:6} {status:4} {size:8} {chunk:8} {url}");
    }
    Ok(())
}

fn write_record_to(output: &Arc<Mutex<BufWriter<File>>>, record: &FlowRecord) {
    let Ok(line) = serde_json::to_string(record) else {
        return;
    };
    let Ok(mut writer) = output.lock() else {
        return;
    };
    let _ = writeln!(writer, "{line}");
    let _ = writer.flush();
}

fn serve_viewer(listen: String, captures_dir: PathBuf) -> Result<()> {
    let server = Server::http(&listen).map_err(|err| anyhow::anyhow!("{err}"))?;
    println!("viewer listening at http://{listen}");
    println!("captures dir: {}", captures_dir.display());

    for request in server.incoming_requests() {
        let url = request.url().to_owned();
        let response = if url == "/" {
            html_response(index_html())
        } else if url == "/api/files" {
            json_response(list_capture_files(&captures_dir)?)
        } else if let Some(name) = url.strip_prefix("/api/file/") {
            let name = percent_decode(name);
            let path = safe_capture_path(&captures_dir, &name)?;
            json_response(read_capture_records(&path)?)
        } else {
            TinyResponse::from_string("not found").with_status_code(404)
        };
        let _ = request.respond(response);
    }
    Ok(())
}

fn list_capture_files(captures_dir: &PathBuf) -> Result<Value> {
    let mut files = Vec::new();
    if captures_dir.exists() {
        for entry in fs::read_dir(captures_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let metadata = entry.metadata()?;
            files.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "size": metadata.len(),
                "modified": metadata.modified().ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
            }));
        }
    }
    files.sort_by(|a, b| b["modified"].as_u64().cmp(&a["modified"].as_u64()));
    Ok(json!({ "files": files }))
}

fn safe_capture_path(captures_dir: &PathBuf, name: &str) -> Result<PathBuf> {
    if name.contains('/') || name.contains('\\') || !name.ends_with(".jsonl") {
        anyhow::bail!("invalid capture file name");
    }
    Ok(captures_dir.join(name))
}

fn read_capture_records(path: &PathBuf) -> Result<Value> {
    let content = fs::read_to_string(path)?;
    let mut records = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            records.push(value);
        }
    }
    Ok(json!({ "records": records }))
}

fn json_response(value: Value) -> TinyResponse<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    TinyResponse::from_data(body).with_header(json_header())
}

fn html_response(body: String) -> TinyResponse<std::io::Cursor<Vec<u8>>> {
    TinyResponse::from_string(body).with_header(html_header())
}

fn json_header() -> Header {
    Header::from_bytes(&b"content-type"[..], &b"application/json; charset=utf-8"[..]).unwrap()
}

fn html_header() -> Header {
    Header::from_bytes(&b"content-type"[..], &b"text/html; charset=utf-8"[..]).unwrap()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn index_html() -> String {
    r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>cc-capture viewer</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #101214; color: #e8eaed; }
    header { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid #2a2f35; background: #161a1f; position: sticky; top: 0; z-index: 2; }
    h1 { font-size: 16px; margin: 0 10px 0 0; font-weight: 650; }
    select, input, button { background: #20252b; color: #e8eaed; border: 1px solid #3a424b; border-radius: 6px; padding: 7px 9px; font: inherit; }
    button { cursor: pointer; }
    main { display: grid; grid-template-columns: minmax(360px, 42vw) 1fr; min-height: calc(100vh - 58px); }
    #flows { border-right: 1px solid #2a2f35; overflow: auto; }
    #detail { overflow: auto; padding: 16px; }
    .flow { padding: 11px 14px; border-bottom: 1px solid #242a31; cursor: pointer; }
    .flow:hover, .flow.active { background: #1c2229; }
    .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .method { min-width: 58px; font-weight: 700; color: #8ab4f8; }
    .status { min-width: 42px; color: #81c995; }
    .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d7dce2; }
    .meta { margin-top: 4px; color: #9aa0a6; font-size: 12px; display: flex; gap: 10px; }
    .pill { background: #29313a; border: 1px solid #3a424b; border-radius: 999px; padding: 1px 7px; }
    .panel { margin-bottom: 14px; border: 1px solid #2a2f35; border-radius: 8px; overflow: hidden; }
    .panel h2 { margin: 0; padding: 10px 12px; font-size: 13px; background: #171b20; border-bottom: 1px solid #2a2f35; }
    pre { margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.45; }
    .empty { padding: 32px; color: #9aa0a6; }
    .chunk { border-top: 1px solid #242a31; }
    .chunk:first-child { border-top: 0; }
    mark { background: #775f14; color: inherit; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } #flows { max-height: 42vh; border-right: 0; border-bottom: 1px solid #2a2f35; } }
  </style>
</head>
<body>
  <header>
    <h1>cc-capture</h1>
    <select id="file"></select>
    <button id="refresh">Refresh</button>
    <input id="q" placeholder="Search url/body/header" size="34">
    <span id="count" class="pill"></span>
  </header>
  <main>
    <section id="flows"></section>
    <section id="detail"><div class="empty">Select a capture file.</div></section>
  </main>
<script>
const $ = (id) => document.getElementById(id);
let records = [];
let grouped = [];
let active = null;

function textOfBody(body) {
  if (!body) return "";
  if (body.json !== undefined) return JSON.stringify(body.json, null, 2);
  if (body.text !== undefined) return body.text;
  if (body.binary !== undefined) return body.binary;
  if (body.stream !== undefined) return body.stream;
  return JSON.stringify(body, null, 2);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function groupRecords() {
  const map = new Map();
  for (const r of records) {
    const id = r.flow_id ?? `no-flow-${Math.random()}`;
    if (!map.has(id)) map.set(id, { id, request: null, response: null, chunks: [] });
    const g = map.get(id);
    if (r.direction === "request") g.request = r;
    else if (r.direction === "response_start") g.response = r;
    else if (r.direction === "response_chunk") g.chunks.push(r);
  }
  grouped = [...map.values()].sort((a,b) => Number(a.id) - Number(b.id));
}

function flowText(g) {
  return JSON.stringify(g).toLowerCase();
}

function renderFlows() {
  const q = $("q").value.trim().toLowerCase();
  const list = grouped.filter(g => !q || flowText(g).includes(q));
  $("count").textContent = `${list.length}/${grouped.length} flows`;
  $("flows").innerHTML = list.map(g => {
    const r = g.request || g.response || {};
    const status = g.response?.status ?? "";
    const method = r.method ?? "-";
    const url = r.url ?? "";
    const chunks = g.chunks.length;
    const size = g.chunks.reduce((sum, c) => sum + (c.body?.size_bytes || 0), 0);
    return `<div class="flow ${active === g.id ? "active" : ""}" data-id="${escapeHtml(g.id)}">
      <div class="row"><span class="method">${escapeHtml(method)}</span><span class="status">${escapeHtml(status)}</span><span class="url">${escapeHtml(url)}</span></div>
      <div class="meta"><span>flow ${escapeHtml(g.id)}</span><span>${chunks} chunks</span><span>${size} bytes</span></div>
    </div>`;
  }).join("") || `<div class="empty">No matching flows.</div>`;
}

function renderDetail(g) {
  if (!g) {
    $("detail").innerHTML = `<div class="empty">Select a flow.</div>`;
    return;
  }
  const req = g.request ? JSON.stringify(g.request, null, 2) : "";
  const res = g.response ? JSON.stringify(g.response, null, 2) : "";
  const chunks = g.chunks.map(c => `<div class="chunk"><pre>${escapeHtml(textOfBody(c.body))}</pre></div>`).join("");
  $("detail").innerHTML = `
    <div class="panel"><h2>Request</h2><pre>${escapeHtml(req)}</pre></div>
    <div class="panel"><h2>Response Start</h2><pre>${escapeHtml(res)}</pre></div>
    <div class="panel"><h2>Response Chunks (${g.chunks.length})</h2>${chunks || "<pre>No chunks.</pre>"}</div>
  `;
}

async function loadFiles() {
  const data = await fetch("/api/files").then(r => r.json());
  $("file").innerHTML = data.files.map(f => `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)} (${Math.round(f.size/1024)} KB)</option>`).join("");
  if (data.files.length) await loadFile(data.files[0].name);
}

async function loadFile(name) {
  const data = await fetch(`/api/file/${encodeURIComponent(name)}`).then(r => r.json());
  records = data.records;
  groupRecords();
  active = grouped[0]?.id ?? null;
  renderFlows();
  renderDetail(grouped.find(g => g.id === active));
}

$("file").addEventListener("change", e => loadFile(e.target.value));
$("refresh").addEventListener("click", () => loadFiles());
$("q").addEventListener("input", renderFlows);
$("flows").addEventListener("click", e => {
  const item = e.target.closest(".flow");
  if (!item) return;
  active = Number(item.dataset.id);
  renderFlows();
  renderDetail(grouped.find(g => g.id === active));
});

loadFiles().catch(err => {
  $("detail").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
});
</script>
</body>
</html>"#.to_owned()
}
