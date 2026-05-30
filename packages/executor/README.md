# Executor — Go Agent for Mesh Nodes

The executor is extracted from `vpsagentweb/apps/agent/` (a production-verified Go agent).

## What it does

- Connects to the Gateway via WebSocket
- Executes shell commands on the node
- Reports health (CPU, memory, disk)
- Supports sandboxing: seccomp BPF, rlimit, WASM wazero, Docker

## How to reuse

The vpsagentweb agent is already working. To integrate:

1. **Copy the agent source**:
   ```bash
   cp -r ../vpsagentweb/apps/agent/cmd/ cmd/agent/
   cp -r ../vpsagentweb/apps/agent/internal/ internal/
   cp ../vpsagentweb/apps/agent/go.mod go.mod
   cp ../vpsagentweb/apps/agent/go.sum go.sum
   ```

2. **Adjust the Gateway URL** in config to point to your los Gateway:
   ```yaml
   # agent-config.yaml
   server_urls:
     - http://your-gateway:8080
   agent_key: your-shared-key
   ```

3. **Build and deploy to mesh nodes**:
   ```bash
   GOOS=linux GOARCH=amd64 go build -o agent cmd/agent/main.go
   scp agent root@mesh-node:/usr/local/bin/los-agent
   ssh root@mesh-node "los-agent -config /etc/los/agent-config.yaml"
   ```

4. **Enable executor in los Gateway** (in .env):
   ```env
   EXECUTOR_ENABLED=true
   EXECUTOR_AGENT_KEY=your-shared-key
   EXECUTOR_MESH_NODES=node1:8080,node2:8080
   ```

## Current status

The Go agent from vpsagentweb supports:
- ✅ SSH execution with tmux
- ✅ WebSocket heartbeat + reconnection
- ✅ seccomp BPF sandbox (90 syscall whitelist)
- ✅ rlimit (RLIMIT_AS/NOFILE/NPROC)
- ✅ WASM wazero sandbox
- ✅ Docker container isolation
- ✅ Multi-upstream failover
- ✅ Health sampling (CPU, memory, disk via /proc)

For MVP, copy directly and configure the Gateway URL.
