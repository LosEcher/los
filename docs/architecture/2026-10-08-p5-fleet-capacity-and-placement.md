# P5 设计：fleet 容量与名分 + 跨项目登记 + 成本/预算原语

- **状态**：设计（待评审）
- **归属**：los 侧（`packages/agent` 调度/放置 + `packages/gateway` 路由 + `tools/`）+ 工作区文档（登记）
- **批次**：P5
- **依据**：2026-10-08 盘点 §2（节点矩阵与 30 天负载）+ §5.2（B10/B11/B12/B18/B19/B24/B25）+ 10-07 closeout 剩余项
- **前置**：L5-1 依赖 P2 的 `project-registry.json`（把 `project_id` 映射到 `project_key`）

---

## 1. 问题陈述（有数字）

### 1.1 36 行注册表里只有 8 行是活的，且 6/8 零负载

实测 `executor_nodes`：

| 分类 | 数量 | 状态 |
| --- | --- | --- |
| `executor` online | **8** | mbp / m3pro / desktop-r45553o / desktop-srsbe20 / node34 / oracle / tencent-sin / vultr |
| `executor` offline | 1 | `grok-cloud-executor-1`（心跳停 2026-09-29，`verified_json` 无 TTL，无再入册路径） |
| `ssh_target` | **27** | **全部 offline，心跳集体冻结在 2026-08-19 22:28:45**（是"从未探测"，不是"探测通过"） |

近 30 天 `task_runs` 的执行位置分布：

| 位置 | runs | succeeded | blocked | failed |
| --- | --- | --- | --- | --- |
| `mbp-executor-1` | 221 | 154 | 53 | 14 |
| **`gateway-local`（in-process，`executor_nodes` 里 0 行）** | 176 | 142 | 26 | 8 |
| `node34-executor-1` | 87 | 62 | 8 | 17 |
| **其余 6 台在线 executor** | **0** | — | — | — |

**三个结论**：
1. **6/8 零负载确认**（架构文档 P1-1 的"未修"状态成立）；
2. **`gateway-local` 这个伪 node_id 承担了 36% 的负载**，且它不在一行注册表里 ⇒ "集群执行"在数据上仍是"本机为主"，而**日报/一致性检查看不到这个事实**（它按 registry 比对，天然漏掉进程内路径）；
3. 节点"名分"缺失：既没有按场景分派（Windows 专用 / 构建主机 / 低资源巡检 / 网络出口），也没有"待命"的显式登记 ⇒ 日报无法区分**待命**与**漂移**。

### 1.2 探测与再入册缺 TTL

- `last_probe_at` 在架构文档里记"9 台全停在 2026-09-27"；本轮实测 **27 个 ssh_target 的心跳停在 2026-08-19**（比文档更早）⇒ probe 覆盖与新鲜度都没有门禁。
- `fleet_host_check_state` 只覆盖 5/9。
- `grok-cloud-executor-1` 离线后**没有任何再入册路径**，唯一手段是人工 promote；`verified_json` 没有过期时间，所以"曾经验证过"会永久留存。

### 1.3 滚动发布的剩余缺口（10-07 closeout 已登记）

已落地：upload-then-extract 默认、`tools/los-fleet-rollout.sh`（reconcile + plan/canary/fail-fast/锁/报告）、Windows 驱动、可移植盖章、摘要口径收窄。
**未落地**：① `--batch-size`；② 把 Linux/macOS 也拆成 `deploy-drivers/*`；③ **canary 强制化**；④ 摘要口径继续收窄（需先做"节点到底执行了什么"的审计）。

另有一处结构性风险：**本机工作树版本与 fleet 目标版本可以相差一天且都"正常"**（今天实测：本机 `b59bdf4e` vs fleet target `bca2863a`）。`mbp-executor-1` 因此连续 ≥12h 判 drift，而它**同时是控制面节点**。

### 1.4 没有成本/配额/拓扑放置

- P1-3 未做：无成本、无配额、无机房/区域/RTT/数据驻留维度。
- 免费兜底链（`opencode-zen` / `openrouter` / `nvidia-nim`）已在 `~/.los/config.yaml` 里配好，但**没有"何时允许用免费渠道"的机械判据**（现只靠注释说"禁投敏感内容"）。
- `provider_accounts` **只有 1 行**（xai），ADR 0030 的 Phase 2（quota/entitlement 面）**未落地**——403 配额耗尽只能靠错误消息正则兜底 fallback。
- P1-4 幂等键原语缺失、P1-5 工具三态审计缺失、P1-6 租约过期无收敛（L3-4 已覆盖 P1-6）。

