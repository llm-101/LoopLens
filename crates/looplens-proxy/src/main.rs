use anyhow::{Context, Result};
use bytes::Bytes;
use chrono::Utc;
use clap::{Parser, Subcommand};
use http_body_util::{BodyExt, Full};
use hudsucker::{
    certificate_authority::RcgenAuthority,
    futures::TryStreamExt,
    hyper::{
        header::{HeaderMap, HeaderName, HeaderValue},
        Request, Response, Uri,
    },
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
    io::{BufWriter, Read, Write},
    net::SocketAddr,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tiny_http::{Header, Response as TinyResponse, Server, StatusCode as TinyStatusCode};
use tracing::{error, info, warn};

#[derive(Parser, Debug)]
#[command(name = "looplens-proxy")]
#[command(about = "Native local capture proxy and API gateway for LoopLens")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg(long, env = "CCC_LISTEN", default_value = "127.0.0.1:8899")]
    listen: SocketAddr,

    #[arg(long, env = "CCC_OUTPUT_DIR", default_value = "captures")]
    output_dir: PathBuf,

    #[arg(long, env = "CCC_OUTPUT_FILE")]
    output_file: Option<PathBuf>,

    #[arg(long, env = "CCC_CA_CERT", default_value = "ca/looplens-ca.pem")]
    ca_cert: PathBuf,

    #[arg(long, env = "CCC_CA_KEY", default_value = "ca/looplens-ca.key")]
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
    Summary {
        file: PathBuf,
    },
    Gateway {
        #[arg(long, env = "LL_GATEWAY_LISTEN", default_value = "127.0.0.1:37918")]
        listen: SocketAddr,
        #[arg(long, env = "LL_GATEWAY_OUTPUT_DIR", default_value = "captures")]
        output_dir: PathBuf,
        #[arg(long, env = "LL_GATEWAY_OUTPUT_FILE")]
        output_file: Option<PathBuf>,
        #[arg(long, env = "LL_GATEWAY_BODY_LIMIT", default_value_t = 20000)]
        body_limit: usize,
        #[arg(
            long,
            env = "LL_GATEWAY_OPENAI_BASE_URL",
            default_value = "https://api.openai.com"
        )]
        openai_base_url: String,
        #[arg(
            long,
            env = "LL_GATEWAY_ANTHROPIC_BASE_URL",
            default_value = "https://api.anthropic.com"
        )]
        anthropic_base_url: String,
        #[arg(long, env = "LL_GATEWAY_OPENAI_API_KEY")]
        openai_api_key: Option<String>,
        #[arg(long, env = "LL_GATEWAY_ANTHROPIC_API_KEY")]
        anthropic_api_key: Option<String>,
        #[arg(long, env = "LL_GATEWAY_MAX_RETRIES", default_value_t = 2)]
        max_retries: u32,
        #[arg(long, env = "LL_GATEWAY_REDACT", default_value_t = true)]
        redact: bool,
    },
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
    async fn handle_request(&mut self, ctx: &HttpContext, req: Request<Body>) -> RequestOrResponse {
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

    async fn handle_response(&mut self, ctx: &HttpContext, res: Response<Body>) -> Response<Body> {
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
        format!(
            "{}...[truncated {} bytes]",
            &value[..end],
            value.len() - end
        )
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
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "looplens_proxy=info,hudsucker=info".to_owned()),
        )
        .init();

    let mut cli = Cli::parse();
    let command = cli.command.take().unwrap_or(Command::Run);
    match command {
        Command::Run => run_proxy(cli).await,
        Command::Summary { file } => summary(file),
        Command::Gateway {
            listen,
            output_dir,
            output_file,
            body_limit,
            openai_base_url,
            anthropic_base_url,
            openai_api_key,
            anthropic_api_key,
            max_retries,
            redact,
        } => tokio::task::spawn_blocking(move || {
            run_gateway(GatewayConfig {
                listen,
                output_dir,
                output_file,
                body_limit,
                openai_base_url,
                anthropic_base_url,
                openai_api_key,
                anthropic_api_key,
                max_retries,
                redact,
            })
        })
        .await
        .context("gateway thread failed")?,
        Command::Serve {
            listen,
            captures_dir,
        } => serve_viewer(listen, captures_dir),
    }
}

