# rclonemana → vpsagentweb Migration Design

2026-05-18

## 1. Current State

### 1.1 rclonemana: What It Is

A multi-path, state-driven file migration system that transfers ~345GB from Hetzner
Singapore (HH) to a LAN NAS (192.168.31.34, "34").

| Dimension | Detail |
|-----------|--------|
| Source | `/mnt/syncthing/` on HH (Hetzner SG, TS IP 100.86.24.22) |
| Target | `/rclone-hub/` on 34 (LAN IP 192.168.31.34) |
| Total data | ~345GB across 6 folders |
| Transport | rclone SFTP, rsync, SCP — converged to scp relay as the reliable path |
| Relay | tencent-sin-p (43.156.121.2) — HH → relay → 34 |
| State model | Manifest TSV + `attempts.jsonl` + bucket-level lock files |
| Concurrency | Single-worker, size-ordered queue, one file at a time |
| Cleanup | RUN_ID-scoped temp dirs, verified before promotion |
| Script count | ~90 shell scripts, ~6 Python helpers |
| Completed | `stableDiffusionOut`, `pmfiles`, `eagle`, `pfiles/d/4P` |
| Remaining | `project` (~33GB), `needSort` (~195GB) |

### 1.2 Proven Transfer Path

```
HH (100.86.24.22:23452)
  │ SCP (relay pulls from HH using dedicated SSH key)
  ▼
tencent-sin-p (/tmp/rclonemana-pilot/<RUN_ID>/payload)
  │ SCP (34 pulls from relay on port 23452)
  ▼
34 (192.168.31.34) → /rclone-hub/<folder>/<subpath>
```

Each hop does size verification. Temp files cleaned after success.

### 1.3 Key Design Patterns Worth Preserving

**Manifest-first verification.** Before any transfer, capture source and target
manifests. Only transfer what's verifiably missing or incomplete. After transfer,
re-verify before declaring closure.

**Segmented bucket execution.** Large folders split into small subpaths (buckets
like `d/2H`, `d/AE`) processed independently. This bounds failure radius.

**Split-deeper-on-failure.** When a whole subpath fails, enumerate its children
and process them individually. Don't retry the broad path.

**Relay staging with cleanup gates.** Every transfer leaves a machine-readable
attempt record. No promotion without pre/post manifest proof and zero temp residue.

---

## 2. vpsagentweb Capability Map

### 2.1 Mesh Topology (6 nodes)

```
oracle        | 100.103.147.128  | control-plane-primary
tencent-sin   | 100.93.220.9    | control-plane-backup + mesh-gateway
vultr         | 100.93.104.96   | primary-mesh-gateway
hh-sgp1       | 100.86.24.22    | storage-and-transfer (agent online)
fly-sjc       | 100.83.129.45   | stateless-edge-candidate
fly-fra       | 100.116.86.115  | stateless-edge-candidate
```

All nodes communicate over Tailscale IPs. All have agents (hh-sgp1 connected and
healthy).

### 2.2 Existing Primitives

| Primitive | API/Mechanism | Shape |
|-----------|--------------|-------|
| Agent command exec | `TaskPayload{ID, Command, Timeout, Env, WorkingDir}` | Agent pulls via WS/poll, executes, returns exit code + stdout/stderr |
| File upload | `POST /api/v1/files` (multipart, 100MB) | Stores artifact in API, returns ID |
| File distribute | `POST /api/v1/files/{id}/distribute` | Pushes to target agents with SHA-256 verify |
| Cross-instance delivery | `CrossInstanceDeliveryService` | HTTP POST between API instances for task/message relay |
| Job tracking | `JobStore` with status/version/audit | Create → pending → running → done/failed |
| Agent heartbeat | WS ping/pong or HTTP poll | Liveness, system health, spool backlog |

### 2.3 Gap Analysis

