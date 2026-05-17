#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT="${CCC_CA_CERT:-$ROOT/ca/looplens-ca.pem}"
KEYCHAIN="${CCC_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

if [[ ! -f "$CERT" ]]; then
  echo "CA cert not found: $CERT" >&2
  echo "Run ./bin/gen-ca.sh first." >&2
  exit 1
fi

security add-trusted-cert \
  -d \
  -r trustRoot \
  -k "$KEYCHAIN" \
  "$CERT"

echo "Trusted $CERT in $KEYCHAIN"
