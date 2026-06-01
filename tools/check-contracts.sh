#!/usr/bin/env bash
# check-contracts.sh — lightweight contract presence and drift gate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_DIR="$ROOT/contracts"

required_contracts=(
  run-spec.yaml
  run-stream.yaml
  node-registry.yaml
  node-command.yaml
  artifact-transfer.yaml
)

failures=0

fail() {
  printf 'contract check failed: %s\n' "$1" >&2
  failures=$((failures + 1))
}

require_pattern() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if ! grep -Eq "$pattern" "$file"; then
    fail "$(basename "$file") missing $label"
  fi
}

if [ ! -d "$CONTRACT_DIR" ]; then
  fail "contracts directory is missing"
else
  for name in "${required_contracts[@]}"; do
    file="$CONTRACT_DIR/$name"
    if [ ! -s "$file" ]; then
      fail "$name is missing or empty"
      continue
    fi
    require_pattern "$file" '^contract:[[:space:]]+los\.' 'contract id'
    require_pattern "$file" '^version:[[:space:]]+' 'version'
    require_pattern "$file" '^status:[[:space:]]+' 'status'
    require_pattern "$file" '^owner:[[:space:]]+' 'owner'
    require_pattern "$file" '^verification:' 'verification section'
  done
fi

run_spec="$CONTRACT_DIR/run-spec.yaml"
run_stream="$CONTRACT_DIR/run-stream.yaml"
node_registry="$CONTRACT_DIR/node-registry.yaml"
node_command="$CONTRACT_DIR/node-command.yaml"
artifact_transfer="$CONTRACT_DIR/artifact-transfer.yaml"

[ -f "$run_spec" ] && {
  require_pattern "$run_spec" 'prompt:' 'prompt field'
  require_pattern "$run_spec" 'workspaceRoot:' 'workspaceRoot field'
  require_pattern "$run_spec" 'toolMode:' 'toolMode field'
  require_pattern "$run_spec" 'executor:' 'executor field'
}

[ -f "$run_stream" ] && {
  require_pattern "$run_stream" 'session\.started' 'session.started event'
  require_pattern "$run_stream" 'task\.running' 'task.running event'
  require_pattern "$run_stream" 'model\.delta' 'model.delta event'
  require_pattern "$run_stream" 'tool\.result' 'tool.result event'
}

[ -f "$node_registry" ] && {
  require_pattern "$node_registry" 'nodeKind:' 'nodeKind field'
  require_pattern "$node_registry" 'agent_http_ndjson' 'agent_http_ndjson mode'
  require_pattern "$node_registry" 'capabilities:' 'capabilities field'
  require_pattern "$node_registry" 'verified:' 'verified field'
}

[ -f "$node_command" ] && {
  require_pattern "$node_command" 'upgrade' 'upgrade command'
  require_pattern "$node_command" 'drain' 'drain command'
  require_pattern "$node_command" 'allowlisted maintenance actions' 'maintenance security note'
}

[ -f "$artifact_transfer" ] && {
  require_pattern "$artifact_transfer" 'checksum' 'checksum field'
  require_pattern "$artifact_transfer" 'chunk:' 'chunk field'
  require_pattern "$artifact_transfer" 'pathPolicy:' 'pathPolicy field'
}

if [ "$failures" -gt 0 ]; then
  exit 1
fi

printf 'contract check passed (%s files)\n' "${#required_contracts[@]}"
