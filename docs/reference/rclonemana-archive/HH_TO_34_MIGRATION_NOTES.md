# HH To 34 Migration Notes

Updated: 2026-04-04

## Goal

Use `192.168.31.34` as the new storage target for data that used to participate in the HH Syncthing network, while keeping the MBP-side sync target path stable.

## Current Working Status

Observed on `2026-04-04`:

- `stableDiffusionOut` is complete
- `pmfiles` is complete
- `pfiles/d/4P` is complete
- `eagle` is now complete
- `project` is now in progress
- the remaining top-level folders after `project` are:
  - `pfiles`
  - `needSort`

Current practical interpretation:

- the old `pmfiles` residual notes are historical and should not be treated as the active queue anymore
- HH SSH reachability is healthy enough for short probes and SFTP listing
- HH full-tree manifest collection is still too slow for `check_hh_34_top_level_status.py` on the open folders
- the current working path is `hh_to_34_via_mbp_rclone.sh`

`2026-04-04 eagle` closure:

- the earlier `run-check eagle` differences were real
- the stabilized `run-sync eagle` eventually completed with a clean summary:
  - `Checks: 38954`
  - `Transferred: 174`
  - `Deleted: 61 files, 20 dirs`
  - `Elapsed time: 2h43m51s`
- the practical takeaway remains the same:
  - HH-side directory enumeration is slow, but the MBP dual-SFTP path is good enough to close a folder if left running long enough

`2026-04-04 project` start:

- `run-sync project` is now active in background `tmux` session `project_sync`
- early output already shows a real delta on 34:
  - `.spacedrive` copied as a new file

`2026-04-04 project` current reduction:

- the broad MBP dual-SFTP folder sync has effectively converged to one remaining large file:
  - `ComfyUI/models/checkpoints/chilloutmix.ckpt`
- the three reported `EditAnything/env/bin/python*` errors were source-side `file does not exist` events and are not the active blocker
- the MBP dual-SFTP path was too slow for the last `7.70G` file, so the active transfer has been switched to direct `34 <- HH` rsync with:
  - `--partial`
  - `--append-verify`
- the old rclone-created partial on 34 was promoted into the real destination file and the direct rsync path is now extending it
- active tracking:
  - tmux session: `project_bigfile_pull`
  - state log pointer: `state/project.bigfile.rsync.log`

## Confirmed On MBP

- `rclone` is installed locally
- SSH aliases already exist for both `192.168.31.34` and `hh-sgp1-r-p`
- The active LaunchAgent found so far is `~/Library/LaunchAgents/com.echerlos.rclone-logs-sync.plist`
- That LaunchAgent only syncs `~/rclone-logs` to `/Volumes/rclone-hub/_logs/rclone-logs`
- Main data sync evidence exists on 34 in `_logs/rclone-logs`, for example:
  - `mbp-project-*.log`
  - these logs show `rclone sync /Users/echerlos/syncthing/project/... /Volumes/rclone-hub/project/...`
- Existing ignore rules already live on 34:
  - `/rclone-hub/nodemap/rclone-ignore-common.rules`
  - this should remain the baseline filter set for any HH cutover involving `project` or `pmfiles`

## Confirmed On 34

- `vda` is the system disk, about `200G`, mounted on `/`
- `vdb` is the data disk, about `400G`, mounted on `/rclone-hub`
- Current free space:
  - `/`: about `150G`
  - `/rclone-hub`: about `280G`
- `pfiles` has now been spilled onto the system disk and bind-mounted back to `/rclone-hub/pfiles`
- `/etc/fstab` now contains a persistent bind entry for `/data-spill/pfiles -> /rclone-hub/pfiles`

## Confirmed On HH

Old Syncthing data still exists under `/mnt/syncthing`.

Top-level entries confirmed:

- `config`
- `needSort`
- `stableDiffusionOut`
- `pmfiles`
- `project`
- `pfiles`
- `eagle`
- `Sync`
- `mms`
- `so-vits-svc`

Syncthing config recovered from `/mnt/syncthing/config/config.xml`.

### Old Syncthing Shared Folders

