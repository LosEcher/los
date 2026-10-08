# 分阶段开发任务：工具与项目边界收敛（2026-10-08）

- **依据**：[工具与项目边界分析](2026-10-08-tool-and-project-boundary-analysis.md)（判据 J1–J10、违规 V1–V21、风险 A1–A7）
- **配套**：与 `2026-10-08-batch-index.md` 的 P1–P5 是**正交**关系——P1–P5 解决"跨项目/DSH/工作区*能力*缺口"，本批解决"**职责与边界**"，两者在 B2 阶段交汇（都用工作区 `projects.json`）。
- **执行纪律**：每个阶段有**停止条件**；不满足不得进下一阶段。**B0 全部是决策与只读登记，不改任何行为**——这是刻意的，因为 A1/A2/A3 三个风险都源于"先改行为后定边界"。

---

## 阶段总览

| 阶段 | 主题 | 性质 | 依赖 | 出口判据 |
| --- | --- | --- | --- | --- |
| **B0.0** | ✅ **已完成** — 插队修正在发生的事故 | 3 处小改 + 状态回滚 | 无 | ✅ 全部达标（见下节） |
| **B0** | ✅ **已完成** | 决策 + 只读登记 | 无 | ✅ ADR 0047（8 条重新评估触发条件）· ✅ `capability-ownership.yaml`（26 能力/7 层）+ 校验器接进 `pnpm check` · ✅ `projects.json`（11 顶层/28 条，v2）+ 校验器接进 `pnpm check` · ✅ B0.4 三支只读脚本（`boundary-audit` / `model-route-truth` / `path-split-report`）+ 别名表已生成 |
| **B1** | ✅ **已完成**（`file:tools/check-doc-status-anchors.mjs:1`） | 新增只读门禁 | B0 | ✅ **J1–J10 全部有机检手段**：J1/J5→`check:capability-ownership`、J9/J10→`check:project-registry`、J2/J3/J7→`audit:boundary`、J8→`audit:model-route:check`、**J4→`check:workspace-docs`**、**J6→`check:doc-anchors`**（带 baseline 棘轮 + STALE 反向检测）· ✅ **6 支检具各带负向控制**（7+11+10+12+18+15 断言）· ✅ `dsfolder/AGENTS.md` · ✅ `.gitignore` 判据修正（产物忽略 / 台账保留）· ✅ 综合验收 **15/15** · ⬜ 仅剩「把 `audit:*` 纳入常规节奏」 |
| **B2** | 🟡 **进行中**（`file:tools/boundary-audit.sh:150`） | 接线，不改语义 | B1 | ✅ `los mcp serve` 已接线进 **Codex**（⬜ 待真实调用）· ✅ **B2.3 provider 读侧统一** · ✅ **B2.4 记忆三层 canonical** · 🟡 **B2.1(a) D8 单一真源已完成**（跑出 session-index +17% 真回归）；⬜ B2.1(b)(c)(d) |
| **B3** | 合并与退役 | 删除/合并 | B2 | `dsfolder` 结构定性落地；无 VCS 目录清零；重复实现只剩一份 |

**为什么 B1 在 B2 前面**：今天"谁该消费谁"没有机械判据，先接线只会把错配固化。B1 让越界**可见且可回归**，B2 才敢动消费面。

---

## B0.0 ✅ 已完成（2026-10-08 15:20，三步全达标）

| 步 | 动作 | 状态 | 验收证据 |
| --- | --- | --- | --- |
| 1 | `tools/los-launchd-wrapper.sh:22` 的 PATH 补 `$HOME/.cargo/bin` | ✅ | 运行中网关（pid 78521）`ps -Eww` 的 PATH 含 `~/.cargo/bin`；`env -i PATH=<网关PATH> /bin/sh -c 'cargo --version'` → `cargo 1.97.0`（端到端） |
| 2 | 门禁三态收紧：环境故障 → exit 2/TIMEOUT，不得记 FAIL | ✅ | 分类逻辑提到模块级 `classifyRecord()`；自检 5 正例 + 2 负向控制（退出码 101 的 `cargo test` 与体积超预算**必须仍 FAIL**）；真实台账末条 11 个 FAIL **全部 → TIMEOUT**；`--repos fmtguard` 实跑 `documented PASS` + `size:dist PASS` |
| 3 | 回滚被污染状态 | ✅ | 走 `los run recover --apply --intent cancel`（状态机）：16 条 → cancelled + 2 条原 failed = 全终态；全库精确对账 `created 150→146`、`blocked 59→51`；Work Item 走 `PATCH /todos/:id`（带 `x-los-operator-token`）6 个 blocked → done，1 条重复 → cancelled |

**执行顺序的机制要点（只有懂这里才能做对）**：光改 wrapper 脚本不够 —— ① 运行中的 wrapper 是 bash，按**字节偏移**读脚本，改文件会让它从错位处继续解析；② 运行中的 gateway 环境里仍是旧 PATH；③ `los.sh:90` 会把**当前** PATH 写进 daemon 环境。正确顺序 = **停 wrapper（`launchctl bootout`）→ 停 gateway（`los.sh stop-gateway`）→ 用新 wrapper 起 gateway（`launchctl bootstrap`）**。executor 未受影响；本会话走 `deepseek-official` 直连，未被中断。

**⚠️ 更正我此前的一处判断**：我在分析文档里写"**没有 HTTP 端点能终止 run_spec ⇒ 按 AP1 不能回滚**"。**前半句对、结论错**：HTTP 端点确实没有，但 **CLI 有 `los run recover <id> --apply --intent cancel`**（`--intent recover|cancel|operator-attention`，需 `--operator-token`），它走 `transitionExecutionState` 状态机。**教训**：判断"某能力不存在"之前要把 CLI 子命令面也扫一遍，不能只 grep 路由文件。

**两处诚实记录**：
1. **`dsfolder/scripts/rust-repo-gate-run.mjs` 与 `rust-repo-gate-daily.sh` 是 `??` 未跟踪文件**（`git ls-files --error-unmatch` 报 "did not match any file(s) known to git"）⇒ 修复活在**无人版本控制**的文件里，任何 `git clean` 都会抹掉它。已做耐久化备份：`~/.dsh/backups/rust-gate-path-fix-20261008/`（含 wrapper 共 3 个文件）；「把这两个脚本纳入 VCS」并入 **B3.1**（并与 J10「无 VCS 的代码目录不得进入交付链」同源）。
2. 期间新增 1 条死信 `fetch failed`（13:00:17）——查证为**跨月既有模式**（全量 14 条，分布 06-30 / 08-18×5 / 08-20 / 08-21 / 08-25 / 09-03 / 10-08），且网关 outbox 全程 `published`、`retried=0` ⇒ **不是本次操作造成**。

