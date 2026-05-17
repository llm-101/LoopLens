#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT="${CCC_CA_CERT:-$ROOT/ca/looplens-ca.pem}"

security remove-trusted-cert -d "$CERT" || true
echo "Removed trust entry for $CERT"
