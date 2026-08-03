#!/usr/bin/env bash
# setup-herdr-plugins.sh — install the curated herdr plugin set for los dev
# (2026-08-05). Idempotent: skips already-installed plugins.
#
# NOTE: must run in a REAL terminal (not an agent sandbox) — herdr writes
# under ~/.config/herdr, which sandboxed shells cannot access.
#
#   bash tools/setup-herdr-plugins.sh
#
# Curated set (small, observation-first):
#   smarzban/herdr-file-viewer            git-aware file tree + diff + markdown sidebar (331★)
#   persiyanov/herdr-reviewr              diff review sidebar, line comments feed back
#                                         to the agent's prompt (316★, pairs with forgejo flow)
#   NathanFlurry/herdr-plugin-jj-workspace  jj workspace <-> herdr workspace (los uses jj)
#   Davidcreador/herdr-token-dashboard    live token spend dashboard per agent pane
#
# Deliberately NOT installed yet (observe first, then decide):
#   fkiene/llmtrim-herdr    PowerShell-only, macOS unsupported
#   AltanS/collie           phone PWA — wait until the pane plugins prove useful
#   ezcorp-org/herdr-git-status / herdr-pc-ram-and-cpu-usage-overlay  — second batch
set -euo pipefail

PLUGINS=(
  "smarzban/herdr-file-viewer"
  "persiyanov/herdr-reviewr"
  "NathanFlurry/herdr-plugin-jj-workspace"
  "Davidcreador/herdr-token-dashboard"
)

if ! command -v herdr >/dev/null 2>&1; then
  echo "herdr not found — install first: curl -fsSL https://herdr.dev/install.sh | sh" >&2
  exit 1
fi

# herdr config dir is ~/.config/herdr; warn if it is missing so the user can
# re-run tools/setup-herdr-config.sh first.
if [ ! -d "$HOME/.config/herdr" ]; then
  echo "warning: ~/.config/herdr missing — re-run 'bash tools/setup-herdr-config.sh' first" >&2
fi

for p in "${PLUGINS[@]}"; do
  name="$(basename "$p")"
  if herdr plugin list 2>/dev/null | grep -qi "$name"; then
    echo "skip $p (already installed)"
    continue
  fi
  echo "installing $p ..."
  herdr plugin install "$p" --yes
done

echo ""
echo "installed plugins:"
herdr plugin list
