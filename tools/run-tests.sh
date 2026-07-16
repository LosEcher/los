#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export LOS_TEST_RUN_ID="${LOS_TEST_RUN_ID:-$(node -e "process.stdout.write(require('node:crypto').randomUUID())")}"
TEST_CONCURRENCY="${LOS_TEST_CONCURRENCY:-4}"
printf 'los test run id: %s\n' "$LOS_TEST_RUN_ID"
printf 'los test concurrency: %s\n' "$TEST_CONCURRENCY"

exec turbo test --concurrency="$TEST_CONCURRENCY"
