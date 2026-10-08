# ADR 0047: Tool, Project, and Provider Boundary Ownership

- **Status**: Accepted（2026-10-08）
- **Date**: 2026-10-08
- **Supersedes**: `docs/architecture/2026-10-08-tool-and-project-boundary-analysis.md` §7 的"需要 operator 定调的 3 个问题"（该节自此为历史记录）
- **执行计划**: `docs/architecture/2026-10-08-phased-development-plan.md` B0–B3
- **范围**: 本机 AI 工具层（DSH / Codex / Claude Code / Grok / cc-switch）、项目仓层（cantool / cankey / canpad / lot2extension / wechatdp / lzlyx / los / dsfolder 及其 6 个 Rust 工具仓）、los 执行与证据层。**不涉及** los 内部架构（那是 ADR 0001–0046 的领域）。

---

## Context

2026-10-08 的全量盘点（`docs/operations/2026-10-08-los-inventory.md`）与随后的边界取证（`docs/architecture/2026-10-08-tool-and-project-boundary-analysis.md`）发现：

1. **同一能力存在多份实现且无冲突判定规则**：provider 路由有 **3 个各自成立的决策中心**（`cc-switch` GUI :15721 管桌面工具；DSH 自己的 `agent-default-model` + `dsh-llm-fallbacks` 管会话宿主；`los gateway` :8080 管 agent/headless/治理）；凭证刷新有 4 份；验证门禁有 3 层；会话投影有 2 套；skills 有 3 处（`~/.agents/skills` 72 ∩ `~/.claude/skills` 32 = **11 个同名**）。
2. **文档级权威互相矛盾且无门禁会发现**：`los/docs/governance/toolchain-matrix.md` 判"外部 transcript 只当比较输入"，而 `dsfolder/RUST-REPO-LOS-GOVERNANCE-DESIGN-2026-10-07.md` 判"工具 `runs.jsonl` 可作外部证据引用"。
3. **记忆有三个候选 canonical**：`los-memory`（SQLite）/ los `packages/memory`（Postgres）/ DSH `~/.dsh/memories`（**由第三方插件 `dsh-memory-evolve` 拥有**，`lib/index.js:402-404`）。
4. **`dsfolder` 是"仓套仓且未登记"**：父目录是 git 仓，6 个子目录是**内嵌独立 git 仓**，但**无 `.gitmodules`、无 gitlink** ⇒ 父子都无法版本化对方；且 `dsfolder/scripts/rust-repo-gate-run.mjs`、`rust-repo-gate-daily.sh` **完全未跟踪**（`git ls-files --error-unmatch` 报 "did not match any file(s) known to git"）。
5. **一起正在发生的事故**：网关 PATH 缺 `~/.cargo/bin` ⇒ 每日 rust 门禁 6 仓 11 check 全部以 exit 127 失败，却被记成 **"真实漂移"**，污染 6 个 Work Item + 18 条 run_spec，并触发 6 次无效 planning。（已于同日修复，见 `docs/architecture/2026-10-08-phased-development-plan.md` B0.0。）

根因不是"缺一个总管"，而是缺三样**机械判据**：能力的**唯一归属层**、跨层引用的**允许方向**、冲突时的**真相优先级**。

---

## Decision

### 1. 分层与三条机械规则

采用六层模型 + 三条规则，全部可机械检查：

| 层 | 范围 |
| --- | --- |
| **L0 全局规则** | `~/.codex/AGENTS.md` + `~/.codex/rules/*` + `~/.claude/rules/*` |
| **L1 工作区** | `los-workspace/AGENTS.md`、`WORKSPACE.md`、`.workspace/projects.json` |
| **L2 项目规则** | 各仓 `AGENTS.md` / `SKILL.md` / `TODO.md` / `docs/` |
| **L3 工具二进制** | `~/.cargo/bin/*`（unirun / rustopt / fmtguard / sandbox-run / verify-gate / run-diff） |
| **L4 执行与证据** | **los**（`run_specs` / `task_runs` / `verification_records` / `session_events`） |
| **L5 会话与交互** | **DSH**（及 Codex/Claude/Grok 作为入口） |
| （横切）**provider 访问** | 协议/凭证/配额/健康/路由 |

