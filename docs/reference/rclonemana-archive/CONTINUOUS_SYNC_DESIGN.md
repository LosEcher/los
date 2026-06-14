# Controlled Multipath And Continuous Sync Design

This document defines the adjustment plan for transfer optimization after the
current HH -> 34 recovery work. It intentionally avoids MRC/RoCE-style protocol
changes. The local problem is not a missing transport primitive; it is fragile
source reads, intermittent SSH/SFTP resets, partial files, and the need to
prove closure with manifests.

## Decision

Use controlled application-level multiplexing, not infrastructure-level MRC.

- Keep the active `needSort/sort/d` bucket runner single-owner and
  manifest-closed.
- Add opt-in rclone profiles for future folder syncs.
- Add a separate incremental queue for source-folder changes after the initial
  migration converges.
- Promote any wider transfer path only through the existing pilot gate.

## Current Boundaries

The current migration tail has different needs from future continuous sync:

- Current tail recovery closes historical mismatches and partial files. It must
  prioritize correctness and cleanup over throughput.
- Future continuous sync handles new or changed source files. It should avoid
  broad recursive retries and move only stable deltas.
- Reconcile work is not transfer work. `missing_files=0` with
  `target-smaller`, `size-match`, or `hh-error` still needs compare/reconcile
  handling before closure.

## Transfer Profiles

Add explicit profiles to `scripts/hh_to_34_via_mbp_rclone.sh` later. The
default must remain conservative.

| Profile | Intended use | Transfers | Checkers | Notes |
| --- | --- | ---: | ---: | --- |
| `safe` | fragile HH reads, active recovery, unknown folder health | 1 | 1 | Current default behavior |
| `balanced` | healthy window, small/medium stable deltas | 2 | 2-4 | Enable only after probe and clean recent logs |
| `large-file` | one or few large files already classified as stable | 1 | 1-2 | May test rclone multi-thread streams through pilot |
| `scan-only` | dry inventory and changed-file planning | 0 | 2-4 | No writes; useful for manifest generation |

Promotion rule:

1. Start with `safe`.
2. Run a probe-only pass.
3. Run one small bounded transfer.
4. Verify manifest and cleanup.
5. Only then try `balanced` for that same folder class.

Do not make profile changes while `state/needSort.sort.d.bucket.runner.lock`
exists unless the change is documentation-only or a separate non-conflicting
pilot.

## Incremental Sync State Model

Future source-folder sync should be manifest-driven. Avoid using process
existence or command success alone as the truth surface.

Suggested state files:

- `state/incremental/<folder>.source.manifest.tsv`
- `state/incremental/<folder>.target.manifest.tsv`
- `state/incremental/<folder>.delta.tsv`
- `state/incremental/<folder>.queue.tsv`
- `state/incremental/<folder>.attempts.jsonl`
- `state/incremental/<folder>.status.json`

Manifest fields:

```text
path<TAB>size<TAB>mtime<TAB>kind<TAB>scan_id
```

Queue fields:

```text
id<TAB>folder<TAB>path<TAB>size<TAB>mtime<TAB>state<TAB>attempts<TAB>last_error
```

States:

- `discovered`: found in source manifest.
- `settling`: waiting for size/mtime to remain stable.
- `ready`: stable enough to transfer.
- `transferring`: currently owned by a runner.
- `verifying`: transfer command ended; compare is still pending.
- `done`: source and target match.
- `retry`: transient transfer failure.
- `cooldown`: repeated transport or source-read failure.
- `reconcile`: target exists but differs, or delete/rename needs policy.

## Stable-File Gate

A source path may enter `ready` only when one of these is true:

- Two consecutive scans show the same size and mtime.
- The path has not changed for a configured settle window.
- The path is manually selected for a pilot run with explicit expected size.

Default settle window:

- small files: 2 scans
- large files: 15 minutes without size movement
- actively changing app/cache folders: require manual allowlist or longer
  folder-specific settle windows

## Continuous Runner Design

