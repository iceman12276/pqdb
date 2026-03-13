#!/bin/sh
set -eu

# Wait for Vault to be ready (depends_on healthcheck should handle this,
# but add a small retry loop for robustness).
echo "Waiting for Vault at ${VAULT_ADDR}..."
until vault status >/dev/null 2>&1; do
    sleep 1
done

echo "Enabling transit secrets engine..."
vault secrets enable transit 2>/dev/null || echo "Transit engine already enabled."

echo "Vault initialization complete."