### 1.5 跨项目登记与治理覆盖面不匹配

近 14 天 DSH 活跃 **9 个仓**，但 los `todos` 按 `project_id` 实测：`los` 6231 / `lot2extension` 204 / `dsfolder` 3 / `dsfolder-rustopt` 2 / `dsfolder-fmtguard` 2 / `dsfolder-run-diff` 1 / `dsfolder-sandbox-run` 1。⇒ **最活跃的仓几乎没有治理登记**（P2 的 L2-1 解决"仓拓扑"，本条解决"治理覆盖面"）。

另两条已登记但未修的集成缺口：
- **11 个 DSH 调度 job 只有 2 个碰 los，且都绕过 los API 直连 DB**（I-6）；
- **los→DSH 事件 webhook 的唯一发送方在被停用的 wechat-bot**（I-5）。

### 1.6 两个"建好就停摆"的观测机制

- `.los-runtime/ci-metrics/runs.jsonl` 共 **14 行，末行停在 2026-08-17**（run 642 仍标 `running`）⇒ CI 观测建好即停摆。
- `tools/wiring-topology-baseline.txt` 实测 **396 行**（架构文档记 384）⇒ 豁免在**扩张**，与"逐步收紧"反向。

---

## 2. 设计目标与非目标

**目标**
1. 注册表**只保留有名义的行**；每个在线节点有**显式名分**（专用场景 or 待命），日报能区分 **待命 / 漂移 / 未探测**。
2. 进程内执行路径（`gateway-local`）**进入可见面**，不再让"集群一致性"报告漏掉 36% 的负载。
3. 探测与 `verified` 有 **TTL 与刷新节奏**；离线节点有**机械可执行的再入册清单**。
4. 滚动发布补上 `--batch-size` / 三平台 driver 统一 / **canary 强制化**。
5. 有**最小可用的成本/预算原语**：免费渠道的使用有机械判据，quota 面至少有快照表。
6. 观测机制**带新鲜度门禁**，不允许静默停摆。

**非目标**
- 不做多租户 SaaS（单租户仍是默认）。
- 不做完整的成本核算/计费（只做"能不能用免费渠道"+"quota 快照"两个最小原语）。
- 不为了"用满 8 台"而制造负载（名分包含"明确待命"这一合法结论）。
- 不实现 container/VM 隔离（P4 处置 ADR 0046）。

---

## 3. 交付物

### L5-1 节点名分与注册表卫生

**a) 名分（`node_maintenance_policy` 同族的显式字段）**

`executor_nodes.capabilities_json` 增 `designation`（或新增列 `designation`）：

| designation | 含义 | 出现在哪个日报栏 |
| --- | --- | --- |
| `primary` | 默认放置目标（今天：`mbp-executor-1`、`node34-executor-1`） | 负载分布 |
| `specialist:<kind>` | 专用场景：`windows` / `builder` / `low-resource-probe` / `network-egress` | 名分表 |
| `standby` | **明确待命**（有意不派活） | 名分表（**不计入漂移**） |
| `draining` | 退出中（已有语义） | 退出表 |
| `unassigned` | 未定 ⇒ **必须出 todo** | 异常 |

**规则**：8 台在线 executor **每台必须落在某个 designation 上**；`unassigned` 出 todo（给 operator 决策），**不再把零负载当默认正常**。

**b) 注册表卫生**

- 27 个 `ssh_target`：按"是否仍被任何脚本/文档引用"分两类 → ① 仍被引用：补 probe 计划（进 L5-2）；② 无引用：删除或标 `retired`（保留行但 `status='retired'`，避免历史引用断裂）。**先出只读清单再动**。
- `gateway-echers-mbp-local-18080` / `-8081`（07-12 / 07-19 停）：标 `retired`。
- `smoke-mcp-distribution-*`（路径指向旧 `~/projects/...`）：删除或改指向。

**验收**：`executor_nodes` 无 `unassigned`（或每条有 todo）；无 `ssh_target` 处于"从未探测却仍 active"；日报新增"名分表"且 `standby` 与 `drift` 分列。

### L5-2 探测 TTL + 离线再入册清单

