# 五项开口的解决方案设计（依 DSH 执行记录与 harness 设计约定）

- **状态**：设计（本文只设计，不含实现）
- **依据**：本文引用的 DSH/harness 约定**均取自本机实测**（见各节「取证」），不是对 harness 设计的转述
- **上游**：`docs/architecture/2026-10-08-phased-development-plan.md`（B0.0–B3 已完成）；本文处理其收口时暴露的 5 项开口

---

## 0. 从 DSH 执行记录中取出的四个可复用约定

设计前先把"harness 的做法"落成可引用的具体形态。四项均有本机取证。

| # | 约定 | 取证位置 | 可复用的本质 |
| --- | --- | --- | --- |
| **P1** | **版本化增量迁移（对账式）** | `dsh-dashboards/index.mjs:1410-1450`（`DEFAULT_WIDGETS_VERSION` 在 `:1422`；内置清单在 `:238-251`） | store 存在后完全取代默认值 ⇒ 新增默认项对已有安装**静默不可见**。修法：信封记 `widgetsVersion` + `removedDefaults`，低于当前版本时**追加**缺失默认项（不动既有顺序、不动用户改过的字段），**已最新则零写入**，**用户删过的不复活** |
| **P2** | **插件状态端点** | `lib/poller.mjs:24,111` | `GET /plugins/<id>/status`（bundle-id = package.json name）暴露 `lastDurationMs`/`lastError`/`consecutiveFails`/`dataAgeMs`；**成功不清空 lastError**（供事后定位）。未实现的插件在 `dsh-obs plugin-status` 里标 `N/A` |
| **P3** | **append-only 执行台账** | `dsfolder/.rust-los-gov/gate-runs.jsonl`（58 条 `gate-run.finish`） | 每次执行追加一条事件（`t` + `ts` + 结果字段），**不可重建** ⇒ 属证据面必须跟踪。修好/失效的项由"棘轮"反向检出（见 `doc-status-anchor-baseline`） |
| **P4** | **watermark 增量** | `session-index.db` 的 `ingest_files(path,mtime,size,session_id,events,ingested_at)` | 以 `(path, mtime, size)` 为水位判断是否已摄入，避免重复处理；**水位不匹配即重做** |

**另有两条反向教训**（本计划已实测踩到，设计必须避开）：

- **"空即通过"族**：`verify-gate` 的全 `na` 曾被当 pass；`fmtguard` 在干净树下 `files_scanned=0`。⇒ 任何计数型判据都要区分"**没有**"与"**没读到**"。
- **"名字硬找"族**：`rustopt` 的体积门禁写在 `documented` 条目里（不叫 `size:dist`）⇒ 判据要按**语义/结构**，不按名字。

---

## 1. 三个质量属性落成可失效的不变量

"可追溯 / 可观测 / 可维护可扩展"若不写成**可被违反**的形式，就只是形容词。逐条给出判据与失效方式。

### T · 可追溯（Traceability）