async fn run_proxy(cli: Cli) -> Result<()> {
    fs::create_dir_all(&cli.output_dir).context("creating output dir")?;
    let output_path = cli.output_file.clone().unwrap_or_else(|| {
        cli.output_dir
            .join(format!("capture-{}.jsonl", Utc::now().timestamp_millis()))
    });
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
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
    let content =
        fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    for (idx, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .with_context(|| format!("parsing {} line {}", path.display(), idx + 1))?;
        let direction = value["direction"].as_str().unwrap_or("?");
        let flow_id = value["flow_id"]
            .as_u64()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "-".to_owned());
        let status = value["status"]
            .as_u64()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "-".to_owned());
        let method = value["method"].as_str().unwrap_or("-");
        let url = value["url"].as_str().unwrap_or("-");
        let size = value["body"]["size_bytes"].as_u64().unwrap_or(0);
        let chunk = value["body"]["chunk_index"]
            .as_u64()
            .map(|v| format!("#{v}"))
            .unwrap_or_default();
        println!("{direction:14} flow={flow_id:6} {method:6} {status:4} {size:8} {chunk:8} {url}");
    }
    Ok(())
}

struct GatewayConfig {
    listen: SocketAddr,
    output_dir: PathBuf,
    output_file: Option<PathBuf>,
    body_limit: usize,
    openai_base_url: String,
    anthropic_base_url: String,
    openai_api_key: Option<String>,
    anthropic_api_key: Option<String>,
    max_retries: u32,
    redact: bool,
}

#[derive(Clone)]
struct GatewayRoute {
    provider: &'static str,
    provider_label: &'static str,
    upstream_url: String,
    route_reason: String,
    configured_key: Option<String>,
    auth_header: &'static str,
    auth_value_prefix: &'static str,
}

struct GatewayUpstreamResponse {
    response: reqwest::blocking::Response,
    attempt_count: u32,
    retry_reasons: Vec<String>,
}

struct GatewayCaptureReader {
    inner: reqwest::blocking::Response,
    output: Arc<Mutex<BufWriter<File>>>,
    headers: HeaderMap,
    body_limit: usize,
    flow_id: u64,
    client_addr: String,
    method: String,
    url: String,
    chunk_index: u64,
    gateway_meta: Value,
}

impl Read for GatewayCaptureReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buf)?;
        if count == 0 {
            return Ok(0);
        }
        let bytes = Bytes::copy_from_slice(&buf[..count]);
        let mut body = describe_chunk(&self.headers, &bytes, self.body_limit, self.chunk_index);
        body["gateway"] = self.gateway_meta.clone();
        let record = FlowRecord {
            timestamp: Utc::now().to_rfc3339(),
            direction: "response_chunk",
            flow_id: Some(self.flow_id),
            client_addr: self.client_addr.clone(),
            method: Some(self.method.clone()),
            url: Some(self.url.clone()),
            status: None,
            reason: None,
            headers: HashMap::new(),
            body,
        };
        self.chunk_index += 1;
        write_record_to(&self.output, &record);
        Ok(count)
    }
}

fn run_gateway(config: GatewayConfig) -> Result<()> {
    fs::create_dir_all(&config.output_dir).context("creating output dir")?;
    let output_path = config.output_file.clone().unwrap_or_else(|| {
        config.output_dir.join(format!(
            "capture-gateway-{}.jsonl",
            Utc::now().timestamp_millis()
        ))
    });
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&output_path)
        .with_context(|| format!("opening {}", output_path.display()))?;
    let output = Arc::new(Mutex::new(BufWriter::new(output)));
    let next_flow_id = AtomicU64::new(1);
    let server = Server::http(config.listen).map_err(|err| anyhow::anyhow!("{err}"))?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .context("building gateway HTTP client")?;

    info!("gateway listening on {}", config.listen);
    info!("gateway writing {}", output_path.display());

    for request in server.incoming_requests() {
        let flow_id = next_flow_id.fetch_add(1, Ordering::Relaxed);
        if request.method().as_str().eq_ignore_ascii_case("OPTIONS") {
            let _ = request.respond(cors_response(TinyResponse::empty(204)));
            continue;
        }
        if let Err(err) = handle_gateway_request(&config, &client, output.clone(), flow_id, request)
        {
            warn!("gateway request failed: {err}");
        }
    }
    Ok(())
}

