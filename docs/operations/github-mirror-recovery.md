# GitHub Mirror Recovery

## Current Evidence

Verified from local jj remote bookmarks on 2026-07-18:

| Remote | Main head | Role |
| --- | --- | --- |
| Forgejo `origin` | `85db18b4b821` | Primary source of truth |
| GitHub `github` | `6530f16c83c4` | Secondary mirror, ahead 10 and behind 37 |

The GitHub-only commits were reviewed as patch-equivalent to changes already on
Forgejo; the remaining divergence is merge topology. Recheck this before any
repair because remote heads can change.

## Preconditions

1. Freeze mirror writes and record the full current heads with
   `jj bookmark list --all-remotes main`.
2. Fetch both remotes and verify Forgejo `origin/main` is the approved primary
   head.
3. Confirm every GitHub-only patch is present on Forgejo. Stop if any patch is
   missing; reconcile it through a Forgejo PR instead of force-updating main.
4. Obtain explicit operator approval for the GitHub `main` rewrite and any
   temporary GitHub ruleset bypass.

## Repair

Use full commit IDs in the actual command. The abbreviated IDs below are only
the evidence snapshot.

```bash
# Preserve the divergent GitHub head as a remote archive branch first.
git push github <github-main-full-sha>:refs/heads/archive/github-main-20260718

# Rewrite only when the remote still equals the reviewed old head.
git push github refs/remotes/origin/main:refs/heads/main \
  --force-with-lease=refs/heads/main:<github-main-full-sha>
```

`--force-with-lease` is required. A plain `--force` is not an acceptable repair
because it can overwrite a concurrent GitHub update that was not reviewed.

## Verification

```bash
git ls-remote github \
  refs/heads/main \
  refs/heads/archive/github-main-20260718
jj bookmark list --all-remotes main
```

The repair is complete only when GitHub `main` equals Forgejo `origin/main`, the
archive branch still points to the old GitHub head, and the next mirror run is a
fast-forward or no-op. GitHub Actions are mirror validation only; they do not
replace Forgejo required checks.

## Rollback

If the rewritten GitHub branch causes an unexpected mirror failure, restore the
archive head with another exact lease after operator approval:

```bash
git push github refs/heads/archive/github-main-20260718:refs/heads/main \
  --force-with-lease=refs/heads/main:<rewritten-main-full-sha>
```

Do not merge the divergent GitHub topology back into Forgejo to make the graphs
look alike. Forgejo remains the primary history.
