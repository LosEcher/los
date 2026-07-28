#!/usr/bin/env sh
# los — Docker entrypoint
#
# 1. Wait for PostgreSQL to accept connections.
# 2. Start the los gateway (migrations run automatically at startup).
# 3. Optionally start the executor if EXECUTOR_ENABLED=true.

set -e

# ── Configurable wait ────────────────────────────────────
: "${DB_WAIT_HOST:=postgres}"
: "${DB_WAIT_PORT:=5432}"
: "${DB_WAIT_TIMEOUT:=60}"
: "${DB_WAIT_INTERVAL:=2}"

# ── Runtime defaults ─────────────────────────────────────
: "${SERVER_HOST:=0.0.0.0}"
: "${SERVER_PORT:=8080}"
: "${EXECUTOR_HOST:=0.0.0.0}"
: "${EXECUTOR_PORT:=8090}"
: "${LOS_RUNTIME_DIR:=/app/.los-runtime}"

# ── Wait for PostgreSQL ──────────────────────────────────
if [ -n "${DATABASE_URL}" ]; then
  # Extract host:port from DATABASE_URL for pg_isready-style check.
  # Fall back to DB_WAIT_HOST:DB_WAIT_PORT if parsing fails.
  DB_HOST=$(printf '%s' "${DATABASE_URL}" | sed -n 's|.*@\([^:/]*\).*|\1|p')
  DB_PORT=$(printf '%s' "${DATABASE_URL}" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
  DB_HOST="${DB_HOST:-$DB_WAIT_HOST}"
  DB_PORT="${DB_PORT:-$DB_WAIT_PORT}"

  echo "los: waiting for PostgreSQL at ${DB_HOST}:${DB_PORT} (timeout ${DB_WAIT_TIMEOUT}s)..."
  ELAPSED=0
  while [ "$ELAPSED" -lt "$DB_WAIT_TIMEOUT" ]; do
    if timeout 2 sh -c "cat < /dev/null > /dev/tcp/${DB_HOST}/${DB_PORT}" 2>/dev/null; then
      echo "los: PostgreSQL is ready."
      break
    fi
    sleep "$DB_WAIT_INTERVAL"
    ELAPSED=$((ELAPSED + DB_WAIT_INTERVAL))
  done
  if [ "$ELAPSED" -ge "$DB_WAIT_TIMEOUT" ]; then
    echo "los: WARNING — PostgreSQL did not become ready within ${DB_WAIT_TIMEOUT}s, starting anyway."
  fi
else
  echo "los: DATABASE_URL is not set — starting without DB wait. Migrations will fail if the DB is unreachable."
fi

# ── Runtime directory ────────────────────────────────────
mkdir -p "${LOS_RUNTIME_DIR}"

# ── Start Gateway ────────────────────────────────────────
echo "los: starting gateway on ${SERVER_HOST}:${SERVER_PORT}..."
GATEWAY_CMD="node --import ./packages/gateway/node_modules/tsx/dist/loader.mjs packages/gateway/src/server.ts"

# Start gateway in background so we can optionally add the executor.
${GATEWAY_CMD} &
GATEWAY_PID=$!

# ── Start Executor (if enabled) ──────────────────────────
if [ "${EXECUTOR_ENABLED:-false}" = "true" ]; then
  echo "los: starting executor on ${EXECUTOR_HOST}:${EXECUTOR_PORT}..."
  EXECUTOR_CMD="node --import ./packages/executor/node_modules/tsx/dist/loader.mjs packages/executor/src/index.ts"
  ${EXECUTOR_CMD} &
  EXECUTOR_PID=$!
fi

# ── Wait for any child to exit; bring down the others ────
trap 'echo "los: shutting down..."; kill ${GATEWAY_PID} ${EXECUTOR_PID:-} 2>/dev/null; wait; exit 0' TERM INT

wait ${GATEWAY_PID}