fn handle_gateway_request(
    config: &GatewayConfig,
    client: &reqwest::blocking::Client,
    output: Arc<Mutex<BufWriter<File>>>,
    flow_id: u64,
    mut request: tiny_http::Request,
) -> Result<()> {
    let method = request.method().as_str().to_owned();
    let local_url = format!("http://{}{}", config.listen, request.url());
    let client_addr = request
        .remote_addr()
        .map(|addr| addr.to_string())
        .unwrap_or_else(|| "-".to_owned());
    let request_headers = request.headers().to_vec();
    let request_header_map = tiny_headers_to_header_map(&request_headers);
    let mut body_bytes = Vec::new();
    request
        .as_reader()
        .read_to_end(&mut body_bytes)
        .context("reading gateway request body")?;
    let body_bytes = Bytes::from(body_bytes);

    let route = match route_gateway_request(config, request.url()) {
        Ok(route) => route,
        Err(err) => {
            let body = json!({
                "error": {
                    "message": err.to_string(),
                    "type": "unsupported_gateway_endpoint"
                }
            });
            request.respond(gateway_json_response(404, &body))?;
            return Ok(());
        }
    };
    let mut request_body = describe_body(&request_header_map, &body_bytes, config.body_limit);
    request_body["gateway"] = gateway_meta(
        &route,
        0,
        1,
        config.max_retries,
        Vec::new(),
        config.redact,
        None,
    );
    write_record_to(
        &output,
        &FlowRecord {
            timestamp: Utc::now().to_rfc3339(),
            direction: "request",
            flow_id: Some(flow_id),
            client_addr: client_addr.clone(),
            method: Some(method.clone()),
            url: Some(local_url.clone()),
            status: None,
            reason: None,
            headers: redact_tiny_headers(&request_headers),
            body: request_body,
        },
    );

    if route.configured_key.is_none() && !has_gateway_auth(&request_headers, &route) {
        let diagnostic = json!({
            "error": {
                "message": format!("LoopLens Gateway has no {} API key configured and the request did not provide pass-through credentials.", route.provider_label),
                "type": "missing_provider_key",
                "provider": route.provider,
            }
        });
        write_gateway_response_start(
            &output,
            flow_id,
            &client_addr,
            &method,
            &local_url,
            401,
            "Unauthorized",
            HeaderMap::new(),
            gateway_meta(
                &route,
                0,
                1,
                config.max_retries,
                Vec::new(),
                config.redact,
                Some("missing_key"),
            ),
        );
        write_gateway_chunk(
            &output,
            flow_id,
            &client_addr,
            &method,
            &local_url,
            &json_bytes(&diagnostic),
            config.body_limit,
            0,
            gateway_meta(
                &route,
                0,
                1,
                config.max_retries,
                Vec::new(),
                config.redact,
                Some("missing_key"),
            ),
        );
        request.respond(gateway_json_response(401, &diagnostic))?;
        return Ok(());
    }

    match send_gateway_upstream(
        client,
        &route,
        &method,
        &request_headers,
        &body_bytes,
        config.max_retries,
    ) {
        Ok(upstream) => {
            let status = upstream.response.status();
            let status_code = status.as_u16();
            let reason = status.canonical_reason().unwrap_or("");
            let response_headers = upstream.response.headers().clone();
            let response_headers_for_record = response_headers.clone();
            let data_length = upstream
                .response
                .content_length()
                .and_then(|value| usize::try_from(value).ok());
            let meta = gateway_meta(
                &route,
                upstream.attempt_count.saturating_sub(1),
                upstream.attempt_count,
                config.max_retries,
                upstream.retry_reasons.clone(),
                config.redact,
                None,
            );
            write_gateway_response_start(
                &output,
                flow_id,
                &client_addr,
                &method,
                &local_url,
                status_code,
                reason,
                response_headers_for_record.clone(),
                meta.clone(),
            );
            let reader = GatewayCaptureReader {
                inner: upstream.response,
                output,
                headers: response_headers_for_record,
                body_limit: config.body_limit,
                flow_id,
                client_addr,
                method,
                url: local_url,
                chunk_index: 0,
                gateway_meta: meta,
            };
            let response = TinyResponse::new(
                TinyStatusCode(status_code),
                tiny_response_headers(&response_headers),
                reader,
                data_length,
                None,
            );
            request.respond(cors_response(response))?;
        }
        Err(err) => {
            let diagnostic = json!({
                "error": {
                    "message": err.to_string(),
                    "type": "upstream_unavailable",
                    "provider": route.provider,
                }
            });
            let meta = gateway_meta(
                &route,
                config.max_retries,
                config.max_retries.saturating_add(1),
                config.max_retries,
                vec![err.to_string()],
                config.redact,
                Some("upstream_error"),
            );
            write_gateway_response_start(
                &output,
                flow_id,
                &client_addr,
                &method,
                &local_url,
                502,
                "Bad Gateway",
                HeaderMap::new(),
                meta.clone(),
            );
            write_gateway_chunk(
                &output,
                flow_id,
                &client_addr,
                &method,
                &local_url,
                &json_bytes(&diagnostic),
                config.body_limit,
                0,
                meta,
            );
            request.respond(gateway_json_response(502, &diagnostic))?;
        }
    }
    Ok(())
}

