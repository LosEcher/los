#!/usr/bin/env bash
# Guard the turbo test-env contract (strict env mode strips undeclared vars).
# See tools/check-turbo-env-passthrough.mjs for the incident this encodes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node ./tools/check-turbo-env-passthrough.mjs
