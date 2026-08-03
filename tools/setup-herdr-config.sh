#!/usr/bin/env bash
# setup-herdr-config.sh — install the herdr config generated for los dev
# (2026-08-02). Idempotent: backs up an existing config once, then writes
# the managed config. Run from the repo root:
#
#   bash tools/setup-herdr-config.sh
#
# What the config sets (see docs/operations/2026-08-02-node-toolchain-audit.md):
#   - catppuccin theme with light/dark auto-switch
#   - zsh login shell (keeps Homebrew PATH in new panes), follow cwd
#   - agent session restore on server restart
#   - CJK IME cursor anchor + ASCII input-source switch in prefix mode
#     (for Chinese-language agent work in herdr panes)
set -euo pipefail

CONFIG_DIR="${HERDR_CONFIG_DIR:-$HOME/.config/herdr}"
CONFIG_PATH="$CONFIG_DIR/config.toml"

if [[ -f "$CONFIG_PATH" ]] && ! grep -q "generated 2026-08-02 for los dev machine" "$CONFIG_PATH"; then
  cp "$CONFIG_PATH" "$CONFIG_PATH.bak-$(date +%Y%m%d%H%M%S)"
  echo "backed up existing config to $CONFIG_PATH.bak-*"
fi

mkdir -p "$CONFIG_DIR"

cat > "$CONFIG_PATH" << 'EOF'
# herdr config — generated 2026-08-02 for los dev machine
onboarding = false

[theme]
name = "catppuccin"
auto_switch = true

[terminal]
default_shell = "zsh"
shell_mode = "login"
new_cwd = "follow"

[worktrees]
directory = "~/.herdr/worktrees"

[session]
resume_agents_on_restore = true

[ui.toast]
delivery = "herdr"

[experimental]
reveal_hidden_cursor_for_cjk_ime = true
cjk_ime_agents = ["claude", "pi", "codex"]
switch_ascii_input_source_in_prefix = true
EOF

echo "herdr config written: $CONFIG_PATH"
echo "verify with: herdr config check"