- `needSort`
- `stableDiffusionOut`
- `pmfiles`
- `project`
- `pfiles`
- `eagle`

### Old Device Mapping

- `HH | Syncthing`: all six folders
- `MBP23`: `stableDiffusionOut`, `pmfiles`, `project`, `eagle`
- `Nas`: `stableDiffusionOut`, `pmfiles`, `project`, `pfiles`, `eagle`
- `Vultr`: `stableDiffusionOut`, `project`, `eagle`
- `DESKTOP-BRSDQNH`: `pmfiles`, `project`, `eagle`

## Approximate HH Folder Sizes

Recovered from Syncthing `index-v2` counts:

- `needSort`: about `195G`
- `stableDiffusionOut`: about `211M`
- `pmfiles`: about `22.35G`
- `project`: about `33.63G`
- `pfiles`: about `83.13G`
- `eagle`: about `10.96G`

## Current 34 Folder Sizes

- `/rclone-hub/needSort`: empty
- `/rclone-hub/stableDiffusionOut`: about `203M`
- `/rclone-hub/pmfiles`: about `21G`
- `/rclone-hub/project`: about `24G`
- `/rclone-hub/pfiles`: empty
- `/rclone-hub/eagle`: about `11G`

## Design Decision

Do not change MBP-side destination paths right now.

Instead:

- Keep the logical target rooted at `/rclone-hub`
- Spill `pfiles` to the system disk using a bind mount
- Leave `project`, `pmfiles`, `eagle`, `stableDiffusionOut`, `needSort` on `/rclone-hub`

This avoids rewriting existing sync scripts and Samba paths.

### Target Layout On 34

- `/rclone-hub/project` -> keep on `vdb`
- `/rclone-hub/pmfiles` -> keep on `vdb`
- `/rclone-hub/eagle` -> keep on `vdb`
- `/rclone-hub/stableDiffusionOut` -> keep on `vdb`
- `/rclone-hub/needSort` -> keep on `vdb`
- `/rclone-hub/pfiles` -> bind-mount from `/data-spill/pfiles` on `vda`

## Why `pfiles` First

- `pfiles` is large enough to matter
- `pfiles` is still empty on 34, so it is easy to relocate now
- Moving it off `/rclone-hub` frees space for later HH catch-up
- It is safer than pushing `needSort` onto the system disk

## Recommended Migration Order

1. `stableDiffusionOut`
2. `pmfiles`
3. `eagle`
4. `project`
5. `pfiles`
6. `needSort`

## Remaining Risks

- HH still has some directories outside the old six-folder set:
  - `Sync`
  - `mms`
  - `so-vits-svc`
- These need separate classification before any broad HH migration.
- `pmfiles` contains personal shell files and `.ssh`; keep the existing filter rules in any `rclone` workflow.
- Direct remote changes on 34 are currently blocked because user `z` does not have passwordless `sudo`.
- HH can still be reached over SSH from MBP, but some remote reads under `/mnt/syncthing` may hang.
- Treat HH data access as fragile I/O and avoid broad recursive scans before cutover.

## Practical Cutover Model

Phase 1: prepare storage on 34

- create `/data-spill/pfiles`
- bind-mount it onto `/rclone-hub/pfiles`
- keep Samba and all existing logical paths unchanged

Status:

- completed on 34
- verified with `findmnt`, `stat`, `df`, and `fstab`

Phase 2: verify shared folders first

- `stableDiffusionOut`
- `pmfiles`
- `eagle`
- `project`

Use `rclone check` first and only run `sync` on folders that actually differ.
Run these as individual folder actions, not one broad batch, because HH source I/O is not consistently responsive.

Phase 3: move large HH-only or partially shared folders

- `pfiles`
- `needSort`

These should be handled separately because they dominate the remaining capacity risk.

## SSH Note

- A root password has been configured on 34 as requested
- SSH is still using the default `PermitRootLogin prohibit-password`
- That means root password login over SSH is still not enabled unless `sshd` policy is changed separately

## MBP-Orchestrated Fallback

