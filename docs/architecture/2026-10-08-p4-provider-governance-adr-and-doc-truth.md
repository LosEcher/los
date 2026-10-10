# P4 设计：provider 治理复活 + ADR 处置批 + 文档状态绑定提交号

- **状态**：设计（待评审）
- **归属**：los 侧为主（provider/契约/ADR/docs）；L4-3 含**跨仓一致性**
- **批次**：P4
- **依据**：2026-10-08 盘点 B2/B3/B21/B22/B23 + §10（ADR 判定）+ §5.3（文档漂移 D1–D7）
- **前置**：无。但 L4-3 的规则一旦落地，P1/P2/P3 的新文档必须从一开始就遵守

---

## 1. 问题陈述（有数字）

### 1.1 provider 配置只写内存，重启即丢（B2）

实测调用链：`provider-crud-routes.ts:112,132,144`、`infrastructure/settings-routes.ts:121`、`provider-model-sync-routes.ts:131` **全部只调 `setConfig()`**，而 `packages/infra/src/config.ts:375-377` 就是：

```ts
export function setConfig(config: Config): void {
  _config = config;
}
```

⇒ `POST/PATCH/DELETE /providers`、`PATCH /settings`、`models/sync applyModel` **全都只在进程内存生效**。而 `loadConfig()` 是 7 层合并（system `/etc/los/config.yaml` → user `~/.los/config.yaml` → `.env` → 进程环境 → provider auto-discovery → CLI overrides），**没有任何写回层**。

后果：
- "改了就生效"是假象（重启即丢）；
- 多进程（gateway + executor + 常驻 job）配置不一致；
- `models/sync` 这个**唯一的模型清单同步入口**即便被调用，结果也活不过一次重启 —— 等于该能力事实上不存在。

### 1.2 自动更新能力极不对称，且证据面停摆（B3）

| 面 | 实测 |
| --- | --- |
| 凭证自动刷新 | **只有 `kimi` / `xai`**（`providers/registry.ts:16-24` 只为这两个注册 credentialResolver）；其余全部静态 `apiKey` |
| 模型清单同步 | **零自动化**：唯一入口 `POST /providers/:name/models/sync`（operator 鉴权、除路由与测试**零调用方**、无 UI/CLI/job）；`GET /v1/models` **不是上游代理**，只是本地名单（`owned_by:los`）；无 `models.json` 缓存；`modelAliases` 全硬编码（packycode 手写 10 个）；18 类 governance job **无** provider/model 同步类 |
| provider/tool 热重载 | **ADR 0045 未实现**（全仓零 `fs.watch`/`chokidar`/`providerConfigVersion`/`toolRegistryVersion`；G10 open） |
| compat 证据 | `provider_compat_evidence` **26 行，末条 2026-07-19**，全部 `verified_advisory` ⇒ **停更 80 天** |
| 晋升决策 | `provider_promotion_decisions` **0 行** ⇒ ADR 0017 的阶梯事实上停摆 |
| 最终成熟度 | `required` 只剩 **`deepseek:deepseek-v4-flash`** 一个 merge gate |
| 运行时用量对照 | 近 7 天只有 deepseek 1372 次（0 错）+ kimi 11 次（0 错，末次 10-05）；`provider_accounts` **只有 1 行**（xai active），kimi/packycode 都无 account 行 |

而 P1 已实证：DSH 真实流量 **590/596 走 `deepseek-official` 直连**，los gateway 几乎不经手 ⇒ **provider 治理面既没被跑、也没被用**。

### 1.3 端点能力面：读接口零消费者，写接口与声明不一致（B21/B22/B23）

- `los mcp serve` 暴露 4 个工具（`los_run` / `los_run_state` / `los_run_replay` / `los_operator_control`）—— **零消费者**（架构文档 I-3）。
- `/v1/chat/completions` **硬编码** `toolMode:'read-only'` + `persistMemory:false`（`openai-compat-route.ts:209,217`），调用方**无法提权**（设计如此，但没在文档里写成产品限制）。
- CLI `--help` **遗漏 4 个已 dispatch 的命令**（`auth` / `memory` / `scan` / `cbm`：`cli/src/index.ts:82,118,130,134` vs `help.ts` 131 行内 0 命中）。
- `mcp_servers` 唯一一行 `cantool.smoke.local`：**`enabled=false` 却 `status=connected`**，61 tools 中 7 个 `local_private` 因 `data_grant_forwarding_unavailable` 判 `availability:blocked` ⇒ **申报与可用不一致**。