**沉淀的新判据**（已并入 J6）：门禁必须把「环境故障」与「真实漂移」分开。混为一谈的代价是三重的——① 环境故障伪装成产品缺陷；② 真漂移被淹没（本例：`verify-gate` 已装 0.1.0 vs 源码 0.2.0 正被淹没）；③ 按假信号烧掉自动恢复额度（本例 6 次无效 planning，单次 prompt 123k–168k tokens）。

---

## B0：定调 + 事实面

### B0.1 三个待定调问题的决策（必须由 operator 回答并落 ADR）

| # | 问题 | 建议默认 | 若不决策的后果 |
| --- | --- | --- | --- |
| Q1 | **provider 冲突判定权 + 谁可改 DSH 默认模型**（注意："唯一写者"是错的问法——三个决策中心各自成立：`cc-switch`=桌面工具、**DSH 自己的 `agent-default-model`+`dsh-llm-fallbacks`=会话宿主**、`los gateway`=agent/headless/治理） | **(a) 冲突判定权给 los**（唯一有程序化接口与账本，且已在读 cc-switch DB）：三者指向不同上游时由 los **发现并报冲突**；**(b) DSH 的 `agent-default-model` 与 fallback root chain 属 DSH owner 权限，los 不得代改**；要 los 当统一入口必须显式改 DSH 默认并承担可用性责任 | A1：三处 active 不一致且无法判定谁对 |
| Q2 | **记忆的 canonical** | **分层**：`los-memory` = 个人长期记忆（跨项目、可检索）；los `packages/memory` = **执行记忆**（session/compaction/procedural，绑 run_spec）；DSH `~/.dsh/memories` = **会话工作记忆**（daily/MEMORY.md）。三者**不得互相复制正文**，只在需要时引用 id | A4：三处 canonical 未定，"某条记忆在哪"无法机械回答 |
| Q3 | **`dsfolder` 结构定性** | **方案 B**（母仓 + 独立子仓，补 `.gitignore` 排除 + 补 `AGENTS.md` 声明 + 用 `projects.json` 登记），**不转 submodule** | A3：子仓改动既不入父仓史也不可推 |

**产出**：`docs/adr/` 新增 3 条（或 1 条合并的"边界定调"ADR，含三段决策 + 重新拾起的触发条件）。ADR 必须写清**反面**（什么不该发生）。

**出口判据**：Q1–Q3 有书面结论；每条含"重新评估触发条件"。

### B0.2 能力归属表（`capability-ownership`）

新增 `docs/governance/capability-ownership.yaml`（+ 一个只读生成器 `tools/show-capability-ownership.mjs`）：

```yaml
version: 1
capabilities:
  - id: model-routing
    owner_layer: provider          # 唯一写者
    owner_object: "cc-switch(桌面) + los gateway(agent/headless)"
    readers: [los/discovery, codex, claude, grok, dsh]
    canonical_state: "cc-switch.db(桌面) / ~/.los/config.yaml+overrides(agent)"
    forbidden: "任何其他层写 active provider"
  - id: provider-credential-refresh
    owner_layer: provider
    implementations:            # 允许 >1，但必须登记并说明为何不能合并
      - { path: "auth/kimi-code.ts", scope: "kimi", cadence: "per-request" }
      - { path: "auth/xai-oauth.ts", scope: "xai", cadence: "async+fence" }
      - { path: "~/.local/bin/packycode-token-keychain", scope: "codex", cadence: "300s" }
      - { path: "cc-switch.db", scope: "claude/grokbuild", cadence: "app-managed" }
    forbidden: "把 scope 之外的 provider 交给这些实现"
  - id: rust-formatting
    owner_layer: tool
    tool: fmtguard
    consumers: [los(planned), dsh/rust-fmtguard]
    forbidden: "仓内直接用裸 cargo fmt 作为门禁"
  # verification / session-projection / memory / skills / mcp-tools / node-placement …
```

**规则（机械）**：`capabilities[].id` 必须唯一；每个 `owner_layer` 必须属于固定枚举（`global|workspace|project|tool|execution|session|provider`）；`implementations` 长度 >1 时必须带 `why_not_merge`。

**出口判据**：所有已知能力（≥15 条）登记完毕；`show-capability-ownership.mjs` 输出可读表；同层同 id 重复即红。

### B0.3 `projects.json` 补 `umbrella`/`children`

在 P2 L2-1 的 schema 上**加两个必填字段**以支撑 J9/J10：
- `kind: umbrella` 的条目**必须**有 `children[]`，且每个 child 在磁盘上存在；
- 新增 `vcs: git|jj|none` 与 `remote: url|null`：**`kind=repo` 且 `vcs=none` 必须显式登记豁免理由**（当前 `run-diff`、`session-index` 是 `none`）。

**出口判据**：`check-project-registry.mjs` 覆盖上述两条；`dsfolder` 的 6 个子仓 + `routeguard` + `win-exec` 全部在册。

### B0.4 只读盘点（三个脚本，不改行为）

| 脚本 | 作用 |
| --- | --- |
| `tools/boundary-audit.sh` | 一次跑出 §3 的全部违规证据（多份实现、越界引用、孤儿、无 VCS、文档状态无锚） |
| `tools/model-route-truth.mjs` | 输出 §2.2 的"配置 vs 生效"对照表（读 cc-switch.db、各工具 config、los config、session-index 的 `request/header`），**只读、值脱敏** |
| `tools/path-split-report.mjs` | 列出 `~/syncthing/project/*` 与 `~/syncfolder/project/*` 的会话分布与可映射关系（为 A6 的修复准备映射表） |

**出口判据**：三个脚本在本机 exit 0 且输出与本文档 §2/§3 的数字一致（作为交叉验证）。

---

## B1：机械判据 + 门禁

### B1.1 把 J1–J10 落成门禁