fn route_gateway_request(config: &GatewayConfig, path_with_query: &str) -> Result<GatewayRoute> {
    let path = path_with_query.split('?').next().unwrap_or(path_with_query);
    if path == "/v1/messages" {
        return Ok(GatewayRoute {
            provider: "anthropic",
            provider_label: "Anthropic",
            upstream_url: join_upstream_url(&config.anthropic_base_url, path_with_query),
            route_reason: "endpoint:/v1/messages".to_owned(),
            configured_key: clean_optional_key(config.anthropic_api_key.clone()),
            auth_header: "x-api-key",
            auth_value_prefix: "",
        });
    }
    if matches!(
        path,
        "/v1/responses" | "/v1/chat/completions" | "/v1/embeddings" | "/v1/models"
    ) || path.starts_with("/v1/models/")
    {
        return Ok(GatewayRoute {
            provider: "openai",
            provider_label: "OpenAI",
            upstream_url: join_upstream_url(&config.openai_base_url, path_with_query),
            route_reason: format!("endpoint:{path}"),
            configured_key: clean_optional_key(config.openai_api_key.clone()),
            auth_header: "authorization",
            auth_value_prefix: "Bearer ",
        });
    }
    anyhow::bail!("unsupported gateway endpoint: {path}")
}

fn clean_optional_key(value: Option<String>) -> Option<String> {
    value.and_then(|key| {
        let key = key.trim().to_owned();
        (!key.is_empty()).then_some(key)
    })
}

fn join_upstream_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = if base.ends_with("/v1") && path.starts_with("/v1/") {
        &path[3..]
    } else {
        path
    };
    format!("{base}{path}")
}

