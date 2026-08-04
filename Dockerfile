# los — Multi-stage Docker image
#
# Stage 1 (build): install dependencies, build Web UI.
# Stage 2 (runtime): copy built artifacts + source, run with tsx.
#
# The runtime stage uses tsx because package.json exports point to .ts files.
# Once conditional exports switch to compiled dist/, the runtime stage can
# drop tsx and source files — see deploy/systemd/los-executor.service:19-21.
#
# Build (local):
#   docker build -t los .
#
# Build (multi-platform, for publishing):
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/losecher/los:latest .
#
# Run standalone (with external PostgreSQL):
#   docker run -d --name los \
#     -p 8080:8080 \
#     -e DATABASE_URL=postgres://user:pass@host:5432/los \
#     -e DEEPSEEK_API_KEY=sk-xxx \
#     ghcr.io/losecher/los:latest

# ── Stage 1: Build ─────────────────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.6.0 --activate
WORKDIR /app

# Layer 1: workspace root configs (infrequently changed — good cache hit)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./

# Layer 2: per-package manifests (changes when deps are added/upgraded)
COPY packages/agent/package.json       packages/agent/
COPY packages/cli/package.json         packages/cli/
COPY packages/contracts/package.json   packages/contracts/
COPY packages/executor/package.json    packages/executor/
COPY packages/gateway/package.json     packages/gateway/
COPY packages/infra/package.json       packages/infra/
COPY packages/media/package.json       packages/media/
COPY packages/memory/package.json      packages/memory/
COPY packages/telegram-bot/package.json packages/telegram-bot/
COPY packages/web/package.json         packages/web/
COPY packages/wechat-bot/package.json  packages/wechat-bot/

# Layer 3: install dependencies (cached until a package.json changes)
RUN pnpm install --frozen-lockfile

# Layer 4: copy source + contracts (frequently changed)
COPY packages/   packages/
COPY contracts/  contracts/

# Layer 5: pre-build Web UI so the gateway starts instantly
RUN pnpm --filter @los/web build

# Layer 6: prune pnpm store + turbo cache to keep the stage lean
RUN pnpm store prune && rm -rf .turbo packages/*/.turbo

# ── Stage 2: Runtime ───────────────────────────────────
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /app

# Copy workspace configs (needed for pnpm workspace resolution at runtime)
COPY --from=build /app/pnpm-workspace.yaml \
     /app/pnpm-lock.yaml \
     /app/package.json \
     /app/tsconfig.base.json \
     /app/turbo.json \
     ./

# Copy dependencies (includes tsx for TypeScript execution)
COPY --from=build /app/node_modules ./node_modules

# Copy source packages (tsx runs .ts files directly)
COPY --from=build /app/packages ./packages

# Copy contracts
COPY --from=build /app/contracts ./contracts

# ── Entrypoint ─────────────────────────────────────────
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8080

ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=8080

# Non-root user for defense-in-depth
RUN addgroup -S los && adduser -S los -G los && \
    chown -R los:los /app
USER los

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.SERVER_PORT||8080)+'/health',r=>{process.exit(r.statusCode===200?0:1)})" || exit 1

CMD ["/app/docker-entrypoint.sh"]
