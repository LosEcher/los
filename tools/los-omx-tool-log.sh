#!/usr/bin/env bash
# los-omx-tool-log.sh — Query OMX tool-level logs.
#
# Usage:
#   ./tools/los-omx-tool-log.sh                  Show today's tool events
#   ./tools/los-omx-tool-log.sh --date 2026-06-04  Show a specific date
#   ./tools/los-omx-tool-log.sh --summary        Summarize by tool name
#   ./tools/los-omx-tool-log.sh --errors         Show only errors
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# OMX writes to the workspace root, not the los project root.
# Fall back to cwd if no workspace root found.
WORKSPACE_ROOT="$(cd "$ROOT/../.." 2>/dev/null && pwd || echo "$ROOT")"
LOG_DIR="$WORKSPACE_ROOT/.omx/logs"

date_arg=""
summary=false
errors=false

while [ $# -gt 0 ]; do
  case "$1" in
    --date) date_arg="$2"; shift 2 ;;
    --summary) summary=true; shift ;;
    --errors) errors=true; shift ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

if [ -z "$date_arg" ]; then
  date_arg=$(date +%Y-%m-%d)
fi

LOG_FILE="$LOG_DIR/omx-$date_arg.jsonl"

if [ ! -f "$LOG_FILE" ]; then
  echo "No log file for $date_arg at $LOG_FILE"
  exit 0
fi

# Extract tool events (not session_start/end)
TOOL_EVENTS=$(grep -E '"tool_(call|result|error)"' "$LOG_FILE" 2>/dev/null || true)

if [ -z "$TOOL_EVENTS" ]; then
  echo "No tool events recorded for $date_arg"
  exit 0
fi

if $errors; then
  echo "=== Tool errors for $date_arg ==="
  echo "$TOOL_EVENTS" | grep '"tool_error"' | while read -r line; do
    echo "$line" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
print(f\"  [{d.get('tool_name','?')}] {d.get('tool_use_id','?')[:20]}...  exit={d.get('exit_code','?')}  bytes={d.get('output_byte_count',0)}\")
"
  done
  exit 0
fi

if $summary; then
  echo "=== Tool summary for $date_arg ==="
  echo "$TOOL_EVENTS" | grep '"tool_result"' | python3 -c "
import sys,json
from collections import Counter
tools = Counter()
errors = Counter()
total = 0
total_duration = 0
for line in sys.stdin:
    d = json.loads(line.strip())
    name = d.get('tool_name','?')
    tools[name] += 1
    total += 1
    total_duration += d.get('duration_ms',0)
    if d.get('exit_code',0) != 0:
        errors[name] += 1
print(f'  Total tool calls: {total}')
print(f'  Total duration: {total_duration}ms')
print(f'  By tool:')
for name,count in tools.most_common():
    err = errors.get(name,0)
    print(f'    {name}: {count} calls ({err} errors)')
"
  exit 0
fi

echo "=== Tool events for $date_arg ==="
echo "$TOOL_EVENTS" | python3 -c "
import sys,json
for line in sys.stdin:
    d = json.loads(line.strip())
    event = d.get('event','')
    name = d.get('tool_name','?')
    status = d.get('status','')
    dur = d.get('duration_ms','')
    dur_str = f' {dur}ms' if dur else ''
    exc = d.get('exit_code')
    exc_str = f' exit={exc}' if exc is not None else ''
    ts = d.get('start_time','') or d.get('end_time','')
    ts_short = ts[11:19] if ts else ''
    print(f'  {ts_short}  {event:12s}  {name:10s}  {status:10s}{dur_str}{exc_str}')
"
