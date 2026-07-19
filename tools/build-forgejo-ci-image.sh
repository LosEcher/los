#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
IMAGE=${FORGEJO_CI_IMAGE:-los-ci:node22-jj0.39.0}

docker build \
  --platform linux/amd64 \
  --tag "$IMAGE" \
  "$ROOT/.forgejo/images/node22-jj"

docker run --rm --platform linux/amd64 "$IMAGE" sh -c '
  node -e "if (Number(process.versions.node.split(\".\")[0]) < 22) process.exit(1)"
  jj --version
'
