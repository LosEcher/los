#!/usr/bin/env bash
# los-mcp-serve.sh — 把 los 的 MCP server（`los mcp serve`）跑成可被宿主 spawn 的 stdio 服务。
#
# 为什么需要这层壳：宿主（DSH / Codex / Claude）spawn MCP server 时的 PATH 各不相同，
# 而 `bin/los` 依赖 pnpm、直接 `node dist/...` 又可能落后于源码（本仓 gateway/executor
# 都是 tsx 直跑 src，dist 不是权威）。这里按 tools/los.sh 的同一套「blessed 调用」：
# 显式补 PATH → 解析 node + tsx → `node --require tsx/preflight.cjs --import tsx/loader.mjs
# packages/cli/src/index.ts mcp serve`。
#
# 用法（宿主配置里直接指向本脚本，无需参数）：
#   command: /bin/bash
#   args: ['<repo>/tools/los-mcp-serve.sh']
# 环境：LOS_GATEWAY_URL（缺省 http://127.0.0.1:8080）、LOS_OPERATOR_TOKEN、LOS_AUTH_TOKEN
#       —— 宿主注入了就用宿主的；没注入则**只**从本仓 .env 补这两个 token（不整份 source，
#       避免把仓库 .env 的其它键灌进宿主进程）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 与 tools/los-launchd-wrapper.sh 同款：launchd/宿主环境 PATH 不含 fnm/pnpm。
export PATH="$HOME/.cargo/bin:$HOME/Library/pnpm:$HOME/Library/Application Support/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

_read_env_key() { # 取单个键；不 source 整份 .env
  [ -f "$ROOT/.env" ] || return 0
  sed -n "s/^$1=//p" "$ROOT/.env" | head -1 | sed -e 's/^"//' -e 's/"$//'
}
if [ -z "${LOS_AUTH_TOKEN:-}" ]; then
  LOS_AUTH_TOKEN="$(_read_env_key LOS_AUTH_TOKEN)"; export LOS_AUTH_TOKEN
fi
if [ -z "${LOS_OPERATOR_TOKEN:-}" ]; then
  LOS_OPERATOR_TOKEN="$(_read_env_key LOS_OPERATOR_TOKEN)"; export LOS_OPERATOR_TOKEN
fi

NODE="$(command -v node || true)"
TSX="$(ls -d "$ROOT"/node_modules/.pnpm/tsx@*/node_modules/tsx/dist 2>/dev/null | head -1 || true)"
ENTRY="$ROOT/packages/cli/src/index.ts"
if [[ -z "$NODE" || -z "$TSX" || ! -f "$ENTRY" ]]; then
  echo "los-mcp-serve: missing prerequisite (node='$NODE' tsx='$TSX' entry='$ENTRY')" >&2
  exit 1
fi

exec "$NODE" --require "$TSX/preflight.cjs" --import "file://$TSX/loader.mjs" "$ENTRY" mcp serve
