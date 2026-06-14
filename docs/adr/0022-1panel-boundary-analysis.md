# ADR 0022: 1Panel Boundary Analysis

## Status

Proposed.

## Background

Oracle executor recovery involved manually stopping 1Panel-managed containers
to free memory. This raises the question of what role 1Panel should play
alongside `los` on resource-constrained nodes.

## Current State

On Oracle (`168.107.1.16`), 1Panel manages:
- Docker containers (non-LOS services)
- PostgreSQL (potentially used by LOS)
- Web terminal access
- Application marketplace

The Oracle recovery stopped these containers to free ~300MB for the executor
process. They were not restarted.

## Decision

LOS will **not** replace 1Panel as a general server management panel.

LOS will own these LOS-specific operations:

1. Node health (`/health` + heartbeat)
2. Executor status, drain, promote, restart
3. Resource preflight (RAM, swap, disk, PSI)
4. Log summary (journald for the executor unit)
5. Artifact and evidence transfer
6. Deployment coordination (sync, install, verify)

LOS will **not** try to replace:

1. Docker container lifecycle management
2. Application marketplace installation
3. Web terminal access
4. Full server resource monitoring dashboard
5. PostgreSQL server management
6. Non-LOS service supervision

## 1Panel Coexistence

On nodes where 1Panel is present:

1. LOS executor runs as a systemd unit, not a 1Panel-managed container.
2. LOS firewall rules (`los-firewall.sh`) are additive to existing iptables rules.
3. `deploy-to-remote.sh` preflight checks for resource pressure but does not
   stop non-LOS containers by default. Stopping containers requires explicit
   confirmation.
4. LOS may consume PostgreSQL managed by 1Panel, but does not manage the
   PostgreSQL server itself.

## Migration Path

If a node eventually drops 1Panel, LOS needs:

1. Tailscale for mesh connectivity (already required)
2. PostgreSQL reachable via Tailscale or local socket
3. systemd for executor lifecycle (already implemented)
4. No other LOS dependencies on 1Panel

The analysis confirms that LOS has no hard dependency on 1Panel today.

## Non-Goals

1. Do not build a Docker management UI in LOS.
2. Do not replicate 1Panel's application marketplace.
3. Do not implement a web terminal in LOS.
4. Do not automatically restart non-LOS containers after recovery.