- HH does not currently have `rclone` installed
- MBP can orchestrate HH -> 34 comparison and sync using two SFTP remotes in `rclone`
- This avoids depending on HH -> 34 direct connectivity
- Helper scripts:
  - `scripts/build_temp_rclone_sftp_config.sh`
  - `scripts/hh_to_34_via_mbp_rclone.sh`

### First Sample Result

- A first MBP-orchestrated `rclone check` against `stableDiffusionOut` did reach both ends
- The first reported mismatch was `._trackPic`
- That is AppleDouble metadata, so the MBP fallback filter list was updated to exclude:
  - `**/._*`
  - `**/.AppleDouble/**`
  - `**/.Spotlight-V100/**`
- After the metadata filters were expanded, the same `stableDiffusionOut` sample no longer immediately reported the old AppleDouble mismatch
- The check still remained very slow on HH-side reads and did not complete within the interactive session window
- The fallback command set has been reduced to `--checkers 1` and `--transfers 1` for gentler folder-by-folder execution

This means the MBP fallback path is technically working, but HH-side reads are still slow enough that checks should remain one-folder-at-a-time.

## Pmfiles Top-Level File Backlog

The directory-first `pmfiles` queue excludes these top-level files for now and they should be handled separately after directory validation:

- `.gitconfig`
- `.gitignore_global`
- `.zsh_history`
- `.zshrc`
- `aliases.zsh`
- `瀚石项目管理系统.jpeg`

## 2026-03-16 StableDiffusionOut Status

- Active path is the segmented `rsync` runner, not the old `rclone check` path.
- Completed buckets so far:
  - `2H`
  - `73`
  - `CR`
  - `CZ`
  - `DY`
- These completed buckets account for `42` logged entries total (`32` regular files) and every completed sync reported `0` files transferred, so 34 already matched HH for those segments.
- Historical Syncthing index data for `stableDiffusionOut` was about `505` files total, so the current segmented run has only covered a small slice so far.
- Rough uncovered remainder is still about `463` logged entries, plus the outer metadata files that are not part of the `d/<bucket>` slices.

## Cleanup Inventory

## 2026-03-25 Status Refresh

This document's old residual examples are no longer current. The live source of truth is now:

- `state/pmfiles.split.parent.failed`
- `state/pmfiles.split.subitem.failed`
- `state/pmfiles.pv_d.bucket.failed`

Historical residual parents on `2026-03-25` were:

- `extension`
- `bmkp`
- `tyys`
- `pv`

Historical residual subitems on `2026-03-25` were:

- `tyys/svn`
- `bmkp/出租车`
- `bmkp/天兔_Usagi_driver_APP`
- `bmkp/悟空_Wukong_zebraSaaS`
- `bmkp/玉兔_Yutu_customer_APP`
- `bmkp/鹦鹉_Nuri_oversea_APP`
- `extension/aixdownloader-9.0.57`
- `bmkp/手册`
- `tyys/文档`
- `pv/d`

Important correction:

- `mdfolder/daily` should no longer be treated as residual
- the remaining issue is no longer "does 34 have these paths"
- the remaining issue is "are these paths fully converged, or did transport fail after most data already landed"

Operational implication:

- use pair probes before more retries
- avoid reusing the old broad retry loop as the default tool for the current tail set
- the first `2026-03-25` pair probe did not find any HH/34 byte-equal residual item
- current tail shape is:
  - `4` items where `34` is smaller than HH and targeted sync still makes sense
  - `5` items where HH metadata probing times out before a trustworthy size is returned
  - `1` item where HH SSH/banner negotiation itself timed out during probe

## 2026-03-25 34 Pull Path Validation

Key updates:

- fixed a local bug where the HH master `ControlPath` had been reused too broadly
- the corrected manifest probe is now `scripts/check_pmfiles_residual_manifest_status.py`
- `34` now has a dedicated pull key at `~/.ssh/id_ed25519.hh_to_34`
- `34 -> HH` SSH access is verified with `root@185.223.207.130:23452`

Current corrected manifest result:

- `manifest-match`
  - `tyys/svn`
  - `bmkp/出租车`
  - `bmkp/手册`
  - `tyys/文档`