| 判据 | 门禁 | 放在哪 |
| --- | --- | --- |
| J1 单写者 | `check-capability-ownership.mjs`（读 B0.2 的 yaml，校验 owner 唯一 + 枚举合法） | los `pnpm check` |
| J2 引用方向 | `check-tool-layer-purity.sh`（扫描被登记为 `tool` 的仓，禁止出现项目名/`~/syncfolder` 路径/git 仓名） | 各工具仓 CI + los |
| J3 L0 纯洁 | `check-global-rules-purity.sh`（`~/.codex/rules`、`~/.claude/rules` 禁止具体端口/本机路径/项目命令） | dsfolder 脚本（本机门禁） |
| J4 L2 路径可解析 | P2 L2-2D 的 `check-workspace-docs.sh` | 工作区 |
| J5 无两份实现 | 由 J1 的 `implementations` + `why_not_merge` 覆盖（新增实现不改 yaml 即红） | los `pnpm check` |
| J6 计划/实现/证据三态 | P4 L4-3 的 `check-doc-status-anchors.mjs` | los `pnpm check` |
| J7 投影标明 canonical + 新鲜度 | `check-projection-freshness.mjs`（session-index / 看板 / 读模型必须暴露 `asOf` + 源路径；落后阈值报警） | los + dsfolder |
| J8 配置≠生效 | `tools/model-route-truth.mjs --check`（不一致即非零；允许白名单并写理由） | 本机门禁（不进 CI，因为读本机 GUI 状态） |
| J9 内嵌仓登记 | B0.3 的 `check-project-registry.mjs` | 工作区 |
| J10 无 VCS 不得进交付链 | 同 `check-project-registry.mjs` 的 `vcs:none` 规则 | 工作区 |

**出口判据**：每条门禁**带负向控制**（人为造一次违规必须红）。这是本阶段唯一的硬指标——**没有负向控制的门禁不算落地**。

### B1.2 `dsfolder` 的 `AGENTS.md`（跨子仓共同规则）

内容只写共同规则（对应分析 §4.2 方案 B）：
1. **本目录不是单一仓**：列出子仓清单 + 各自 `AGENTS.md` 入口；声明"父仓不跟踪子仓内容"；
2. **父仓只提交非仓内容**（`scripts/`、`docs/`、`.rust-los-gov/` 这类产物需明确忽略策略）；
3. **跨子仓修改规则**：改一个工具仓的模式要不要推广到其余仓 → 引用 `transferable-pattern-audit` 的四级可迁移性判据；
4. **验证纪律**：沙箱内/外、`fmtguard` 而非裸 `cargo fmt`、`verify-gate` 跑门禁；
5. **禁止**在父目录 `git add -A`（会误吞子仓目录或漏掉子仓改动）。

**出口判据**：在 `dsfolder` 起一个会话，system-reminder 里出现该文件；`git status` 在父目录不再把子仓目录列为未跟踪。

### B1.3 `.gitignore` 与产物策略

`dsfolder/.gitignore` 显式排除 6 个子仓目录 + `run-diff` + `session-index`（若决定保持独立），并把 `.rust-los-gov/`、`.fmtguard/`、`.publish-readiness/` 这类**运行产物**归入忽略或明确纳入（当前 `git status` 里它们以 `??` 出现，说明策略缺失）。

**出口判据**：父仓 `git status --porcelain` 只剩有意跟踪的内容；`git ls-files` 里不含子仓路径。

---

## B2：消费面收敛（让孤儿有主）

### B2.1 rust 工具的接线决策（逐个，不许「都接」）

口径已修正：**「6 个工具零消费者」是错的**。正确基线 = los 消费 2 / DSH 消费 3 / 待仲裁 1 / 退役或转评测 1。

| 工具 | 决策 | 接线内容 | 验收 |
| --- | --- | --- | --- |
| `unirun` | **保持**（los 已接；它是 los 自己的 ssh 传输层，不是外部工具） | 无新增；仅补网关 launchd PATH（见 B0.0） | `tools/los.sh doctor` 的 unirun 分支为 ok |
| `rustopt` | **不新增 los 代码**（**事实上已接**：`gates.json` 的 `size:dist` 就是 `rustopt check --build-profile dist --budget N --emit json`） | **修 D8 单一真源**：预算以仓内 manifest 为准，`gates.json` 只做带 hash 的快照 | 改预算只需改一处；跨仓一致性门禁能红 |
| `fmtguard` | **不接进 los**（口径修正）：它的输入是「agent 刚编辑了哪些 hunk」= **交互面信息**，los 的 E3 作业拿不到也不该拿；DSH 侧 `dsh-fmtguard` 已接且默认 dry-run | 补强：把 `fmtguard_doctor --requireVersion` 用到 CI（防「装的是旧版」） | doctor 能报出与仓内版本不一致 |
| `verify-gate` | **不接线到 los**；与 los verification 面**显式分层** | 仲裁规则只有一条：**「这个 check 失败后需不需要自动 revision/派 todo」→ 需要走 los，不需要走 verify-gate**；并要求其 `verdict` 三态在 DSH 侧如实透传（**不得把 exit 2 当 failed**） | 三态透传有测试；los 不再把超时/非 0 无条件记 failed |
| `sandbox-run` | ✅ **已裁决（2026-10-08）**：**不是单 owner，是分层 + 可插拔后端** | **los 拥有隔离资源的身份与生命周期**（账本不下放）；**具体机制由 `IsolationBackend` 提供**，`sandbox-run` 是其中**一个后端**（覆盖 docker），los 内建 `jj-workspace`/`git-worktree`；后端**只返回原始结果、不返回 PASS/FAIL**；显式指定不可用 **fail-closed 报因，禁止静默回落** | 见仲裁文档 C1–C5：契约 + `vcsKind`→`backend` 迁移 / 两内建后端 / docker 适配器 / 配置面 /（sandbox-run 自己）`enum`→`trait` |
| `run-diff` | ✅ **已裁决（2026-10-08）：归档退役**（保留代码，移出交付链） | 零消费者（二进制不存在；los 侧 2 处命中是 e2e fixture 字符串）+ 无排期 + **无 VCS** 三者同时成立 ⇒ 按 A3 退役。**不删代码**（1,296 行已验证逻辑是现成参考实现）：移入 `dsfolder/archive/`、从 `rust-repo-snapshot.mjs` 与 `rust-cold-build-budget.sh` 的 REPOS 名单移除、`projects.json` 标 `kind: archived` + `archivedAt`/`archiveReason`/`reviveCondition`。**复活条件**：需"改 prompt/模型/effort 后行为好坏的机械对比"时，作为 **DSH 评测面组件**复活，**必须先纳入 VCS** | 登记已生效（校验器 +R11/R12 archived 规则，11/11 负向控制） |

