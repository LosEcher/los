# Forgejo Runner Topology And Turbo Cache Persistence (2026-08-18)

Operational record. The los Forgejo CI runs on **exactly one runner, on one
device**, with per-job containers; the turbo cache directory was **never
persisted across jobs** (only the pnpm store is); the fix (a second persisted
named volume) and the merge/split ("合分") criteria for device→runner mapping
follow from the los node-mesh model (ADRs 0008/0009/0010) and the DSH harness
worker-isolation plan (`agent-worker-process-isolation`).

## Topology (verified 2026-08-18)

One device → one Podman VM → one act_runner process → three logical queues:

```
DESKTOP-R45553O (Windows; AMD Ryzen 7 PRO 8845HS 8c/16t, 79.8 GiB RAM;
                 Tailscale 100.90.170.58, LAN 192.168.31.5)
└─ Podman machine "podman-machine-default" (WSL backend, 8 vCPU)
   └─ container forgejo-runner-win-canary  (data.forgejo.org/forgejo/runner:12,
                                            restart=unless-stopped)
      ├─ act_runner v12.13.2, capacity 2, ephemeral: false
      ├─ cmd: forgejo-runner --config /data/config.yaml daemon
      ├─ volume forgejo-runner-data → /data   (config.yaml + .runner registration)
      ├─ /run/podman/podman.sock → /var/run/docker.sock  (root; container-admin
      │   authority inside the VM — keep the runner repo-scoped, per the
      │   2026-07-17 runner doc's trust caveat)
      └─ labels: [win-ci, win-ci-jj, win-ci-playwright]  (3 queues on one runner)
```

Evidence:

- Forgejo API `GET /api/v1/repos/los/los/actions/runners` returns a **single**
  runner `win-los-canary` (id 7, v12.13.2, labels `[win-ci win-ci-jj
  win-ci-playwright]`, ephemeral false).
- Every job runs in a **fresh ephemeral container**. The container hostnames
  seen in job logs (`7ea1d7104bec`, `2a3ce7d244d5`, …) are per-job container
  IDs, not hosts — an earlier analysis pass mistook them for multiple hosts.
- `win-ci-jj` was never multiple hosts; the apparent "multiple runners" is the
  combination of 3 labels (3 queues), capacity 2 (2 slots), and per-job
  container hostnames.

## Root cause: turbo cache never persisted

The runner's `config.yaml` persists only the pnpm store, as a podman **named
volume** (the 2026-07-17 doc's `/home/z/...` bind-mount text predates a later
switch to named volumes):

```yaml
container:
  options: "--volume forgejo-pnpm-store:/root/.local/share/pnpm/store"
  valid_volumes: [forgejo-pnpm-store]
```