### 1.4 四个 ADR 长期 Proposed，其中一个与既有决策直接矛盾（§10）

| ADR | 状态 | 问题 |
| --- | --- | --- |
| 0038 Web-first 日常编码产品边界 | Accepted | **需修订**：采用未成立（30 天 1022 task_run 零代码改造类；首个 E3 案例 10-06） |
| 0039 Pi 内核 | Accepted + status | 已落地（默认只暴露 LOS；K4 真跑过）；**planning canary 因 phase=planning 与 plan-approved 冲突延期**未登记为待办 |
| 0043 health-aware | Accepted（09-01 追加熔断） | 已接线且有防孤立边界测试；**只需清编号残留**（0043/0045/0046 的 "Numbering conflict" 段是 08-26 去重后残留；**0042 实测无该段**）+ 修 `provider-selection.ts:30` 的 "(ADR 0031)" |
| **0042** declarative flow DSL | **Proposed** | 无消费点证据；与 run-contract plan 数组的关系未定 |
| **0044** ACP endpoint | **Proposed** | **与 gap G14 直接矛盾**（G14：ACP 是 rejected/intentional，los-mcp 是唯一程序化接口）——**必须二选一** |
| **0045** provider/tool hot reload | **Proposed** | 未实现，且被 `2026-08-08-configure-surface-p0-p1-design.md:95` 列为 **Non-Goals** |
| **0046** sandbox multi-backend | **Proposed** | 未实现 + **命名碰撞**：`resolveSandboxBackend`（`shell-sandbox.ts:132`）只是 **OS 级**后端选择器，**无 container/VM**；ADR 要求的 docker/firecracker 不存在 |

### 1.5 文档状态与代码状态系统性脱节（D1–D7）

| # | 漂移（实测） |
| --- | --- |
| D1 | 10-06 架构缺口清单 **P0 行未回填 ✅**（只 P0-1/5/7 有标记），`:218` 仍写"待办即 P0-1…P0-6"，而 10-07 closeout 已宣告 **"P0 全清"** |
| D2 | 架构文档代码行号漂移 **13–25 行**（`:174` 引 `openai-compat-route.ts:60,74`，实测 `/v1/models` 在 `:73`、`/v1/chat/completions` 在 `:87`；硬编码值 `:209,217`） |
| D3 | ADR 0043/0044/0045/0046 仍带"编号冲突"提示（2026-08-26 已去重）；架构文档 `:145` 说"0042–0046 都声称"，**实测 0042 无该段**（`grep -c`：0042=0，0043-0046=1） |
| D4 | P1-8「40 契约里 22 个零引用」与独立复核不一致（basename grep 得 **6/40**）⇒ 判据需重放 |
| D5 | gap G10 把 hot reload ADR 记作 **"ADR 0033"**，实为 **0045** |
| D6 | 2026-06-21 架构基线仍列已移除的 `@los/input-preprocessor`（2026-07-05 移除） |
| D7 | `scheduler/provider-selection.ts:30` 注释仍写 "(ADR 0031)"，应为 **0043** |
| 附 | `tools/wiring-topology-baseline.txt` 实测 **396 行**（文档记 384）⇒ 豁免在**扩张**，与"逐步收紧"反向 |

**根因**：文档的"状态段"是**自由文本**，与 VCS 无机械绑定 ⇒ 任何"只读文档判断状态"的流程（含 agent 自己）都会系统性出错。这正是 AGENTS.md 那条 "Persisted evidence outranks UI state or agent summaries" 的文档侧同类问题。

---

## 2. 设计目标与非目标