**出口判据**：capability-ownership 表里这 6 条的 `consumers` 与代码实际一致。

### B2.2b cantool / cankey / canpad：共性能力抽象 + 边界规则

**operator 口径（2026-10-08，权威）**：**cantool 与 cankey 是有共性能力的不同应用**；部分能力可**抽象**共同使用，但**基于输入法与应用启动器的使用场景和边界不一样**；**两者不需要强耦合，可以各自独立使用**。（详见 ADR 0047 第 7 节。）

**实测耦合为 0（支持该口径）**：cankey 全仓仅 1 处 cantool 提及（`crates/cankey-config/bundles/config.example.toml:54` 注释掉的示例 socket）；`cankey-sidecar` 自述 "Optional CanTool IME sidecar client. **Not used in `Engine::step`.**"；cantool 侧对 cankey 引用为 0；canpad 全文 0 次提 cankey。

**共性能力抽象原则（A1–A4）**

| # | 原则 |
| --- | --- |
| A1 | 共性能力抽象到**独立可发布单元**，不落进任一应用内部；**禁止 A 应用引用 B 应用的内部 crate** |
| A2 | 抽象是"**共同使用**"不是"共同拥有"：独立单元有自己的写权与发布节奏 |
| A3 | 抽象必须由**第二个真实消费者**证明（两应用都已在用才抽出） |
| A4 | **不强耦合 = 任一方可单独构建/安装/使用/发布**；判定：cankey 在**没有 cantool 安装**的机器上必须完整可用，反之亦然 |

**边界规则（R1–R6）**

| # | 规则 | 机械检查 |
| --- | --- | --- |
| R1 | **击键所有权只在 cankey**（`cankey-core`/`-protocol`/`-config`/`-lexicon` 写权独占）；cantool 不得把平台依赖反向塞入 | `cargo tree -p cankey-core` 不得出现 `objc2*`/`tauri`/`tokio`/`reqwest`；`grep -rn cankey cantool/src-tauri` 必须为空 |
| R2 | **输入注入类改动必须先判定"谁拥有击键"**；不得复制或绕过 cankey 的投递协议（应**调用**而非再造一条注入路径） | PR 模板一项；`rg 'NSWorkspace\|TIS\|SecureInput' cantool/src-tauri` 需与 cankey 能力表对齐 |
| R3 | 协议写权只在 cankey；**`cankey-sidecar` 是可选扩展点，禁止变成必需**（否则违反 A4） | cankey 的 `default-members`/`apps/*` 不得出现"缺 sidecar 即失败"；`Engine::step` 不得出现 sidecar 调用 |
| R4 | canpad→cantool 只允许「探针 + 消费已发布端点」（只许 `GET /v1/capabilities`），**禁止定义新端点** | canpad 侧出现 `POST /v1/<新路径>` 到 cantool 即红 |
| R5 | canpad 配置类型写权在 `canpad-core`，生成物不手改 | `npm run contracts:generate && git diff --exit-code` 型门禁 |
| R6 | 三仓各自独立 VCS 与发布；**禁止一个 PR 跨两仓**；共享能力抽出**另立变更** | 跨仓需求开 N 个变更（N = 被改仓数） |

**最该先做（2 行文档，且不建立耦合）**：`cantool/AGENTS.md` 的 Read Order 加一行指向 `cankey/docs/design/architecture.md`（作为**相关应用**而非依赖），Hard Invariants 加一条「输入注入类改动必须先判定击键所有权；不得复制或绕过 cankey 的投递协议」。

### B2.2 `los mcp serve` 接线或下线（ADR 0031 的兑现）

ADR 0031 说 MCP 是**唯一**程序化接口，但 4 个工具零消费者（V7/V13）。二选一：

| 选项 | 动作 | 验收 |
| --- | --- | --- |
| **接**（推荐） | 至少把 `los mcp serve` 挂进**一个**真实宿主：DSH headless profile（定时任务需要读 los run 状态）或 Codex（`~/.codex/config.toml` 的 `mcp_servers`） | 真实会话调用过 `los_run_state`（session-index 有记录） |
| **下线** | 从 CLI/README/对外表述里移除，并在 ADR 0031 补"未接线"的实际状态 | 无"已实现能力"的假象 |

**出口判据**：capability-ownership 里 `mcp-tools` 的 `consumers` 非空，或明确标 `deprecated`。

### B2.4 ✅ 已完成（2026-10-08）—— 记忆三层 canonical 声明 + 跨层写入门禁 — `file:docs/governance/memory-canonical.yaml:1`

**产出**：`docs/governance/memory-canonical.yaml`（3 层，每层含 `canonical_for` / `canonical_object` / `storage` / `writer` / `code_roots` / **`forbidden`** + 3 条 `cross_layer_rules`）+ `tools/check-memory-canonical.mjs`（`check:memory-canonical`，`check` 链第 17 步）。

| 层 | canonical 对象 | 存储 | writer |
| --- | --- | --- | --- |
| personal-longterm | `los-memory` | SQLite + Nowledge（primary）+ shadow 只读镜像 | `los-memory` |
| execution | los `packages/memory` | **Postgres 表**（`observations`/`memory_compactions`/`procedural_candidates`/`memory_fts`）—— **刻意不落文件系统** | los memory module |
| session-working | `~/.dsh/memories` | 文件系统 | **第三方插件 `dsh-memory-evolve`**（los 侧只读） |

**四道校验**：M1 三层层齐备且每层 `forbidden` 非空；M2 存储路径存在（缺失只 warn）；**M3 跨层写入扫描**（核心）；M4 至少一层 `kind=postgres`。

**M3 突变测试暴露并修掉一个真盲区**：首版仅**字面字符串**匹配 ⇒ 注入动态构造（`` `${homedir()}/.dsh/memories/MEMORY.md` ``）**漏检（rc=0）**。补启发式 `looksLikeDynamicCrossWrite()`（同行同时出现 ① home 解析与 ② 记忆目录段）。复测：**字面注入 rc=1、动态注入 rc=1**，两次 sha256 还原一致，真实仓库 **0 假阳性**。

**扫描面核实**（防"看着在检查其实没扫"）：三层实收文件 **410 / 41 / 2**（personal 层含 `los-memory` 真实源码 131 个）。**负向控制 11 断言**，完整验收 **15/15**。

---

