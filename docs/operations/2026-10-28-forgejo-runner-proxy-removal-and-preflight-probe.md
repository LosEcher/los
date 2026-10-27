---
subject: Forgejo runner job-container proxy injection removal + CI preflight probe
auditedRev: 4d28b508 (los main; the CI-side change landed in PR #385, head 1d2daff7e1)
readOnly: false
method:
  - runner host inspection (podman ps/exec, netstat, netsh on DESKTOP-R45553O)
  - job-like container probes (same image as CI jobs) — direct vs `-x` through the injected proxy
  - transfer measurement of the old probe URL
  - Forgejo API run/job read
---

# Forgejo runner job-container proxy injection removal + preflight probe

Date: 2026-10-28
Scope: the single `win-los-canary` runner (`DESKTOP-R45553O`), the runner's
`container.options`, and the four CI egress-preflight steps in
`.forgejo/workflows/ci.yml`. No los runtime, node, scheduler, or gate-rules change.

## 1. Symptom

All four CI jobs failed within ~15 s, before any gate ran. The job log of each
showed the preflight step printing its proxy and then a curl timeout:

```text
proxy=http://192.168.31.5:12081 no_proxy=localhost,127.0.0.1,::1,100.68.106.96
registry preflight failed (curl exit 28)
```

`curl exit 28` means **timeout**, not `connection refused` — which is why the
first reading ("the npm registry is unreachable from the runner") was wrong: the
pod with a proxy env var talks to the proxy first, and a proxy address the job
container cannot reach also surfaces as a timeout.

## 2. Three layers, in the order they were found

### 2.1 The runner container itself was not running

`podman ps` showed no `forgejo-runner-win-canary`; `podman ps -a` showed it
`Exited` for 8 days. Every job therefore queued and then failed at the runner
boundary. Fixed by starting it (`podman start forgejo-runner-win-canary`).

> Honest boundary: this observation was recorded at repair time and **cannot be
> re-verified now** — the container is up by design. The only durable evidence is
> this record.

### 2.2 The injected proxy address is unreachable from job containers

The runner config (`config.yaml` on the `forgejo-runner-data` volume, mounted at
`/data/config.yaml`) carried the four proxy env vars that the 2026-10-19 incident
introduced (see §5):

```text
container.options: "... --env HTTP_PROXY=http://192.168.31.5:12081
                          --env HTTPS_PROXY=http://192.168.31.5:12081
                          --env http_proxy=http://192.168.31.5:12081
                          --env https_proxy=http://192.168.31.5:12081
                          --env NO_PROXY=localhost,127.0.0.1,::1,100.68.106.96 ..."
```

Measured from a job-like container (same image as CI, `--http-proxy=false` so the
client's own env cannot contaminate the probe):

```text
--- direct
200 0.766602s
--- via12081
000 8.001294s
curl: (28) Connection timed out after 8001 milliseconds
--- host.containers.internal
10.88.0.1       host.containers.internal host.docker.internal
```

So the job containers reach the registry **directly and fast**, while the
address the injected env points them at **black-holes into a timeout**. The
Podman engine runs in a VM whose route to the Windows host is
`host.containers.internal` (`10.88.0.1`), not the host's LAN address — so a
`192.168.31.5:*` proxy target is not "the host" from inside a job container.

Host-side state at repair time (kept for the record, still present):

```text
netsh interface portproxy show v4tov4
  192.168.31.5    12081   ->  127.0.0.1    12081
netstat -ano | findstr LISTENING | findstr ":1208"
  127.0.0.1:12080  LISTENING  23900
  127.0.0.1:12081  LISTENING  23900
```

That is: the portproxy target *is* live on the host loopback, and the firewall
rule `los-proxy-12081` still allows inbound 12081. The breakage is therefore
**in the VM→host path**, not in the portproxy target — which is exactly the
`10.88.0.1` vs `192.168.31.5` distinction above.

### 2.3 Even with working egress, the probe downloaded 5.7 MB under an 8 s budget

The preflight fetched the whole `pnpm` packument to prove reachability:

```text
# before (4 sites)
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 https://registry.npmjs.org/pnpm)
```

That URL is 5,723,917 bytes. Measured direct from a job container today:

```text
pnpm-packument bytes=5723917 time=1.769082s speed=3235529B/s code=200
```

It fits *today*, at 3.2 MB/s, with 1.8 s of an 8 s budget spent on payload the
step throws away. Any slowdown below ~700 KB/s turns "is the registry reachable"
into a red step — the probe measured **throughput**, not reachability.

## 3. Changes

### 3.1 Runner `container.options` (`/data/config.yaml` on the runner volume)

```text
# before
container.options: "--volume forgejo-pnpm-store:/root/.local/share/pnpm/store --volume forgejo-turbo-cache:/root/.local/share/turbo --env HTTP_PROXY=http://192.168.31.5:12081 --env HTTPS_PROXY=http://192.168.31.5:12081 --env http_proxy=http://192.168.31.5:12081 --env https_proxy=http://192.168.31.5:12081 --env NO_PROXY=localhost,127.0.0.1,::1,100.68.106.96 --env no_proxy=localhost,127.0.0.1,::1,100.68.106.96"

# after
container.options: "--volume forgejo-pnpm-store:/root/.local/share/pnpm/store --volume forgejo-turbo-cache:/root/.local/share/turbo --env NO_PROXY=localhost,127.0.0.1,::1,100.68.106.96 --env no_proxy=localhost,127.0.0.1,::1,100.68.106.96"
```

- The four `*_PROXY` env vars are gone; the two cache volumes and both
  `NO_PROXY/no_proxy` entries stay. `NO_PROXY` is inert while no proxy is
  configured, and is kept deliberately: whoever re-introduces a proxy later must
  not also silently route the Forgejo checkout (`100.68.106.96`) through it.
- Backup: `/data/config.yaml.bak-20261028-proxy` (verified to still contain the
  four `*_PROXY` entries, so a rollback is a single copy).
- A comment recording the removal and its reason sits directly above
  `container.options` in the live config, so the next operator does not have to
  re-derive it from this document.
- **Which file is live**: `/data/config.yaml` inside the `forgejo-runner-data`
  volume (`podman exec forgejo-runner-win-canary cat /data/config.yaml`). The two
  Windows-side files `C:\Users\los\runner-config.yaml` and
  `runner-config-new.yaml` are **templates whose `options:` line is commented
  out** — verified by `findstr /c:"^  options:"` returning nothing on both. Editing
  them changes nothing about the runner; that trap costs a debugging round.

### 3.2 Preflight probe (`.forgejo/workflows/ci.yml`, 4 sites)

```text
-  https://registry.npmjs.org/pnpm      (5.7 MB, --max-time 8)
+  https://registry.npmjs.org/-/ping    (tiny,  --max-time 8)
```

Lines 78 / 200 / 333 / 418 in `.forgejo/workflows/ci.yml` at
`commit:4d28b508`. The step still prints `proxy=` and `no_proxy=` before the
probe, so a future timeout can be attributed to the proxy path without reading
the runner config.

## 4. Verification `[E]`

1. Job-like container, direct: `200` in `0.77 s` (see §2.2).
2. Job-like container through the previously injected proxy: `curl (28)` after
   8 s (see §2.2) — the same shape the failing CI logs showed.
3. Runner up and registered: `podman ps` → `forgejo-runner-win-canary Up 7 hours`.
4. CI on PR #385 (head `1d2daff7e1`, merge `4d28b508`):

```text
run 1668  failure   # pre-fix attempt
run 1669  failure   # pre-fix attempt
run 1670  success   # head after both fixes
  gate-fast      success
  gate-test      success
  gate-web-e2e   success
  gate-drift     success
```

## 5. Relationship to the 2026-10-19 repair (policy reversal, made explicit)

`docs/operations/2026-10-19-forgejo-runner-egress-repair-and-ci-timeouts.md`
introduced the proxy injection (§3.1 portproxy + §3.2 `container.options`
proxy env) because direct VM egress was then measured at ~127 KB/60 s. That
measurement no longer holds, and the injected address is not reachable from job
containers at all (§2.2) — so the injection was **withdrawn** here. The 10-19
document is annotated at its top; its other two parts stand and are still in
force:

- `Install dependencies` keeps `timeout-minutes: 8` (a stall must fail red in
  8 minutes rather than hold a runner slot);
- the portproxy + firewall rule remain installed on the host, now unused.

## 6. What this does not do

- It does **not** remove the `192.168.31.5:12081` portproxy or the
  `los-proxy-12081` firewall rule. They are now unused but still expose an
  inbound listener on the host's LAN address; deleting them is a separate
  decision (removing them would also remove the rollback path for §3.1).
- It does **not** explain *why* the VM→`192.168.31.5` path broke while the host
  loopback listener stayed healthy. What is measured: the path timeouts, the
  direct path is fast, and the VM's host address is `10.88.0.1`. If a proxy is
  ever needed again, probe **from a container** first, using
  `host.containers.internal` as the host candidate.
- It does **not** re-measure install-scale throughput. Only two shapes were
  measured: the tiny `/-/ping` probe (0.77 s) and the 5.7 MB packument
  (3.2 MB/s). `pnpm install`'s own traffic profile remains unmeasured here.
- It does **not** change runner capacity (still 2 on one device) or the
  gate-test parallelization from the 2026-10-19 follow-up.

## 7. Durable rules (the transferable part)

1. **A preflight proves reachability, not payload transfer.** If the check
   downloads a payload, its timeout budget is a throughput budget in disguise —
   `/-/ping` (or a HEAD on a known-cheap path) is the shape that survives slow
   days.
2. **A proxy env injected into job containers must be verified from inside the
   same network namespace.** With a container engine in a VM, neither `127.0.0.1`
   nor the host's LAN address necessarily means "the host"; `host.containers.internal`
   is the candidate to probe.
3. **`curl exit 28` through a proxy reads like "the destination is down".** Always
   print the effective `proxy=`/`no_proxy=` in the same step (this step already
   did, which is what made §2.2 findable) and treat a timeout as a routing
   question before a service question.
4. **When the fix is "remove an injected setting", say so in the config itself.**
   Two documents disagreeing about the same env vars is how this incident's
   cause (§5) stayed invisible: the 10-19 record still prescribed what the runner
   no longer did.