| 不变量 | 判据 | 违反即 |
| --- | --- | --- |
| **T1 每次写投影/生成内置项都留版本与时刻** | 行内必须有 `as_of`（或信封 `widgetsVersion`+`updatedAt`） | 无法回答"这个数字是什么时候的" |
| **T2 三态不压平** | 任何"无法归属/无法判定"必须落成**独立状态**并保留（不得丢弃、不得并成"成功"） | 历史上出现过：全 `na`→pass、exit 127→real drift、读不到库→"无分裂" |
| **T3 判据版本随行** | 机械化判据（正则族等）必须把 `pattern_version` 落库 | 规则改了之后新旧计数混在一起，历史不可解释 |
| **T4 归档保留可复活性** | 退役物必须写 `archivedAt`/`archiveReason`/**`reviveCondition`** 三字段 | `check-project-registry` 对 `kind: archived` 强制校验（已实现） |

### O · 可观测（Observability）

| 不变量 | 判据 | 违反即 |
| --- | --- | --- |
| **O1 有状态组件必须有状态面** | 暴露 `P2` 形态（`lastRunAt`/`lastDurationMs`/`lastError`/`consecutiveFails`/`dataAgeMs`） | 出问题时只能靠猜 |
| **O2 `lastError` 成功时不清空** | 成功运行**不得**抹掉上一条错误 | 间歇故障自愈后线索消失（DSH 踩过，见 `poller.mjs:111`） |
| **O3 新鲜度必须显式** | 投影/报告必须带 `as_of`，落后超阈值标 **[STALE]** | "看起来正常但其实是旧数据"（本计划已在日报第 8 节实现该徽标） |
| **O4 每日只读盘点覆盖新增面** | 新组件必须进 `audit:boundary` 或日报某一节 | 加了东西但没人每天看 |

### M · 可维护可扩展（Maintainability / Extensibility）

| 不变量 | 判据 | 违反即 |
| --- | --- | --- |
| **M1 加一个内置项不改既有安装的状态** | 走 `P1` 对账式迁移：追加、不复活已删、已最新零写入 | `dsh-dashboards` 的 `surge-packy`/`z4pro-health` 曾只出现在新装机上（该坑原文见 `index.mjs:1411-1421`） |
| **M2 加一个后端/模式不改调用方** | 走注册表（`ISOLATION_BACKENDS` 形态）+ 契约先行（`contracts/*.yaml`） | B2.1(d) 的三处"唯一路径"假设 |
| **M3 每个新检具带负向控制** | `--self-test` 且断言数可陈述 | 本计划 8 支检具全部如此；`check-doc-status-anchors` 曾因判据过宽产生噪音 |
| **M4 单一真源，其余为派生投影** | 投影必须**自证**其源（`budgetSource`/`trackedBy` 形态） | D8：`gates.json` 的预算曾是第二真源 |

---

## 2. 逐项设计

### 2.1 四项预算余量：**统一提到 8%，但用"政策值"而非"贴着实测"**

| | 内容 |
| --- | --- |
| **现状** | 4.74%–5.43%（全部紧贴天花板）。历史规则是"末次实测 +5%"，**四个仓无一例外** |
| **问题** | 余量 < 一次常规功能增量 ⇒ 每次开发都触发 re-review。**常报警等于没报警**（M2 的反面） |
| **取证** | 功能提交后实测**都 ≤108% 基线**（session-index +17.2%、fmtguard +8.1%）⇒ 8% 覆盖"**一次**功能迭代"；且必须 > `headroomWarnBelow`(4%)，否则预算一设好就自报警 |
| **设计** | 预算 = 当前实测 × **1.08**，并**把政策写进 `projection.budgetPolicy`**（单一真源，见 M4）。`driftTolerance` 保持 15%（依据新鲜度），`headroomWarnBelow` 保持 4% |
| **可追溯** | 每个预算的 `budgetAttestation.basisNote` 必须写明"基于哪次实测、为什么是这个余量"（T1） |
| **可观测** | 日报「体积预算」行 + `--list` 逐仓（已实现）；余量低于 4% 自动报 `headroom-low` |
| **可维护** | 将来追加仓时，**政策是 8%**，不需要逐个论证 ⇒ 加仓成本 O(1) |
| **负向控制** | ① 余量 ≥ 4%（否则自报警）；② 越界**不被** `--auto-attest` 吸收（已验证：session-index 17.19% 被 hold）；③ 已最新的 attestation 不因重复运行而 churn |
| **验收** | `rust-budget-check` 7/7 attested；四仓改为 8% 后 `headroom-low` 归零；真实门禁 `rustopt check` exit 0 |

**不这么做的代价（诚实的另一面）**：放宽余量会降低对**渐进式膨胀**的敏感度（每次 +6%、三次就 +19%）。**对冲**：`driftTolerance` 15% 仍在，且 `rustopt plan` 的变体对比（`lto`/`strip`/`tuned`）仍能在回归时给出优化方向。若某仓进入"稳定期"，应把该仓降到 5% —— **余量是逐仓政策值，不是全局常数**。

---

### 2.2 `DSH-PLUGIN-AUDIT-2026-10-08.md`：**移入被审计主体的仓，并登记归属**

| | 内容 |
| --- | --- |
| **现状** | dsfolder 的**唯一**剩余未跟踪文件；内容是 DSH 插件审计（宿主 `:3080`、harness `0.2.1-alpha.1`、cwd `deepseek-harness`、rev `5badb15009`） |
| **判据** | 报告的**被审计主体**是 `deepseek-harness`，该仓有 `docs/` ⇒ 按 R2（引用只能上层→下层）它属于那边；放在 dsfolder 会让"谁的证据"含糊 |
| **设计** | 移到 `deepseek-harness/docs/audits/2026-10-08-dsh-plugin-audit.md`，并在文首补**归属信封**：`subject`/`auditedRev`/`host`/`method`/`readOnly: true` |
| **可追溯** | 信封里的 `auditedRev = 5badb15009` 使"这份结论对哪个修订有效"可机械核对（T1） |
| **可观测** | 审计类文档纳入 `check-doc-status-anchors` 的状态行判据（若含状态断言则必须带锚） |
| **可维护** | 约定"**审计报告归被审计主体**"写入 `dsfolder/AGENTS.md`，避免下次又漂到父仓 |
| **负向控制** | 移动后 dsfolder `git status` 必须**干净**（唯一剩余项消失）—— 这是硬判据 |
| **验收** | dsfolder 未跟踪 = 0；新位置有归属信封且含 `auditedRev` |

---

### 2.3 los 的 12 个提交：**建 bookmark + 推送，但按意图拆成两条线**

| | 内容 |
| --- | --- |
| **现状** | 12 个提交未建 bookmark、未推送（属需明确批准的动作，已获授权） |
| **问题** | 12 个提交**不是一个意图** ⇒ 直接推一条线会让 review 无法定位（违反 `dsfolder/AGENTS.md` 的"一个 change 一个意图"） |
| **设计** | 拆 **2 条 bookmark**：<br>① `boundary/governance-b0-b1` —— B0/B1 的边界治理、能力归属、J1–J10 门禁、只读审计<br>② `boundary/consumption-b2-b3` —— B2 消费面收敛（mcp 接线 / provider 三态 / 记忆分层 / isolation C1–C4）+ B3（归档 / V3-V6 边界 / L1-2 投射）<br>推送到 `origin`（forgejo 为主、github 为镜像，遵循既有 `mirror/*` 约定） |
| **可追溯** | 每条 bookmark 的描述必须列出**该线的验收证据**（门禁数、负向控制数），使"这条线凭什么可以合并"可机械回答（T1） |
| **可观测** | 推送后核对两侧（forgejo/github）head sha 一致 —— 这是可机械验证的，不是"应该推上去了" |
| **可维护** | 采用既有 `deliver/*`、`mirror/*` 命名；**新线用 `boundary/*`** 与既有区分，避免和历史线混在一起 |
| **负向控制** | ① 推送前 `jj status` 必须 `no changes`（工作区干净）；② 推送后**本地与远端 sha 逐一比对**；③ 若某一侧推送失败，**不得**只报另一侧成功 |
| **验收** | 两侧 head sha == 本地对应 change 的 commit id；`jj bookmark list` 显示两条线各自指向预期的提交 |

---

### 2.4 P1 剩余三项

#### 2.4.1 L1-2 的另两张表投影器（`dsh_session_pain` / `dsh_context_injection`）

| | 内容 |
| --- | --- |
| **现状** | **两张表已建**（迁移 063 + 内联 SCHEMA 双路径一致），**投影器未写** ⇒ 表空 |
| **设计** | 写 `projectSessionPain()` 与 `projectContextInjection()`，与已有 `projectSessionCatalog()` **并列**，共用同一个 SQLite 只读助手（`querySqlite`）与同一份 `projection-run.jsonl` 台账 |
| **可追溯（T3）** | `dsh_session_pain` 已有 `pattern_version` 列 ⇒ **必须**落 `PAIN_PATTERN_VERSION`；判据族固定正则在代码里，改规则即 bump 版本，**旧版本行保留**（不删）以便对比 |
| **可观测** | 日报第 8 节扩两行：`跨项目重复痛点 top3（按 sessions 去重）`、`上下文注入: runtime_context N 次 / skill_catalog M 次（14d）`；各自带 `as_of` 与 `[STALE]` |
| **可维护** | 三个投影器走**同一模式**（读水位 → 聚合 → 事务内 replace → 落台账行），加第四个只需照抄 ⇒ O(1) |
| **性能** | 已有教训：相关子查询 **91s → 0.4s**（改一次 `GROUP BY`）。pain 投影涉及 `events.text` 全量正则匹配（44k 行有 text） ⇒ **必须**按 `events.ts` 时间窗 + `session_id` 过滤，并**实测记录耗时**到台账 |
| **负向控制** | ① SQLite 不可读 ⇒ `degraded`，**不写**表、**不**抛异常、**不**假装"无痛点"（T2）；② `aliasMap` 缺失 ⇒ 相关行标 `unknown` 但**保留**；③ 同一 `as_of` 重复运行**幂等**（同输入同结果，无 churn） |
| **验收** | `pnpm --filter @los/agent check` 绿；单测含上述 3 条负向控制；真实库上 pain/injection 两表非空且 `as_of` 与 catalog 一致 |

#### 2.4.2 L1-1 `session-index` 插件装进 desktop profile

| | 内容 |
| --- | --- |
| **现状** | 已在 **web** profile（`~/.dsh/profiles/web/package.json` 的依赖与 lock 两处），**不在 desktop**（当前 GUI 宿主）。装入需**重启宿主** ⇒ 会打断当前会话 |
| **设计** | ① **先改配置、不重启**：把 desktop profile 的 `package.json` 加上依赖（照 web 的写法）—— 这一步本身不生效也不破坏；② **重启窗口内**验证：重启后核对 `dsh-obs plugin-status` 里该插件不再是 `N/A`，且 `~/.dsh/storages/session-index.db` 的 **mtime 确实在推进**（watchdog 现状：漏跑 ≥2 次才拉响 ⇒ 新鲜度阈值内不算故障） |
| **可追溯** | 记录"装入前的 db mtime / 行数"，装入后对比 ⇒ 证明"真的在跑"而不是"配置写了"（**这正是 V-19「配置被当生效」的防法**） |
| **可观测** | `/plugins/<id>/status`（P2）+ 日报第 8 节的 `[STALE]` 徽标 |
| **可维护** | 依赖只写在 profile 的 `package.json`（`link:` 指向 dsplugins 源），与既有 `dsh-verify-gate`/`dsh-access-gate` 同一模式 ⇒ 升级即改源 |
| **负向控制** | 若重启后 mtime **不推进**，**不得**报成功 —— 必须显式报"已配置但未生效"（与 `verify-gate` 的 `inconclusive` 同族） |
| **注意** | 本项**需要重启宿主**，会中断会话 ⇒ 必须由你在合适窗口批准，我不自行重启 |

#### 2.4.3 L1-3 `dsh-dashboards` 跨项目健康 widget

| | 内容 |
| --- | --- |
| **现状** | `DEFAULT_WIDGETS_VERSION = 1`；store 一旦存在即取代 `DEFAULT_WIDGETS` ⇒ **新增内置 widget 对已有安装静默不可见**（`surge-packy`/`z4pro-health` 已踩过） |
| **设计** | ① 在 `DEFAULT_WIDGETS` 追加两张卡（照第 238-251 行的形状）：`xproj-sessions`（`type: 'chart'`）、`xproj-pain`（`type: 'list'`），`endpoint` 指向新的 `/dashboards/xproj/*`；② **`DEFAULT_WIDGETS_VERSION` 1 → 2**（**不可省**，否则对已有安装不可见）；③ 后端路由读 los 的 `dsh_session_catalog`/`dsh_session_pain`/`dsh_context_injection` |
| **可追溯（T1/M1）** | 迁移走 `P1` 对账：**追加**在末尾、不动既有顺序、不动用户改过的 `title`/`refreshMs`；信封带 `widgetsVersion: 2` 与 `removedDefaults`；**用户删过的 id 不复活** |
| **可观测** | 卡片各自带 `as_of` 与新鲜度徽标（数据来自 los 投影，其 `as_of` 由 2.4.1 保证，O3） |
| **可维护** | 加第三张卡只需"追加 + bump 版本"两步 ⇒ O(1)；**不做** store 删掉重来（会抹掉用户的增删改） |
| **负向控制** | ① 已经是 v2 的 store **零写入**（幂等，不 churn `revision`）；② 用户删过的内置 id **不复活**；③ 迁移写失败时**返回内存合并结果**，不得把用户已有卡片弄丢（照 `index.mjs` 的既有处理） |
| **验收** | 三态各有单测（新项进入既有 store / 已最新零写入 / 删过不复活）；本机 GUI 里两张卡**真的出现**（不是"路由 200 就当作好了"—— 那正是 `surge-packy` 的坑） |

---

### 2.5 `sandbox-run` C5：`enum Backend` → 注册表（**属该仓，低优先**）

| | 内容 |
| --- | --- |
| **现状** | `src/main.rs:94-116` 是 `enum Backend { Auto, Worktree, Docker }` + `match`；加后端要改 `main.rs`。**已实测**：源码解析 `--backend`，`0.1.3` 的 debug/installed 二进制支持它，而 `target/release` 停在 `0.1.0`（该产物已重建） |
| **设计** | 定义 `trait IsolationBackend { fn id(&self)->&str; fn probe(&self)->Probe; fn run(&self,..)->RawResult; }` + 注册表 `fn backends() -> &'static [&'static dyn IsolationBackend]`；`--backend <id>` 变成**查表**；`auto` 保留为解析规则而非 enum 成员 |
| **可追溯** | 该仓已有 `.rustopt/runs.jsonl` 与 `.fmtguard/runs.jsonl` 台账；新增 trait 不需要新台账，但**版本 bump 必须与该仓 CHANGELOG/README 同步**（否则又是"配置/版本被当生效"） |
| **可观测** | `--backend` 的可用性由**它自己的** `probe()` 回答（与 los 侧 `IsolationBackend` 契约同构）；不可用时**必须带原因** |
| **可维护** | 加后端 = 加一个文件 + 注册一行，**不改 `main.rs` 的解析** |
| **负向控制** | ① 未知 `--backend` 值必须**拒绝并列出已声明 id**（不得强转）；② `auto` 仍须在既非 git 也非 jj 时 fail-closed 报因；③ trait 化后**既有 `--backend worktree|docker` 行为逐字不变**（回归测试锁住） |
| **与 los 的边界** | 两侧**各自定义**接口、**不共享代码**（跨语言）：以 **`contracts/isolation-backend.yaml` 为契约真源**，两侧各自实现并各自测。C5 完成后 los 侧 C3 的适配器可直接对接 trait，但**不因此耦合构建** |
| **优先级的诚实说明** | 它**不阻塞**任何 los 侧功能（C1–C4 已完成且工作）。做它的收益是"该仓自己加后端变便宜"，属**该仓的可扩展性**，不是本计划的出口判据 |

---

## 3. 落地次序与依赖

```
第一批（无外部依赖，可立即做）
  2.3 bookmark + 推送 ── 先把已完成的工作固化成可追溯的线
  2.2 审计报告归属    ── 顺带让 dsfolder status 归零

第二批（纯新增，风险低）
  2.1 预算余量统一 8% ── 改配置 + 重签依据，有 --auto-attest 与越界 hold 保护
  2.4.1 pain/injection 投影器 ── 照 catalog 的既有模式，含 3 条负向控制

第三批（需重启宿主 / 属他仓）
  2.4.2 L1-1 装 desktop profile ── **需你批准重启窗口**
  2.4.3 L1-3 dashboards widget ── 属 dsh-dashboards 仓；**必须 bump DEFAULT_WIDGETS_VERSION**
  2.5  sandbox-run C5 ── 属该仓，低优先；不阻塞任何东西
```

**依赖关系**：2.4.3 依赖 2.4.1（widget 读的是那三张表；表已建、catalog 已有数据，pain/injection 空表也能渲染但只有一列有值）。其余互不依赖。

---

## 4. 与既有决定的相容性检查

| 检查 | 结论 |
| --- | --- |
| 是否违反 R1 单写者？ | **不违反**：投影只写 los 自己的库；DSH 侧只读（2.4.1 已验证 mtime 不变） |
| 是否违反 R2 引用方向？ | **不违反**：los 读 DSH 的库属"上层读下层"；`sandbox-run` 不引入对项目的引用（C5 只加 trait） |
| 是否违反 R3 真相优先级？ | **强化**：预算自证依据（2.1）、审计报告带 `auditedRev`（2.2）、pain 带 `pattern_version`（2.4.1） |
| 是否违反 J10（无 VCS 不得进交付链）？ | **不违反**：2.2 是把文件移入**有 VCS** 的仓 |
| 是否违反"空即通过"禁令？ | **遵守**：所有新增判据都区分"没有"与"没读到"（2.4.1 的 `degraded`、2.4.2 的"未生效"、2.4.3 的"路由 200 ≠ 卡片可见"） |
| 是否需要新的 operator 批准？ | 仅 **2.4.2**（重启宿主打断会话）与 **2.3**（推送远端）—— 后者已获你授权 |

---

## 5. 本文未做的事（诚实边界）

- **未实现任何一项**。本文只有设计。
- **`sandbox-run` C5 的实现细节**只给到 trait 骨架，未核对它现有 `docker.rs`/`gates.rs` 的拆分是否已接近该形态（需要读那 3803 行才能给精确的迁移步）。若要做 C5，**先补这一步取证**。
- **2.4.3 的 widget 后端路由**未定具体响应 schema（需先确定卡片要展示哪几个字段；建议在实现时与 `dsh-dashboards` 既有 `type` 的渲染约定对齐）。
- **P1 的 L1-3 之外**，`p1-cross-project-observability.md` 里的 L2/L3 项未纳入本文。