### B2.3 ✅ 已完成（2026-10-08）—— provider 面的读侧统一（Q1 落地）— `file:packages/infra/src/provider-route-conflicts.ts:1`

**实现**：`packages/infra/src/provider-route-conflicts.ts`（纯函数）+ `ConfigSchema.providerRouteConflicts` + `mergeDiscoveredProviders` 接线 + **operator-gated** `/settings/private` 暴露（公开 `/settings` 不返回，已加负向控制测试）。

**三态区分（关键设计）**

| 态 | 含义 | 去处 |
| --- | --- | --- |
| `conflicts` | **跨决策中心**覆盖（如 operator yaml 被 cc-switch 覆盖） | 进 config + WARN 日志 |
| `sameCenterVariants` | **同决策中心内**差异（cc-switch 的 codex vs grokbuild 路由） | 只 INFO 日志，**不进 config** |
| `unverifiable` | apiKey 两侧脱敏成 `<redacted>` ⇒ **不可判等** | 明示"未验证"，**不当作无冲突** |

**判据修正（端到端跑出来才发现）**：首版按**完整 source 字符串**判同一来源，把 cc-switch 的 codex 路由（`api-slb.packyapi.com`）与 grokbuild 路由（`cf.api.fan`）误判为跨中心冲突 ⇒ `/settings/private` 实测 **2 条误报**。修法 = `sourceNamespace()` 归一 + apiKey 不可判等单列 ⇒ 修正后 **`providerRouteConflicts: []`**，误报消除而可观测性保留（INFO 日志）。

**验证**：新单测 **16/16**（6+ 负向控制）、infra 全包 **75/75**、新 `settings-routes.test.ts` **3/3**（含"公开路径不泄露"负向控制）、gateway 相关 **23/23**、仓内 9 项门禁全绿、端到端 operator 可见 / 公开 0 命中。

**Q1 结论落地情况**：**冲突判定权归 los** ✅（本项）；**los 不得代改 DSH 默认模型** ✅（`audit:boundary` 的 R1 段已在检查）。

---

### B2.3 provider 面的读侧统一（Q1 落地）

按 B0.1 的 Q1 结论实施（**三个决策中心都保留，los 只做冲突判定**）：
- **桌面侧**（cc-switch 管）→ 只**读**，产出 `model-route-truth` 表；
- **DSH 会话侧**（DSH 自己的 plugin+profile 管）→ **只读并记录** `agent-default-model` 与 `fallbacks` 配置作为"声明值"，**不得代改**；
- **agent/headless 侧**（los 管）→ los 的 provider 配置落盘（P4 L4-1 的 overrides）+ `credentialClass` 字段；
- **禁止**：los 用 cc-switch 的 `is_current` 覆盖自己的 provider 真相而不标注来源（今天 `config-sources.ts:148` 就是这么做的）——改为**标注** `source: cc-switch(current)`，并在三方声明不一致时**显式报冲突**而不是静默覆盖。

**出口判据**：`model-route-truth.mjs --check` 在"配置=生效"时 exit 0；人为把 Codex 的 base_url 改成与 cc-switch active 不符 → **报冲突**（而不是静默）。

### B2.4 记忆三处 canonical（Q2 落地）

- 三处各自声明 `canonical_for`（个人长期 / 执行 / 会话工作）；
- 交叉引用只允许**引用 id**，禁止复制正文；
- 新增门禁：三处的写入路径不得互相写对方存储（grep 各自代码库的目标路径）。

**出口判据**：capability-ownership 的 `memory` 条目有 3 个分层 owner；负向控制：模拟"los 写 `~/.dsh/memories`" → 红。

---

### B2.1 🟡 进行中 —— rust 工具的接线/收敛

**(a) ✅ 已完成（2026-10-08）—— D8 单一真源：`rustopt` 体积预算改为「自证依据」** — `file:tools/boundary-audit.sh:1`

- **实证**：`.rust-los-gov/gates.json` 的 `repos[].checks[].budget` 是硬编码绝对字节数，runner 读它传 `rustopt --budget`；实测真源在各仓 `.rustopt/runs.jsonl` ⇒ 同一数字两处。
- **自动推导失败（已写进代码注释防重犯）**：`budget = ceil(measured × 1.05)` 用 5 个真实实例验证**五例全不符** ⇒ 不猜公式；预算本质是人工策略值（约 +5% 手工余量）。
- **新模型**：台账 = 实测唯一真源；预算须自证 `basisMeasuredBytes` / `basisLedger` / `basisFrozenAt` + 两个**独立**比值 `driftTolerance`（依据新鲜度）与 `headroomWarnBelow`（余量线）。判据：`attested` / `attestation-stale` / `headroom-low` / `over-budget` / `no-measurement`（不算通过）/ `no-budget`（纯信息）/ `no-budget-but-measured`（真缺口）/ `disabled`。
- **`--auto-attest`**：自动门禁每次跑都推进台账末次 ⇒ 依据必然陈旧；只在实测**仍落在已声明容差内**时刷新，**越界则保持陈旧 + rc=1 升级给人**（首跑 refreshed 4 / held 1）。
- **实测真发现**：`session-index` 二进制 **1259552 → 1476048（+17.19%）** 首次超预算 ⇒ auto-attest 正确 hold 且未刷新 basis（不掩盖回归）。
- **自检 46 断言**；工具 `dsfolder/scripts/{lib/rust-budget-attestation.mjs,rust-budget-check.mjs}`，提交 `d0d2c9b` + `fe30253`。
- **顺带**：`run-diff` 在 gates.json 里 `enabled: true`（已于本日归档）⇒ 改 `false` + reason；`projection.note` 声明该文件是**派生投影、非真源**。

**(b) ✅ 已完成（2026-10-08）—— `fmtguard doctor` 环境探测进 CI；版本契约落到实处** — `file:tools/los-governance-daily.sh:1`

