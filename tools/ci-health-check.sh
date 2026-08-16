#!/usr/bin/env bash
# ci-health-check.sh — detect stuck / queued / failing Forgejo CI runs.
#
# Exit 0 = healthy, exit 1 = at least one anomaly (cron/launchd friendly).
# Purpose: the 2026-08-09..08-13 outage (runs 600-619, wall 24-35h each) had
# no active alerting; this script is the minimal watchdog to close that gap.
#
# Usage:
#   source .env                       # FORGEJO_TOKEN
#   bash tools/ci-health-check.sh                     # stuck/queued only
#   bash tools/ci-health-check.sh --include-failures  # + run-level failures
#   bash tools/ci-health-check.sh --wall-min 15 --queue-min 30 --recent 5
#
# Integration notes:
#   - cron:  */30 * * * * cd <repo> && bash tools/ci-health-check.sh \
#              --include-failures >/tmp/ci-health.log 2>&1 || <alert command>
#   - Alert channel: pipe non-zero exit into los IM/notification or a
#     wechat/telegram bot; output is newline-structured for easy parsing.
#   - Metrics trend: bash tools/ci-status-report.sh --trend 30
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

if [[ -z "${FORGEJO_TOKEN:-}" ]]; then
  echo "FORGEJO_TOKEN required (source .env)" >&2
  exit 2
fi

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
FORGEJO_URL="$(printf '%s\n' "$ORIGIN_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
if [[ -z "$FORGEJO_URL" || "$FORGEJO_URL" == "$ORIGIN_URL" ]]; then
  FORGEJO_URL="http://100.68.106.96:3022"
fi

WALL_MIN=15
QUEUE_MIN=30
RECENT=5
INCLUDE_FAILURES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wall-min) WALL_MIN="${2:?value required}"; shift 2 ;;
    --queue-min) QUEUE_MIN="${2:?value required}"; shift 2 ;;
    --recent) RECENT="${2:?value required}"; shift 2 ;;
    --include-failures) INCLUDE_FAILURES=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

FORGEJO_URL="$FORGEJO_URL" FORGEJO_TOKEN="$FORGEJO_TOKEN" \
WALL_MIN="$WALL_MIN" QUEUE_MIN="$QUEUE_MIN" RECENT="$RECENT" \
INCLUDE_FAILURES="$INCLUDE_FAILURES" python3 - <<'PY'
import json, os, sys
from datetime import datetime
from collections import defaultdict

base = os.environ["FORGEJO_URL"]
token = os.environ["FORGEJO_TOKEN"]
wall_min = float(os.environ["WALL_MIN"])
queue_min = float(os.environ["QUEUE_MIN"])
recent = int(os.environ["RECENT"])
include_failures = os.environ["INCLUDE_FAILURES"] == "1"

def get(path):
    import urllib.request
    req = urllib.request.Request(
        base + path,
        headers={"Authorization": f"token {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)

def iso(s):
    return datetime.fromisoformat(s)

tasks = get("/api/v1/repos/los/los/actions/tasks?limit=80")
runs = defaultdict(list)
for t in tasks.get("workflow_runs") or []:
    rn = t.get("run_number")
    if rn is None:
        continue
    runs[rn].append(t)

now = datetime.now().astimezone()
anomalies = []

# 1) stuck runs: finished runs whose wall exceeded the threshold. Scoped to
# the most recent RECENT finished runs — earlier history (runs < 620) had
# 24-48h walls as the pre-burst-runner norm and is not actionable alerting.
finished = []
for rn, items in runs.items():
    if any(t["status"] not in ("success", "failure", "cancelled", "skipped") for t in items):
        continue  # still running/queued; handled below
    starts = [iso(t["run_started_at"]) for t in items]
    ends = [iso(t["updated_at"]) for t in items]
    wall = (max(ends) - min(starts)).total_seconds() / 60.0
    title = (items[0].get("display_title") or "")[:60]
    failed = any(t["status"] == "failure" for t in items)
    finished.append((rn, wall, failed, title))

recent_finished = sorted(finished, key=lambda x: -x[0])[:recent]
for rn, wall, failed, title in recent_finished:
    if wall > wall_min:
        anomalies.append(
            f"STUCK run {rn}: wall={wall:.0f}m (> {wall_min:.0f}m) {title}"
        )

# 2) queued/stalled runs: non-terminal tasks that have been open too long.
for t in tasks.get("workflow_runs") or []:
    if t.get("status") in ("success", "failure", "cancelled", "skipped"):
        continue
    age_min = (now - iso(t["created_at"])).total_seconds() / 60.0
    if age_min > queue_min:
        anomalies.append(
            f"STALLED task {t.get('id')} ({t.get('name')} run {t.get('run_number')}): "
            f"open {age_min:.0f}m status={t.get('status')}"
        )

# 3) run-level failures over the last N finished runs (opt-in).
if include_failures:
    for rn, wall, failed, title in recent_finished:
        if failed:
            anomalies.append(f"FAILED run {rn}: wall={wall:.0f}m {title}")

if anomalies:
    print(f"CI HEALTH CHECK: {len(anomalies)} anomaly(ies) @ {now.isoformat()}")
    for a in anomalies:
        print("  " + a)
    print(f"thresholds: wall>{wall_min:.0f}m queue>{queue_min:.0f}m recent={recent}")
    sys.exit(1)

recent_finished = sorted(finished, key=lambda x: -x[0])[:recent]
summary = " | ".join(
    f"{rn}:{wall:.0f}m{'✗' if failed else '✓'}" for rn, wall, failed, _ in recent_finished
)
print(f"CI HEALTH CHECK: healthy @ {now.isoformat()}")
print(f"  recent {len(recent_finished)} finished runs: {summary or 'none'}")
sys.exit(0)
PY
