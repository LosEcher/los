# 仲裁：隔离 owner（`sandbox-run` vs los `managed-workspaces`）+ `run-diff` 处置

- **状态**：已裁决（2026-10-08，operator 授权按"可维护 / 可扩展 / 插件化-组件化"评估后定案）
- **依据**：ADR 0047 第 5 节；本文件给出评估过程与最终决定，并**更正** ADR 0047 里"sandbox-run = 隔离 owner"的单 owner 表述
- **裁决者授权原文**：「按你评估的结果来。还是根据后续的可维护可扩展以及符合插件化配置化的设计思路 组件化的进行迭代和开发」

---

## 1. 评估标准（operator 给定三条）

| 标准 | 判据 |
| --- | --- |
| **可维护性** | 改一处不牵动多处；有明确的状态 owner 与收敛路径；失败模式可诊断 |
| **可扩展性** | 新增能力（新隔离后端 / 新比较维度）不需要改动既有消费者 |
| **插件化 / 配置化 / 组件化** | 能力以**独立可替换组件 + 配置选择**的形态存在，而不是写死在某个消费者内部 |

---

## 2. 两侧真实形态（实测）

### 2.1 `sandbox-run` 0.1.3 —— **执行器**，且**已有可插拔后端**

| 事实 | 证据 |
| --- | --- |
| 它是一个独立可发布的 CLI（`sandbox-run-cli`，MIT，有 repository/keywords/categories 与 `exclude` 打包策略） | `Cargo.toml` |
| **已有后端枚举**：`Backend::{Auto, Worktree, Docker}`，`auto` → 默认 `worktree`，`docker` 需显式 | `src/main.rs:94-116, 223-225, 426-444` |
| **已有 `--backend` 旗标与分支执行** | `src/main.rs:426`（Docker）/ `:444`（Worktree） |
| 后端实现按文件分离：`docker.rs`（543+ 行）、worktree 路径走 `gates.rs`/`exec.rs`/`scope.rs` | `ls src/` |
| 自带污染检测与报告（`pollution`/`overlaid`/`cleaned`） | `src/docker.rs:547`、`report.rs` |
| 已知限制：docker 后端是**串行**的 | `src/docker.rs:148` |
| **缺**：没有显式 `trait` 接口（后端是一个 `enum` + `match`），所以"加一个新后端"仍需改 `main.rs` | `grep -rn "^pub trait" src/*.rs` = 空 |

### 2.2 los `managed-workspaces` —— **治理账本**，不是执行器

| 事实 | 证据 |
| --- | --- |
| 状态机：`creating｜active｜backup_ready｜released｜failed` | `managed-workspace-types.ts:1` |
| 有账本表 + 事件流 + 归属（`assignedTask`）+ 备份/释放语义 + artifact 落账 | `managed-workspace-store.ts`、`managed-workspaces.ts:110-200`、`putArtifact` |
| **`vcsKind` 被硬编码为 `'jj'`** | `managed-workspace-types.ts:11` |
| **无任何 backend/provider 字段**（可插拔预留缺失） | `grep -nE "backend\|provider\|kind"` 无命中 |
| 全部实现通过 `runJj(...)` 直接调外部 `jj` 二进制 | `managed-workspaces.ts:244` |

### 2.3 结论：这不是"两个实现做同一件事"，是**层不同**

| | `sandbox-run` | los `managed-workspaces` |
| --- | --- | --- |
| 回答的问题 | **怎么隔离**（建 worktree/jj workspace/docker，在里面跑验证，报告污染） | **谁在什么状态下拥有哪个隔离资源**（状态机、归属、备份、释放、事件审计） |
| 状态 | 无持久账本（一次性执行 + 报告） | 有持久账本（DB 表 + 事件流） |
| 可替换性 | 后端已可换（worktree/docker），但接口是 enum | 完全不具可替换性（`vcsKind: 'jj'` 硬编码） |
| 若把 owner 判给任一方 | `sandbox-run` 拿 owner ⇒ 它得长出账本/状态机（**违背单一可执行能力**，违反 ADR 0047 第 1 节 L3 判据） | `managed-workspaces` 拿 owner ⇒ 它得自己实现 docker/隔离（**重复 `sandbox-run` 已有能力**，且 `vcsKind` 已硬编码证明它做不好） |

⇒ **"谁当隔离 owner"这个问法本身是错的**（与分析文档里"provider 唯一写者"同型错误）。二者是**执行面**与**治理面**的关系，正确的收敛是**定义接口 + 让后端可插拔**。

---

## 3. 裁决

### 3.1 隔离：分层 + 插件化后端（**不是单 owner**）

