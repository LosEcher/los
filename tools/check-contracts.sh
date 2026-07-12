#!/usr/bin/env bash
# check-contracts.sh — lightweight contract presence and drift gate.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT_DIR="$ROOT/contracts"

required_contracts=(
  run-spec.yaml
  run-stream.yaml
  session-trace.yaml
  node-registry.yaml
  node-command.yaml
  artifact-transfer.yaml
  agent-task-graph.yaml
  provider-compat-evidence.yaml
  todo-dispatch.yaml
  integration-feed-analysis.yaml
  memory.yaml
  task-intake.yaml
  coordinator-context-policy.yaml
  coordinator-resume-plan.yaml
  coordinator-resume-guard.yaml
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
    fail "$file: missing $label (pattern: $pattern)"
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
agent_task_graph="$CONTRACT_DIR/agent-task-graph.yaml"
provider_compat_evidence="$CONTRACT_DIR/provider-compat-evidence.yaml"
coordinator_context_policy="$CONTRACT_DIR/coordinator-context-policy.yaml"
coordinator_resume_plan="$CONTRACT_DIR/coordinator-resume-plan.yaml"
coordinator_resume_guard="$CONTRACT_DIR/coordinator-resume-guard.yaml"

[ -f "$run_spec" ] && {
  require_pattern "$run_spec" 'prompt:' 'prompt field'
  require_pattern "$run_spec" 'workspaceRoot:' 'workspaceRoot field'
  require_pattern "$run_spec" 'toolMode:' 'toolMode field'
  require_pattern "$run_spec" 'executor:' 'executor field'
  require_pattern "$run_spec" 'requiredPrincipal:[[:space:]]+operator' 'operator principal requirement'
  require_pattern "$run_spec" 'actorSource:[[:space:]]+principal\.subject' 'trusted operator actor source'
  require_pattern "$run_spec" '/runtimes/\{kind\}/run' 'runtime operator route'
  require_pattern "$run_spec" '/runtimes/bridge/start' 'runtime bridge operator route'
  require_pattern "$run_spec" '/governance/jobs/sweep' 'governance operator route'
}

[ -f "$run_stream" ] && {
  require_pattern "$run_stream" 'session\.started' 'session.started event'
  require_pattern "$run_stream" 'task\.running' 'task.running event'
  require_pattern "$run_stream" 'model\.delta' 'model.delta event'
  require_pattern "$run_stream" 'tool\.result' 'tool.result event'
  require_pattern "$run_stream" 'requiredPrincipal:[[:space:]]+operator' 'stream operator principal requirement'
  require_pattern "$run_stream" 'actorSource:[[:space:]]+principal\.subject' 'stream actor source'
  require_pattern "$run_stream" '/sessions/\{sessionId\}/operator-events' 'session operator route'
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

[ -f "$agent_task_graph" ] && {
  require_pattern "$agent_task_graph" 'agent_tasks' 'agent_tasks source'
  require_pattern "$agent_task_graph" 'task_edges' 'task_edges source'
  require_pattern "$agent_task_graph" 'task_attempts' 'task_attempts source'
  require_pattern "$agent_task_graph" '/agent-graphs/\{graphId\}' 'graph read route'
  require_pattern "$agent_task_graph" 'requireVerifier' 'requireVerifier query'
}

[ -f "$provider_compat_evidence" ] && {
  require_pattern "$provider_compat_evidence" '/providers/compat-evidence' 'provider compat route'
  require_pattern "$provider_compat_evidence" '/providers/promotion-decisions' 'provider promotion route'
  require_pattern "$provider_compat_evidence" '/providers/promotion-decisions/enforce' 'provider promotion enforcement route'
  require_pattern "$provider_compat_evidence" 'requiredPrincipal:[[:space:]]+operator' 'provider operator principal requirement'
  require_pattern "$provider_compat_evidence" 'actorSource:[[:space:]]+principal\.subject' 'provider actor source'
  require_pattern "$provider_compat_evidence" 'provider_compat_evidence\.rows' 'provider compat rows'
  require_pattern "$provider_compat_evidence" 'verified_advisory' 'verified advisory decision'
  require_pattern "$provider_compat_evidence" 'raw transcripts' 'raw transcript redaction'
}

[ -f "$coordinator_context_policy" ] && {
  require_pattern "$coordinator_context_policy" 'coordinator\.context_policy_selected' 'context policy event'
  require_pattern "$coordinator_context_policy" 'baseSystemPromptSource:' 'base prompt source field'
  require_pattern "$coordinator_context_policy" 'queriedLayers:' 'memory layer evidence'
  require_pattern "$coordinator_context_policy" 'Never persist system prompt text' 'prompt content exclusion'
}

[ -f "$coordinator_resume_plan" ] && {
  require_pattern "$coordinator_resume_plan" 'coordinator\.resume_plan_selected' 'resume plan event'
  require_pattern "$coordinator_resume_plan" 'candidateRunSpecIds:' 'resume candidate field'
  require_pattern "$coordinator_resume_plan" 'lastEventId:' 'resume cursor field'
  require_pattern "$coordinator_resume_plan" 'Never persist prompts' 'resume prompt exclusion'
}

[ -f "$coordinator_resume_guard" ] && {
  require_pattern "$coordinator_resume_guard" 'run\.resume_dispatch_suppressed' 'resume suppression event'
  require_pattern "$coordinator_resume_guard" 'active_task_present' 'active task guard reason'
  require_pattern "$coordinator_resume_guard" 'transitionExecutionState' 'state transition boundary'
  require_pattern "$coordinator_resume_guard" 'Never persist prompts' 'resume guard prompt exclusion'
}

integration_feed="$CONTRACT_DIR/integration-feed-analysis.yaml"
memory="$CONTRACT_DIR/memory.yaml"

[ -f "$integration_feed" ] && {
  require_pattern "$integration_feed" '/api/integrations/feed-analysis/targets' 'targets route'
  require_pattern "$integration_feed" '/api/integrations/feed-analysis/dispatch' 'dispatch route'
  require_pattern "$integration_feed" 'sourceSystem' 'sourceSystem field'
  require_pattern "$integration_feed" 'idempotency' 'idempotency support'
  require_pattern "$integration_feed" 'sourceOfTruth' 'sourceOfTruth section'
  require_pattern "$integration_feed" '/api/integrations/feed-analysis/dispatch/:id/result' 'result route'
  require_pattern "$integration_feed" '/api/integrations/feed-analysis/dispatch/:id/cancel' 'cancel route'
  require_pattern "$integration_feed" 'materialBundle' 'material bundle schema'
  require_pattern "$integration_feed" 'feed_analysis_callback_deliveries' 'callback delivery source'
  require_pattern "$integration_feed" '/api/integrations/feed-analysis/callbacks/dead-letter' 'callback dead-letter route'
  require_pattern "$integration_feed" '/api/integrations/feed-analysis/callbacks/:id/replay' 'callback replay route'
  [ -s "$CONTRACT_DIR/fixtures/feed-analysis-v2-dispatch.json" ] \
    || fail 'feed-analysis v2 dispatch fixture is missing'
  [ -s "$CONTRACT_DIR/fixtures/feed-analysis-v2-completed-event.json" ] \
    || fail 'feed-analysis v2 completed event fixture is missing'
}

[ -f "$memory" ] && {
  require_pattern "$memory" '/memory' 'memory search route'
  require_pattern "$memory" '/memory/compact' 'memory compact route'
  require_pattern "$memory" '/memory/active-rules' 'active rules route'
  require_pattern "$memory" '/memory/retrieve' 'retrieval route'
  require_pattern "$memory" 'observations' 'observations source'
  require_pattern "$memory" 'memory_compactions' 'compactions source'
  require_pattern "$memory" 'procedural_candidates' 'candidates source'
}

# ── Status-based gating (informational only, never blocks) ──

for name in "${required_contracts[@]}"; do
  file="$CONTRACT_DIR/$name"
  [ -f "$file" ] || continue
  status=$(grep -E '^status:[[:space:]]+' "$file" | head -1 | sed 's/^status:[[:space:]]*//')
  if [ "$status" = "draft" ]; then
    # draft status is informational; contracts gate on structure + cross-references, not on status
    :  # no-op — suppress "contract check warning: ... has status draft" noise
  fi
done

# ── Version consistency check ──

versions_tmp=$(mktemp "${TMPDIR:-/tmp}/los-contract-versions.XXXXXX")
trap 'rm -f "$versions_tmp"' EXIT
for name in "${required_contracts[@]}"; do
  file="$CONTRACT_DIR/$name"
  [ -f "$file" ] || continue
  ver=$(grep -E '^version:[[:space:]]+' "$file" | head -1 | sed 's/^version:[[:space:]]*//')
  printf '%s\t%s\n' "$name" "$ver" >> "$versions_tmp"
done

if [ -s "$versions_tmp" ]; then
  printf '  contract versions:\n' >&2
  while IFS=$'\t' read -r cname cver; do
    printf '    %-45s %s\n' "$cname" "$cver" >&2
  done < "$versions_tmp"
fi

versions_only=$(cut -f2 "$versions_tmp" | sort -u)
version_count=$(echo "$versions_only" | grep -c . || true)
if [ "$version_count" -gt 1 ]; then
  printf '  contract check warning: %d distinct versions across %d contracts\n' \
    "$version_count" "${#required_contracts[@]}" >&2
fi

# ── Cross-contract reference validation ──

# Verify session-trace → run-stream dependency
if [ -f "$CONTRACT_DIR/session-trace.yaml" ]; then
  if ! grep -q 'run-stream\.yaml' "$CONTRACT_DIR/session-trace.yaml"; then
    fail "session-trace.yaml should declare its dependency on run-stream.yaml"
  fi
fi

# Verify run-spec references los.run-stream
if [ -f "$CONTRACT_DIR/run-spec.yaml" ]; then
  if ! grep -q 'los\.run-stream' "$CONTRACT_DIR/run-spec.yaml" 2>/dev/null; then
    printf '  contract check warning: run-spec.yaml does not reference los.run-stream\n' >&2
  fi
fi

# Validate that referenced los.<name> contracts exist
for name in "${required_contracts[@]}"; do
  file="$CONTRACT_DIR/$name"
  [ -f "$file" ] || continue
  refs=$(grep -oE 'los\.[a-z-]+' "$file" 2>/dev/null | sort -u || true)
  for ref in $refs; do
    ref_file="$CONTRACT_DIR/${ref#los.}.yaml"
    if [ ! -f "$ref_file" ]; then
      printf '  contract check warning: %s references %s but %s does not exist\n' \
        "$name" "$ref" "${ref#los.}.yaml" >&2
    fi
  done
done

# ── Event coverage: contract eventTypes vs actual emissions ──

verify_event_coverage() {
  local contract_file="$1"          # run-stream.yaml
  local event_types_section="$2"     # eventTypes: | sseProtocol:
  local label="$3"                   # human-readable label
  shift 3
  local src_files=("$@")

  # Extract declared event types from contract (lines with "  - <name>" under the section)
  local declared
  declared=$(awk -v section="$event_types_section" '
    $0 ~ "^" section ":" { in_section=1; next }
    in_section && /^  - / { gsub(/^  - /, ""); print; next }
    in_section && /^[a-zA-Z]/ { exit }
  ' "$contract_file")

  if [ -z "$declared" ]; then
    printf '  (no %s entries in contract)\n' "$label"
    return 0
  fi

  local had_failures=0

  # Forward check: every declared event that appears as a session_events type
  # must be emitted somewhere (relayed via relaySessionEvent or send).
  for evt in $declared; do
    local found=0
    for f in "${src_files[@]}"; do
      if grep -qE "send\('[^']*${evt}[^']*'" "$f" 2>/dev/null; then
        found=1
        break
      fi
      # Also check for relaySessionEvent which relays all session_events types
      if grep -qE 'relaySessionEvent' "$f" 2>/dev/null; then
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      fail "$label event '$evt' declared in contract but not found in emission code"
      had_failures=1
    fi
  done

  # Reverse check: every send('name', ...) must appear in one of the contract sections
  local emitted
  emitted=$(for f in "${src_files[@]}"; do
    [ -f "$f" ] && grep -ohE "send\('[a-zA-Z._-]+'" "$f" 2>/dev/null || true
  done | sed "s/send('//;s/'//" | sort -u)

  local all_declared
  all_declared=$(awk '
    /^(eventTypes|sseProtocol):/ { in_section=1; next }
    in_section && /^  - / { gsub(/^  - /, ""); print; next }
    in_section && /^[a-zA-Z]/ { in_section=0 }
  ' "$contract_file" | sort -u)

  for evt in $emitted; do
    if ! echo "$all_declared" | grep -qFx "$evt"; then
      fail "event '$evt' emitted in code but not declared in $contract_file ($label)"
      had_failures=1
    fi
  done

  return $had_failures
}

scan_files=(
  "$ROOT/packages/gateway/src/chat-route.ts"
  "$ROOT/packages/gateway/src/chat-live-events.ts"
  "$ROOT/packages/gateway/src/routes/sse-routes.ts"
)

[ -f "$run_stream" ] && verify_event_coverage "$run_stream" eventTypes "run-stream" "${scan_files[@]}"
[ -f "$run_stream" ] && verify_event_coverage "$run_stream" sseProtocol "run-stream sse" "${scan_files[@]}"

# ── Projector coverage: every tool.* event must be handled in session-trace.ts ──

verify_projector_coverage() {
  local contract_file="$1"
  local projector_file="$2"

  if [ ! -f "$contract_file" ] || [ ! -f "$projector_file" ]; then
    return 0
  fi

  local tool_events
  tool_events=$(awk '
    /^(eventTypes):/ { in_section=1; next }
    in_section && /^  - tool\./ { gsub(/^  - /, ""); print; next }
    in_section && /^[a-zA-Z]/ { in_section=0 }
  ' "$contract_file")

  local had_failures=0
  for evt in $tool_events; do
    if ! grep -qE "event\.type === ['\"]${evt}['\"]|event\.type\.startsWith.*tool" "$projector_file" 2>/dev/null; then
      fail "tool event '$evt' in contract has no handler in session-trace.ts projector"
      had_failures=1
    fi
  done

  return $had_failures
}

projector_file="$ROOT/packages/agent/src/session-trace.ts"
[ -f "$run_stream" ] && verify_projector_coverage "$run_stream" "$projector_file"

if [ "$failures" -gt 0 ]; then
  exit 1
fi

printf 'contract check passed (%s files)\n' "${#required_contracts[@]}"
