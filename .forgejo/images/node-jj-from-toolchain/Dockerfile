ARG TOOLCHAIN_IMAGE=los-ci:node22-jj0.39.0
ARG NODE_IMAGE=node:24.16.0-bookworm@sha256:40ad9f3064e67d6860b4bc3fe1880b2953934fd6320ada990e45fe0efa6badd7

FROM ${TOOLCHAIN_IMAGE} AS toolchain

FROM ${NODE_IMAGE}

ARG PNPM_VERSION=9.0.0

# Reuse only the pinned, already-verified CI toolchain. Application dependencies
# and mutable runner state are supplied separately by the job.
COPY --from=toolchain /usr/local/bin/jj /usr/local/bin/jj
COPY --from=toolchain /root/.cache/node/corepack /root/.cache/node/corepack

RUN set -eux; \
    corepack enable; \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
    test "$(pnpm --version)" = "${PNPM_VERSION}"; \
    jj --version
