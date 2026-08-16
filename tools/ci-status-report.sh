#!/usr/bin/env bash
# Summarize recent Forgejo Actions job durations and PR head status.
#
# Usage:
#   source .env   # FORGEJO_TOKEN
#   bash tools/ci-status-report.sh            # last ~12 runs (and record to JSONL)
#   bash tools/ci-status-report.sh 256        # PR number
#   bash tools/ci-status-report.sh --sha <sha>
#   bash tools/ci-status-report.sh --trend 30 # trend stats from recorded JSONL (no API)
#   bash tools/ci-status-report.sh --no-record
#
# Every default run appends run-level wall + per-job durations to a JSONL
# metrics file (LOS_CI_METRICS_FILE, default .los-runtime/ci-metrics/runs.jsonl)
# so cross-run trend/regression analysis does not depend on the Forgejo
# job-log API (which returns stale/wrong bodies, observed 2026-08-09 PR #256).
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

MODE="recent"
TARGET=""
RECORD=1
TREND_DAYS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha)
      MODE="sha"
      TARGET="${2:?sha required}"
      shift 2
      ;;
    --trend)
      MODE="trend"
      TREND_DAYS="${2:-30}"
      shift 2
      ;;
    --no-record)
      RECORD=0
      shift
      ;;
    --record)
      RECORD=1
      shift
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MODE="pr"
        TARGET="$1"
        shift
      else
        echo "unknown argument: $1" >&2
        exit 2
      fi
      ;;
  esac
done

METRICS_FILE="${LOS_CI_METRICS_FILE:-$ROOT/.los-runtime/ci-metrics/runs.jsonl}"

FORGEJO_URL="$FORGEJO_URL" MODE="$MODE" TARGET="$TARGET" \
FORGEJO_TOKEN="$FORGEJO_TOKEN" RECORD="$RECORD" TREND_DAYS="$TREND_DAYS" \
METRICS_FILE="$METRICS_FILE" python3 - "$MODE" <<'PY'
import json, os, sys
from datetime import datetime
from collections import defaultdict

base = os.environ["FORGEJO_URL"]
mode = sys.argv[1]
target = os.environ["TARGET"]
token = os.environ["FORGEJO_TOKEN"]
metrics_file = os.environ["METRICS_FILE"]

def get(path):
    import urllib.request
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

if mode == "trend":
    days = int(os.environ["TREND_DAYS"] or 30)
    rows = []
    if os.path.exists(metrics_file):
        with open(metrics_file, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    cutoff = datetime.now().timestamp() - days * 86400
    rows = [r for r in rows if r.get("ts_epoch", 0) >= cutoff]
    if not rows:
        print(f"No recorded runs in the last {days} days in {metrics_file}")
        print("Run without --trend to populate the metrics file.")
        sys.exit(0)
    walls = sorted(r["wall_min"] for r in rows)
    n = len(walls)
    med = walls[n // 2] if n % 2 else (walls[n // 2 - 1] + walls[n // 2]) / 2
    mean = sum(walls) / n
    print(f"CI trend (last {days} days, {n} runs, {rows[0]['ts'][:10]} .. {rows[-1]['ts'][:10]}):")
    print(f"  wall (min): median={med:.1f}  mean={mean:.1f}  min={walls[0]:.1f}  max={walls[-1]:.1f}")
    # job-level medians and failure rates
    job_stats = defaultdict(lambda: {"mins": [], "fail": 0, "ok": 0})
    for r in rows:
        for jname, j in (r.get("jobs") or {}).items():
            st = job_stats[jname]
            st["mins"].append(j.get("min"))
            if j.get("status") == "failure":
                st["fail"] += 1
            else:
                st["ok"] += 1
    print("  job (median min / failure rate):")
    for jname in sorted(job_stats):
        st = job_stats[jname]
        jm = sorted(st["mins"])
        m = jm[len(jm) // 2] if jm else 0.0
        tot = st["fail"] + st["ok"]
        rate = f"{st['fail'] / tot * 100:.0f}%" if tot else "n/a"
        print(f"    {jname:16s} {m:5.1f}m   fail {rate} ({st['fail']}/{tot})")
    anomalies = [r for r in rows if r["wall_min"] > 15]
    if anomalies:
        print("  anomalies (wall > 15m):")
        for r in anomalies[-10:]:
            print(f"    run {r['run_number']}: {r['wall_min']:.0f}m  {r.get('title', '')[:60]}")
    else:
        print("  anomalies (wall > 15m): none")
    print()
    print("  NOTE: run-level JSONL at " + metrics_file)
    sys.exit(0)

if mode in ("pr", "sha"):
    sys.exit(0)

# -- recent mode: fetch and print, then record to JSONL --
tasks = get("/api/v1/repos/los/los/actions/tasks?limit=80")
runs = defaultdict(list)
for t in tasks.get("workflow_runs") or []:
    rn = t.get("run_number")
    if rn is None:
        continue
    runs[rn].append(t)

print(f"{'run':>5} {'wall':>6}  jobs (name:min status)  title")
new_rows = []
for rn in sorted(runs.keys(), reverse=True)[:12]:
    items = runs[rn]
    starts = [datetime.fromisoformat(t["run_started_at"]) for t in items]
    ends = [datetime.fromisoformat(t["updated_at"]) for t in items]
    wall = (max(ends) - min(starts)).total_seconds() / 60.0
    title = (items[0].get("display_title") or "")[:42]
    parts = []
    jobs = {}
    for t in sorted(items, key=lambda x: x["name"]):
        d = dur(t["run_started_at"], t["updated_at"]) / 60.0
        mark = "✓" if t["status"] == "success" else ("✗" if t["status"] == "failure" else t["status"][:1])
        parts.append(f"{t['name']}:{d:.1f}m{mark}")
        jobs[t["name"]] = {"min": round(d, 2), "status": t["status"]}
    print(f"{rn:5} {wall:5.1f}m  " + " | ".join(parts))
    print(f"      {title}")
    new_rows.append({
        "ts": items[0]["run_started_at"],
        "ts_epoch": int(min(starts).timestamp()),
        "run_number": rn,
        "event": items[0].get("event"),
        "title": items[0].get("display_title") or "",
        "wall_min": round(wall, 2),
        "jobs": jobs,
    })

print()
print("Notes:")
print("- wall = max(end)-min(start) across jobs in the run (parallel).")
print("- Forgejo jobs/*/logs may return stale bodies; prefer commit status +")
print("  workflow failure-tail steps in .forgejo/workflows/ci.yml.")
print("- Green baseline (2026-08-09 samples): wall ~3.6–6.0m; gate-test ~3.6–4.9m;")
print("  gate-fast ~2.1–3.2m; gate-web-e2e ~1.1–1.9m; gate-drift ~0.4–1.1m.")
print("- Trend: bash tools/ci-status-report.sh --trend 30")

if os.environ.get("RECORD", "1") == "1":
    os.makedirs(os.path.dirname(metrics_file), exist_ok=True)
    seen = set()
    if os.path.exists(metrics_file):
        with open(metrics_file, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    seen.add(json.loads(line)["run_number"])
                except (json.JSONDecodeError, KeyError):
                    continue
    appended = 0
    with open(metrics_file, "a", encoding="utf-8") as fh:
        for row in new_rows:
            if row["run_number"] not in seen:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                appended += 1
    print(f"metrics: appended {appended} run(s) to {metrics_file}")
PY