```
┌─ los（治理面 / L4）───────────────────────────────────────────┐
│  隔离资源的身份与生命周期 = los 的账本责任                      │
│  · 状态机 creating|active|backup_ready|released|failed          │
│  · 归属（哪次 run / 哪个 task 拥有它）                          │
│  · 备份 / 释放 / 事件审计 / artifact 落账                        │
│  · 策略：何时允许隔离、允许哪种后端、谁可以释放                  │
└──────────────────────┬───────────────────────────────────────┘
                       │ IsolationBackend 接口（新增，见 3.2）
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
   jj-workspace   git-worktree    docker        (未来: firecracker/…)
   （los 内建）    （los 内建）   （sandbox-run）     （新增组件）
```

| 决定 | 内容 |
| --- | --- |
| **D1** | **los 拥有隔离资源的身份与生命周期**（账本、状态机、归属、备份/释放、审计）。这是 L4 的职责，不下放。 |
| **D2** | **具体隔离机制由可插拔后端提供**，los 通过 `IsolationBackend` 接口调用；`sandbox-run` 是**其中一个后端**（目前是唯一能覆盖 docker 的），不是 owner。 |
| **D3** | **取消 `vcsKind: 'jj'` 硬编码**，改为 `backend: string` + `backendConfig`；`jj` 成为后端 id 之一（`jj-workspace`），与 `git-worktree`、`docker` 并列。 |
| **D4** | **los 内建 `jj-workspace` 与 `git-worktree` 两个后端**（它们只是 git/jj 命令编排，几十行，且必须在**无外部二进制依赖**时也可用）；**`docker` 后端委托 `sandbox-run`**（`sandbox-run --backend docker`），因为容器编排属 L3 工具的领域，不该在 los 里重写。 |
| **D5** | 后端选择**配置化**：`isolation.backend = auto | jj-workspace | git-worktree | docker`（`auto` 按仓的 VCS 与可用性解析）；**显式指定不可用时必须 fail-closed 并给出原因**，不得静默回落到另一个后端（静默回落正是 2026-10-08 门禁假红同类错误）。 |
| **D6** | `sandbox-run` 侧**可选**改进（不阻塞 los）：把 `enum Backend` 提升为 `trait IsolationBackend` + 注册表，使"加后端不改 `main.rs`"。这属于它自己的可扩展性，优先级低于 D1–D5。 |

### 3.2 `IsolationBackend` 接口（契约先行）

los 侧新增（`contracts/` 先行，再落 `packages/agent`）：

```ts
export interface IsolationBackend {
  /** 稳定 id：'jj-workspace' | 'git-worktree' | 'docker' | ... */
  readonly id: string;
  /** 这个后端是否可用于当前仓（探测 VCS 类型、外部二进制可用性） */
  probe(input: { repository: string }): Promise<{ available: boolean; reason?: string }>;
  /** 建立隔离资源；返回给账本落库的句柄 */
  create(input: { repository: string; taskId?: string; label?: string }):
    Promise<{ path: string; backendState: Record<string, unknown> }>;
  /** 在隔离资源内执行验证；返回原始结果（**不解释成 PASS/FAIL**，那是门禁的职责） */
  run(input: { path: string; command: string; timeoutMs: number }):
    Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  /** 污染检测（可选；`sandbox-run` 已提供，内建后端可返回 null） */
  detectPollution?(input: { path: string; repository: string }): Promise<{ polluted: boolean; detail?: string } | null>;
  /** 释放/清理 */
  release(input: { path: string; backendState: Record<string, unknown> }): Promise<void>;
}
```

**分层纪律（重要）**：
- 后端**只返回原始结果**（`exitCode`/输出），**不得**返回 `PASS/FAIL` —— 判定与三态分类（ADR 0047 第 6 节）是**门禁层**的职责。这条直接防止"环境故障被后端吞成 FAIL"。
- 后端**不得写 los 账本**（R1 单写者）：它只返回句柄与原始结果，落账由 los 做。
- `probe()` 必须能回答"**为什么不可用**"，供 D5 的 fail-closed 报因。

### 3.3 迭代路径（组件化）

| 阶段 | 动作 | 验收 |
| --- | --- | --- |
| **C1** | `contracts/isolation-backend.yaml` + 上面接口的类型落地；`managed-workspaces` 的 `vcsKind: 'jj'` 改为 `backend` + `backendConfig`（含数据迁移：存量行 → `backend='jj-workspace'`） | 迁移后 `check:migration-drift` 绿；存量 workspace 仍可 load/backup/release |
| **C2** | 内建 `jj-workspace` 与 `git-worktree` 两个后端（纯命令编排，行为对齐现有 `runJj` 路径） | 既有 `managed-workspaces.test.ts` 全绿；新增两后端各自的正/负用例 |
| **C3** | `docker` 后端适配器 = 调 `sandbox-run --backend docker`（探测 `sandbox-run` 是否在 PATH；不在则 `probe().available=false` 并给原因） | 显式 `--backend docker` 且 sandbox-run 缺失 → **fail-closed 报因**（负向控制） |
| **C4** | 配置面：`isolation.backend`（`auto` 解析规则 + 显式指定 fail-closed） | `auto` 在 jj 仓选 `jj-workspace`、在 git 仓选 `git-worktree`；显式不可用 → 非零且报因 |
| **C5** | （属于 `sandbox-run` 自己）`enum Backend` → `trait` + 注册表 | 加一个新后端不改 `main.rs` |

