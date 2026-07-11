#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export LOS_TEST_RUN_ID="${LOS_TEST_RUN_ID:-$(node -e "process.stdout.write(require('node:crypto').randomUUID())")}" 
printf 'los test run id: %s\n' "$LOS_TEST_RUN_ID"

exec turbo test --concurrency=4