| 规则 | 内容 | 检查方式 |
| --- | --- | --- |
| **R1 单写者** | 每个**状态**只有一个层可以写；其他层只能读或提议 | 维护"状态 → 唯一写者"表（`capability-ownership.yaml`），出现第二个写者即红 |
| **R2 允许方向** | 引用只能**上层→下层**（L2 可引用 L3 二进制；L1 可引用 L2）；**L3 不得知道项目** | grep 被登记为 `tool` 的仓是否出现项目名/本机路径/仓名 |
| **R3 真相优先级** | 冲突时：**持久化证据 > 运行时可观测事实 > 文档声称 > 记忆/摘要**；且**谁写的状态谁负责收敛** | 状态断言行必须带 `commit:` / `file:line` 锚（P4 L4-3） |

### 2. Provider 访问：保留三个决策中心，los 只做冲突判定

**不合并**。三个中心各自成立且各自拥有自己的状态：

| 中心 | 管的范围 | 写权 |
| --- | --- | --- |
| `cc-switch`（GUI，`:15721`） | **桌面工具**：Claude Code / Codex / Gemini / Grok CLI / OpenCode | 只属于它的 GUI 操作者；**los 只读它的 DB，不得写** |
| **DSH 自己**（`agent-default-model` + `dsh-llm-fallbacks`） | **会话宿主**的默认模型与 fallback root chain | **DSH owner 权限；los 不得代改** |
| `los gateway`（`:8080`） | **agent / headless / 治理** | los owner |

**决策**：
- **(a) 冲突判定权归 los**：当三方声明的上游不一致时，由 los **发现并显式报冲突**（不得择一静默处理）。los 是唯一同时具备程序化接口、账本、且已在读 `cc-switch.db` 的一方。
- **(b) los 不得代改 DSH 的默认模型**：`~/.dsh/profiles/*/cordis.patch.yml` 的 `agent-default-model` 与 `dsh-llm-fallbacks` 的 root chain 属 DSH owner。若要让 los 成为 DSH 的统一入口，必须显式修改 DSH 默认并承担随之而来的可用性责任 —— 这是一个**独立决策**，不在本 ADR 授权范围内。
- **(c) 禁止静默覆盖**：`packages/infra/src/config-sources.ts:148` 目前让 cc-switch 的 `is_current` **覆盖** los 的 discovery 结果。改为**标注来源**（`source: cc-switch(current)`）并在冲突时显式报冲突。

### 3. 记忆：三层 canonical，禁止互相复制正文

| 层 | canonical 范围 | 存储 |
| --- | --- | --- |
| **个人长期记忆** | 跨项目、可检索的稳定事实 | `los-memory`（SQLite ledger） |
| **执行记忆** | 绑 `run_spec` 的 session/compaction/procedural | los `packages/memory`（Postgres） |
| **会话工作记忆** | 每日日志、MEMORY.md、项目 KEY | `~/.dsh/memories`（**由 `dsh-memory-evolve` 插件拥有**） |

**规则**：三者**不得互相复制正文**，只在需要时**引用 id**。新增门禁：任一层的写入路径不得写另一层的存储。

**附注（风险意识）**：`~/.dsh/memories` 由第三方插件供给（该插件同时把 `skillDir` 默认设为 `~/.agents/skills`，形成并发写面）。插件被禁用或替换即该层记忆面消失。这是**已知的、被接受的**外部依赖，但必须在文档中显式登记，不得当作 DSH 核心能力。

### 4. `dsfolder` 结构：母仓 + 独立子仓（方案 B），不转 submodule

| 决定 | 内容 |
| --- | --- |
| **不转 submodule** | 子仓中 `routeguard`/`win-exec` 无 remote，submodule 化会让日常操作复杂化且 agent 易误操作 |
| **父仓只管非仓内容** | `.gitignore` 显式排除 6 个子仓目录与运行产物（`.rust-los-gov/`、`.fmtguard/`、`.publish-readiness/`） |
| **补齐父 `AGENTS.md`** | 只写跨子仓共同规则 + 子仓清单与各自规则入口 + "禁止在父目录 `git add -A`" |
| **工作区级登记** | 用 `los-workspace/.workspace/projects.json` 表达 `umbrella` / `children` / `vcs` / `remote` |
| **无 VCS 目录必须登记或纳入** | `run-diff`、`session-index`、以及**本次发现未跟踪的门禁脚本**；`kind=repo` 且 `vcs=none` 必须显式登记豁免理由 |