`TURBO_CACHE_DIR=/root/.local/share/turbo` (set in `.forgejo/workflows/ci.yml`
since B1, 2026-08-16) falls in the ephemeral job container filesystem and is
wiped after every job. Empirical proof (PR #293 runs):

- run 775: gate summary `turbo: {cached: 0, total: 16}`, observe step
  `entries: 16` (cold write inside the container);
- run 776 with identical file contents: `turbo: {cached: 0, total: 16}`,
  `entries: 16` — a shared volume would have shown ≥32 entries and ≥16 hits.

Therefore the 2.2–2.8m gate-fast measured on runs 646–657 was the **no-cache**
value (TURBO_CONCURRENCY=4 + path-gating), not a warm-cache value. The B1
assumption that `~/.local/share` was fully persisted was wrong: only the
pnpm-store sub-path is. The gate-summary `turbo` block and the
`observe-turbo-cache.sh` step added in PR #293 are what made this diagnosable
across runs — the mechanical-verification investment paid off immediately.

## Fix (implemented 2026-08-18)

Persist the turbo cache as a second named volume, mirroring the pnpm-store
mechanism (no host bind paths to maintain):

1. `podman volume create forgejo-turbo-cache` (on the runner host, inside the
   Podman VM).
2. `config.yaml`:
   - `container.options` → `--volume forgejo-pnpm-store:/root/.local/share/pnpm/store --volume forgejo-turbo-cache:/root/.local/share/turbo`
   - `valid_volumes` → `[forgejo-pnpm-store, forgejo-turbo-cache]`
3. Backup kept at `/data/config.yaml.bak-20260818-turbo`.
4. `podman restart forgejo-runner-win-canary` (with no jobs in flight).

Expected effect: the first run after the change cold-writes the volume; the
following run with unchanged package content hits (`gate summary turbo.cached
> 0`), and gate-fast drops toward ~2m warm (typecheck ~15–20s + security ~35s
+ structure ~20s + install).

## Verification (2026-08-18, live)

- PR #295 gate-fast (first run after the fix): `turbo: {cached: 0, total: 16}`
  — the expected cold write, in 3m17s.
- Host-side volume inspection right after that run:
  `podman run --rm -v forgejo-turbo-cache:/cache --entrypoint /bin/sh
  data.forgejo.org/forgejo/runner:12 -c "ls /cache | wc -l"` → **48 files**
  (16 tasks × manifest/meta/tar.zst) — the entries survive the job container's
  teardown. Persistence proven.
- The follow-up run on the same PR head (identical package content) is the
  acceptance signal: gate summary `turbo.cached` must be > 0.

## Merge/split criteria (one device = one runner, unless an isolation boundary)

**Merge is the default.** One device = one mesh node = one runner process;
labels are capabilities (ADR 0010 separates node kind / connectivity /
capability / verification), capacity is the device's concurrency budget,
queueing is a scheduling concern. The harness `agent-worker-process-isolation`
note states the same principle: a process boundary is an isolation boundary,
not a per-task-type convenience (one worker = one failure domain; pooled
workers require separate evidence).

**Split (multiple runner processes on one device) is justified only at a real
isolation boundary:**

| # | Boundary | Why one process cannot express it |
|---|---|---|
| 1 | Trust/privilege | The runner holds root + podman.sock ("container-administration authority", 2026-07-17 doc). Privileged jobs (deploy, image build, VM-level tests) must not share a process/credential with jobs that execute untrusted PR code |
| 2 | Executor heterogeneity | act_runner uses one executor mode per process (docker/host) and one OS/arch per label scheme. Mixed execution environments (Linux containers + Windows native + GPU passthrough) need separate processes |
| 3 | Capacity/queue isolation ("fast lane") | capacity is process-global; a 9-minute gate-test occupies slots and delays gate-fast (observed queueing, run 585 in the 08-09 doc). Reserving a fixed slot for a class of jobs requires a separate process (Forgejo has no per-label capacity) |
| 4 | Failure domain | One crashed/misconfigured runner takes down all three queues. Per-class processes contain the blast radius |
| 5 | Credential scope | repo-scoped vs org-scoped tokens, per-job-type secrets — separate processes when credential sets must not mix |
| 6 | Network/egress policy | internet-facing vs offline/air-gapped jobs cannot be distinguished inside one process |

Decision rule: same device ∧ same trust domain ∧ same executor ∧ same
credentials ∧ same network policy → **merge** (1 process + labels + capacity);
crossing any boundary → **split**.

## Treatment path (mesh + harness alignment)

- **Near term (done, this change):** persist the turbo cache on the runner
  volume; keep the machine-verified gate-summary `turbo` block as the
  acceptance signal (`cached > 0`).
- **Mid term (mesh-ify the runner):** `DESKTOP-R45553O` is already on the los
  fleet P1 track (nssm/WinSW service-ification, todo 58108d31). Model the
  runner as a mesh node: labels = capabilities reported to the node registry,
  probe-verified (ADR 0010 `verified` face); one runner service per device;
  multi-device = same-capability devices share labels for horizontal capacity,
  different-capability devices get distinct labels for capability routing;
  cross-device cache sharing via a hub-side shared cache (turbo remote cache
  or a Forgejo cache server) on top of per-device local volumes.
- **Long term (harness worker alignment):** one execution worker per device;
  process division follows execution world / trust domain (P3 Landlock
  semantics), not job class; capacity guarantees are expressed with quotas and
  queues, not with process counts.

## Rollback

```bash
podman exec forgejo-runner-win-canary sh -c "cp /data/config.yaml.bak-20260818-turbo /data/config.yaml"
podman restart forgejo-runner-win-canary
podman volume rm forgejo-turbo-cache   # optional, after restart
```
