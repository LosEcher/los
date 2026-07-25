#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENGINE=${CONTAINER_ENGINE:-docker}
IMAGE=${FORGEJO_CI_IMAGE:-los-ci:node24.16.0-jj0.39.0}
NODE_IMAGE=${FORGEJO_CI_NODE_IMAGE:-node:24.16.0-bookworm@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7}
REQUIRED_NODE_MAJOR=${FORGEJO_CI_NODE_MAJOR:-24}
TOOLCHAIN_IMAGE=${FORGEJO_CI_TOOLCHAIN_IMAGE:-}
BUILD_CONTEXT="$ROOT/.forgejo/images/node22-jj"
BUILD_ARGS=(
  --platform linux/amd64
  --build-arg "NODE_IMAGE=$NODE_IMAGE"
  --tag "$IMAGE"
)

if [[ -n "$TOOLCHAIN_IMAGE" ]]; then
  BUILD_CONTEXT="$ROOT/.forgejo/images/node-jj-from-toolchain"
  BUILD_ARGS+=(--build-arg "TOOLCHAIN_IMAGE=$TOOLCHAIN_IMAGE")
fi

"$ENGINE" build \
  "${BUILD_ARGS[@]}" \
  "$BUILD_CONTEXT"

"$ENGINE" run --rm --platform linux/amd64 \
  --env "REQUIRED_NODE_MAJOR=$REQUIRED_NODE_MAJOR" \
  "$IMAGE" sh -c '
  node -e "if (Number(process.versions.node.split(\".\")[0]) !== Number(process.env.REQUIRED_NODE_MAJOR)) process.exit(1)"
  jj --version
  test "$(pnpm --version)" = "9.0.0"
'
