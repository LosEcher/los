# 跨项目手工验证报告

> 2026-06-29 | 阶段 0 | 安全守则：仅只读操作，不改代码

## 测试环境

| 项目 | 路径 | git HEAD | 工作树 | branch |
|------|------|----------|--------|--------|
| los | `projects/los` | `957b5f9` | dirty (19 files) | main (detected) |
| pi | `projects/pi` | `304f42d` | clean | `los-local` |

- Gateway: 127.0.0.1:8080, 运行正常 (uptime >35h)
- Auth: enabled, token `test-token-123`
- Governance jobs: 13 active, 全部 closed, 无运行中 sweep
- CBM: 全部功能禁用（符合安全守则）

---

## 验证 1：项目绑定

**操作**：
```bash
POST /projects/bind { projectId: "pi", displayName: "pi", workspacePath: "/.../projects/pi" }
```

**结果**：✅ 成功
- 绑定写入 `~/.los/projects.json`
- `GET /projects/pi` 返回正确信息

---

## 验证 2：workspaceRoot 覆盖 + 只读操作

**操作**：
```bash
POST /chat {
  workspaceRoot: "/.../projects/pi",
  prompt: "Read the README.md and tell me what this project does",
  toolMode: "read-only", maxLoops: 2
}
```

**结果**：✅ 成功

完整 trace 记录：
1. **Turn 1**: Agent 调用了 `read_file("README.md")` — 文件路径在 pi 目录下 ✅
2. **Turn 2**: Agent 返回了准确的 pi 项目总结
   - 正确识别为 "Pi Agent Harness monorepo"
   - 列出了 4 个 packages: agent, ai, coding-agent, tui
   - 识别了关键特性: self-extensible, multi-provider, supply-chain hardened

观察：
- `workspaceRoot: "/Users/.../projects/pi"` — 正确 ✅
- `projectId: "unknown"` — 因为未传 `x-project-id` header ⚠️
- `toolMode: "read-only"` — 正确限制工具集 (10个只读工具) ✅
- provider: deepseek-v4-flash, 2 turns, 1936 tokens

---

## 验证 3：projectId 传播

**操作**：带 `x-project-id: pi` header 的 chat 请求

**结果**：✅ Header 传播生效，session 记录 `projectId: "pi"`

**无 header 时**：`projectId: "unknown"` ⚠️

**结论**：projectId 不会从 `workspaceRoot` 自动反查绑定。`workspaceRoot → projectId` 的反向查找链路不存在。

---

## 验证 4：阻塞点确认

### 4.1 Spec loader 硬编码 — 确认

`spec-loader.ts:35`：
```typescript
const WORKSPACE_ROOT = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
```

`loadAllSpecs()` 不接受参数，始终从 los 源码树加载。即使 pi 有 `.los/spec/overview.md`，也不会被加载。

**影响**：外部项目的 spec 上下文在 system prompt 中缺失。Agent 对 pi 没有架构级别的理解。

### 4.2 CBM projectName 硬编码 — 确认

`cbm-client.ts:270-274`：
```typescript
static projectName(): string {
  return 'Users-echerlos-projects-los-workspace-projects-los';
}
```

CBM 配置全部禁用，但即使启用，也只能查询 los 的 KG，无法查询 pi。

### 4.3 Gateway 默认 workspace 硬编码 — 确认

`server.ts:75-76`：
```typescript
const DEFAULT_WORKSPACE_ROOT = resolve(__dirname, '../../..');
```

不传 `workspaceRoot` 时默认永远是 los 目录。

### 4.4 Todo 种子硬编码 — 确认

`todos.ts`：`seedLosPlanningTodos()` 始终播种 los 内置种子。

---

## 验证 5：Identity 加载

pi 下创建了 `.los/identity/default/IDENTITY.md` + `SOUL.md`。

`identity-loader.ts` 以 `workspaceRoot` 为参数正确解析。pi 的身份文件会被发现。但 session events 中未暴露 identity 信息，无法从 API 层面确认是否实际注入到 system prompt 中。

**推断**：身份加载链 `<workspaceRoot>/.los/identity/<name>/` 已支持，应该生效，但缺少直接可观测的证据。

---

## 验证 6：工具执行边界

| 工具 | read-only mode | 行为 |
|------|---------------|------|
| read_file | ✅ | 在 pi 目录下正确读取 |
| list_directory | ✅ | 可用但未调用 |
| search_content | ✅ | 可用但未调用 |
| write_file | ❌ 未暴露 | 正确被 toolMode 过滤 |

工具注册的 path safety gating 以 `workspaceRoot` 为边界，pi 操作正常。

---

## 总结表

| 验证项 | 结果 | 备注 |
|--------|------|------|
| 项目绑定 | ✅ 通过 | API + 文件持久化 |
| workspaceRoot 覆盖 | ✅ 通过 | 文件操作在正确目录 |
| 只读模式 | ✅ 通过 | 工具集正确限制 |
| Agent 对外部项目的理解 | ✅ 通过 | 正确读取和总结了 pi |
| projectId 自动映射 | ⚠️ 缺失 | 需手传 x-project-id header |
| Spec 上下文 | ❌ 阻塞 | 硬编码，始终加载 los spec |
| CBM 上下文 | ❌ 阻塞 | projectName 硬编码 |
| Gateway 默认 workspace | ❌ 阻塞 | 硬编码为 los 路径 |
| Identity 加载 | ⚠️ 未确认 | 机制存在但无 API 可观测证据 |
| Todo 种子 | ❌ 阻塞 | los 内置种子，无外部加载机制 |
| Governance sweep | ✅ 安全 | 全部空闲，无并发冲突 |
| Auth | ✅ 正常 | token 认证通过 |

---

## 确认的 4 个硬阻塞

与计划分析一致，全部确认存在：

1. `spec-loader.ts` — `WORKSPACE_ROOT` 硬编码为 `resolve(__dirname, '../../..') `
2. `cbm-client.ts` — `projectName()` 返回固定字符串
3. `server.ts` — `DEFAULT_WORKSPACE_ROOT` 硬编码
4. `todos.ts` — `seedLosPlanningTodos()` 无外部种子参数

## 新增发现

5. **projectId 不从 workspaceRoot 反查** — `workspaceRoot: "/path/to/pi"` 不会自动设置 `projectId: "pi"`，必须手传 `x-project-id` header。需要添加反向查找链路（从 workspaceRoot → project binding）。

---

## 下一步

进入阶段 1：解开 4 个硬阻塞 + projectId 反向查找。