### 5. 工具归属（逐个结论，不是"都接"）

| 工具 | 归属 | 决策 |
| --- | --- | --- |
| `unirun` | **los 消费（已接）** | 它是 los 自己的 ssh 传输层。保持；仅补网关 PATH（B0.0 已完成） |
| `rustopt` | **los 消费（事实上已接，经 `requiredChecks`）** | 不新增 los 代码；修"预算单一真源"（预算以仓内 manifest 为准，`gates.json` 只做带 hash 的快照） |
| `fmtguard` | **DSH 消费（已接）；不进 los** | 其输入是"agent 刚编辑了哪些 hunk"= **交互面信息**，los 的 E3 作业拿不到也不该拿。补强：`fmtguard_doctor --requireVersion` 用到 CI |
| `verify-gate` | **DSH 消费（已接）；与 los verification 面显式分层，不接线** | **仲裁规则只有一条**：「这个 check 失败后需不需要自动 revision/派 todo」→ 需要走 los，不需要走 verify-gate。并要求其 `verdict` 三态（0/1/2）在 DSH 侧如实透传，**不得把 exit 2 当 failed** |
| `sandbox-run` | **独立组件；是 los 隔离后端之一（覆盖 docker），不是"隔离 owner"** | **隔离分两层**（见第 5.1 节）：**los 拥有隔离资源的身份与生命周期**（账本责任，不下放）；**具体机制由可插拔 `IsolationBackend` 提供**。后端只返回原始结果，**不返回 PASS/FAIL**（判定属门禁层） |
| `run-diff` | **归档退役（保留代码，移出交付链）** | 零消费者（二进制不存在；los 侧 2 处命中是 e2e fixture 字符串）+ 无排期 + **无 VCS** 三者同时成立 ⇒ 按 A3 退役。**不删代码**（1,296 行已验证逻辑是现成参考实现），移入 `dsfolder/archive/`、移出 REPOS 名单、`projects.json` 标 `archived`。**复活条件**：若将来需要"改 prompt/模型/effort 后行为好坏的机械对比"，则它作为 **DSH 评测面的组件**复活，且**必须先纳入 VCS** |

### 5.1 隔离资源：分层 + 可插拔后端（2026-10-08 仲裁，取代"单 owner"表述）

**"谁当隔离 owner"这个问法本身是错的**（与第 2 节"provider 唯一写者"同型错误）。实测两侧是**层不同**，不是两个实现做同一件事：

| | `sandbox-run` 0.1.3 | los `managed-workspaces` |
| --- | --- | --- |
| 回答 | **怎么隔离**（建 worktree/jj workspace/docker、跑验证、报污染） | **谁在什么状态下拥有哪个隔离资源**（状态机 `creating｜active｜backup_ready｜released｜failed`、归属、备份、释放、事件审计） |
| 状态 | 无持久账本（一次性执行 + 报告） | 有持久账本（DB 表 + 事件流 + artifact 落账） |
| 可替换性 | **已有**后端枚举 `Backend::{Auto,Worktree,Docker}`（`src/main.rs:94-116,426-444`），但接口是 `enum + match`（无 trait） | **无**：`vcsKind` 被硬编码为 `'jj'`（`managed-workspace-types.ts:11`），无任何 backend 字段 |

**裁决**：
1. **los 拥有隔离资源的身份与生命周期**（账本、状态机、归属、备份/释放、审计）—— L4 职责，不下放。
2. **具体隔离机制由可插拔 `IsolationBackend` 提供**；`sandbox-run` 是**其中一个后端**（目前唯一覆盖 docker 的），**不是 owner**。
3. **取消 `vcsKind: 'jj'` 硬编码** → `backend` + `backendConfig`；`jj` 成为后端 id 之一（`jj-workspace`），与 `git-worktree`、`docker` 并列。
4. **los 内建 `jj-workspace` 与 `git-worktree`**（纯命令编排，必须能在无外部二进制时可用）；**`docker` 后端委托 `sandbox-run`**（容器编排属 L3 工具领域，不在 los 重写）。
5. **后端选择配置化** `isolation.backend = auto|jj-workspace|git-worktree|docker`；**显式指定不可用时 fail-closed 报因**，**禁止静默回落**（静默回落与 2026-10-08 门禁假红同类）。

