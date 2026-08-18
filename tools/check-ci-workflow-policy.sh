#!/usr/bin/env bash
# Assert CI workflow job-ordering, concurrency, and path-gate skip wiring.
# Runs as a gate-fast phase so workflow drift fails the same path as structure
# checks, not only the broader `pnpm check` surface.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

exec node --test ./tools/ci-workflow-policy.test.mjs ./tools/path-gate.test.mjs