1. **TTL**：`verified_json` 增 `verifiedAt` + `ttlSeconds`；过期即降级为 `unverified` 并出 todo。
2. **probe 节奏**：让 `last_probe_at` 有**计划任务**（复用 `fleet host check (remotes)` 那条 6h 链路，把覆盖从 5/9 提到全部 active 行）；门禁：任一 active 行的 `last_probe_at` 落后 >2×节奏 → 日报异常。
3. **再入册清单**（针对 `grok-cloud-executor-1` 这类）：成文为一个可执行 check，而不是散文。参考既有 `grok-cloud-node-onboarding` 技能，产出 `tools/reenroll-node.sh <node-id>`：① 可达性（tailscale/ssh）→ ② 版本 vs `target_version` → ③ 注册表 `verified` 刷新 → ④ 一次 dry-run 任务 → ⑤ 失败时明确停在哪一步。

**验收**：人为把某节点 `verifiedAt` 改旧 → 出 todo；把 `last_probe_at` 改旧 → 日报异常；`reenroll-node.sh` 对 `grok-cloud-executor-1` 给出可复跑的判断（当前应停在"不可达"）。

### L5-3 进程内执行路径进入可见面

**问题**：`gateway-local` 承担 176/484 = 36% 的近 30 天负载，却不在 `executor_nodes` 里，导致一致性报告与负载分布都漏看它。

**设计**（不假装它是 executor）：
1. `task_runs.node_id = 'gateway-local'` 是**合法且应保留**的语义（进程内执行是快速路径）。
2. 日报与 fleet 一致性报告增一栏 **"in-process 执行"**：runs + succeeded/blocked/failed + 占比。
3. 若 in-process 占比 > 阈值（建议 50%）→ 出 todo（"集群容量被闲置"或"in-process 已足够，应削减节点"——两个方向都要能表达）。
4. 指标落 `fleet_resource_state` 或新表 `execution_placement_daily`（每（天 × 位置）一行），供 P1 看板复用。

**验收**：日报出现 "in-process 执行" 栏且数字与 DB 一致；人为把阈值降到 10% → 出 todo（负向控制）。

### L5-4 滚动发布补完 + canary 强制化

| 项 | 设计 |
| --- | --- |
| `--batch-size N` | 编排器把节点分批，批间有**显式屏障**（前批全部 `consistent` 才进下一批）；默认 1（等价 canary 链） |
| 三平台 driver 统一 | 把 Linux/systemd 与 macOS/launchd 也抽成 `tools/deploy-drivers/{linux-systemd,macos-launchd,windows-service}.sh`，与 Windows 对齐（今天只有 Windows 有独立 driver） |
| **canary 强制化** | 非 `--plan` 的滚动**必须先跑 canary 并停下等人确认**；跳过需显式 `--skip-canary --justification <text>`，且**写审计事件** |
| 版本方向守卫 | 编排器拒绝"把节点降级到比它当前更旧且非回滚意图"的目标；回滚需 `--rollback` 显式声明（今天实测本机比 fleet 目标旧一天，这个守卫能防误操作） |
| 摘要口径收窄 | 先做"节点到底执行了什么"的审计（列出每轮摘要覆盖的路径集合），再决定 `ci/observe/node-probes` 是否排除 |

**验收**：canary 未确认时滚动不继续（负向控制：无确认 → 停在 canary）；`--batch-size 2` 时第二批在第一批全 `consistent` 前不启动；`--rollback` 缺失时拒绝降级目标。

### L5-5 最小成本/预算原语

1. **免费渠道使用判据**（把注释变成机械判据）：`~/.los/config.yaml` 的免费兜底链增 `freeTier: { allowedFor: ['public', 'mechanical'], forbiddenFor: ['local_private', 'sensitive'] }`；`provider-fallback` 在选择免费渠道前校验**数据的 `dataClassification`**（los 已有这个概念，见 cantool capability 的 `dataClassification`）。命中 `forbiddenFor` → 不降级到免费渠道，直接 fail with `blocked_reason='free_tier_forbidden'`。
2. **quota 快照表**（ADR 0030 Phase 2 的最小切片）：
   ```sql
   CREATE TABLE provider_quota_snapshots (
     provider TEXT NOT NULL, model TEXT, window_kind TEXT NOT NULL,  -- daily|monthly|rolling
     observed_at TIMESTAMPTZ NOT NULL, remaining NUMERIC, used NUMERIC, limit_value NUMERIC,
     source TEXT NOT NULL,            -- header|api|error-inferred|manual
     confidence TEXT NOT NULL,        -- exact|inferred
     PRIMARY KEY (provider, model, window_kind, observed_at)
   );
   ```
   写入方：① 解析 provider 响应头（`x-ratelimit-*`）② 解析 403/quota 错误（`confidence='inferred'`）③ 人工。**只读用于路由提示，不做自动封禁**（避免误杀）。