**接口纪律（三条，直接对应本 ADR 其它节）**：
- 后端**只返回原始结果**（`exitCode`/stdout/stderr/durationMs），**不得**返回 `PASS/FAIL` —— 判定与三态分类属门禁层（第 6 节）；
- 后端**不得写 los 账本**（R1 单写者）；
- `probe()` 必须能回答"**为什么不可用**"，供第 5 条 fail-closed 报因。

**迭代路径**：C1 契约 + 数据迁移（`vcsKind`→`backend`）→ C2 内建两个后端 → C3 `sandbox-run` docker 适配器 → C4 配置面 → C5（属 `sandbox-run` 自己）`enum`→`trait` + 注册表。

### 6. 门禁三态：环境故障不得伪装成真实漂移

**任何门禁/验证执行器必须把以下三类分开，并使用不同的退出码或结果态**：

| 类 | 含义 | 处置 |
| --- | --- | --- |
| **PASS** | 通过 | 正常 |
| **FAIL** | **真实漂移**（产品/代码缺陷） | 触发自动 revision / 派 Work Item |
| **判不了**（TIMEOUT/ERROR，exit 2） | **环境故障、工具缺失、超时、权限拒绝** | **不得**触发 revision；**不得**记入"real drift"；必须报为独立类 |

判据（可机械检查）：`recordError`/输出含 `exited with 127`、`command not found`、`No such file or directory…sh|bash`、`Permission denied`、`timed out after` ⇒ **判不了**。

**理由（本 ADR 的直接动因）**：混为一谈的代价是三重的 —— ① 环境故障伪装成产品缺陷；② 真漂移被淹没（本例：`verify-gate` 已装 0.1.0 vs 源码 0.2.0 正被淹没）；③ 按假信号烧掉自动恢复额度。

### 7. 跨应用边界：cantool / cankey / canpad

**定性（2026-10-08 operator 口径，本 ADR 的权威表述）**：

> **cantool 与 cankey 是「有共性能力的不同应用」**。部分能力可以**抽象**出来共同使用，但**基于输入法与应用启动器的使用场景和边界是不一样的**；**两者也不需要强耦合，可以各自独立使用**。

三个应用各自的**使用场景与边界**（这是判据的起点，不是可选的描述）：

| 应用 | 使用场景 | 边界 |
| --- | --- | --- |
| **cantool** | 应用启动器 / 生产力面板（Raycast·Alfred·Espanso 类） | 以**用户主动唤起**为中心；不拥有 OS 击键 |
| **cankey** | **OS 输入法**：独占击键、产出文本/动作候选 | 以**击键所有权**为中心；热路径禁止网络/AI/**CanTool RPC**/磁盘 fsync；core 零平台 API |
| **canpad** | 本地优先 Markdown / 文本工作台 | 把 cantool 当**运行时能力提供方**（`/v1/capabilities`），**客户端 ↔ 服务** |

**实测的耦合程度（支持"不需要强耦合"）**：
- `cankey` 全仓只有 **1 处**提到 cantool，且是**注释掉的示例路径**：`crates/cankey-config/bundles/config.example.toml:54` → `# socket = "/tmp/cantool-ime.sock"`。
- `cankey-sidecar` crate 的自述即 **"Optional CanTool IME sidecar client. **Not used in `Engine::step`.**"** ⇒ 它是**可选扩展点**，不是运行必需；`cankey` 的 `default-members` 含它（会构建），但核心面（`cankey-protocol`/`-core`/`-config`/`-lexicon`/`apps/cli`）**不依赖任何 cantool 侧组件**。
- `cantool` 侧对 cankey 的引用为 **0**（`grep -rn "cankey\|CanKey" cantool/src-tauri/ cantool/AGENTS.md cantool/README.md cantool/TODO.md` 全 0 命中）。
- `canpad` 全文 0 次提到 cankey。

