# LoopLens

Visual debugger for Claude Code and Codex runs.

LoopLens is a local desktop workbench for understanding what happened inside a Claude Code or Codex CLI run. It opens each tool through a fresh capture, records structured hook events where available, reads Claude session sidecars, captures proxied network traffic, and turns the result into a loop timeline you can inspect.

It is not a generic packet viewer. The product is focused on Claude Code and Codex debugging: user prompts, model turns, tool calls, MCP traffic, skill usage, token pressure, compact events, hook lifecycle events, and the network evidence behind a run.

> LoopLens is for local debugging of traffic you explicitly route through it. Capture files may contain sensitive prompts, paths, responses, and metadata.

![LoopLens Inspect workbench](docs/assets/looplens-inspect-workbench.png)

[Watch the desktop demo](docs/assets/looplens-demo.mp4)

## How To Install

Download the latest packaged app from [GitHub Releases](https://github.com/llm-101/LoopLens/releases/latest):

- **macOS Apple Silicon**: download `LoopLens_<version>_arm64.dmg`
- **macOS Intel**: download `LoopLens_<version>_x64.dmg`
- **Windows x64**: download `LoopLens_<version>_windows_x64.exe`

The GitHub-generated **Source code (zip)** and **Source code (tar.gz)** files are not app installers.

Current macOS builds use ad-hoc signing and are not notarized yet. macOS or Windows may show a security warning on first launch; approve the app only if you downloaded it from the LoopLens release page.

If macOS says **"Apple cannot verify LoopLens is free of malware"**:

1. On your Mac, choose **Apple menu → System Settings**, then click **Privacy & Security** in the sidebar. You may need to scroll down.
2. Go to the **Security** section, then click **Open**.
3. Click **Open Anyway**.
4. The **Open Anyway** button is available for about one hour after you try to open the app.
5. Enter your login password, then click **OK**.

You can also Control-click `LoopLens.app` in Finder, choose **Open**, then confirm.

If macOS says **"LoopLens is damaged and can't be opened"**, copy the app to Applications and remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/LoopLens.app
open /Applications/LoopLens.app
```

This workaround is only needed for the current non-notarized preview builds. Future Developer ID signed and notarized releases should open normally.

## Highlights

- One-click **Open Claude Code** and **Open Codex** launchers, each creating a fresh source-specific run file.
- Claude Code loop reconstruction from session sidecars plus official HTTP hook events.
- Codex run capture through the local proxy and command-hook bridge.
- Turn-by-turn Inspect view for prompts, model steps, tool calls, MCP calls, skills, final results, token usage, and warnings.
- Network Inspector for the requests, responses, streaming chunks, headers, raw payloads, and token evidence produced during the run.
- Local CA workflow for Claude Code / Codex HTTPS proxying.
- Conservative redaction for common secret-bearing headers and JSON fields before capture display.

## What LoopLens Shows

For **Claude Code**, LoopLens can combine:

- `.claude` session JSONL sidecars
- official Claude Code HTTP hook events
- proxied model/tool/MCP network traffic
- token usage and compact-related metadata when present

For **Codex**, LoopLens can combine:

- a fresh `capture-codex-*.jsonl` run file
- command-hook events routed through `bin/looplens-hook`
- proxied OpenAI/API traffic and streaming chunks
- token and network evidence extracted from captured payloads

## Architecture

```text
Claude Code / Codex CLI
        |
        | fresh launch wrapper + HTTPS proxy + hooks
        v
looplens-proxy  ->  captures/capture-claude-code-*.jsonl
                 ->  captures/capture-codex-*.jsonl
                 ->  hooks/hook-events.jsonl
        |
        v
LoopLens Desktop  ->  AI Loop / Network / Timeline / Tokens / Raw
```

The native proxy writes JSONL capture files. The desktop app reads those captures, reads Claude session sidecars when available, reads LoopLens hook events, and builds a unified Claude Code / Codex run model in the UI.

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

- Claude Code and/or Codex CLI installed.
- For packaged releases: macOS or Windows.
- For source builds: Rust stable toolchain and Node.js 22 or newer.
- macOS is currently required for the included CA trust helper scripts.

## Build From Source

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

Inside the app, use **Open Claude Code** or **Open Codex**. LoopLens creates a new run, starts the proxy if needed, launches the selected CLI through the local wrapper, and follows the latest loop automatically.

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

Capture files are written to source-specific files such as `captures/capture-claude-code-*.jsonl`, `captures/capture-codex-*.jsonl`, and `captures/capture-gateway-*.jsonl`.

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

Run Claude Code through the LoopLens proxy:

```bash
./bin/run-claude
```

Run Codex through the LoopLens proxy:

```bash
./bin/run-codex
```

The desktop app uses these wrappers when you click **Open Claude Code** or **Open Codex**.

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

## Automated Releases

GitHub Actions builds release packages when you push a version tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

The release workflow builds macOS arm64/x64 `.dmg` bundles and a Windows x64 `.exe` installer from `desktop/`, uploads the assets, and creates a draft GitHub Release named from the app version in `desktop/src-tauri/tauri.conf.json`.

You can also run it manually from **Actions → Release → Run workflow**.

Current macOS release builds use ad-hoc signing and are not notarized. macOS and Windows may require manual approval on first launch.

## Security And Privacy

LoopLens captures local Claude Code / Codex traffic that you route through it. Even with redaction, JSONL captures can contain sensitive prompts, tool inputs, file paths, model responses, headers, and metadata.

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

- More faithful Claude Code transcript reconstruction from `parentUuid` chains.
- Better Codex hook/session correlation.
- HAR/export workflows.
- Signed and notarized macOS releases.
- Provider-specific token/cost attribution.
- Replay and diff tools with explicit safety controls.

## License

Apache-2.0. See [LICENSE](LICENSE).