**目标**
1. provider / settings 变更**可持久化**，且**只落"变更层"**，不污染 7 层合并结果。
2. provider 治理面**复活**：compat 证据、晋升决策、模型清单同步至少有一条**自动跑的节奏**（不是新增人工步骤）。
3. 端点能力面**声明与实际一致**（零消费者要么接线要么显式标注；`enabled` 与 `status` 自洽）。
4. 四个悬置 ADR **全部有结论**（排期 / Deferred / Rejected）；其中 0044 与 G14 的矛盾**消除**。
5. **文档状态段与提交号机械绑定**，让"文档说已修"可被一条命令证伪。

**非目标**
- 不给 `packycode` 造 OAuth（它是第三方中转，凭证本来就要人工；本批次只要求它在**注册表里被标成"手工维护"**）。
- 不实现 ADR 0045 的热重载（本批次只做**处置决策**；若选排期，另立批次）。
- 不实现 ADR 0046 的 container/VM（同上）。
- 不把 provider 自动升降级改成自动（ADR 0017 的 operator 门禁保持）。

---

## 3. 交付物

### L4-1 provider / settings 变更落盘（分层写回）

**核心约束**：`loadConfig()` 是 7 层合并，**绝不能把合并结果整份写回**（会把 `.env` 的秘密与 discovery 结果固化进 config 文件）。

**设计**：引入**变更层**（overlay）概念：

```
~/.los/config.yaml            # Layer 3：用户层（人工维护 + 到此为止）
~/.los/config.overrides.yaml  # ★ 新增 Layer 3.5：运行时变更层（程序唯一可写）
```

| 项 | 规则 |
| --- | --- |
| 谁写 | `POST/PATCH/DELETE /providers`、`PATCH /settings`、`models/sync applyModel` **只写 overrides 层** |
| 合并顺序 | Layer 3 → **Layer 3.5（overrides）** → Layer 4/5/6/7 |
| 内容限制 | 只允许 provider 条目与 settings 白名单键；**不得写入** `apiKey` 之外的任何 env 来源值？——`apiKey` **允许**（否则 provider CRUD 无意义），但必须标 `source: runtime-override` 并在 `/settings/private` 里可审 |
| 原子性 | 临时文件 + `rename`（原子替换）；写前备份 `<file>.bak-<ts>`，保留最近 3 份 |
| 校验 | 写前用同一份 Zod schema 校验整个合并结果；校验失败 → 4xx 且**不落盘** |
| 幂等 | 相同内容不重写（比对 hash）；写后 bump `providerConfigVersion`（见 L4-2） |
| 反向 | 提供 `los config overrides list\|clear [key]`，让"恢复人工配置"是一步 |

**验收（核心三条）**
- 改 provider/模型 → **重启 gateway** → 变更仍在（跨越式测试）。
- `overrides.yaml` 里**不含** `.env`/discovery 来的键（机械断言：文件内键集合 ⊆ 白名单）。
- 校验失败不落盘（注入非法值 → 4xx 且文件 mtime 不变）。

### L4-2 provider 治理复活（节奏 + 证据 + 版本号）

1. **compat 证据刷新节奏**：新增 governance job `provider_compat_refresh`（weekly，或挂到既有 `supply_chain_audit`/`performance_audit` 的同一拍上），对**已启用 provider × 默认模型**跑 `provider_compat_execute` 并写 `provider_compat_evidence`。
   - **不自动晋升**（ADR 0017 保持）；只**产出证据 + 出 todo**。
   - 若某 provider 无凭证 → 记 `blocked`，**不报 failed**（这是预期状态，不是故障）。
2. **晋升决策可见化**：`provider_promotion_decisions` 为 0 行是个信号，不是成就 ⇒ 日报增一行"待评审的晋升候选（verified_advisory 且 ≥N 天无回退）"。
3. **模型清单同步**：两条独立动作，别混。
   - **a) 让现有 sync 变得有意义**：`models/sync` 的 `applyModel` 走 L4-1 落盘 + `providerConfigVersion` bump；
   - **b) 新增只读巡检**（不自动改配置）：`GET /providers/models/drift` 比对"上游 `/models` 列表 vs `modelAliases`"并输出差集 + 出 todo。**先做只读，再决定要不要自动应用**（避免又一次"自动改了没人知道"）。