- **旗标名纠正**：是 `--require-version`（kebab-case），计划里写的 `--requireVersion` 不存在。
- **位置纠正（重要）**：`--require-version` 的 `--help` 设计意图是「**use it in AGENTS.md to catch a stale install**」⇒ 属**本地/agent 侧**。CI 里二进制是本 job 刚 `cargo build` 的，版本必然等于 `Cargo.toml`，硬编码版本号是**恒真的同义反复**。故 CI 只做：`doctor` 环境探测 + 用 `cargo metadata` **派生**版本校验接口可用（`>=` 语义与退出码）+ **负向控制**（99.0.0 必须 fail-closed exit 2）。
- **真正的半边已落地**：新增 `dsfolder/scripts/check-toolchain-freshness.mjs`（自检 16 断言），覆盖 **unirun / rustopt / fmtguard / sandbox-run / verify-gate** 五个工具的本机二进制 vs 源码版本；结果接进治理日报新行「工具链新鲜度」。判据五态（`fresh`/`stale`/`not-installed`/`no-source`/`error`，`error` **不算 fresh**）。
- **跑出并修掉一个真问题**：`verify-gate` 本机装的是 **0.1.0 而源码 0.2.0** ⇒ **同日做的"全 na 不算 pass"三态修复在本机根本不生效**。已 `cargo install --path . --locked` 重装到 0.2.0，复核 5/5 fresh，并验证新二进制行为（全 na ⇒ `inconclusive` + exit 2）。
**(c) ✅ 已完成（2026-10-08）—— `verify-gate` 三态透传；修掉静默绿灯「全 `na` 被当 pass」** — `file:tools/boundary-audit.sh:1`

- **契约取证**：per-check `result` 三态 `pass|fail|na`；顶层 `exitCode` 三态 `0/1/2`；顶层 `verdict` 只有 `pass|fail`。`na` 来自 check 的 `enabled=false` 与 policy 规则的 `scope` 不匹配（`policy.rs:342-350`）。
- **静默绿灯**：verdict 原为 `if failed == 0 {"pass"}` 而 `na` **不计入** `failed` ⇒ "所有 check 都 disabled / 都作用域不匹配"报 `pass` + exit 0。且 `na` 计入 `report.checks`，故 `manifest.rs:182` 的 `empty gate = false confidence` 守卫**不触发**（只覆盖"清单为空"）。与 2026-10-08 门禁假红同类：**状态被压平**。
- **修法**：`failed==0 && pass==0 && total>0` ⇒ `verdict:"inconclusive"` + **exit 2**（与 tool error 同码 = "判不了"，绝非"通过"）；`cmd_run` + `cmd_policy` 两条路径都改。
- **连带真 bug**：`report::build()` 自己重算 verdict，把 `inconclusive` 覆盖回 `pass` ⇒ 退出码对但 **JSON 契约错**（插件消费的正是 JSON）。改为由调用方传入 `verdict`/`pass`，并新增 `passed` 字段（此前报告无任何 `na` 计数）。
- **测试**：既有 `G10` 的 `na.toml` 是**混合**清单，**从未测过全 `na`**（盲区）；新增 `test/fixtures/all-na.toml` + `G10b` + 负向控制；**突变测试**确认回退修复即红。
- **插件侧**（`dsh-verify-gate`）：`na` 用独立标记 `–`（不与"未知态 `·`"混淆）+ 三态计数行 + 全 `na` 警示"不构成通过"。
**(d) ⬜ `sandbox-run` 按裁决 C1–C5 组件化**（起点 = `IsolationBackend` 契约 + `vcsKind`→`backend` 数据迁移）

---

## B3：合并与退役

### B3.1 `dsfolder` 结构落地（Q3 结论）

| 动作 | 判据 |
| --- | --- |
| `.gitignore` + `AGENTS.md`（B1.2/B1.3 已做） | 父仓 status 干净 |
| `run-diff` / `session-index` 纳入 VCS | `vcs != none`；有 remote 或显式登记"本地专用" |
| `routeguard` 补 remote 或登记"本地专用" | 同上 |
| 父仓 `docs/` 里"哪些是设计、哪些是产物"分离 | `.rust-los-gov/` 等产物有明确忽略/归档策略 |

### B3.2 重复实现的合并（逐个，带"为什么不早合并"的复盘）

| 目标 | 动作 | 风险 |
| --- | --- | --- |
| V3 格式化门禁 | 各 Rust 仓的格式检查统一走 `fmtguard`；删除裸 `cargo fmt --check` 门禁 | 需逐仓验证 fmtguard 的 scope 语义与现有 gate 等价 |
| V4 验证门禁 | 明确分工：`verify-gate` = 执行 manifest；仓内 `check-*.sh` = 仓特定不变量；los `verification_records` = 账本。**三者的边界写进 capability-ownership** | 不能一刀切合并（仓不变量确实属于仓） |
| V5 会话投影 | **不合并**：DSH 投影管"跨会话检索"，los 账本管"执行证据"。但**必须能 join**（用 `session_id` 或 trace 关联） | 需要两侧都暴露稳定的关联键 |
| V6 skills 三处 | 明确：DSH `~/.agents/skills` = 可执行工作流（唯一执行面）；los `skills` 表 = **投影/登记**（供治理与检索，不执行）；`~/.codex/skills` = Codex 自己的（不跨用）。给 los 的 `usage_count=0` 一个解释：它是投影，不消费 | 需要决定 los `skills` 表是"投影"还是"要执行的"——建议前者 |

### B3.3 路径分裂的历史映射（A6）

一次性产出 `~/.dsh/storages/path-alias-map.json`：`/Users/echerlos/syncthing/project/X` → `/Users/echerlos/syncfolder/project/X`，供 P1 的读模型在归项目时使用；并把映射版本化（改则 bump）。

**出口判据**：P1 的 `dsh_session_catalog` 能把 214 条旧路径会话归到今天的仓；映射表缺失时降级为 `unknown` 而非静默丢弃。

---

## 每个项目的执行手册（把判据落到日常）

| 项目 | 谁可以写 | 必须消费的工具 | 跨仓规则 | 常见越界 |
| --- | --- | --- | --- | --- |
| **cantool** | 本仓 agent；**不得**直接改 cankey | `fmtguard`/`sandbox-run`/`verify-gate` | 经 `cankey-protocol` 与 cankey 交互；不依赖 cankey 内部 crate | 把 cankey 当子目录改 |
| **cankey** | 本仓 agent；core 零平台 API（AGENTS 已立） | 同上 + `rustopt`（体积预算） | 协议改动必须同轮改两侧并各跑门禁；**不得**读 cantool 平台 API | 把"协议冻结"当"Host 已实现" |
| **canpad** | 本仓 agent | 同上 | **与 cantool/cankey 无契约**；只共享模式（Rust core + 生成契约 + 单一 invoke 出口） | 复制 cantool 代码而非模式 |
| **lot2extension** | 本仓 agent | 自有 e2e + `verify-gate`（如需） | 与 los 的集成只走 feed-analysis 契约；不读 los 内部表 | 把 los 当数据源直连 |
| **wechatdp** | 本仓 agent | 自有 ETL 工具链 | 数据搬运**不进 los**（los 非目标） | 让 los 承担冷层搬运 |
| **lzlyx** | 本仓 agent | **应**接 `fmtguard`/`sandbox-run`/`verify-gate` 降单轮步数 | 独立项目 | 长循环耗尽上下文（比值 137.8） |
| **dsfolder** | 父目录只改非仓内容 | — | 见 B1.2 的 5 条 | 父目录 `git add -A` |
| **los** | 本仓 agent | `unirun`（已接）+ B2.1 新增 3 个 | 消费工具，不复制工具逻辑 | 把门禁逻辑搬进 los |