- `target-smaller`
  - `bmkp/天兔_Usagi_driver_APP`
    - first differing child focus: `.git`
  - `bmkp/悟空_Wukong_zebraSaaS`
    - first differing child focus: `.git`
  - `bmkp/玉兔_Yutu_customer_APP`
    - first differing child focus: `.git`
    - secondary diff focus: `原型`
- `hh-error`
  - `bmkp/鹦鹉_Nuri_oversea_APP`
  - `extension/aixdownloader-9.0.57`
  - `pv/d`

Execution note:

- `bash ./scripts/run_34_hh_pull.sh probe pmfiles extension/aixdownloader-9.0.57` already succeeds
- `bash ./scripts/run_34_hh_pull.sh dry-run pmfiles 'bmkp/天兔_Usagi_driver_APP/.git'` returns a concrete delta list and is the current proof that child-level `34 pull` is the right granularity
- whole-item `34 pull` still times out intermittently, so the operational rule remains: split deeper before syncing

## 2026-03-25 Residual Reduction Update

Follow-up execution on the `34 pull <- HH` path reduced the live residual state again:

- cleared from failed state:
  - `bmkp/天兔_Usagi_driver_APP`
  - `bmkp/悟空_Wukong_zebraSaaS`
- both items converged after pulling their missing `.git/FETCH_HEAD` file and then re-running manifest verification

Live residual subitems are now:

- `bmkp/玉兔_Yutu_customer_APP`
- `bmkp/鹦鹉_Nuri_oversea_APP`
- `extension/aixdownloader-9.0.57`
- `pv/d`

Live residual parents are now:

- `bmkp`
- `extension`
- `pv`

Practical meaning:

- the remaining work is no longer a broad `bmkp` cleanup
- it is one unresolved `bmkp` item plus three HH-readability / bucket items

## 2026-03-25 Final Residual Closure

Final result after child-level `34 pull <- HH` fixes and bucket re-verification:

- `state/pmfiles.split.subitem.failed` is now empty
- `state/pmfiles.split.parent.failed` is now empty
- `state/pmfiles.pv_d.bucket.failed` is now absent
- `python3 ./scripts/check_pmfiles_residual_manifest_status.py` now returns `parents=0 subitems=0`

Important closure details:

- `bmkp/天兔_Usagi_driver_APP`
  - converged after pulling `.git/FETCH_HEAD`
- `bmkp/悟空_Wukong_zebraSaaS`
  - converged after pulling `.git/FETCH_HEAD`
- `bmkp/玉兔_Yutu_customer_APP`
  - converged after pulling `.git/FETCH_HEAD` and verifying top-level child sizes
- `bmkp/鹦鹉_Nuri_oversea_APP`
  - converged after pulling `.git/FETCH_HEAD` and verifying top-level child sizes
- `extension/aixdownloader-9.0.57`
  - converged by source/target top-level child-size equality
- `pv/d/AE`
  - converged by direct subtree manifest match

Operational conclusion:

- `pmfiles` should now be treated as converged in the active split-plus-bucket model
- the successful pattern for the late tail was:
  - avoid whole-item retries
  - compare manifests or top-level child sizes
  - fix only the smallest missing child, often `.git/FETCH_HEAD`

## 2026-04-02 Pfiles 4P Final Closure

`pfiles/d/4P` is now complete.

Final verified state:

- `state/pfiles__d__4P.source.files = 29`
- `state/pfiles__d__4P.target.files = 29`
- `state/pfiles__d__4P.missing.files = 0`

Accepted completion path:

- `HH -> tencent-sin-p -> 34`
- the relay path was automated into:
  - `scripts/refresh_relay_state.py`
  - `scripts/cache_relay_sizes.py`
  - `scripts/check_relay_status.sh`
  - `scripts/run_relay_queue.sh`
- the queue ran single-worker, sorted by cached source size, refreshed state after each success, and wrote machine-readable attempts to `state/pfiles__d__4P.relay.attempts.jsonl`

Final large-file closure:

