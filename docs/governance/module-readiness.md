# Module Readiness Criteria

定义 `App.tsx` NAV 数组中 `partial` → `live` 升级的退出条件。每个条件必须可验证（自动化或人工检查）。

## 判断框架

三个维度，全部满足才能升级：

| 维度 | 含义 | 验证方式 |
|---|---|---|
| **API 完备** | 该模块需要的读写端点全部存在，Vite proxy 覆盖 | `tools/check-readiness.sh` 自动化 |
| **UI 完备** | 页面有写入/操作能力（不仅是只读展示），StatusPill 一致 | 人工 review |
| **证据闭环** | 有自动化测试/探针/CI 触发，不是纯手动 | `tools/check-readiness.sh` 自动化 |

当前状态总览：

复核时间：2026-06-19。证据来自 `packages/web/src/App.tsx`、
`packages/web/src/pages/*`、`packages/gateway/src/routes/providers/provider-routes.ts`、
`packages/gateway/src/provider-routes.test.ts`、`packages/web/vite.config.ts`
和 `bash tools/check-readiness.sh`。

| 模块 | API 完备 | UI 完备 | 证据闭环 | 当前 |
|---|---|---|---|---|
| providers | ⚠️ update/delete 已有，create 缺失 | ❌ 页面仍显示只读/copy-paste | ❌ CRUD 集成测试缺失 | `partial`（NAV 当前误标 `live`） |
| evals | ✅ 读写俱全 | ⚠️ summary/compare 可视，手动录入仍弱 | ✅ E01-E06 探针和 backlog scheduler 已有 | `live`（仍有 P2 增强项） |
| nodes | ✅ `/node-commands` proxy 已有 | ✅ 心跳/候选状态已在表格显示 | ✅ stale/candidate blocker 单测已有 | `live`（仍有资源压力展示增强项） |
| settings | ✅ `PATCH /settings` 已有 | ✅ 表单保存已接 `patchJson` | ⚠️ 运行时更新路径存在，缺专门 route round-trip 测试 | `live`（仍有 P2 热加载测试/磁盘持久化） |

---

## 1. providers → live

### 1.1 API 完备
- [x] **P1** `POST /providers` — 创建 provider 配置
- [x] **P1** `PATCH /providers/:name` — 更新 provider 配置（含 enabled、API key、model、baseUrl、weight）
- [x] **P1** `DELETE /providers/:name` — 删除 provider 配置
- [x] **P1** Provider 配置可更新到进程内运行时 config（当前通过 `setConfig()`）
- [ ] **P2** Provider 配置持久化到 `~/.los/config.yaml` 或等效 owner store

### 1.2 UI 完备
- [x] **P1** ProviderConfigWorkspace 表单接入 `useMutation` + `postJson`/`patchJson`，替代当前 copy-paste 片段
- [x] **P1** Provider Endpoints 表格增加 add/edit/delete 操作按钮
- [ ] **P2** Provider Settings panel StatusPill 从 `partial` → `live`
- [x] **P1** NAV 中 providers StatusPill 与页面内部状态对齐；当前 `App.tsx` 标 `partial`，页面 panel 标 `partial`，一致

### 1.3 证据闭环
- [x] **P1** Provider CRUD 端点有集成测试（创建→读取→更新→删除 全生命周期）
- [ ] **P2** Config 持久化 round-trip 测试（写入→重启→读取验证）

---

## 2. evals → live

### 2.1 API 完备（已满足）
- [x] `GET /run-evals` — 列表
- [x] `POST /run-evals` — 记录
- [x] `GET /run-evals/summary` — 汇总
- [x] `GET /run-evals/compare` — 对比
- [x] `POST /eval-backlog/run` — backlog 快照
- [x] `GET /eval-backlog` — backlog 列表

### 2.2 UI 完备
- [x] **P1** 页面 header 加 `StatusPill status="live"`
- [ ] **P2** 加 "Record Backlog Snapshot" 按钮，调用 `POST /eval-backlog/run`
- [ ] **P2** 加 "Record Eval" 表单（手动录入单条 eval）
- [x] **P2** NAV 中 evals StatusPill 从 `partial` → `live`

### 2.3 证据闭环
- [x] **P1** E01-E06 全部有自动化探针
- [x] **P1** Backlog snapshot 接入 scheduler
- [ ] **P2** Service-failover 自动录制 eval（当前只自动录 executor-failover）
- [ ] **P2** 探针失败时 CI 报 warn（不 block，但可见）

---

## 3. nodes → live

### 3.1 API 完备
- [x] **P1** Vite proxy 加 `'/node-commands': 'http://127.0.0.1:8080'`

### 3.2 UI 完备
- [x] **P1** 表格行展示心跳陈旧度（`lastHeartbeatAt > 60s` 时灰显/标记 stale）
- [x] **P1** 表格行展示执行候选状态（candidate + blockers），不只 inspector 里看
- [ ] **P2** 表格行展示 memory/disk pressure 警告（不只 inspector 里看）
- [x] **P2** NAV 中 nodes StatusPill 从 `partial` → `live`

### 3.3 证据闭环
- [x] **P1** 心跳陈旧度在 CI 测试中可验证（mock 时间）
- [x] **P2** 执行候选状态计算有单元测试覆盖 blocker 类型

---

## 4. settings → live

### 4.1 API 完备
- [x] **P1** `PATCH /settings` — 部分更新运行时配置
- [x] **P1** 配置运行时更新：写入进程内 config
- [ ] **P2** 配置磁盘持久化：写入 `~/.los/config.yaml` 或等效 owner store
- [ ] **P2** 配置热加载：PATCH 后无需重启 gateway 即生效

### 4.2 UI 完备
- [x] **P1** Settings 页面表单可编辑并提交（不只是只读展示）
- [ ] **P2** Provider 配置可从 settings 页面直接保存（消除 providers 页的 copy-paste）
- [ ] **P2** "Config ownership" 机制实现（不只是 UI 文案）— 至少做到确认对话框
- [x] **P2** NAV 中 settings StatusPill 从 `partial` → `live`

### 4.3 证据闭环
- [x] **P2** `PATCH /settings` 集成测试（修改→读取验证）
- [x] **P2** 配置热加载测试（PATCH → 无需重启 → GET 反映新值）
- [ ] **P2** 磁盘持久化 round-trip 测试（写入→重启→读取验证，与 P2 持久化配套）

---

## 验证命令

```bash
# 自动化检查（CI warn，不 block）
bash tools/check-readiness.sh

# 人工 review checklist
rg -n "status.*partial" packages/web/src/App.tsx
```

## 升级流程

1. 模块所有 P1 项完成
2. 运行 `check-readiness.sh` 通过
3. 改 `App.tsx` NAV 中对应模块的 `status: 'partial'` → `status: 'live'`
4. Commit message: `feat: graduate <module> from partial to live`
