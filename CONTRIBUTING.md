# Contributing

Thanks for helping improve LoopLens.

## Development

Build the native proxy:

```bash
cargo build --release
```

Run the desktop app:

```bash
cd desktop
npm install
npm run dev
```

Build the desktop app:

```bash
cd desktop
npm run build:vite
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

## Guidelines

- Do not commit generated CA files, capture files, logs, or build outputs.
- Keep UI changes consistent with the LoopLens matte dark design system.
- Prefer Radix primitives for accessible interactions.
- Prefer TanStack Table for dense data views.
- Keep capture parsing conservative; unknown data should be shown as unknown/unmatched rather than guessed.