fn send_gateway_upstream(
    client: &reqwest::blocking::Client,
    route: &GatewayRoute,
    method: &str,
    headers: &[Header],
    body: &Bytes,
    max_retries: u32,
) -> Result<GatewayUpstreamResponse> {
    let max_attempts = max_retries.saturating_add(1).max(1);
    let mut attempt = 0;
    let mut retry_reasons = Vec::new();
    loop {
        attempt += 1;
        let result = build_gateway_request(client, route, method, headers, body).send();
        match result {
            Ok(response) => {
                let status = response.status().as_u16();
                if attempt < max_attempts && is_retryable_status(status) {
                    retry_reasons.push(format!("attempt {attempt}: HTTP {status}"));
                    gateway_backoff(attempt);
                    continue;
                }
                return Ok(GatewayUpstreamResponse {
                    response,
                    attempt_count: attempt,
                    retry_reasons,
                });
            }
            Err(err) => {
                if attempt < max_attempts {
                    retry_reasons.push(format!("attempt {attempt}: {err}"));
                    gateway_backoff(attempt);
                    continue;
                }
                if retry_reasons.is_empty() {
                    anyhow::bail!(err);
                }
                retry_reasons.push(format!("attempt {attempt}: {err}"));
                anyhow::bail!(retry_reasons.join("; "));
            }
        }
    }
}

fn build_gateway_request(
    client: &reqwest::blocking::Client,
    route: &GatewayRoute,
    method: &str,
    headers: &[Header],
    body: &Bytes,
) -> reqwest::blocking::RequestBuilder {
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST);
    let mut builder = client
        .request(method, &route.upstream_url)
        .body(body.clone());
    for header in headers {
        let name = header.field.as_str().as_str();
        let lower = name.to_ascii_lowercase();
        if is_hop_by_hop_header(&lower)
            || lower == "host"
            || lower == "content-length"
            || lower == "authorization"
            || lower == "x-api-key"
        {
            continue;
        }
        builder = builder.header(name, header.value.as_str());
    }
    if let Some(key) = &route.configured_key {
        builder = builder.header(
            route.auth_header,
            format!("{}{}", route.auth_value_prefix, key),
        );
    } else if let Some(value) = pass_through_auth(headers, route) {
        builder = builder.header(route.auth_header, value);
    }
    if route.provider == "anthropic" && request_header_value(headers, "anthropic-version").is_none()
    {
        builder = builder.header("anthropic-version", "2023-06-01");
    }
    builder
}

fn has_gateway_auth(headers: &[Header], route: &GatewayRoute) -> bool {
    pass_through_auth(headers, route).is_some()
}

fn pass_through_auth(headers: &[Header], route: &GatewayRoute) -> Option<String> {
    if route.provider == "anthropic" {
        request_header_value(headers, "x-api-key")
            .or_else(|| request_header_value(headers, "authorization"))
    } else {
        request_header_value(headers, "authorization")
    }
}

fn request_header_value(headers: &[Header], name: &str) -> Option<String> {
    let name = name.to_ascii_lowercase();
    headers
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(&name))
        .map(|header| header.value.as_str().to_owned())
}

