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

| 模块 | API 完备 | UI 完备 | 证据闭环 | 当前 |
|---|---|---|---|---|
| providers | ❌ 无 CRUD | ❌ 只读+copy-paste | ✅ compat harness | `partial` |
| evals | ✅ 读写俱全 | ❌ 无操作按钮 | ❌ 3/20 探针，无自动触发 | `partial` |
| nodes | ⚠️ `/node-commands` 缺 proxy | ✅ 完整 CRUD | ⚠️ 心跳陈旧不可见 | `partial` |
| settings | ❌ 只有 GET | ❌ 纯只读 | ❌ 无写入测试 | `partial` |

---

## 1. providers → live

### 1.1 API 完备
- [ ] **P1** `POST /providers` — 创建 provider 配置
- [ ] **P1** `PUT /providers/:id` — 更新 provider 配置（含 enabled、API key、model）
- [ ] **P1** `DELETE /providers/:id` — 删除 provider 配置
- [ ] **P2** Provider 配置持久化到 `~/.los/config.yaml`（调用 `setConfig()` 或等效写入路径）

### 1.2 UI 完备
- [ ] **P1** ProviderConfigWorkspace 表单接入 `useMutation` + `postJson`/`patchJson`，替代当前 copy-paste 片段
- [ ] **P1** Provider Endpoints 表格增加 add/edit/delete 操作按钮
- [ ] **P2** Provider Settings panel StatusPill 从 `partial` → `live`
- [ ] **P2** NAV 中 providers StatusPill 从 `partial` → `live`

### 1.3 证据闭环
- [ ] **P1** Provider CRUD 端点有集成测试（创建→读取→更新→删除 全生命周期）
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
- [ ] **P1** 页面 header 加 `StatusPill status="live"`（当前完全没有 StatusPill）
- [ ] **P1** 加 "Record Backlog Snapshot" 按钮，调用 `POST /eval-backlog/run`
- [ ] **P2** 加 "Record Eval" 表单（手动录入单条 eval）
- [ ] **P2** NAV 中 evals StatusPill 从 `partial` → `live`

### 2.3 证据闭环
- [ ] **P1** E01-E06 全部有自动化探针（当前只有 E02, E03 有，E01/E04/E05/E06 缺）
- [ ] **P1** Backlog snapshot 接入 scheduler 或 CI（每次 push 自动跑），不再纯手动
- [ ] **P2** Service-failover 自动录制 eval（当前只自动录 executor-failover）
- [ ] **P2** 探针失败时 CI 报 warn（不 block，但可见）

---

## 3. nodes → live

### 3.1 API 完备
- [ ] **P1** Vite proxy 加 `'/node-commands': 'http://127.0.0.1:8080'`（当前只有 `/nodes` 前缀）

### 3.2 UI 完备
- [ ] **P1** 表格行展示心跳陈旧度（`lastHeartbeatAt > 60s` 时灰显/标记 stale）
- [ ] **P1** 表格行展示执行候选状态（candidate + blockers），不只 inspector 里看
- [ ] **P2** 表格行展示 memory/disk pressure 警告（不只 inspector 里看）
- [ ] **P2** NAV 中 nodes StatusPill 从 `partial` → `live`

### 3.3 证据闭环
- [ ] **P1** 心跳陈旧度在 CI 测试中可验证（mock 时间）
- [ ] **P2** 执行候选状态计算有单元测试覆盖所有 blocker 类型

---

## 4. settings → live

### 4.1 API 完备
- [ ] **P1** `PATCH /settings` — 部分更新运行时配置
- [ ] **P1** 配置持久化：写入 `~/.los/config.yaml` 或等效存储
- [ ] **P2** 配置热加载：PATCH 后无需重启 gateway 即生效

### 4.2 UI 完备
- [ ] **P1** Settings 页面表单可编辑并提交（不只是只读展示）
- [ ] **P1** Provider 配置可从 settings 页面直接保存（消除 providers 页的 copy-paste）
- [ ] **P2** "Config ownership" 机制实现（不只是 UI 文案）— 至少做到确认对话框
- [ ] **P2** NAV 中 settings StatusPill 从 `partial` → `live`

### 4.3 证据闭环
- [ ] **P1** `PATCH /settings` 集成测试（修改→读取验证→重启后仍存在）
- [ ] **P2** 配置热加载测试（PATCH → 无需重启 → GET 反映新值）

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
