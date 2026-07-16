#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec pnpm --dir "$ROOT" --filter @los/contracts exec node --import tsx ../../tools/check-contracts.ts "$@"
