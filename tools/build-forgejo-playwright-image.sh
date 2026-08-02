#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENGINE=${CONTAINER_ENGINE:-docker}
BASE_IMAGE=${FORGEJO_CI_BASE_IMAGE:-los-ci:node22-jj0.39.0}
IMAGE=${FORGEJO_PLAYWRIGHT_IMAGE:-los-ci:node22-jj0.39.0-playwright1.61.1}

"$ENGINE" build \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --tag "$IMAGE" \
  "$ROOT/.forgejo/images/node22-jj-playwright"

"$ENGINE" run --rm "$IMAGE" sh -c '
  set -eu
  node -e "if (Number(process.versions.node.split(\".\")[0]) < 22) process.exit(1)"
  test "$(pnpm --version)" = "11.6.0"
  case "$(jj --version)" in
    "jj 0.39.0"*) ;;
    *) exit 1 ;;
  esac
  chrome="$(find "$PLAYWRIGHT_BROWSERS_PATH" -type f -name chrome -print -quit)"
  test -n "$chrome"
  "$chrome" --no-sandbox --headless --version
'
