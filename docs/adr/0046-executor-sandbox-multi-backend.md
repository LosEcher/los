# ADR 0046: Executor Sandbox Multi-Backend Abstraction

## Status

**Superseded by ADR 0047** (2026-10-10).

This ADR proposed a `SandboxBackend` interface (process / docker / firecracker).
It was never implemented and is **not** to be started: isolation backends are owned
by `docs/adr/0047-tool-project-and-provider-boundary-ownership.md` §5 and the
`config.isolation.backend` enum (`auto | jj-workspace | git-worktree | docker`).
The `SandboxBackend` interface described below is retained for history only; the
docker backend, if ever built, is a `sandbox-run` delegation under 0047, not a
second interface here.

## Context

Kimi's KAOS (Kimi Agent Operating System) provides a unified sandbox abstraction with multiple backends: BoxLite (lightweight), E2B (cloud sandbox), and Sprites (custom). los currently has a single executor model: the gateway dispatches tasks to executor nodes via HTTP or SSH, and the executor runs with filesystem-level isolation (`sandboxMode: 'readonly' | 'workspace-write' | 'sandbox'`).

The current `sandboxMode: sandbox` is aspirational — no actual container/VM isolation is enforced. A multi-backend sandbox abstraction would:
1. Define a `SandboxBackend` interface
2. Implement concrete backends (Docker, Firecracker microVM, local process)
3. Route tasks to backends based on risk profile

## Decision

1. **SandboxBackend interface**:
```typescript
interface SandboxBackend {
  readonly id: string;
  readonly capabilities: SandboxCapability[];
  create(input: SandboxCreateInput): Promise<SandboxInstance>;
}

interface SandboxCreateInput {
  image: string;           // docker image or VM template
  workspacePath: string;   // mounted workspace
  networkPolicy: 'none' | 'loopback' | 'restricted' | 'full';
  resourceLimits: { cpu: string; memory: string; disk: string };
  timeout: number;         // max lifetime in seconds
}

interface SandboxInstance {
  readonly id: string;
  execute(command: string, opts?: ExecOpts): Promise<ExecResult>;
  snapshot(): Promise<string>; // for fork/resume
  destroy(): Promise<void>;
}
```

2. **Three backends (in priority order)**:

| Backend | Runtime | Isolation | Use Case |
|---------|---------|-----------|----------|
| `process` | Local child_process | None (current) | Read-only audit tasks |
| `docker` | Docker container | Container | Project-write execution |
| `firecracker` | Firecracker microVM | VM-level | Untrusted code, sandbox |

3. **Selection logic**: `resolveSandboxBackend(sandboxMode, toolMode, riskProfile)`:
   - `read-only` → `process` (minimum overhead)
   - `project-write` → `docker` (container isolation)
   - `sandbox` → `firecracker` (VM isolation)
   - Overridable per provider/executor node configuration

4. **Integration**: `packages/agent/src/sandbox/` with backend implementations in separate files.

## Consequences

**Positive**: True isolation for sandbox mode. Fork/resume via Firecracker snapshots (inspired by AgentEnv).

**Negative**: Docker/Firecracker dependency for higher isolation levels. Added infrastructure complexity.

**Risk**: Performance overhead of container/VM startup. Mitigation: warm pool of pre-created instances, snapshot-based resume.

## References

- Kimi KAOS (AgentEnv + BoxLite + E2B + Sprites)
- Cocoon microVM design patterns (`docs/research/2026-07-11-cocoon-microvm-design-patterns-for-los.md`)
- `packages/agent/src/loop/types.ts` — AgentRunConfig.sandboxMode
