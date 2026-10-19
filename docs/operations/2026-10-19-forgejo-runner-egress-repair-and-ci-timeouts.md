---
subject: Forgejo runner egress repair + CI install timeouts
auditedRev: ace51e14 (los main at batch start, 2026-10-19)
readOnly: false
method:
  - runner host inspection (podman ps/exec/logs on DESKTOP-R45553O)
  - container-level registry/Forgejo probes
  - Forgejo commit status + job logs
  - ci-status-report metrics JSONL
---

# Forgejo runner egress repair + CI install timeouts

Date: 2026-10-19
Scope: the single `win-los-canary` runner (DESKTOP-R45553O) and the four CI
jobs. No los runtime, node, or scheduler change.

## 1. Acceptance criteria (written before the repair)

### H1 — Job containers can reach the registry

- A fresh job-like container resolves and fetches
  `https://registry.npmjs.org/pnpm` through the configured proxy (HTTP 200).
- A fresh job-like container reaches Forgejo directly (no proxy) for
  `http://100.68.106.96:3022/los/los.git`; it must not get a proxy 502.
- The runner itself declares successfully and polls.

### H2 — CI fails fast on install stalls

- Every `Install dependencies` step has `timeout-minutes: 8`, so a registry/
  proxy stall turns into a red step within 8 minutes instead of occupying a
  runner slot until the job timeout.
- Existing job timeouts remain: gate-fast 15m, gate-test 40m, gate-web-e2e
  10m, gate-drift 10m.

### H3 — The green path is proven end to end

- A PR head after the fix completes gate-fast/gate-test/gate-web-e2e/
  gate-drift green; the run is appended to
  `.los-runtime/ci-metrics/runs.jsonl`.
- The previous stuck runs (815/816) remain visible as anomalies, not erased.

### H4 — No silent infra dependency

- The repair is recorded here: Windows portproxy + firewall, runner
  `container.options` proxy/no_proxy, and the runner container's rootful/
  host-network/privileged invocation.

## 2. Symptom and root cause

Runs 815/816 hung: gate-fast was cancelled after ~16m, gate-test occupied a
slot for 21+ minutes at `pnpm install --frozen-lockfile --prefer-offline`
(CPU 2%), gate-web-e2e waited. `ci-health-check.sh` reported
`STUCK run 815: wall=27m`.

Container-level diagnosis:

- The Podman engine injects
  `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:12080` into job containers.
- Port 12080 listens on the **Windows host loopback** only. Inside the Podman
  VM and job containers, `127.0.0.1:12080` is a different network namespace,
  so `proxyconnect ... connection refused`.
- The job container's DNS/egress then failed (`getent hosts
  registry.npmjs.org` → `DNS_FAIL`), and pnpm waited on network.
- Forgejo checkout also went through the broken proxy, producing
  `502 Bad Gateway` on `http://100.68.106.96:3022/los/los.git` (run 817).

Direct VM egress without a proxy was extremely slow (~127 KB/60s), so simply
unsetting the proxy is not a fix.

## 3. Fix (host-side)

1. **Windows portproxy**: expose the proxy on a VM-reachable address:
   ```text
   netsh interface portproxy add v4tov4 \
     listenaddress=192.168.31.5 listenport=12081 \
     connectaddress=127.0.0.1 connectport=12080
   netsh advfirewall firewall add rule name=los-proxy-12081 dir=in \
     action=allow protocol=TCP localport=12081
   ```
2. **Runner job-container env** in `/opt/.../config.yaml` (`container.options`):
   ```text
   --env HTTP_PROXY=http://192.168.31.5:12081
   --env HTTPS_PROXY=http://192.168.31.5:12081
   --env http_proxy=http://192.168.31.5:12081
   --env https_proxy=http://192.168.31.5:12081
   --env NO_PROXY=localhost,127.0.0.1,::1,100.68.106.96
   --env no_proxy=localhost,127.0.0.1,::1,100.68.106.96
   ```
   Both cases matter: git honors `no_proxy`; Forgejo's IP must bypass the
   proxy or checkout gets 502.
3. **Runner container** (rootful Podman):
   ```text
   podman run -d --name forgejo-runner-win-canary --restart unless-stopped \
     --network host --privileged --user root \
     -e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= \
     -v forgejo-runner-data:/data \
     -v /run/podman/podman.sock:/var/run/docker.sock \
     data.forgejo.org/forgejo/runner:12 \
     /bin/forgejo-runner --config /data/config.yaml daemon
   ```
   The runner itself needs no proxy (Forgejo is local); job containers get the
   proxy from `container.options`.
4. **CI install bound**: `.forgejo/workflows/ci.yml` adds
   `timeout-minutes: 8` to all four `Install dependencies` steps.

Backups: `/tmp/runner-config.yaml.bak` locally,
`/data/config.yaml.bak-20260818-turbo` on the old config, plus the new
`container.options` change recorded here.

## 4. Verification `[E]`

Container probes (rootful Podman, same env as job containers):

```text
registry.npmjs.org/pnpm -> HTTP 200 (via 192.168.31.5:12081)
git ls-remote http://100.68.106.96:3022/los/los.git -> reaches Forgejo
  (auth prompt; no 502)
runner log: "declared successfully" / "[poller] launched"
```

End-to-end CI:

```text
run 817 (before no_proxy): all jobs failed in ~0.3m with Forgejo 502
run 818 (after fix):
  gate-fast     2.22m  success
  gate-test    10.15m  success
  gate-web-e2e  1.63m  success
  gate-drift    0.48m  success
  wall         10.15m  success
```

`ci-status-report --trend 5` now shows the incident instead of an empty
ledger:

```text
run 816: 53.9m  (stuck)
run 815: 26.6m  (stuck)
run 818: 10.15m (green)
```

## 5. What this does not do

- It does **not** add a second runner; capacity is still 2 on one device. A
  hung gate-test can still delay gate-web-e2e, but the 8-minute install bound
  stops the indefinite hang.
- It does **not** remove the manual dependency on the Windows portproxy and
  firewall rule. A host reboot/app update can drop either; the container
  probe above is the revalidation command.
- It does **not** schedule `ci-status-report`; the ledger is populated
  manually today. A periodic recorder remains a follow-up.
- It does **not** change los runtime, nodes, or the B2 canary.

## 6. Adversarial review

- **"Restart the runner" was not enough**: the first restart registered the
  runner but jobs still failed in 8s. The observable cause was the Forgejo 502
  from the proxy, which is why the fix includes `no_proxy` for
  `100.68.106.96`, not just a proxy address.
- **Busybox `wget` ignores `no_proxy`**: the wget probe still showed 502 even
  when git succeeded. The acceptance probe for Forgejo is `git ls-remote`, not
  wget; documented so the next operator does not chase a false negative.
- **Metrics ledger is manual**: `ci-status-report` appended 12 runs and shows
  815/816 as anomalies, but nothing schedules it. Treated as a follow-up, not
  a green claim.
- **Single runner capacity**: this incident is an egress failure, but the
  existing 08-09/08-18 analyses still say capacity 2 is the queueing
  bottleneck. This batch does not change that; it only prevents an install
  stall from consuming a slot for 20+ minutes.
