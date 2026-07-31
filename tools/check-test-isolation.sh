#!/usr/bin/env bash
# Guard parallel-test filesystem isolation (LOS_TEST_GROUP races).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node ./tools/check-test-isolation.mjs