---

## 依赖与工期

```
B0（决策+登记，1 个会话）
  └──> B1（门禁+文档，1-2 个会话）
         └──> B2（接线，2-3 个会话）
                └──> B3（合并+退役，1-2 个会话）
```

- **B0 不能省**：Q1/Q2/Q3 未答就动 B1 的门禁，会把错误的边界固化成 CI 门禁。
- **B1 与 P2 L2-1/L2-2 可并行**（同一个 `projects.json`，注意合并写者）。
- **B2 的 fmtguard/sandbox-run/verify-gate 接线与 P3 的 L3-1（blocked_reason 契约）有交集**：接线时若遇沙箱拒绝，用 L3-1 的 typed reason，不要新造一套。
- **B3 的 V6（skills 定性）会影响 P1 L1-2**：先定"los skills 表是投影"再写读模型，否则读模型会试图"执行"技能。

---

## 本批的停止条件

出现以下任一情况，**停在当前阶段**并回报，不得继续：

1. Q1/Q2/Q3 中任一未决策（B0 无法出口）；
2. 任一门禁无法给出负向控制（说明判据不可机械检查，需重写判据）；
3. `dsfolder` 的 `.gitignore`/`AGENTS.md` 改动会**影响子仓已跟踪内容**（需先确认子仓工作副本干净，否则先冻结）；
4. 接线某个 rust 工具时发现它的退出码语义与 los 的 verification 契约冲突（先谈契约，不改工具）；
5. 任何需要改 `cc-switch` 行为的动作（它无 API，属 GUI 手工动作，须 operator 亲自做）。

---

## 附：4 项裁决结果（2026-10-08）

| # | 事项 | 裁决 | 依据 |
| --- | --- | --- | --- |
| D1 | B0.0 是否立即修 | ✅ **已修完**（`file:tools/los-launchd-wrapper.sh:22`） | ADR 0047 第 6 节（门禁三态） |
| D2 | `requiredChecks` 双求值器 | ✅ **拆两个字段**（`shell` / `toolTrace`）—— 落地见 B2.1（`file:docs/architecture/2026-10-08-phased-development-plan.md:1`） | 两者语义不同且一个要 shell 一个禁 shell |
| D3 | `sandbox-run` vs `managed-workspaces` 隔离 owner | ✅ **不是单 owner，是分层 + 可插拔后端**（los 管账本；`IsolationBackend` 管机制；`sandbox-run` 是 docker 后端） | `file:docs/architecture/2026-10-08-arbitration-isolation-owner-and-run-diff.md:1` §3 |
| D4 | `run-diff` / `los mcp serve` | ✅ `run-diff` **归档退役**（不删代码，写复活条件）；`los mcp serve` **接线**（ADR 0031 已 Accepted；`file:tools/boundary-audit.sh:150`） | 同上 §4 |

---

## 附：需要评审人先裁决的 4 件事（2026-10-08 增补）

| # | 事项 | 建议 | 不做会怎样 |
| --- | --- | --- | --- |
| D1 | **B0.0 是否立即修** | **立即** | 每天 15 分钟的假红 + 每轮 6 仓各一次无效 planning（实测单次 prompt 123k–168k tokens）+ 6 个 Work Item 永久 blocked |
| D2 | **`requiredChecks` 双求值器**：拆两个字段，还是保留一个但强制声明 channel？ | **拆两个字段**（`requiredChecks.shell` / `requiredChecks.toolTrace`），因为两者语义不同且一个要 shell 一个禁 shell | 同一条缺陷换个 check 就复现；"模板已修好"但 `verification_records` 里没有对应 check |
| D3 | **`sandbox-run` vs los `managed-workspaces` 的隔离 owner** | **owner = `sandbox-run`**（跨语言、不绑 jj），los 只负责**发起 + 记录** | 两条隔离路径各演进 ⇒"验证通过"在两条路径下含义不同（dsfolder 已挂了一个批次的未决项） |
| D4 | **`run-diff` 与 `los mcp serve`**：排期还是退役？ | `run-diff` **退役**（0.1.0 / 7 test / 3 依赖，成本最低；二进制与 `~/.cargo/bin/run-diff` 都不存在）；`los mcp serve` **接线**（ADR 0031 已 Accepted，且 `dsh-los-ops` 证明 DSH 侧确实需要 los 工具） | 两者都是"零消费者 + 无排期"，而 ADR 0031/0036 都写成已接受设计 ⇒ 每次盘点都要重新论证（评审成本） |

## 附：本轮对早先文档的三处事实纠正（写文档前必读）

| # | 早先表述 | 实测 | 出处 |
| --- | --- | --- | --- |
| C1 | "`dsh-session-index` 插件没装进 desktop profile，需装 web+headless+desktop 三档" | **web 已装**（`~/.dsh/profiles/web/package.json:25,64` 有 `link:` 与 bundle 条目）；**desktop 未装** | 本轮实测；P1 文档 L1-1 需相应改为"只补 desktop" |
| C2 | "`dsfolder` 子仓各有 `AGENTS.md`"（P2 文档 :33、batch-index :55 都这么写） | **只有 `unirun/AGENTS.md` 与 `sandbox-run/AGENTS.md`**；`rustopt`/`fmtguard`/`verify-gate`/`run-diff`/`session-index` **都没有** | `find dsfolder -maxdepth 2 -name AGENTS.md` → 2 条 |
| C3 | "`verify-gate` 0.2.0" | **已安装二进制是 0.1.0**，源码才是 0.2.0 ⇒ 这本身就是一条未被发现的漂移（正好被 B0.0 的假红淹没） | `~/.cargo/bin/verify-gate --version`；`dsfolder/verify-gate/Cargo.toml:3` |

---