fn is_hop_by_hop_header(lower_name: &str) -> bool {
    matches!(
        lower_name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn is_retryable_status(status: u16) -> bool {
    status == 429 || status >= 500
}

fn gateway_backoff(attempt: u32) {
    let delay = if attempt <= 1 { 500 } else { 1500 };
    thread::sleep(Duration::from_millis(delay));
}

fn gateway_meta(
    route: &GatewayRoute,
    retry_count: u32,
    attempt_count: u32,
    max_retries: u32,
    retry_reasons: Vec<String>,
    redaction_enabled: bool,
    diagnostic: Option<&str>,
) -> Value {
    json!({
        "client": "gateway",
        "provider": route.provider,
        "provider_label": route.provider_label,
        "upstream_url": route.upstream_url,
        "model": null,
        "retry_count": retry_count,
        "attempt_count": attempt_count,
        "max_retries": max_retries,
        "retry_reasons": retry_reasons,
        "gateway_route_reason": route.route_reason,
        "redaction_enabled": redaction_enabled,
        "diagnostic": diagnostic,
    })
}

fn write_gateway_response_start(
    output: &Arc<Mutex<BufWriter<File>>>,
    flow_id: u64,
    client_addr: &str,
    method: &str,
    url: &str,
    status: u16,
    reason: &str,
    headers: HeaderMap,
    gateway: Value,
) {
    let mut body = json!({
        "size_bytes": null,
        "content_type": headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/json"),
        "stream": "[gateway forwarding chunks]"
    });
    body["gateway"] = gateway;
    write_record_to(
        output,
        &FlowRecord {
            timestamp: Utc::now().to_rfc3339(),
            direction: "response_start",
            flow_id: Some(flow_id),
            client_addr: client_addr.to_owned(),
            method: Some(method.to_owned()),
            url: Some(url.to_owned()),
            status: Some(status),
            reason: Some(reason.to_owned()),
            headers: redact_headers(&headers),
            body,
        },
    );
}

fn write_gateway_chunk(
    output: &Arc<Mutex<BufWriter<File>>>,
    flow_id: u64,
    client_addr: &str,
    method: &str,
    url: &str,
    bytes: &Bytes,
    body_limit: usize,
    chunk_index: u64,
    gateway: Value,
) {
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json"),
    );
    let mut body = describe_chunk(&headers, bytes, body_limit, chunk_index);
    body["gateway"] = gateway;
    write_record_to(
        output,
        &FlowRecord {
            timestamp: Utc::now().to_rfc3339(),
            direction: "response_chunk",
            flow_id: Some(flow_id),
            client_addr: client_addr.to_owned(),
            method: Some(method.to_owned()),
            url: Some(url.to_owned()),
            status: None,
            reason: None,
            headers: HashMap::new(),
            body,
        },
    );
}

fn redact_tiny_headers(headers: &[Header]) -> HashMap<String, String> {
    let sensitive = sensitive_regex();
    headers
        .iter()
        .map(|header| {
            let key = header.field.as_str().as_str().to_owned();
            let value = if sensitive.is_match(&key) {
                "[REDACTED]".to_owned()
            } else {
                header.value.as_str().to_owned()
            };
            (key, value)
        })
        .collect()
}

fn tiny_headers_to_header_map(headers: &[Header]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for header in headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(header.field.as_str().as_str().as_bytes()),
            HeaderValue::from_str(header.value.as_str()),
        ) {
            map.insert(name, value);
        }
    }
    map
}

fn tiny_response_headers(headers: &HeaderMap) -> Vec<Header> {
    let mut out = Vec::new();
    for (name, value) in headers {
        let lower = name.as_str().to_ascii_lowercase();
        if is_hop_by_hop_header(&lower) || lower == "content-length" {
            continue;
        }
        if let Ok(value) = value.to_str() {
            if let Ok(header) = Header::from_bytes(name.as_str().as_bytes(), value.as_bytes()) {
                out.push(header);
            }
        }
    }
    add_cors_headers(&mut out);
    out
}

fn add_cors_headers(headers: &mut Vec<Header>) {
    for (name, value) in [
        ("access-control-allow-origin", "*"),
        (
            "access-control-allow-methods",
            "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        ),
        (
            "access-control-allow-headers",
            "authorization,content-type,x-api-key,anthropic-version,openai-beta",
        ),
    ] {
        if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            headers.push(header);
        }
    }
}

fn cors_response<R: Read>(response: TinyResponse<R>) -> TinyResponse<R> {
    response
        .with_header(Header::from_bytes(&b"access-control-allow-origin"[..], &b"*"[..]).unwrap())
        .with_header(
            Header::from_bytes(
                &b"access-control-allow-methods"[..],
                &b"GET,POST,PUT,PATCH,DELETE,OPTIONS"[..],
            )
            .unwrap(),
        )
        .with_header(
            Header::from_bytes(
                &b"access-control-allow-headers"[..],
                &b"authorization,content-type,x-api-key,anthropic-version,openai-beta"[..],
            )
            .unwrap(),
        )
}

fn gateway_json_response(status: u16, value: &Value) -> TinyResponse<std::io::Cursor<Vec<u8>>> {
    cors_response(json_response(value.clone()).with_status_code(status))
}

fn json_bytes(value: &Value) -> Bytes {
    Bytes::from(serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()))
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
    Header::from_bytes(
        &b"content-type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .unwrap()
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
  <title>LoopLens Capture Viewer</title>
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
    <h1>LoopLens Capture</h1>
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