| rclonemana capability | vpsagentweb status | Verdict |
|------------------------|-------------------|---------|
| scp/rsync between nodes | Agent can exec rsync/scp commands | Usable today via TaskPayload |
| Relay staging (A→relay→B) | No native file relay; CrossInstanceDelivery is message-level | Must build or script around |
| Manifest-driven state | Job/Operation store is task-level, not file-level | rclonemana's file-level TSV is more granular |
| Segmented bucket queue | No built-in bucket queue | Can simulate via Job per bucket |
| Size-ordered missing-file queue | No equivalent | Must keep Python helper or port to Go |
| Free-space gating | No built-in disk check | Can add as pre-task probe |
| Temp cleanup scoping | No temp scope tracking | Must manage in scripts |
| attempts.jsonl audit trail | Job attempts tracked in DB | Equivalent, but coarser granularity |

### 2.4 34 Device Assessment

- **Tailscale status:** 34 can reach Tailscale IPs (confirmed: reaches HH at
  100.86.24.22:23452). It is NOT in the vpsagentweb mesh registry.
- **Current access:** LAN-only from MBP (192.168.31.34). SSH key configured.
- **Storage layout:** `/rclone-hub/` on vdb (~400G, ~280G free), system disk
  vda (~200G, ~150G free). `/data-spill/pfiles` bind-mounted to `/rclone-hub/pfiles`.
- **SSH pull key:** `~/.ssh/id_ed25519.hh_to_34` on 34 for pulling from HH.
- **LAN fallback via Tailscale:** If 34's LAN is unreachable but Tailscale is
  online, a vps-agent on 34 would connect via Tailscale IP to the API server.
  The mesh is fully operational over Tailscale.

---

## 3. Migration Options

### Option A: Agent + Scripts (Low-Invasion, Immediate)

Install vps-agent on 34. Dispatch existing rclonemana bash scripts as agent tasks.

**Flow:**
```
Web UI / API → Create Job "sync-project" on agent 34
            → Agent on 34 executes: bash run_34_hh_pull.sh sync project ...
            → Agent reports exit code + stdout/stderr
            → Job status updated, audit log recorded
```

**What stays the same:**
- All rclonemana scripts, state files, and SSH keys on 34
- Manifest-driven transfer logic, bucket segmentation, cleanup

**What changes:**
- Trigger mechanism: manual SSH → agent task dispatch (API/Web UI)
- Visibility: `attempts.jsonl` → Job status in API DB + Web UI

**Effort:** Install agent binary on 34, configure env vars, create Job templates.
~30 minutes.

**Risk:** Low. Agent only executes commands that are already tested. SSH keys and
scripts unchanged.

### Option B: Extend File Distribution with Relay Awareness (Medium)

Add relay-aware distribution to the existing `POST /api/v1/files/{id}/distribute`:

1. **Remote-source support** — distribute can pull from a source node, not just
   from files uploaded to the API
2. **Relay chain** — `{source: "hh-sgp1", relay: "tencent-sin", target: "34"}`
3. **Chunked transfer** — resumable for large files (>100MB)

**Effort:** New API endpoints, agent-side transfer handler, relay coordination
logic. ~1-2 weeks.

**Risk:** Medium. Changes core file distribution path. Must not break existing
binary/config distribution.

### Option C: Dedicated Transfer Worker (Full Integration)

Port rclonemana's logic into a Go service within vpsagentweb:

- **Manifest engine** — source/target manifest TSV generation and diff
- **Queue runner** — per-folder lock, size-ordered processing, `attempts.jsonl`
- **Stable-file gate** — settle window before queueing
- **Relay staging** — scoped temp dirs, verified hop-by-hop
- **Tombstone governance** — delete/rename policy with retention window

This is essentially `CONTINUOUS_SYNC_DESIGN.md` implemented in Go, integrated
with the mesh control plane.

**Effort:** Multi-week. New service, new store tables, new agent protocol messages.

**Risk:** High effort for a pattern that may not recur beyond this migration.
Only justified if continuous cross-node file sync becomes a recurring product need.

---

## 4. Recommendation

### Phase 1 — Now: Option A (Agent + Scripts)

Install vps-agent on 34. Wire the existing relay queue as agent tasks.

**Steps:**
1. Build vps-agent binary for linux/amd64
2. SCP to 34, install systemd unit
3. Configure env: `AGENT_SERVER_URL=http://100.103.147.128:28080/api/v1/agent`,
   `AGENT_KEY=<shared key>`, `AGENT_ID=34-nas`
