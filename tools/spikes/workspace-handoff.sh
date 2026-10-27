#!/usr/bin/env bash
# Workspace handoff spike: prove "M1 -> remote node -> M1" content identity
# before building a Workspace Lease service.
#
# This is deliberately NOT the production protocol. It has no lease, no
# fencing, no auth, and uses ssh + tar rather than the los artifact API. Its
# only job is to make the four boundaries testable on a real repo:
#   git base -> remote worktree -> patch + untracked manifest -> local rebuild
#
# Usage:
#   tools/spikes/workspace-handoff.sh --repo /path/to/git/repo --remote m3-t
#   tools/spikes/workspace-handoff.sh --repo ... --remote localnode34 --keep
#
# Exit codes: 0 all checks pass, 1 a check fails, 2 usage/setup error.
set -euo pipefail

REPO=""
REMOTE=""
REMOTE_ROOT="/tmp/los-handoff-spike-remote"
KEEP=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --remote-root) REMOTE_ROOT="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$REPO" ] && [ -n "$REMOTE" ] || usage
[ -d "$REPO/.git" ] || { echo "not a git repo: $REPO" >&2; exit 2; }
case "$REMOTE_ROOT" in
  /tmp/los-handoff-spike-*) ;;
  *) echo "refusing remote root outside /tmp/los-handoff-spike-*: $REMOTE_ROOT" >&2; exit 2 ;;
esac

LOCAL_ROOT="$(mktemp -d /tmp/los-handoff-spike-local.XXXXXX)"
cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE" "rm -rf '$REMOTE_ROOT'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[1/7] archive $(git -C "$REPO" rev-parse --short HEAD) -> $REMOTE:$REMOTE_ROOT/base"
ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE" "rm -rf '$REMOTE_ROOT'; mkdir -p '$REMOTE_ROOT/base'"
git -C "$REPO" archive HEAD | ssh -o BatchMode=yes "$REMOTE" "tar -x -C '$REMOTE_ROOT/base'"

echo "[2/7] remote baseline commit + deterministic changes"
ssh -o BatchMode=yes "$REMOTE" "set -e
cd '$REMOTE_ROOT/base'
git init -q
git config user.email spike@local
git config user.name spike
git add -A
git commit -qm base
cd '$REMOTE_ROOT'
cp -a base work
cd work
printf '\n<!-- handoff spike 2026-10-18 -->\n' >> README.md
mkdir -p spike-dir
printf 'alpha\nbeta\n' > spike-dir/note.txt
printf 'untracked payload\n' > untracked.txt
git diff --binary > '$REMOTE_ROOT/change.patch'
git ls-files --others --exclude-standard -z > '$REMOTE_ROOT/untracked.list'
tar --null -T '$REMOTE_ROOT/untracked.list' -czf '$REMOTE_ROOT/untracked.tgz'
find . -path ./.git -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > '$REMOTE_ROOT/wt.manifest'
"

echo "[3/7] pull sealed patch + untracked tar + manifest"
ssh -o BatchMode=yes "$REMOTE" "cat '$REMOTE_ROOT/change.patch'" > "$LOCAL_ROOT/change.patch"
ssh -o BatchMode=yes "$REMOTE" "cat '$REMOTE_ROOT/untracked.tgz'" > "$LOCAL_ROOT/untracked.tgz"
ssh -o BatchMode=yes "$REMOTE" "cat '$REMOTE_ROOT/wt.manifest'" > "$LOCAL_ROOT/wt.manifest"

echo "[4/7] rebuild from git base + patch + untracked"
mkdir -p "$LOCAL_ROOT/rebuild"
git -C "$REPO" archive HEAD | tar -x -C "$LOCAL_ROOT/rebuild"
git -C "$LOCAL_ROOT/rebuild" init -q
git -C "$LOCAL_ROOT/rebuild" apply --check "$LOCAL_ROOT/change.patch"
git -C "$LOCAL_ROOT/rebuild" apply "$LOCAL_ROOT/change.patch"
tar -C "$LOCAL_ROOT/rebuild" -xzf "$LOCAL_ROOT/untracked.tgz"

echo "[5/7] compare full manifest (excluding .git)"
( cd "$LOCAL_ROOT/rebuild" && find . -path ./.git -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 ) > "$LOCAL_ROOT/rebuild.manifest"
if ! diff -u "$LOCAL_ROOT/wt.manifest" "$LOCAL_ROOT/rebuild.manifest" > "$LOCAL_ROOT/manifest.diff"; then
  echo "FAIL: manifest mismatch" >&2
  head -40 "$LOCAL_ROOT/manifest.diff" >&2
  exit 1
fi
echo "PASS: manifest match ($(wc -l < "$LOCAL_ROOT/wt.manifest") files)"

echo "[6/7] negative control: corrupt patch must be rejected"
cp "$LOCAL_ROOT/change.patch" "$LOCAL_ROOT/change.patch.corrupt"
printf '\ncorrupt\n' >> "$LOCAL_ROOT/change.patch.corrupt"
if git -C "$LOCAL_ROOT/rebuild" apply --check "$LOCAL_ROOT/change.patch.corrupt" >/dev/null 2>&1; then
  echo "FAIL: corrupt patch was accepted" >&2
  exit 1
fi
echo "PASS: corrupt patch rejected"

echo "[7/7] evidence"
echo "repo=$(git -C "$REPO" rev-parse HEAD)"
echo "remote=$REMOTE"
echo "patch_bytes=$(wc -c < "$LOCAL_ROOT/change.patch")"
echo "untracked_bytes=$(wc -c < "$LOCAL_ROOT/untracked.tgz")"
echo "local_root=$LOCAL_ROOT"
if [ "$KEEP" -eq 1 ]; then echo "remote_root=$REMOTE_ROOT (kept)"; fi
