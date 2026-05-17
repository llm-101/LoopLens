# Project Structure

LoopLens is split into a small number of top-level areas so contributors can find the right layer quickly.

```text
.
├── bin/
│   ├── gen-ca.sh
│   ├── trust-ca-macos.sh
│   ├── untrust-ca-macos.sh
│   ├── run-claude
│   ├── run-codex
│   └── looplens-hook
├── crates/
│   └── looplens-proxy/
│       └── src/main.rs
├── desktop/
│   ├── src/
│   └── src-tauri/
├── docs/
└── .github/workflows/
```

## Native Proxy

`crates/looplens-proxy` contains the Rust capture proxy and local API gateway. It writes JSONL traffic captures and supports the lightweight HTML capture viewer.

Build it with:

```bash
cargo build -p looplens-proxy --release
```

## Desktop App

`desktop` contains the Tauri shell and React UI. Frontend code lives in `desktop/src`; native Tauri commands live in `desktop/src-tauri/src`.

Build it with:

```bash
cd desktop
npm run build
```

## Runtime State

These directories are local runtime state and should not be committed:

- `ca/`
- `captures/`
- `hooks/`
- `release/`
- `.claude/`
- `.codex/`