- the last file `pq7...c9r` finalized on `34` at `850664639`
- after completion:
  - `34` had no `.relay.tmp`
  - relay staging had no residual `payload`
  - relay `/tmp` still had usable free space

Operational conclusion:

- direct `HH -> 34` data-plane attempts were not dependable enough for tail recovery
- relay staging through `tencent-sin-p` is the first repeatedly verified end-to-end path that closed the bucket
- the older direct `scp`, `rsyncd`, and chunked experiments should now be treated as historical troubleshooting paths rather than the primary runbook

## 2026-04-02 Vultr Readiness Check

Read-only Vultr verification can start, but cutover should not be assumed yet.

Current facts:

- `stableDiffusionOut` is already closed
- `pmfiles` is already closed
- `pfiles/d/4P` is now closed
- the older shared-folder set still does not have fresh final closure proof for `project`, `eagle`, and `needSort`

Probe result:

- `vultr-r-t` is reachable and usable for read-only checks
- current `vultr-r-t` root disk is tight:
  - `/dev/vda2 23G total / 21G used / 1.1G free / 96%`
- `vultr-z-t` currently stops at SSH host-key verification and needs explicit trust handling before use

Practical conclusion:

- start Vultr in verification mode first:
  - inventory `stableDiffusionOut`, `project`, and `eagle`
  - compare against current HH / 34 state
- do not start a Vultr cutover or use Vultr as a staging node until disk pressure and the host-key path are addressed

## 2026-03-25 Pfiles 4P Tail Status

Follow-up work moved from the public HH path to the Tailscale path:

- `34` preferred endpoint is now `100.86.24.22:23452`
- short Tailscale control-plane probes reached stable windows such as `3/3 ok` and `4/5 ok`, materially better than the earlier public-path observation

Current `4P` state:

- HH source still reports `31` files
- `34` target has advanced from `2` files to `4` files
- the two confirmed additions were the paired `._DAV/...c9r.dir` and `._DAV/...c9r.pag` items
- live remaining gap is `27` files

What was verified:

- file-at-a-time `scp` over Tailscale can make real forward progress
- it can also leave a hung `.tmp` partial on `34` when the SSH data path stalls
- `scripts/run_34_hh_scp_pull.sh` was updated to clean failed `.tmp` files

What was tried next:

- a temporary read-only `rsync daemon` on HH bound to the Tailscale address
- `34` pulled a one-file batch from `rsync://100.86.24.22:28773/...`

What that proved:

- the architecture is better because it removes SSH from the data plane
- HH temporary `rsyncd` startup succeeded
- `34` really entered the `rsync://` data path
- but the first missing `.c9r` item still stalled, leaving only rsync partial artifacts until the wrapper hard timeout fired
- skipping that first missing item with `BATCH_OFFSET=1` and targeting the next file (`1ZP...c9r`) reproduced the same stall pattern
- that second attempt created only a hidden rsync temp file at `0` bytes, then timed out and required cleanup
- this makes the current failure mode look path- or stream-level, not unique to a single missing file
- a later chunked-file experiment for `1MQ...c9r` got farther:
  HH-side preprocessing succeeded, the file was split into `52` chunks of `65536` bytes, and `34` created a resumable chunk cache path
- even then, the first chunk transfer stalled as `chunk.00000.tmp` at `0` bytes and never promoted into a completed chunk
- that result suggests the current blockage survives even after reducing the data unit from a `3.4 MiB` file to a `64 KiB` chunk
- a later relay-node experiment with `tencent-sin-p` finally completed the same file:
  the relay pulled `1MQ...c9r` from HH and verified a staged size of `3406777`
  `34` then pulled that staged file from `tencent-sin-p` and finalized the target file at the same size
- the same relay path then completed two additional payloads:
  `6T2...c9r` finalized on `34` at `54462565`
  `Ammbv0...c9r` finalized on `34` at `6382252`
- this reduced the live `4P` gap from `27` files to `24` files and is now the first repeatedly verified end-to-end success path for previously stuck `.c9r` payloads

Current operational conclusion:

- `pfiles/d/4P` was later fully closed through the relay queue path documented in the 2026-04-02 section above
- the `rsyncd` path remained useful as a design experiment, but it did not become the accepted completion path for this bucket
- the accepted practical recovery path became relay staging on `tencent-sin-p`, followed by a second pull from `34`
- `34` side should be kept clean after each attempt by removing `.tmp`, hidden rsync temp files, and `.rsync-partial-rclonemana`
- HH-side daemon cleanup should be retried with the dedicated cleanup script whenever HH control-plane SSH is available

## 2026-03-16 Pmfiles Split Decision

`pmfiles` top-level directory validation converged into:

- `16` directories already completed
- `24` directories that need a second-stage split pass

The chosen follow-up is not another broad queue. The active follow-up plan is:

1. keep the completed top-level results as-is
2. enumerate immediate child entries on HH for each failed top-level directory
3. run `dry-run -> sync` on each child entry independently
4. maintain separate split state so the original top-level findings remain intact

This second-stage path is implemented by:

- `scripts/list_hh_immediate_children.py`
- `scripts/run_pmfiles_failed_split_queue.sh`
- `scripts/submit_pmfiles_split_queue.sh`
- `scripts/check_pmfiles_split_queue_status.sh`

Keep:

- `logs/stableDiffusionOut.StableDiffusionOut__d__*.rsync.*`
- `state/stableDiffusionOut.bucket.done`
- `state/stableDiffusionOut.bucket.failed`
- `state/stableDiffusionOut.bucket.runner.log`

Archive or delete later:

- `logs/stableDiffusionOut.d__2H.rsync.*`
  - early wrong-path sample, not part of the final path model
- `logs/archive/stableDiffusionOut.rclone-check.*`
  - old dual-SFTP `rclone check` attempt
- `logs/archive/stableDiffusionOut.rsync.dry-run.failed.*`
  - obsolete whole-folder `rsync` dry-run
- `logs/archive/stableDiffusionOut.to.pmfiles.watch.log`
  - obsolete watcher path
- `state/archive/stableDiffusionOut.bucket.failed.*.bak`
  - backup of the broken nested-launchctl runner spam
- `state/archive/stableDiffusionOut.bucket.runner.log.*.bak`
  - backup of the same broken runner session

Current noisy artifact:

- `state/stableDiffusionOut.bucket.launchctl.log`
  - now only acts as the outer runner stdout/stderr sink
  - safe to rotate or truncate between runner restarts

## 2026-03-20 StableDiffusionOut Final Status

- `stableDiffusionOut` is complete
- bucket result: `44/44`
- failed buckets: `0`
- final conclusion:
  - the segmented `rsync` queue proved that 34 already matched HH for this folder
  - no real file transfer was needed during the final accepted path

## 2026-03-20 Pmfiles Residual Status

Top-level and split processing have converged to a small residual set:

- resolved top-level directories: `16`
- remaining failed parent directories: `5`
- remaining failed subitems: `12`

Current failed parent directories:

- `pv`
- `mdfolder`
- `extension`
- `bmkp`
- `tyys`

Current failed subitems:

- `pv/d`
- `tyys/svn`
- `bmkp/出租车`
- `bmkp/天兔_Usagi_driver_APP`
- `bmkp/悟空_Wukong_zebraSaaS`
- `bmkp/玉兔_Yutu_customer_APP`
- `bmkp/鹦鹉_Nuri_oversea_APP`
- `mdfolder/daily`
- `extension/aixdownloader-9.0.57`
- `bmkp/PM`
- `bmkp/手册`
- `tyys/文档`

These still appear in:

- `state/pmfiles.split.parent.failed`
- `state/pmfiles.split.subitem.failed`

## 2026-03-20 Residual Gap Assessment

The remaining `pmfiles` work is no longer broad migration. It is a small set of real gaps plus an HH-side source readability problem.

Confirmed on 34:

- spot checks confirm that multiple residual subitems are still `missing` under `/rclone-hub/pmfiles`
- confirmed missing examples include:
  - `pv/d`
  - `tyys/svn`
  - `extension/aixdownloader-9.0.57`
  - `bmkp/PM`
  - `bmkp/手册`
  - `tyys/文档`