4. **`providerConfigVersion` / `toolRegistryVersion`**：把 ADR 0045 里这两个版本号**先落地为空转计数器**（配置变更即 bump，写入 `session_events` 的 run 起始记录）。这样即便热重载不做，"这次 run 用的是哪版 provider 配置"也**可审计**——这是 ADR 0045 里唯一不需要 watcher 就能拿到的价值。
5. **凭证类标注**：`/providers` 响应里每个 provider 增 `credentialClass: 'oauth-auto' | 'static-manual' | 'external-import'`，把"2/20 自动刷新"这个事实变成**可查询字段**（而不是靠读代码）。

**验收**：`provider_compat_evidence` 出现 2026-10 之后的条目；`/providers` 每条都有 `credentialClass`；`providerConfigVersion` 在改配置后变化且被 run 起始事件引用；`models/drift` 对 packycode 给出非空差集（或明确"上游不可达"的 degraded）。

### L4-3 文档状态绑定提交号（机械可证伪）

**规则**：任何文档里的**状态断言**（"已修/已实现/已完成/P0 全清"）必须绑定一个**可机械核对的锚**：

```markdown
| 缺口 | 状态 | 锚 |
| --- | --- | --- |
| P0-4 部署零内容校验 | ✅ 已修 | `commit:050a5f5a` · `file:tools/deploy-to-remote.sh:852-879` |
```

**校验器** `tools/check-doc-status-anchors.mjs`：
1. 扫 `docs/**/*.md` 里形如 `✅` / `已修` / `已实现` / `已完成` 的行；
2. 该行（或所在表格行）必须含至少一个锚：`commit:<7-40 hex>` 或 `file:<path>:<line>` 或 `adr:<NNNN>`；
3. `commit:` 锚必须在 `git log` 里存在；`file:` 锚的路径必须存在、且**行号在该文件行数内**；
4. `file:` 锚**允许 ±N 行漂移**？——**不允许**。行号错了就是错的（这是 D2 的教训）；修复方式是改锚而不是放宽校验。
5. 白名单：`docs/research/**`（调研笔记）与明确标 `dated snapshot` 的文档（如 `2026-06-21-project-context-baseline.md`）只 warn 不 error。

**一次性清偿**（本批次内做完 D1–D7）：
- D1：回填 P0-2/3/4/6 的 ✅ + 锚；把 `:218` 的"待办含 P0"改掉。
- D2：修 13–25 行漂移（用 `file:` 锚重新测行号）。
- D3：删 0043/0045/0046 的 "Numbering conflict" 段（0042 无该段，不动）。
- D4：**重放 P1-8 的原始判据**，把结论统一（要么改文档为 6/40 并写清判据，要么补上真正零引用的清单）。
- D5：G10 的 "ADR 0033" → 0045。
- D6：给 `2026-06-21-project-context-baseline.md` 加 `dated snapshot` 标记（进白名单）或删掉已移除包的描述。
- D7：`provider-selection.ts:30` 注释 ADR 0031 → 0043。
- 附：wiring baseline 396→ 目标"不再增长"，并在文档里写**当前真实值**（不是记的旧值）。

**验收**：校验器在清偿后的树上 error=0；**负向控制**：把任一处行号改错 → error；把 `commit:` 改成不存在的 hash → error；给 `docs/research/` 加无锚断言 → 只 warn。

### L4-4 ADR 处置批 + 端点能力面对齐

**ADR 处置（每个都要有结论，不留"永远 Proposed"）**

| ADR | 本批次结论 | 理由 |
| --- | --- | --- |
| 0038 | **修订** | 改为双身份（DSH 模型网关 + 多节点受治理执行与证据面）；把 Web-first 编码流标为"已交付、采用未验证"；**adoption（30 天任务分布）写成验收指标**。依据 P1.6 的流量事实（590/596 走 deepseek-official 直连） |
| 0039 | **状态回填** | 补"当前生产默认仍为 LOS；Pi 仅在 K4 授权路径可达"；把 planning canary 的 phase 冲突**登记为独立待办** |
| 0043 | **清编号残留** | 删 `:5-8` 冲突段；修 `provider-selection.ts:30` 注释 |
| 0042 | **Deferred** | 明确"与 run-contract plan 数组的关系"未定；写清重新拾起的触发条件 |
| 0044 | **Rejected（或撤回 G14）** | 二选一。**推荐**：标 Rejected 并注明"los-mcp 是唯一程序化接口"（与 G14 一致，改动最小） |
| 0045 | **Deferred + 部分落地** | 明确"接受重启作为 provider 变更路径"；**但 L4-2.4 的版本号计数器先落地**（无 watcher 也拿得到审计价值） |
| 0046 | **修订** | 写清 `resolveSandboxBackend` 的**命名碰撞**（OS 后端 ≠ 多后端）；把 docker/firecracker 降级为"未批准候选"；把 `sandboxNetwork:'host'` 放宽面纳入风险段 |
| 新增 | **ADR：执行面契约** | E1/E2/E3 判据 + 「沙箱外采集 → 沙箱内判读」+ 「los 出改动、外部 runner 验收」——三条已由实测确立但只活在 dated 文档里，需 ADR 级承诺 |

