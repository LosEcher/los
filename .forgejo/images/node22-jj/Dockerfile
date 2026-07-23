FROM node:22-bookworm

ARG JJ_VERSION=0.39.0
ARG JJ_SHA256=8da8d96e9c8696c21ad47847a63d533e249acb0449d9af0f0562b5ea7b024f04

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    archive="jj-v${JJ_VERSION}-x86_64-unknown-linux-musl.tar.gz"; \
    curl --fail --location --retry 3 \
      "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/${archive}" \
      --output "/tmp/${archive}"; \
    echo "${JJ_SHA256}  /tmp/${archive}" | sha256sum --check --strict; \
    tar -xzf "/tmp/${archive}" -C /usr/local/bin ./jj; \
    jj --version; \
    rm -f "/tmp/${archive}"; \
    rm -rf /var/lib/apt/lists/*

# Windows burst runners cannot reliably reach registry.npmjs.org. Keep the
# package-manager payload in the image so job startup has no Corepack download.
ARG PNPM_VERSION=9.0.0
RUN set -eux; \
    corepack enable; \
    corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
    test "$(pnpm --version)" = "${PNPM_VERSION}"