4. Create Job templates for: `run_34_hh_pull.sh`, `run_relay_queue.sh`
5. Run `project` transfer via agent task as first validation
6. If successful, proceed with `needSort` (~195GB, will need the relay queue)

**Why this first:**
- Zero changes to rclonemana's battle-tested transfer logic
- Immediate gains: Web UI visibility, job history, no more manual SSH
- Agent is ~15MB, statically linked, no runtime deps
- If anything goes wrong, fall back to manual SSH — scripts are unchanged

### Phase 2 — If Pattern Recurs: Option B

If more cross-node file sync tasks emerge (config distribution, log collection,
backup rotation), extend the File Distribution API with relay awareness.

**Trigger:** 3+ distinct use cases for node-to-node file transfer beyond the
current HH→34 migration.

### Phase 3 — Only If Continuous Sync Becomes a Product Feature: Option C

Port the manifest engine and queue runner to Go. Only justified if the sync
pattern is ongoing (not one-shot migration).

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Agent on 34 interferes with Samba/rclone-hub | Agent only executes commands when dispatched; no background FS operations. Samba and existing cron jobs unaffected. |
| Agent task slot blocked by long transfer | Set `timeout: 3600` on transfer tasks. Agent handles task lifecycle; timeout kills hung rsync. |
| 34's LAN IP not reachable from API server | Agent connects outbound via WebSocket to API — no inbound port needed. Uses Tailscale IP for connectivity. |
| `needSort` (195GB) too large for single task | Use the existing relay queue script (`run_relay_queue.sh`) which processes one file at a time with state tracking. Each file is a separate step. |
| Relay node (tencent-sin) disk pressure | Relay queue already has `MIN_RELAY_FREE_GB=2` gating. tencent-sin has agent installed and can report disk health via heartbeat. |
| HH source I/O still fragile | rclonemana's split-deeper and manifest-gate patterns handle this. Agent task just calls the same scripts. |

---

## 6. Appendix: Key rclonemana Files

| File | Purpose |
|------|---------|
| `scripts/run_transfer_pilot.sh` | Transfer pilot with probe/relay-one/cleanup modes, RUN_ID scoping |
| `scripts/run_relay_queue.sh` | Single-worker relay queue: refresh → size-sort → transfer → verify → repeat |
| `scripts/run_34_hh_pull.sh` | Direct 34→HH pull (probe/dry-run/sync), SSH master multiplexing |
| `scripts/run_34_hh_relay_file_pull.sh` | Single-file relay transfer: HH→relay→34 with size verification |
| `scripts/refresh_relay_state.py` | Fast manifest diff: what files are still missing |
| `scripts/cache_relay_sizes.py` | Cache source file sizes for queue ordering |
| `scripts/check_relay_status.sh` | Current file counts, next candidates, temp residue, free space |
| `scripts/control_34_hh_master.sh` | SSH multiplexed master connection management |
| `TRANSFER_PILOT.md` | Pilot runbook: safety boundaries, verification gates, promotion criteria |
| `CONTINUOUS_SYNC_DESIGN.md` | Future-state design: profiles, incremental sync, stable-file gate |
| `HH_TO_34_MIGRATION_NOTES.md` | Living log of all migration progress and decisions |
| `MIGRATION_RUNBOOK.md` | End-to-end execution plan and cleanup rules |
| `EXECUTION_CHECKLIST.md` | Current working commands and verified paths |

## 7. Appendix: vpsagentweb Mesh Nodes

```
oracle        TS 100.103.147.128  control-plane-primary        API :28080
tencent-sin   TS 100.93.220.9    control-plane-backup+gateway  API :28080
vultr         TS 100.93.104.96   primary-mesh-gateway          sing-box SOCKS5 :2080
hh-sgp1       TS 100.86.24.22    storage-and-transfer          agent online
fly-sjc       TS 100.83.129.45   stateless-edge-candidate      flyctl only
fly-fra       TS 100.116.86.115  stateless-edge-candidate      flyctl only
```

**34 device (target):** LAN 192.168.31.34, Tailscale installed, NOT in mesh.
SSH config alias `192.168.31.34` with key `id_ed25519.z.192.168.31.34`.