**端点能力面对齐（小而具体）**

1. `los mcp serve` 的 4 个工具：**接线或标注**。二选一——① 给它们找一个真实调用方（例如 DSH 插件/看板）；② 在 CLI `--help` 与 README 里显式标 `experimental, no consumer`，并从"对外能力"表述里移除。
2. `/v1/chat/completions` 的硬编码 `toolMode:'read-only'` + `persistMemory:false`：写进文档的**产品限制**一节（当前只在代码里）；同时**保证带 `tools` 的请求返回显式 `400 tool_forward_unavailable`** 而不是静默忽略（这是 10-06 已修的行为，回归测试必须保留）。
3. CLI `--help` 补齐 `auth` / `memory` / `scan` / `cbm`；加一条门禁：`dispatch 的命令集合 ⊆ help 暴露的命令集合`。
4. `mcp_servers` 的 `enabled=false` + `status=connected` 矛盾：改成 `status='disabled'`（或把 `enabled` 改 true 并补 tool_policy 评审）；给 `cantool.smoke.local` 与 `smoke-mcp-distribution-*`（路径还指向旧 `~/projects/...`）定去留。

**验收**：每个 ADR 状态段有明确结论（无长期 Proposed）；0044 与 G14 不再矛盾；CLI help 门禁绿；`mcp_servers` 无 `enabled=false` 且 `status=connected` 的行。

---

## 4. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| overrides 层被用来固化秘密 | 键白名单 + `source: runtime-override` 标注 + `/settings/private` 可审 + 校验器断言"不含 env 来源键" |
| 多进程同时写 overrides | 文件锁 + 原子 rename + 写前重读合并（避免覆盖并发变更） |
| compat 刷新 job 变成新的"建好就停摆" | 它写的是**证据表**，日报增一行"compat 证据新鲜度"，落后 >7 天即计入异常（与 B19 的 CI 观测停摆同因，用同一套新鲜度门禁） |
| `credentialClass` 变成又一份手写元数据 | 它必须**从代码推导**（registry 里是否有 credentialResolver + discovery 来源），不得人工登记 |
| 文档锚校验过于严苛导致写文档成本上升 | 只对**状态断言行**要求锚（不是每行）；`docs/research/**` 与 dated snapshot 只 warn；锚允许 `file:` 或 `commit:` 二选一 |
| ADR 批量改状态被误当"实现了" | 状态段必须区分 `Accepted/Proposed/Rejected/Deferred` 与 `Implementation status`；Deferred/Rejected 必须写"重新拾起的触发条件" |

---

## 5. 验收门（整批）

1. provider/settings 变更跨重启存活；`overrides.yaml` 键集合 ⊆ 白名单；校验失败不落盘。
2. `provider_compat_evidence` 有 2026-10 之后的条目；`/providers` 每条有 `credentialClass`；`providerConfigVersion` 被 run 起始事件引用。
3. `check-doc-status-anchors.mjs` error=0，且三条负向控制（错行号 / 假 commit / research 无锚）表现符合预期。
4. 七个 ADR + 1 个新 ADR 全部有结论；0044 与 G14 矛盾消除。
5. CLI help 门禁绿；`mcp_servers` 无自相矛盾行；`/v1` 的 `400 tool_forward_unavailable` 回归测试保留。
6. `pnpm check` + `check:contracts` + `check:migration-drift` 全绿。
