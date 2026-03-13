#!/bin/bash
set -euo pipefail

# Create the platform database and enable pgvector extension.
# This script runs automatically on first Postgres boot via
# /docker-entrypoint-initdb.d/.

PLATFORM_DB="${PQDB_PLATFORM_DB:-pqdb_platform}"

echo "Creating platform database: ${PLATFORM_DB}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE "${PLATFORM_DB}";
EOSQL

echo "Enabling pgvector extension on ${PLATFORM_DB}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$PLATFORM_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

echo "Database initialization complete."
