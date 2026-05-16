# Security Policy

LoopLens is a local debugging tool for traffic and agent-loop observability. Capture files can contain sensitive prompts, model responses, file paths, request bodies, and metadata.

## Sensitive Local Files

Do not publish or share these generated files:

- `ca/`
- `captures/`
- `*.jsonl`
- `*.pem`
- `*.key`
- `*.log`

The repository `.gitignore` excludes them by default.

## Local CA

LoopLens can generate a local CA so native CLI tools can send HTTPS traffic through the local proxy. This CA is intended for local development only.

- Generate it locally with `./bin/gen-ca.sh`.
- Trust it only when you understand the local proxy flow.
- Remove trust with `./bin/untrust-ca-macos.sh`.
- Never commit or distribute generated CA private keys.

## Reporting Security Issues

Please do not open public issues for sensitive vulnerabilities. Use a private GitHub security advisory when the repository is published, or contact the maintainer privately.