3. **fallback 跳过免费链的可见性**：每次因 quota/rate-limit 降级都写事件（含 `from`/`to`/`reason`/`confidence`），日报增一行"降级事件（24h）"。

**验收**：构造一个 `dataClassification='local_private'` 的请求 + 主 provider 失败 → **不**降级到免费渠道，返回 `free_tier_forbidden`；quota 快照表在真实 403 后有 `confidence='inferred'` 的行；日报有降级事件栏。

### L5-6 治理覆盖面与观测新鲜度

1. **跨项目治理登记**：让 los 的 `project_id` 能容纳 `dsfolder` 下的子仓（与 P2 的 `projects.json` 的 `project_key` 对齐）；新增 todo/审计时**不经映射不得写 `project_id='unknown'`**（实测现有 `unknown/unknown` 11 条 + 2 条 `unknown/los`）。
2. **DSH job ↔ los 的接线**（I-6）：把"11 个 DSH job 只有 2 个碰 los 且直连 DB"收敛为**经 los API** 的只读调用（需要写的时候走 operator 路径）；先出清单与迁移顺序，不一次性全改。
3. **los→DSH 事件 webhook 的唯一发送方在被停用的 wechat-bot**（I-5）：把发送职责迁到一个**不依赖 IM 渠道**的进程（或明确废弃该链路并在文档写明）。
4. **CI 观测复跑**：`.los-runtime/ci-metrics/runs.jsonl` 停在 2026-08-17 ⇒ 恢复写入 + 新鲜度门禁（落后 >48h → 日报异常）。
5. **wiring 豁免不再增长**：`tools/wiring-topology-baseline.txt` 396 行 ⇒ 加"只减不增"棘轮（新增零调用导出即红），并更新文档里的真实值。

**验收**：无 `project_id='unknown'` 新增；CI 台账连续且有新鲜度门禁；wiring baseline 在棘轮下不再上升（注入一条零调用导出 → 红）。

---

## 4. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 删 27 个 ssh_target 破坏历史引用 | 先只读出清单 + 引用扫描；**优先标 `retired` 而非删除**；删除需单独评审 |
| 名分变成"给零负载找借口"（全标 standby 就没人管） | `standby` 必须带 reason + 复核日期；日报把 `standby` 单列并**每 30 天出一次复核 todo** |
| canary 强制化拖慢紧急修复 | `--skip-canary --justification` 逃生门 + 审计事件（可追溯而非静默） |
| 免费渠道判据过严导致可用性下降 | 判据只对 `local_private/sensitive` 硬禁；其余仍可降级（且降级有事件可观测） |
| quota 快照被当成精确账 | `confidence` 字段强制区分 exact/inferred；路由只用它做**提示**，不做自动封禁 |
| 观测新鲜度门禁产生噪音 | 阈值取 2× 节奏（探测 6h → 12h；CI 日更 → 48h），避免抖动误报 |

---

## 5. 验收门（整批）

1. 8 台在线 executor 每台有 designation；`unassigned` 为 0 或每条有 todo；日报"名分表"里 `standby` 与 `drift` 分列。
2. `verified_json` 有 TTL 且过期出 todo；probe 覆盖从 5/9 提到全部 active；`reenroll-node.sh` 可跑。
3. 日报出现 "in-process 执行" 栏且数字与 DB 一致；阈值负向控制能出 todo。
4. 滚动：canary 未确认不继续；`--batch-size 2` 有批间屏障；缺 `--rollback` 拒绝降级。
5. `free_tier_forbidden` 负向控制通过；`provider_quota_snapshots` 有 `inferred` 行；日报有降级事件栏。
6. 无新增 `project_id='unknown'`；CI 台账连续；wiring baseline 只减不增。
7. `pnpm check` + `pnpm run gate` 绿。
