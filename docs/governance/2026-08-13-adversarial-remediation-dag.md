# 2026-08-13 对抗审查修复 DAG

依据: `docs/governance/2026-08-13-adversarial-review-total.md`  
目标: 把审查项变成可逐条验收的任务。本文件不授权 provider promotion、公开端口或生产数据批改。

攻击者: A2 = JWT `role=user` 或只有 `LOS_AUTH_TOKEN`。

## 状态

| ID | 项 | 严重度 | 状态 |
| --- | --- | --- | --- |
| P0-01 | `/chat` 拒绝非 operator 的 `mcpServers` / `toolMode=all` / `sandboxMode` / `allowedTools` / 自定义 `workspaceRoot` | P0 | 完成(focused test) |
| P0-02 | MCP registry 写/verify/reload `requireOperator` | P0 | 完成(focused test) |
| P0-03 | `POST /todos/seed` 与 `POST /todos/:id/dispatch` `requireOperator` | P0 | 完成(focused test) |
| P0-04 | Provider CRUD `requireOperator`；响应只留 `hasApiKey` | P0 | 完成(focused test) |
| P0-05 | `spawn_agent` 钳制子 toolMode；移出只读清单与子 registry | P0 | 完成(focused test) |
| P0-06 | 节点命令 POST、file-sync scan `requireOperator` | P0/P1 | 完成(focused test) |
| P1-07 | 项目 browse/bind/delete/default `requireOperator` | P1 | 完成(focused test，未推) |
| P1-08 | `/chat` 与 todos/work-items 的 tenant/project 只信 `requestContext` | P1 | 待做 |
| P1-09 | 同簇写路由: skills/rules、memory compact/sync-md、session delete/import/claim、services drain、logs | P1 | 待做 |
| P1-10 | tool-call fallback 禁终态覆写；修 AP1 门 | P1 | 待做 |
| P1-11 | 调度 run 终态带 fence；丢租约 no-op | P1 | 待做 |
| P1-12 | chat persist / run-resume 走 `applyTodoOutcome` | P1 | 待做 |
| P1-13 | `blocked` 清 lease；agent-task 无 fence 禁写 | P1 | 待做 |
| P1-14 | session 脱敏 + visibility 读端默认 public | P1 | 待做 |
| P1-15 | query token 仅限 WS/SSE；门改 timing-safe | P1 | 待做 |
| P1-16 | 非 loopback 禁止关 auth 启动 | P1 | 待做 |
| P2-17 | `http_request` 真 SSRF；`realpath` workspace | P2 | 待做 |
| P2-18 | `needsApproval` 真排队或删 L2 in-loop 工具 | P2 | 待做 |

```text
P0-01 chat 升权门
  └─> P0-02 MCP registry
        └─> P0-05 spawn_agent 钳制

P0-03 todo dispatch
P0-04 provider CRUD
P0-06 节点命令 / file-sync
  └─> P1-07 项目 bind/browse

P1-08 身份只信 requestContext
  └─> P1-09 同簇写路由

P1-10 AP1 fallback
  └─> P1-11 调度 fence
        └─> P1-12 AP12 回写
              └─> P1-13 blocked/lease

P1-14 脱敏/可见性
P1-15 query token
P1-16 默认部署 fail-closed
P2-17 SSRF / realpath
P2-18 L2 审批
```

验收: 每条有 focused 测试；A2 对升权面得到 403；`auth.enabled=false` 时本地单用户路径不回归。