- refresh the exact current target-side picture with:
  - `bash ./scripts/check_pmfiles_gap_summary.sh`

Confirmed on HH:

- at least part of the remaining set is now failing before data transfer
- example:
  - `bmkp/天兔_Usagi_driver_APP` can hang even on a minimal remote metadata check
  - `extension/aixdownloader-9.0.57` can hang at the first-hop `HH -> MBP staging` file-list stage
- this means the current blocker is not only SSH transport; it is also fragile or blocking source reads under `/mnt/syncthing/pmfiles`

Interpretation:

- `dry-run:transport-timeout-before-clean-finish`
  - likely heavy or fragile directories that still need another split level
- `dry-run:unknown`
  - usually kex or session setup failure before a clean directory walk
  - these are better candidates for a fresh relay retry after connection cleanup

## 2026-03-20 Next-Step Decision

Do not continue broad queue retries on `pmfiles`.

Instead:

1. treat the current `12` subitems as the exact residual gap set
2. use relay only on small residuals that can still pass a lightweight HH metadata check
3. for the heavy residuals, split one level deeper on HH before any further sync attempt
4. if HH metadata checks hang even at that deeper level, stop migration for that branch and treat it as source-side recovery work

Practical priority order:

1. `extension/aixdownloader-9.0.57`
2. `tyys/文档`
3. `bmkp/PM`
4. `bmkp/手册`
5. `pv/d`
6. `mdfolder/daily`
7. `tyys/svn`
8. the remaining `bmkp/*` directories

## 2026-03-20 Pmfiles `pv/d` Reclassified

`pv/d` is no longer treated as a single stubborn residual item.

HH successfully returned the immediate-child names under `/mnt/syncthing/pmfiles/pv/d`, so this path has been reclassified as a segmented subtree.

Recovered child buckets:

- `DR`
- `BN`
- `BM`
- `ZF`
- `NK`
- `ST`
- `RC`
- `VS`
- `IX`
- `T3`
- `OI`
- `IN`
- `AE`
- `OG`
- `R2`

This means:

- `pv/d` still belongs to the open residual set
- but its next valid handling path is bucket-level execution, not generic subitem retry

## 2026-03-22 Residual Readability Update

The remaining `pmfiles` residual set has now been compressed to `4` parent branches and `10` subitems:

- `pv/d` with only bucket `AE` still open
- `extension/aixdownloader-9.0.57`
- `tyys/svn`
- `tyys/文档`
- `bmkp/手册`
- `bmkp/出租车`
- `bmkp/天兔_Usagi_driver_APP`
- `bmkp/悟空_Wukong_zebraSaaS`
- `bmkp/玉兔_Yutu_customer_APP`
- `bmkp/鹦鹉_Nuri_oversea_APP`

Important reclassification:

- `bmkp/PM` is no longer open
  - a fresh direct `dry-run` completed with a clean summary and `0` create / `0` delete / `0` transfer
- `mdfolder/daily` is fully closed
  - its last open branch `2025` had to be split to month-level and then day-level for `2025-07`

Observed residual behavior now falls into two clearer groups:

- late-timeout but readable
  - example: `bmkp/玉兔_Yutu_customer_APP`
  - whole-tree `dry-run` can traverse deeply and expose real entries like `.git`, `README.md`, `UI设计图`, `需求文档`, `原型`
  - but it still times out before a clean summary
- early-hang / zero-log
  - examples: `bmkp/鹦鹉_Nuri_oversea_APP`, `bmkp/手册`, `tyys/文档`, `extension/aixdownloader-9.0.57`
  - these can establish the SSH/tunnel path but still produce no `rsync` log output within the first 30-60s
  - this strongly suggests HH source-side directory-read blocking, not only transport instability

Operational implication:

- do not keep broad background retries on these remaining paths
- prefer short classification probes, then stop quickly if they remain zero-log
- only continue deep splitting on branches that have already shown readable structure, like `pv/d` and `bmkp/玉兔_Yutu_customer_APP`
