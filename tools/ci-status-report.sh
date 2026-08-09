#!/usr/bin/env bash
# Summarize recent Forgejo Actions job durations and PR head status.
# Usage:
#   source .env   # FORGEJO_TOKEN
#   bash tools/ci-status-report.sh            # last ~12 runs
#   bash tools/ci-status-report.sh 256        # PR number
#   bash tools/ci-status-report.sh --sha <sha>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

if [[ -z "${FORGEJO_TOKEN:-}" ]]; then
  echo "FORGEJO_TOKEN required (source .env)" >&2
  exit 1
fi

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
FORGEJO_URL="$(printf '%s\n' "$ORIGIN_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
if [[ -z "$FORGEJO_URL" || "$FORGEJO_URL" == "$ORIGIN_URL" ]]; then
  FORGEJO_URL="http://100.68.106.96:3022"
fi

auth=(-H "Authorization: token ${FORGEJO_TOKEN}")
api() { curl -fsS "${auth[@]}" "$@"; }

mode="recent"
target=""
if [[ "${1:-}" == "--sha" ]]; then
  mode="sha"
  target="${2:?sha required}"
elif [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  mode="pr"
  target="$1"
fi

python3 - "$FORGEJO_URL" "$mode" "$target" <<'PY'
import json, sys, urllib.request
from datetime import datetime
from collections import defaultdict

base, mode, target = sys.argv[1], sys.argv[2], sys.argv[3]
token = __import__("os").environ["FORGEJO_TOKEN"]

def get(path):
    req = urllib.request.Request(
        base + path,
        headers={"Authorization": f"token {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)

def dur(a, b):
    s = datetime.fromisoformat(a)
    e = datetime.fromisoformat(b)
    return (e - s).total_seconds()

print(f"Forgejo CI status report  base={base}")
print()

if mode == "pr":
    pr = get(f"/api/v1/repos/los/los/pulls/{target}")
    head = pr["head"]["sha"]
    print(f"PR #{target}  state={pr['state']} merged={pr.get('merged')} title={pr['title']}")
    print(f"  head={head}")
    print(f"  html={pr.get('html_url')}")
    st = get(f"/api/v1/repos/los/los/commits/{head}/status")
    print(f"  combined={st.get('state')}  contexts={st.get('total_count')}")
    for s in st.get("statuses") or []:
        print(f"    - {s.get('context')}: {s.get('status')}  {s.get('description')}  updated={s.get('updated_at')}")
    print()
elif mode == "sha":
    head = target
    st = get(f"/api/v1/repos/los/los/commits/{head}/status")
    print(f"SHA {head} combined={st.get('state')}")
    for s in st.get("statuses") or []:
        print(f"  - {s.get('context')}: {s.get('status')}  {s.get('description')}")
    print()

tasks = get("/api/v1/repos/los/los/actions/tasks?limit=80")
runs = defaultdict(list)
for t in tasks.get("workflow_runs") or []:
    rn = t.get("run_number")
    if rn is None:
        continue
    runs[rn].append(t)

print(f"{'run':>5} {'wall':>6}  jobs (name:min status)  title")
for rn in sorted(runs.keys(), reverse=True)[:12]:
    items = runs[rn]
    starts = [datetime.fromisoformat(t["run_started_at"]) for t in items]
    ends = [datetime.fromisoformat(t["updated_at"]) for t in items]
    wall = (max(ends) - min(starts)).total_seconds() / 60.0
    title = (items[0].get("display_title") or "")[:42]
    parts = []
    for t in sorted(items, key=lambda x: x["name"]):
        d = dur(t["run_started_at"], t["updated_at"]) / 60.0
        mark = "✓" if t["status"] == "success" else ("✗" if t["status"] == "failure" else t["status"][:1])
        parts.append(f"{t['name']}:{d:.1f}m{mark}")
    print(f"{rn:5} {wall:5.1f}m  " + " | ".join(parts))
    print(f"      {title}")

print()
print("Notes:")
print("- wall = max(end)-min(start) across jobs in the run (parallel).")
print("- Forgejo jobs/*/logs may return stale bodies; prefer commit status +")
print("  workflow failure-tail steps in .forgejo/workflows/ci.yml.")
print("- Green baseline (2026-08-09 samples): wall ~3.6–6.0m; gate-test ~3.6–4.9m;")
print("  gate-fast ~2.1–3.2m; gate-web-e2e ~1.1–1.9m; gate-drift ~0.4–1.1m.")
PY
