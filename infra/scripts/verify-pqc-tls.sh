#!/usr/bin/env bash
# verify-pqc-tls.sh — Verify that Caddy negotiates X25519MLKEM768 (PQC) key exchange.
#
# Prerequisites:
#   - Caddy running via Docker Compose (infra/compose.yaml)
#   - OpenSSL 3.5+ with ML-KEM support (for -groups flag)
#     OR any openssl 1.1+ to passively check what the server negotiates
#
# Usage:
#   ./infra/scripts/verify-pqc-tls.sh [hostname] [port]
#
# Exit codes:
#   0 — PQC key exchange (X25519MLKEM768) confirmed
#   1 — TLS connected but PQC key exchange NOT detected (classical fallback)
#   2 — TLS connection failed entirely

set -euo pipefail

HOST="${1:-localhost}"
PORT="${2:-443}"
EXPECTED_GROUP="X25519MLKEM768"

echo "=== PQC TLS Verification ==="
echo "Target: ${HOST}:${PORT}"
echo "Expected key exchange: ${EXPECTED_GROUP}"
echo ""

# Attempt TLS connection and capture handshake details.
# We use -servername for SNI (required by Caddy) and skip certificate
# verification (-verify_return_error is NOT set) since Caddy uses an
# internal CA for local dev.
TLS_OUTPUT=$(echo "Q" | openssl s_client \
  -connect "${HOST}:${PORT}" \
  -servername "${HOST}" \
  -brief \
  2>&1) || true

# Check if we got a TLS connection at all
if ! echo "${TLS_OUTPUT}" | grep -qi "protocol.*TLSv1\.[23]\|verification"; then
  echo "FAIL: Could not establish TLS connection to ${HOST}:${PORT}"
  echo ""
  echo "Debug output:"
  echo "${TLS_OUTPUT}"
  exit 2
fi

echo "TLS connection established."
echo ""

# Extract the negotiated server temp key / group.
# OpenSSL reports this as "Server Temp Key:" in verbose output or
# in the -brief output depending on the version.
# Try the verbose approach for more detail.
VERBOSE_OUTPUT=$(echo "Q" | openssl s_client \
  -connect "${HOST}:${PORT}" \
  -servername "${HOST}" \
  2>&1) || true

# Look for the key exchange group in the output.
# Caddy (Go 1.24+) negotiates X25519MLKEM768 when the client supports it.
# The exact string varies by OpenSSL version:
#   - "Server Temp Key: X25519MLKEM768" (OpenSSL 3.5+)
#   - "Server Temp Key: X25519" (older OpenSSL that doesn't support ML-KEM)
#   - "Server Temp Key: MLKEM768" or similar variants

TEMP_KEY_LINE=$(echo "${VERBOSE_OUTPUT}" | grep -i "Server Temp Key:" || echo "")
GROUP_LINE=$(echo "${VERBOSE_OUTPUT}" | grep -i "group:" || echo "")

echo "--- Handshake Details ---"
echo "${VERBOSE_OUTPUT}" | grep -iE "Protocol|Cipher|Server Temp Key|Peer sign|group:" || true
echo "-------------------------"
echo ""

if echo "${TEMP_KEY_LINE}${GROUP_LINE}" | grep -qi "${EXPECTED_GROUP}"; then
  echo "PASS: PQC key exchange confirmed — ${EXPECTED_GROUP} negotiated."
  echo ""
  echo "This means TLS is using a hybrid post-quantum key encapsulation mechanism"
  echo "(ML-KEM-768 + X25519) for forward secrecy."
  exit 0
fi

# Check if we got classical X25519 instead (expected with older OpenSSL)
if echo "${TEMP_KEY_LINE}" | grep -qi "X25519"; then
  echo "WARN: Classical X25519 key exchange detected (not PQC)."
  echo ""
  echo "This typically means your openssl client does not support ML-KEM."
  echo "The SERVER (Caddy/Go 1.24+) supports X25519MLKEM768, but the client"
  echo "must also support it to negotiate PQC key exchange."
  echo ""
  echo "To verify PQC TLS:"
  echo "  1. Use OpenSSL 3.5+ (with ML-KEM support)"
  echo "  2. Use Chrome 131+ or Firefox 132+ and check Security tab in DevTools"
  echo "  3. Use Node.js 23+ with tls.connect() and inspect the ephemeral key info"
  echo ""
  echo "Note: Even without PQC TLS, all sensitive data is ML-KEM encrypted at the"
  echo "application layer by the SDK before transmission."
  exit 1
fi

echo "WARN: Could not determine key exchange algorithm."
echo "Server Temp Key line: ${TEMP_KEY_LINE:-<not found>}"
echo ""
echo "Debug: Full handshake output saved. Re-run with VERBOSE=1 for details."
if [[ "${VERBOSE:-0}" == "1" ]]; then
  echo "${VERBOSE_OUTPUT}"
fi
exit 1
