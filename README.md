# LoopLens

Visual debugger for AI agent loops, tools, MCP, skills, tokens, and network traffic.

LoopLens combines a native Rust HTTP/HTTPS capture proxy with a Tauri desktop workbench for inspecting your own Claude Code and Codex CLI sessions. It is designed for agent observability: prompts, model steps, tool calls, MCP traffic, skill use, token pressure, compact events, and correlated network flows.

> LoopLens is for local debugging of traffic you explicitly route through it. Capture files may contain sensitive prompts, paths, responses, and metadata.

![LoopLens Inspect workbench](docs/assets/looplens-inspect-workbench.png)

[Watch the desktop demo](docs/assets/looplens-demo.mp4)

## Highlights

- Activity-first desktop workflow with Inspect, Network, and Settings workspaces.
- AI Loop Workbench for turn-by-turn agent execution.
- Tool, MCP, skill, token, and network correlation.
- Native launchers for Claude Code and Codex through a fresh capture.
- Dense Network Inspector with request, response, raw, chunk, and token views.
- Local CA workflow for native HTTPS proxying.
- Conservative redaction for common secret-bearing headers and JSON fields.

## Architecture

```text
Claude Code / Codex CLI
        |
        | HTTPS proxy
        v
looplens-proxy  ->  captures/*.jsonl
        |
        v
LoopLens Desktop  ->  AI Loop / Network / Timeline / Tokens / Raw
```

The native proxy writes JSONL capture files. The desktop app reads those captures, reads Claude session sidecars when available, and builds a unified agent-loop model in the UI.

## Repository Layout

```text
.
├── bin/                    # Local helper scripts and CLI launch wrappers
├── crates/looplens-proxy/  # Rust capture proxy and local API gateway
├── desktop/                # Tauri + React desktop application
├── docs/                   # Screenshots and project documentation
└── .github/workflows/      # CI checks
```

Runtime state is intentionally kept out of git:

- `ca/` generated local CA material
- `captures/` JSONL traffic captures
- `hooks/` locally recorded structured hook events
- `release/` packaged artifacts
- `.claude/` and `.codex/` project-local hook config used during development

See [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) for a contributor-focused map of the repository.

## Requirements

- macOS for the desktop app and CA trust helper scripts.
- Rust stable toolchain.
- Node.js 22 or newer.
- Claude Code and/or Codex CLI installed if you want to launch them from LoopLens.

## Quick Start

Build the native proxy:

```bash
cd looplens
./bin/gen-ca.sh
cargo build -p looplens-proxy --release
```

Trust the local CA on macOS:

```bash
./bin/trust-ca-macos.sh
```

Build and open the desktop app:

```bash
cd desktop
npm install
npm run build
open "src-tauri/target/release/bundle/macos/LoopLens.app"
```

Inside the app, use **Open Claude Code** or **Open Codex** to start a fresh capture and launch the selected CLI through the local proxy.

### First launch checklist

When you open the packaged app for the first time:

1. The **Activity** tab shows a short setup checklist at the top: keep the HTTPS proxy running, trust the LoopLens CA (required for HTTPS), then generate capture traffic (for example **Open Claude Code** / **Open Codex**).
2. If TLS still fails or flows stay empty, use **Settings → Trust** and confirm the proxy listen address matches your CLI.
3. Optional: enable **Hooks** under Settings for structured Claude/Codex events.

You can dismiss the checklist anytime. To bring it back during development, clear `looplens.firstRunGuide.dismissed` in the webview’s localStorage.

## Run The Proxy Directly

```bash
./target/release/looplens-proxy run
```

Capture files are written to `captures/capture-*.jsonl`.

Useful environment variables:

```bash
CCC_LISTEN=127.0.0.1:8899
CCC_OUTPUT_DIR=captures
CCC_CA_CERT=ca/looplens-ca.pem
CCC_CA_KEY=ca/looplens-ca.key
CCC_BODY_LIMIT=0
CCC_CAPTURE_ALL=true
```

## CLI Wrappers

Run Claude Code through the proxy:

```bash
./bin/run-claude
```

Run Codex through the proxy:

```bash
./bin/run-codex
```

The desktop app uses these wrappers when opening native tools.

## Inspect Captures From CLI

```bash
./target/release/looplens-proxy summary captures/capture-YYYYMMDD-HHMMSS.jsonl
```

A simple HTML viewer is also available:

```bash
./target/release/looplens-proxy serve --listen 127.0.0.1:8877 --captures-dir captures
```

Then open `http://127.0.0.1:8877`.

## Development

Frontend and Tauri shell:

```bash
cd desktop
npm install
npm run dev
```

Checks used by CI:

```bash
cargo build -p looplens-proxy --release
cd desktop
npm run build:vite
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

## Security And Privacy

LoopLens captures local traffic that you route through it. Even with redaction, JSONL captures can contain sensitive material.

Never commit or publish:

- `ca/`
- `captures/`
- `hooks/`
- `.claude/`
- `.codex/`
- `*.jsonl`
- `*.pem`
- `*.key`
- `*.log`

Remove the local CA trust when you are done:

```bash
./bin/untrust-ca-macos.sh
```

See [SECURITY.md](SECURITY.md) for more detail.

## Roadmap

- Richer Claude Code loop reconstruction from session sidecars.
- Better Codex session correlation.
- HAR/export workflows.
- Signed and notarized macOS releases.
- Provider-specific token/cost attribution.
- Replay and diff tools with explicit safety controls.

## License

Apache-2.0. See [LICENSE](LICENSE).