## B0.4 ✅ 已完成（2026-10-08，三支只读脚本 + 别名表）— `file:tools/model-route-truth.mjs:1`

| 脚本 | 回答什么 | 负向控制 | 真实结论 |
| --- | --- | --- | --- |
| `tools/model-route-truth.mjs` | **J8**：配置 vs 生效 vs **owner** 三列对照（三个决策中心） | 10 断言（脱敏 3 + TOML 3 + DSH 4）；**冲突路径**用假 `lsof` 强制监听探测失败 → `claude` 判 `conflict` 且 `--check` **rc=1**，恢复后 rc=0 | 6 条路由全 `consistent`；**流量观测实测** DSH 声称 `deepseek-official`，实际 594 次 vs 6 次 ⇒ 支持"DSH 自己就是其模型路由 owner"的定性 |
| `tools/path-split-report.mjs` | A6：项目根迁移造成的路径分裂 + **可映射性** | 2 正 + 10 负/边界断言（含"旧路径不在盘上且无声明 ⇒ unmapped，不猜"、"当前根不产生条目"、"最长前缀优先"） | **verified=0**（三个历史根 `~/syncthing/project`、`~/Downloads/projects`、`~/projects` **磁盘上均已不存在**）⇒ 机械验证不可能；**declared=8**（带 `basis`/`declaredBy`/`declaredAt`/`target-exists` provenance）；`unmapped 未知=0`；另单列 6 条非项目 cwd |
| `tools/boundary-audit.sh` | J1/J2/J3/J7/J8/J10/R1/R6/X6 + 孤儿入口，一次跑出证据 | 三条判据在运行中**被实测收窄**（见下） | **ERROR=0 / WARN=3**（X6 归属待收口、`los mcp serve` 零调用、`dsfolder/scripts` 31 个未跟踪文件） |

**运行中被实测收窄的两条判据（重要，属"判据过宽会产生假红"的自我纠正）**：

1. **J2（引用方向）** 原判据"tool 层出现项目名即 ERR"过宽 ⇒ 实测三条命中里只有 **1 条是真缺陷**：
   - `fmtguard/src/events.rs:111` = doc comment（历史背景）→ 无害
   - `session-index/src/main.rs:51` = help string 示例 → 无害
   - **`verify-gate/src/policy.rs:639,641` = 测试夹具硬编码 `/Users/echerlos/...` 本机项目路径 → 真缺陷**（不可移植 + 把项目带进工具层）
   **已修**：改为合成路径（`/srv/work/srv-demo` / `/srv/work/other-app`），语义不变（该测试验的是 `scope.workspace` **子串**匹配）；`fmtguard --scope-from-git` 报 `ok — 0 file(s) changed`；窄验证 `cargo test workspace_scope_substring_match` → **1 passed**。判据相应改为两级：**硬编码本机绝对路径 = ERR；注释/help 里的项目名 = INFO**。
2. **J10（无 VCS）** 原判据不看登记表 ⇒ 与 `projects.json` 自相矛盾（三条其实都已登记豁免）。**已改为 registry-aware**：读 `vcsExemptReason` / `kind=archived`，已登记者报提示、**未登记者才 ERR**。

**新增 pnpm 脚本**（本机门禁，**不进 CI** —— 它们读本机 GUI/DB 状态）：`audit:boundary` / `audit:model-route` / `audit:model-route:check` / `audit:path-split` / `audit:path-split:write`。
**别名表已生成**：`~/.dsh/storages/path-alias-map.json`（schemaVersion 2，供 P1 L1-2 的只读读模型归项目用）。

---

## B1 ✅ 已完成（2026-10-08，J1–J10 判据全部就位）— `file:tools/check-doc-status-anchors.mjs:1`

**判据 → 检具映射（每支都带负向控制，断言数在括号里）**

| 判据 | 检具 | 断言 | 位置 |
| --- | --- | --- | --- |
| J1 单写者 / J5 无两份实现 | `check:capability-ownership` | **7** | `pnpm check` |
| J9 内嵌仓登记 / J10 无 VCS 不进交付链 | `check:project-registry` | **11+1** | `pnpm check` |
| J2 引用方向 / J3 L0 纯洁 / J7 投影新鲜度 | `audit:boundary` | 运行中收窄判据 | 本机 |
| J8 配置≠生效（且指明决策中心） | `audit:model-route:check` | **10** | 本机 |
| **J4 L2 路径可解析** | `check:workspace-docs` | **15** | `pnpm check` |
| **J6 计划/实现/证据三态** | `check:doc-anchors` | **18** | `pnpm check` |

**本轮新增两支 + 三处自我纠正**

1. **J6 `tools/check-doc-status-anchors.mjs`（268 行）**：状态断言行必须带 `commit:` / `file:line` / `adr:` 之一；`file:line` 的**行号必须在文件行数内（不放宽）**。存量债走 **baseline 棘轮**（建成时 **30 条**）+ **STALE 反向检测**。自检抓到两个真 bug：① `verifyAnchors` 硬用模块级 `ROOT` 无法注入测试根；② 状态行正则**过宽**（把纯描述与 `| done |` 枚举当断言）。棘轮双向实测：注入无锚行 → rc=1；补锚 → 报 STALE 且 debt 30→29。
2. **J4 `tools/check-workspace-docs.mjs`（261 行）**：W1 路径引用必须可解析；W2 `WORKSPACE.md` 的 `projects/<name>` 声明必须真实存在或**已澄清**不在磁盘。自检连抓三个真 bug：① 相对引用必须相对**所在文件目录**解析；② 字符类在 `<`/`$`/`*` 前截断造成假阳性 ⇒ 改为抓完整 token；③ `$HOME` 被"未定义变量"规则误杀。
3. **实测修复两处文档漂移（盘点 G8/G9）**：`los-memory/AGENTS.md` 的 4 处 `~/projects/los-workspace/*` → `~/syncfolder/project/los-workspace/*`；`WORKSPACE.md` 目录树只列实际存在的 `los`/`weclaw`、身份表历史行标 `legacy · 不在磁盘`、并加**权威指引**（拓扑以 `.workspace/projects.json` 为唯一真源）。

**W2 的语义纠正（值得复用）**：标了"历史/legacy"**且**写明"不在磁盘/已移除" = **已澄清**（不该 warn）；只标"历史参考源"却仍列在目录结构表里 = **未澄清**（才 warn）。这条区分避免了"一标 legacy 就永久豁免"的漏洞。