⇒ **两仓之间没有编译期依赖、没有运行期必需依赖**；存在的只是**一个可选扩展点**（sidecar）与**一段历史渊源**（cankey 的文档把它写作 "CanTool 的输入法投递面"）。**历史渊源不是运行时边界**。

**共性能力的抽象原则**（operator 明确"有部分能力可以抽象共同使用"）：

| 原则 | 内容 |
| --- | --- |
| **A1 抽象到独立面，不落到任一应用内部** | 共性能力（词典/词库处理、候选排序、配置模型生成、文本变换、契约生成）应作为**独立可发布单元**（crate / package），由**两个应用各自选用**。禁止让 A 应用从 B 应用的内部 crate 里引用共性能力 —— 那等于建立了"B 是 A 的依赖"这种事实上不需要的耦合。 |
| **A2 抽象是"共同使用"，不是"共同拥有"** | 独立单元有自己的写权与发布节奏；**不因为 cantool 需要就改 cankey 的 core**，反之亦然。 |
| **A3 抽象必须由第二个真实消费者证明** | 只有两个应用**都已在用**同一能力时，才把它抽出为共享单元（与 `~/.codex/AGENTS.md` 的"不为假设的复用加抽象"一致）。 |
| **A4 不强耦合 = 任一方可单独构建、安装、使用、发布** | 判定方式：`cankey` 在**没有 cantool 安装**的机器上必须完整可用；`cantool` 同理。任一方不得把另一方列为构建或运行前提。 |

**边界规则（R1–R6，取代此前的"宿主 ↔ 交付面"表述）**：

| # | 规则 | 机械检查 |
| --- | --- | --- |
| **R1** | **击键所有权只在 cankey**：`cankey-core`/`-protocol`/`-config`/`-lexicon` 的写权只属 cankey；`cantool` 不得为"让输入更好用"引入对这三个 crate 的需求，也不得把平台依赖反向塞进去 | `cargo tree -p cankey-core` 不得出现 `objc2*`/`tauri`/`tokio`/`reqwest`（cankey 现有 P0 门禁）；`grep -rn cankey cantool/src-tauri` 必须为空 |
| **R2** | **输入注入类改动必须声明"谁拥有击键"**：`cantool` 改 `text_expansion/`、`input_runtime/injection/` 的语义时，必须在 PR 里回答该问题；**不得复制或绕过 cankey 的投递协议**（若 cankey 已覆盖该场景，正确做法是**调用它**，而不是造第二条注入路径） | PR 模板一项 + `rg 'NSWorkspace\|TIS\|SecureInput' cantool/src-tauri` 的结果需与 cankey 能力表对齐 |
| **R3** | **cankey 的协议写权只在 cankey**；`cankey-sidecar` 是**可选**扩展点，**禁止把它变成必需**（一旦成为必需即违反 A4） | `cankey` 的 `default-members` 或 `apps/*` 不得出现"缺 sidecar 即构建/启动失败"的路径；`Engine::step` 不得出现任何 sidecar 调用 |
| **R4** | **canpad → cantool 只允许「探针 + 消费已发布端点」**（只许 `GET /v1/capabilities`），**禁止 canpad 定义新端点** | canpad 侧出现 `POST /v1/<新路径>` 到 cantool 即红 |
| **R5** | **canpad 的配置类型写权在 `canpad-core`**，生成物不手改 | `npm run contracts:generate && git diff --exit-code` 型门禁 |
| **R6** | **三仓各自独立 VCS、独立发布**；跨仓改动必须在**各自仓**里分别是完整变更，**禁止一个 PR 跨两仓**；共享能力的抽出**另立变更** | 跨仓需求开 N 个变更（N = 被改仓数） |

**即时缺口（保留，但性质变了）**：`cantool` 侧对 cankey 的引用为 0 —— 在**不需要耦合**的前提下这**不是**缺陷本身；真正的缺口是 **cantool 侧没有声明"击键所有权在 cankey"这条边界**，因此在 cantool 里改输入/注入的 agent 不知道存在一个已覆盖该场景的独立应用。**最小修法（2 行，不建立耦合）**：`cantool/AGENTS.md` 的 Read Order 加一行指向 `cankey/docs/design/architecture.md`（作为"相关应用"而非依赖），Hard Invariants 加一条"输入注入类改动必须先判定击键所有权；不得复制或绕过 cankey 的投递协议"。

