#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/ca"

CERT="$ROOT/ca/cc-capture-ca.pem"
KEY="$ROOT/ca/cc-capture-ca.key"

if [[ -f "$CERT" && -f "$KEY" ]]; then
  echo "CA already exists:"
  echo "  $CERT"
  echo "  $KEY"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" \
  -out "$CERT" \
  -days 3650 \
  -subj "/CN=cc-capture-native local CA" \
  -addext "basicConstraints=critical,CA:true" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

chmod 600 "$KEY"
echo "Generated:"
echo "  $CERT"
echo "  $KEY"