Use one owner per folder by default. Add controlled multiplexing only across
independent folders or independent settled files.

Runner loop:

1. Acquire `state/incremental/<folder>.runner.lock`.
2. Refresh source manifest with bounded scan rules.
3. Refresh target manifest when needed, not after every file.
4. Build delta.
5. Move stable deltas to `ready`.
6. Transfer ready items using the selected profile.
7. Verify by size/manifest compare.
8. Write `attempts.jsonl` and update `status.json`.
9. Move repeated failures to `cooldown` or `reconcile`.

Concurrency rules:

- Default one active transfer per folder.
- Allow at most two active folders in `balanced` mode.
- Do not run broad tree sync and per-file reconcile on the same folder at the
  same time.
- Do not parallelize relay staging unless each worker has a unique run-scoped
  temp root and cleanup proof.

## Delete And Rename Policy

Continuous sync should not immediately delete target files.

- Treat missing-from-source paths as `tombstone` candidates.
- Keep tombstones in `reconcile` until a retention window passes.
- Enable real delete only with an explicit `APPLY_DELETES=1` style gate.
- Use rclone `--track-renames` only after a folder has a clean manifest baseline
  and no active recovery queue.

## Health Gates

Before widening concurrency, require a clean recent health window:

- HH SSH master is running or direct probe is healthy.
- No repeated `closed-by-peer`, `banner-timeout`, or `rc=143/255` failures in
  the latest runner slice.
- Free space checks pass on 34 and any relay stage root.
- No active lock conflicts with the target folder.
- Recent transfer attempts left no `.tmp`, `.partial`,
  `.rsync-partial-rclonemana`, `.relay.tmp`, or run-scoped staging residue.

If any gate fails, fall back to `safe` or move the item to `cooldown`.

## Task Plan

### T0: Protect The Current Tail

- [ ] Keep `needSort/sort/d` bucket runner single-owner while it is active.
- [ ] Continue reporting progress from status files plus live process evidence.
- [ ] Do not change default transfer concurrency for active recovery scripts.

### T1: Add Profile Surface

- [ ] Add `RCLONEMANA_SYNC_PROFILE=safe|balanced|large-file|scan-only`.
- [ ] Render profile values in `plan`, `check`, and `sync` modes.
- [ ] Keep default equal to today's `TRANSFERS=1 CHECKERS=1`.
- [ ] Add profile evidence to status/log output.

### T2: Build Incremental Manifest Planner

- [ ] Add a scanner that writes source and target manifest TSV files.
- [ ] Add a delta builder that classifies added, changed, missing, and same
      paths.
- [ ] Add settle-window logic before queueing files as `ready`.
- [ ] Add dry-run output for review before any transfer.

### T3: Build Continuous Queue Runner

- [ ] Add per-folder lock and `attempts.jsonl`.
- [ ] Transfer only `ready` items.
- [ ] Verify each item before marking `done`.
- [ ] Move repeated failures to `cooldown`.
- [ ] Move target-size/content mismatches to `reconcile`.

### T4: Add Deletion/Rename Governance

- [ ] Add tombstone file generation for source-missing paths.
- [ ] Add retention-window checks.
- [ ] Require explicit apply gate for deletes.
- [ ] Evaluate `--track-renames` only after clean baseline manifests exist.

### T5: Pilot Controlled Multiplexing

- [ ] Run profile `safe` probe.
- [ ] Run one small-folder or single-file pilot.
- [ ] Verify manifest, size, and cleanup.
- [ ] Try `balanced` only on the same folder class.
- [ ] Record promotion or rejection in the runbook.

## Stop Conditions

Stop widening concurrency when any of these appears:

- queue done count stops increasing while failures rise
- repeated `target-smaller` after apparently successful transfer
- source scans hang or regress into `hh-error`
- temp residue remains after a run
- active locks overlap for the same folder

The correct response is to shrink to `safe`, classify the failure, and resume
from the manifest queue rather than retrying the whole tree.
