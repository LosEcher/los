# Node Identity Baseline

Date: 2026-06-01

## Observation

The local executor process was listening on `127.0.0.1:8090` on the MBP, but it
reported `nodeId=node34` because the local `.env` had:

```txt
EXECUTOR_NODE_ID=node34
```

That mixed two truth surfaces:

1. `node34` as the historical executor id for the MBP-local executor.
2. `localnode34` / `192.168.31.34` as a LAN VM reachable over SSH.

Verified surfaces:

```txt
curl http://127.0.0.1:8090/health
```

returned the new local executor id after correction:

```json
{
  "nodeId": "mbp-executor-1",
  "publicUrl": "http://127.0.0.1:8090",
  "nodeKind": "executor"
}
```

The VM SSH target was verified separately:

```txt
ssh -G localnode34
ssh -o BatchMode=yes -o ConnectTimeout=5 localnode34 hostname
```

Evidence:

```txt
localnode34 -> z@192.168.31.34:22
hostname -> z-Standard-PC-Q35-ICH9-2009
```

## Action

1. Drained the old `node34` executor record.
2. Stopped the previous MBP-local executor process.
3. Changed local `.env` to:

```txt
EXECUTOR_NODE_ID=mbp-executor-1
```

4. Restarted the local executor.
5. Registered `node34-ssh` as a non-executor SSH target for `localnode34`.
6. Marked the old `node34` executor record as `offline` with rollout message:

```txt
retired: local MBP executor moved to mbp-executor-1
```

## Result

Current `/nodes` identity split:

| node id | kind | host | status | execution candidate |
| --- | --- | --- | --- | --- |
| `mbp-executor-1` | `executor` | `Echers-Mbp.local` | `online` | `true` |
| `node34-ssh` | `ssh_target` | `localnode34` | `online` | `false` |
| `node34` | `executor` | legacy MBP record | `offline` | `false` |

The old `node34` record is retained only as a retired legacy executor record
because earlier task, artifact, and session evidence can still refer to that
node id.

## Next

If the VM should later run a real los executor, create a new executor identity:

```txt
node34-executor-1
```

Do not reuse `mbp-executor-1`, and do not reactivate the retired `node34`
executor record.
