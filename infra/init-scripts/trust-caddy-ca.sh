#!/usr/bin/env bash
# trust-caddy-ca.sh — Extract and install the Caddy internal CA certificate.
#
# Caddy's `tls internal` directive generates a local CA stored inside the
# caddy_data Docker volume. This script copies that root certificate to the
# host's trust store and optionally prints the path for NODE_EXTRA_CA_CERTS.
#
# Usage:
#   ./infra/init-scripts/trust-caddy-ca.sh
#
# Prerequisites:
#   - Docker Compose services are running (`docker compose -f infra/compose.yaml up -d`)
#   - The caddy container has generated its CA (happens on first HTTPS request)
#
# Environment:
#   CADDY_CONTAINER  Name of the Caddy container (default: auto-detected)
#   CA_CERT_PATH     Where to write the CA cert on the host
#                    (default: infra/caddy-root-ca.crt)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Auto-detect the Caddy container name
CADDY_CONTAINER="${CADDY_CONTAINER:-$(docker compose -f "$PROJECT_ROOT/infra/compose.yaml" ps -q caddy 2>/dev/null || true)}"

if [ -z "$CADDY_CONTAINER" ]; then
  echo "ERROR: Caddy container not found. Is Docker Compose running?" >&2
  echo "  docker compose -f infra/compose.yaml up -d" >&2
  exit 1
fi

CA_CERT_PATH="${CA_CERT_PATH:-$PROJECT_ROOT/infra/caddy-root-ca.crt}"
CONTAINER_CA_PATH="/data/caddy/pki/authorities/local/root.crt"

echo "Extracting Caddy root CA certificate..."

# Copy the CA cert from the container
if ! docker cp "$CADDY_CONTAINER:$CONTAINER_CA_PATH" "$CA_CERT_PATH" 2>/dev/null; then
  echo "ERROR: Could not extract CA certificate from Caddy container." >&2
  echo "The CA is generated on the first HTTPS request. Try:" >&2
  echo "  curl -k https://localhost/health" >&2
  echo "Then re-run this script." >&2
  exit 1
fi

echo "CA certificate saved to: $CA_CERT_PATH"

# Install to system trust store (Linux)
if command -v update-ca-certificates &>/dev/null; then
  echo "Installing to system trust store (requires sudo)..."
  sudo cp "$CA_CERT_PATH" /usr/local/share/ca-certificates/caddy-dev-root.crt
  sudo update-ca-certificates
  echo "System trust store updated."
elif command -v trust &>/dev/null; then
  echo "Installing to system trust store via trust anchor (requires sudo)..."
  sudo trust anchor --store "$CA_CERT_PATH"
  echo "System trust store updated."
else
  echo "WARNING: Could not auto-install to system trust store."
  echo "Manually install: $CA_CERT_PATH"
fi

echo ""
echo "For Node.js processes (SDK, MCP server, dashboard), set:"
echo "  export NODE_EXTRA_CA_CERTS=\"$CA_CERT_PATH\""
echo ""
echo "Add to your .env or shell profile for persistence."