---

## 4. `run-diff` 处置：**归档退役**（保留代码，移出交付链）

### 4.1 评估

| 标准 | 评估 |
| --- | --- |
| **可维护性** | 规模小（`src/` 4 文件 / **1,296 行**，依赖只有 `serde`/`serde_json`/`sha2`），**维护成本本身不高**；但它**无 VCS**（`vcs=none`）⇒ 任何改动都不可追溯、不可回滚 —— 这才是真问题 |
| **可扩展性** | 定位是"两个 agent run 事件流的结构化 diff"，与 ADR 0040（execution experiment provenance）同域；但**消费者为 0**（`~/.cargo/bin/run-diff` 与 `target/release/run-diff` 都不存在；los 侧 2 处命中是 e2e fixture 字符串） |
| **插件化-组件化** | 它**本来就是一个独立组件**（形态合格）；问题不是形态，是**没有消费者也没有排期** |
| **结论** | **退役**。理由：按 A3（抽象/组件必须由真实消费者证明）——**零消费者 + 无排期 + 无 VCS** 三者同时成立时，保留它只是持续支付"每次盘点都要重新论证"的评审成本 |

### 4.2 处置动作（**不删除代码**）

| 动作 | 内容 |
| --- | --- |
| **归档而非删除** | 把 `dsfolder/run-diff/` 移入 `dsfolder/archive/run-diff-20261008/`（或就地加 `ARCHIVED.md`），**保留源码**（它是 `dsh-observability` 类任务的现成参考实现，删除会丢失 1,296 行已验证逻辑） |
| **移出交付链** | `rust-repo-snapshot.mjs` 与 `rust-cold-build-budget.sh` 的 REPOS 名单移除 `run-diff`（它不再参与门禁与体积预算） |
| **登记** | `projects.json` 里 `run-diff` 的 `kind` 从 `repo` 改为 `archived`，并写 `archivedAt` / `archiveReason` / `supersededBy`（若将来做 DSH 评测面，指向那个组件） |
| **capability-ownership** | `run-event-diff` 条目 `status: deprecated-candidate` → `deprecated`，`consumers: []` 保留（作为"它没有消费者"的记录） |
| **复活条件（写进 ADR）** | 若将来需要"改 prompt/模型/effort 后行为好坏的机械对比"，则它作为 **DSH 评测面的一个组件**复活（而不是作为 los 的执行面）；届时**必须先纳入 VCS** |

### 4.3 为什么不选"转 DSH 评测面"而是"归档"

"转 DSH 评测面"需要一个**明确的消费者与排期**。今天两者都没有；把它标成"待转"等于把一个未决项伪装成计划（与分析文档 V19「计划被当实现」同型错误）。**归档 + 写清复活条件**是诚实的形态：它承认当前没有需求，同时保留低成本复活路径。

---

## 5. 对 ADR 0047 的更正

ADR 0047 第 5 节原文把 `sandbox-run` 写作"**隔离 owner = `sandbox-run`**"。按本仲裁更正为：

> **隔离资源分两层**：**los 拥有隔离资源的身份与生命周期**（账本责任，不下放）；**具体隔离机制由可插拔 `IsolationBackend` 提供**，`sandbox-run` 是其中一个后端（覆盖 docker），不是 owner。后端只返回原始结果，**判定 PASS/FAIL 与三态分类属门禁层**。

同时更正 `capability-ownership.yaml`：
- `isolated-verification-execution` 条目改为**分层描述**（owner_layer: execution 管账本 / 各后端为 tool 组件）；
- 新增 `isolation-backend-registry` 条目（owner_layer: execution，canonical = `IsolationBackend` 接口 + `isolation.backend` 配置）；
- `run-event-diff` 置 `deprecated`。

---

## 6. 与既有决策的一致性检查

| 检查 | 结论 |
| --- | --- |
| 是否违反 ADR 0047 第 1 节 L3 判据（"工具二进制不写消费者账本"）？ | **不违反**：`sandbox-run` 作为后端只返回原始结果，落账在 los |
| 是否违反 R1 单写者？ | **不违反**：账本唯一写者是 los；后端不写账本 |
| 是否违反第 6 节门禁三态（环境故障不得伪装真实漂移）？ | **强化**：接口层明确规定后端**不得**返回 PASS/FAIL |
| 是否符合 A3（抽象必须由第二个真实消费者证明）？ | **符合**：`run-diff` 因零消费者退役；`IsolationBackend` 接口有 3 个真实后端（jj/git/docker）作为消费者 |
| 是否与 `sandbox-run` 自身定位冲突（它是独立可发布组件）？ | **不冲突**：它继续作为独立组件存在并发布，只是被 los **作为一个后端**消费 |
