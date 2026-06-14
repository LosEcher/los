# Transfer Pilot Runbook

This runbook defines the small-batch transfer pilot used before changing the
main `needSort/sort/d` recovery path.

## Goals

- Validate one alternative path at a time.
- Keep pilot logs and manifests separate from the active queue.
- Avoid broad temporary-file creation.
- Clean remote partials after success, timeout, disconnect, or command failure.
- Promote a path only after repeated small-batch evidence.

## Safety Boundaries

- Do not stop or modify the active direct queue for a pilot.
- Do not use large buckets for first validation.
- Do not delete remote paths unless they are scoped under the current `RUN_ID`.
- Do not write into shared relay staging roots without a `RUN_ID` prefix.
- Do not overwrite a target file unless `ALLOW_OVERWRITE=1` is explicitly set.

Pilot temp roots:

- Local evidence: `state/transfer-pilot/<RUN_ID>/`
- Relay temp: `/tmp/rclonemana-pilot/<RUN_ID>/`
- 34 temp: `/rclone-hub/.rclonemana-pilot/<RUN_ID>/`
- HH temp, only if needed: `/tmp/rclonemana-pilot/<RUN_ID>/`

## Current Entry Point

Use:

```bash
bash ./scripts/run_transfer_pilot.sh probe
```

This records:

- `plan.json`
- `attempts.jsonl`
- one log file per probe step
- `stdout.log`
- `stderr.log`
- `cleanup.log`

The default `probe` mode does not copy files.

For a single-file relay pilot, use an explicit missing file path:

```bash
RUN_ID=pilot-YYYYMMDD-HHMMSS \
bash ./scripts/run_transfer_pilot.sh relay-one needSort sort/d/<bucket> '<relative-missing-file>'
```

The `relay-one` mode refreshes the bucket manifest before and after the copy,
copies the pre/post sidecars into the pilot evidence directory, stages the file
through the relay, verifies sizes at each hop, and removes run-scoped temp files.

## Candidate Selection

Start with non-active failed buckets that have very few missing files:

- 1 file: `J5`, `45`, `55`, `7L`
- 2 files: `GW`, `DZ`, `HA`, `QS`, `W6`
- 4 files: `BV`, `FE`, `JQ`

Avoid active buckets and large buckets such as `YK`, `BX`, `6P`, `JK`, `KQ`,
or `C5` until the pilot passes smaller cases.

## Verification Gates

Run these gates for each pilot:

1. Probe gate:
   - MBP can reach `34:22`.
   - MBP can reach HH Tailscale or public SSH endpoint.
   - MBP can reach relay SSH endpoint.
   - Relay has enough `/tmp` space for the selected file.
   - 34 has enough `/rclone-hub` space.
   - Relay can reach HH.
   - 34 can reach relay.

2. Transfer gate:
   - Source size is recorded before copy.
   - Relay staged size equals source size.
   - 34 temp size equals source size.
   - 34 final size equals source size.

3. Manifest gate:
   - `manifest_before` is captured.
   - `manifest_after` is captured.
   - The selected file no longer appears in the after missing list.
   - If a bucket reaches `missing_files=0`, run the existing compare/reconcile
     gate before marking it closed.

4. Cleanup gate:
   - `/tmp/rclonemana-pilot/<RUN_ID>` is absent on relay after completion.
   - `/rclone-hub/.rclonemana-pilot/<RUN_ID>` is absent on 34 after completion.
   - Any HH temp path under `/tmp/rclonemana-pilot/<RUN_ID>` is absent.
   - No new `.relay.tmp`, `.chunked.tmp`, `.partial`, or `.rsync-partial-*`
     files are left by the pilot.

## Timeout And Disconnect Handling

Pilot commands use bounded connect and transfer timeouts:

- `CONNECT_TIMEOUT_SECS=5` by default.
- `TRANSFER_TIMEOUT_SECS=180` by default.

On timeout or disconnect:

- Keep local evidence under `state/transfer-pilot/<RUN_ID>/`.
- Remove run-scoped remote temp roots.
- Do not retry automatically in broad loops.
- Classify the failure from `attempts.jsonl` and the step log before retrying.

## Promotion Criteria

Do not add a pilot path to the active queue until it passes:

- 1 probe-only run.
- 1 single-file run.
- 1 small-bucket run.
- 3 to 5 small-bucket runs with no remote temp residue.

Promotion requires:

- Evidence in `attempts.jsonl`.
- Pre/post manifest snapshots.
- Cleanup proof.
- Failure reasons that are specific enough to route later retries.
- No conflict with `state/needSort.sort.d.bucket.runner.lock`.

## Cleanup Commands

For a specific pilot run:

```bash
RUN_ID=<run_id> bash ./scripts/run_transfer_pilot.sh cleanup
```

For older non-pilot transfer artifacts, keep using the existing cleanup helper:

```bash
bash ./scripts/cleanup_sync_artifacts.sh --dry-run
```

Use `--apply` only after reviewing the dry-run output.