**对本 ADR 早期表述的更正**：本文档 2026-10-08 首版把 cankey 写作 cantool 的"输入法投递面（同族、架构耦合）"并给出"协议唯一写权在 cankey、cantool 只实现"的表述 —— 那实质建立了**从属与耦合**关系，与 operator 口径不符。**以本节为准。**

### 8. 文档权威唯一化

`capability-ownership.yaml`（`docs/governance/`）是"能力 → 唯一归属层 + 消费者"的**唯一真源**。任何文档声称某能力的归属，必须与该表一致；不一致即冲突（不是"两种观点"）。

---

## Consequences

**Positive**
- 三个 provider 决策中心各自保留自治，同时有了**冲突判定权**，不再出现"切了 provider 但没生效且无人能判定谁对"。
- 记忆三层各有 `canonical_for`，可机械回答"某条记忆在哪"。
- `dsfolder` 的父子关系有明文规则；内嵌仓的改动不再"既不进父仓历史也不可推"。
- 门禁三态使环境故障与产品缺陷可分，真漂移不再被淹没。
- 边界判据全部可写成 grep / exit-code / SQL 断言，可进门禁。

**Negative / 代价**
- 三个 provider 中心意味着**没有单一"统一入口"**；接受这一点，代价是跨工具对齐需要 los 的冲突判定这一跳。
- `sandbox-run` 成为隔离 owner 后，los 的 `managed-workspaces` 需要收敛定位（一次改造）。
- `~/.dsh/memories` 依赖第三方插件这一点**无法通过本 ADR 消除**，只能显式登记。

**Risk / 缓解**
- 风险：`cc-switch` 无管理 API，los 只能读 ⇒ 桌面工具的 provider 变更仍是 GUI 手工动作（且需 operator 亲自做）。缓解：los 只负责**发现并报冲突**，不试图代改。
- 风险：新增的边界门禁可能变成新的"建好就停摆"机制。缓解：每条门禁**必须带负向控制**（人为造违规必须红），否则不算落地。

---

## 重新评估的触发条件

出现以下任一情况时，本 ADR 需要重新评审（而不是默默偏离）：

1. `cc-switch` 提供管理 API 或 CLI（则第 2 节的"只读"约束可放宽）。
2. DSH 决定把默认模型改为 `los-gateway`（则第 2 节 (b) 需要重写，并重新分配可用性责任）。
3. `dsh-memory-evolve` 被上游弃用、替换或移除（则第 3 节的会话工作记忆层需要换 owner）。
4. `dsfolder` 的子仓数量或 VCS 形态变化（新增/移除仓、或有仓获得 remote）。
5. `verify-gate` 或 `sandbox-run` 的退出码语义变更（则第 6 节的判据与仲裁规则需要同步）。
7. `sandbox-run` 的 `Backend` 接口从 `enum` 改为 `trait` + 注册表（则第 5.1 节的 C3/C5 可合并，且 los 侧适配器可直接对接 trait）。
8. 出现第三个需要隔离后端的场景（如 container/VM 之外的沙箱，见 ADR 0046）—— 则需重新评估 `IsolationBackend` 接口是否足够抽象。
6. 出现第二个 operator 或第二个 `user` JWT（则第 2 节的"冲突判定权归 los"需要重新评估权限面）。

---

## References

- `docs/operations/2026-10-08-los-inventory.md` — los 全量盘点（现状基线）
- `docs/architecture/2026-10-08-tool-and-project-boundary-analysis.md` — 边界取证（六层模型 / 21 条违规 / 10 条判据 / §2.9 事故）
- `docs/architecture/2026-10-08-phased-development-plan.md` — 执行计划 B0.0–B3
- `docs/architecture/2026-10-08-batch-index.md` — 跨项目能力批次索引（P1–P5）
- `~/.codex/rules/routing-role-matrix.md` — 既有路由角色分离规则（本 ADR 第 2 节的前身，实测被遵守）
- `docs/adr/0036-cantool-mcp-capability-adapter.md` — 能力面/证据面分离（本 ADR 第 7 节的同源原则）
