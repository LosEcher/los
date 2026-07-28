# los — Docker image
#
# Current production pattern uses tsx to run TypeScript source directly
# (package.json exports point to .ts files). Once conditional exports are
# added, switch to compiled dist/ — see deploy/systemd/los-executor.service:19-21.
#
# Build:
#   docker build -t los .
#
# Run standalone (with external PostgreSQL):
#   docker run -d --name los \
#     -p 8080:8080 \
#     -e DATABASE_URL=postgres://user:pass@host:5432/los \
#     -e DEEPSEEK_API_KEY=sk-xxx \
#     los

FROM node:22-alpine

# ── pnpm ──────────────────────────────────────────────────
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

# ── Workspace root configs (needed for pnpm install) ─────
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./

# ── All package.json files (pnpm needs them for workspace resolution) ──
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

# ── Install dependencies ─────────────────────────────────
RUN pnpm install --frozen-lockfile && pnpm store prune

# ── Copy source and contracts ────────────────────────────
COPY packages/   packages/
COPY contracts/  contracts/

# ── Pre-build web UI (Vite) ──────────────────────────────
# Build at image time so the gateway starts instantly.
RUN pnpm --filter @los/web build

# ── Entrypoint ───────────────────────────────────────────
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8080

ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=8080

CMD ["/app/docker-entrypoint.sh"]
