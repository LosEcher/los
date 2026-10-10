# 2026-10-08 批次索引：跨项目开发场景缺口 → 五批设计

- **背景**：2026-10-08 los 全量盘点（`docs/operations/2026-10-08-los-inventory.md`）后，结合 **DSH 近期 session 记录**（`~/.dsh/storages/session-index.db`：1097 sessions / 592,447 events）与**跨项目开发场景**补出的一批缺口，按批次落设计。
- **用户口径（2026-10-08）**：**IM 按需配置，可以在 DSH 也可以在 los，都是插件化可拔插的方案** ⇒ 不再讨论"IM 归谁"，只做**配置面**（见 P2 的 L2-3/L2-4）。
- **批次文档**：
  - [P1 跨项目状态可观测](2026-10-08-p1-cross-project-observability.md) — DSH session 历史 → los 只读读模型 + 项目健康看板
  - [P2 工作区指令链 + 仓拓扑 + IM 渠道路由](2026-10-08-p2-workspace-instructions-and-channel-routing.md)
  - [P3 执行可靠性 + 验证债](2026-10-08-p3-execution-reliability-and-verification-debt.md)
  - [P4 provider 治理复活 + ADR 处置 + 文档状态绑定提交号](2026-10-08-p4-provider-governance-adr-and-doc-truth.md)
  - [P5 fleet 容量与名分 + 跨项目登记 + 成本原语](2026-10-08-p5-fleet-capacity-and-placement.md)

---

## 一、批次总览

| 批次 | 主题 | 归属侧 | 依赖 | 主要收益 |
| --- | --- | --- | --- | --- |
| **P1** | 跨项目状态可观测 | DSH 主 + los 读模型 | 无 | 让"跨项目重复失败模式"从人工手查变成机械信号 |
| **P2** | 工作区指令链 + 仓拓扑 + IM 渠道路由 | 双侧 | 无 | 补上最活跃仓的规则落点；IM 变成幂等可自证的开关 |
| **P3** | 执行可靠性 + 验证债 | los | P2 的 `project_key`（仅 L3 的死信归类可延后） | 清僵尸 run_spec / self-check 三态 / 沙箱拒绝 typed / 观测不再静默 |
| **P4** | provider 治理 + ADR + 文档真值 | los | 无 | 配置可持久化；四个悬置 ADR 全部有结论；文档状态可机械证伪 |
| **P5** | fleet 容量与名分 + 成本原语 | los + 工作区文档 | **P2 的 `project-registry.json`** | 8 台有名分；in-process 路径可见；canary 强制化；最小成本原语 |

**依赖图**

```
P1 ─────────────┐
                ├──> （看板/日报复用 P1 的读模型与新鲜度门禁）
P2 ──┬──> P5    │
     │          │
     └──> P3 ───┘
P4 ─────────────┘   （P4 的"文档状态绑定提交号"约束 P1/P2/P3/P5 的新文档）
```

- **P1 可独立开工**（纯增量、只读）。
- **P2 → P5**：P5 的 L5-1（跨项目治理登记）需要 P2 的 `projects.json` 提供 `project_key` 映射。
- **P2 → P3**：P3 的死信/僵尸归类需要 `project_key` 才能按项目切分（可延后，不阻塞主干）。
- **P4 是横切约束**：它的 L4-3 规则一旦落地，其余四批**新写的文档必须从一开始带锚**。
- **P3 与 P4 无相互依赖**，可并行。

---

## 二、本批补出的缺口（相对 2026-10-08 盘点新增）

盘点已覆盖 los 自身；本批新增的是**跨项目 / DSH 侧 / 工作区层**的缺口：

| # | 缺口 | 证据 | 归到 |
| --- | --- | --- | --- |
| G1 | **los 看不到 DSH 的历史会话** | `grep -rln "session-index\|dsh/sessions" packages/*/src tools/` = 0 命中；而 DSH 有 1097 sessions / 592,447 events | P1 L1-2 |
| G2 | **`dsh-session-index` 插件没装进 desktop（当前 GUI 宿主）profile** | profile 配置里 0 命中；README 只覆盖 web+headless | P1 L1-1 |
| G3 | **跨项目重复失败模式无人聚合** | 沙箱拒绝跨 ≥4 仓（FTS `SANDBOX` 995 / `workspace-write` 253）；`context_compaction` 29 次跨 5 session | P1 L1-2 |
| G4 | **上下文注入开销无度量** | runtime context 注入 573 次 / skill catalog 353 次（14d）；assistant 平均 355 字符、上限 8000 | P1 L1-2 |
| G5 | **agent 长循环无成本可见性** | 最重 session 1796 tool/call 对 14 次 LLM 请求（≈128:1，最高 ~256:1）；`bash` 29,589 次 vs typed 工具合计 ~13,978 次（68% 走裸 shell） | P1 L1-3 |
| G6 | **DSH 真实流量几乎不经 los gateway** | `request/header` 590/596 = `deepseek-official/deepseek-flash` 直连 | P4 L4-4（ADR 0038 修订） |
| G7 | **最活跃仓 `dsfolder` 无 AGENTS.md**，而子仓各自有 | `dsfolder/AGENTS.md` 缺失；`unirun`/`rustopt`/`fmtguard`/`sandbox-run` 各有 | P2 L2-2 |
| G8 | **`los-memory/AGENTS.md` 路径失效** | 写 `~/projects/los-workspace/*`，实测 `~/projects` 不存在 | P2 L2-2 |
| G9 | **WORKSPACE.md 声称的 7 项目与磁盘不符** | 声称 `lsclaw/vpsagentweb/los-ast/los-memory/pi/aigluetoolset`；`projects/` 实际只有 `los` + `weclaw` | P2 L2-2 |
| G10 | **真实开发区在 `los-workspace` 之外，无权威登记** | 9 个活跃仓都在 `~/syncfolder/project/`；los todos 里只 2 个仓有像样登记 | P2 L2-1 / P5 L5-6 |
| G11 | **沙箱拒绝与幂等命中不可区分（恶性）** | 会话原话：`mkdir` claim 失败被误判 `inFlight → dedup:true exit 0` ⇒ **故障通知没发出去却报成功** | P3 L3-1 / P2 L2-4 |
| G12 | **沙箱拒绝原因不可查询** | `native-denied` 是无语义终态；无 typed `blocked_reason`（`contracts/` 里也没有） | P3 L3-1 |
| G13 | **IM 渠道无统一开关与健康面** | DSH 侧散在 4-5 个插件挂载行；los 侧散在 `.env` + 两个 package；`WECLAW_API_ADDR` 指向不监听端口 | P2 L2-3 |
| G14 | **渠道依赖任务与渠道可用性不联动** | `daily execution digest (feishu)` enabled 而渠道全 disabled；DSH `job-440be80b` `failed` 与 `exit=0` 并存 | P2 L2-4 |
| G15 | **in-process 执行路径不在可见面** | `gateway-local` 承担 176/484 = 36% 负载却不在 `executor_nodes` | P5 L5-3 |
| G16 | **27 个 ssh_target 是"从未探测"却被当注册表成员** | 心跳集体冻结 2026-08-19 22:28 | P5 L5-2 |
| G17 | **观测机制建好就停摆** | `ci-metrics/runs.jsonl` 14 行，末行 2026-08-17；wiring baseline 384→**396 行**（在扩张） | P5 L5-6 |
| G18 | **免费渠道使用只有注释、没有判据** | `~/.los/config.yaml` 注释"禁投敏感内容"；`dataClassification` 概念已存在但未接 | P5 L5-5 |
| G19 | **provider 治理面停摆 + 配置不落盘** | compat 证据末条 2026-07-19；promotion 决策 0 行；`setConfig()` 只改内存 | P4 L4-1/L4-2 |
| G20 | **文档状态无法机械核对** | D1–D7 七条实测漂移；只读文档判状态会系统性出错 | P4 L4-3 |

### 三之零、边界批（B0.0–B3）新增的缺口

| # | 缺口 | 证据 | 归到 |
| --- | --- | --- | --- |
| **G21** | **两份互相矛盾的「权威」**：`los/docs/governance/toolchain-matrix.md` 判「外部 transcript 只当**比较输入**」，`dsfolder/RUST-REPO-LOS-GOVERNANCE-DESIGN-2026-10-07.md` 判「工具 `runs.jsonl` 作为**外部证据可引用**」——同一批工具两处不同归属规则，**且没有任何门禁会红** | 两份文档各自自称权威；实测 `toolchain-matrix.md` 里**一个 Rust 工具都没列** | B0.2 的 `capability-ownership.yaml`（**最先收口**） |
| **G22** | **单向依赖的规则不对等**：`cankey` 自述是「CanTool 的输入法投递面」，但 **cantool 侧对 cankey 的引用为 0** | `grep -rn "cankey\|CanKey" cantool/src-tauri/ cantool/AGENTS.md cantool/README.md cantool/TODO.md` = 0 命中 | B2.2b（2 行文档修） |
| **G23** | **⚠️ 正在发生的事故**：网关 PATH 缺 `~/.cargo/bin` ⇒ 每日 rust 门禁 6 仓 11 check 全 FAIL 被记 `real drift`，污染 6 个 Work Item + 18 条 run_spec | 分析文档 §2.9（已独立复核） | **B0.0 插队** |
| **G24** | **工具归属口径错**：「6 个 rust 工具零消费者」不成立 ⇒ 正确是 los 消费 2 / DSH 消费 3 / 待仲裁 1 / 退役 1；真问题是「los 不知道其余 5 个的存在，其中 3 个已被 DSH 用起来」 | 分析文档 §4.1 | B2.1（已按新口径改写） |

### 三之一、三处事实纠正（写文档前必读）

| # | 早先表述 | 实测 |
| --- | --- | --- |
| C1 | 「`dsh-session-index` 需装 web+headless+**desktop** 三档」 | **web 已装**（`~/.dsh/profiles/web/package.json:25,64`）；**desktop 未装** ⇒ P1 L1-1 只需补 desktop |
| C2 | 「`dsfolder` 子仓各有 `AGENTS.md`」 | **只有 `unirun`/`sandbox-run` 有**；rustopt/fmtguard/verify-gate/run-diff/session-index **都没有** |
| C3 | 「`verify-gate` 0.2.0」 | **已装二进制 0.1.0**，源码才是 0.2.0 ⇒ 这本身就是一条未被发现的漂移（正被 G23 的假红淹没） |

---

## 三、开工顺序建议

| 序 | 批次 | 理由 |
| --- | --- | --- |
| 1 | **P1 L1-1**（装插件，~10 分钟） | 立刻让 agent 能查跨项目历史；后续所有分析都受益 |
| 2 | **P3 L3-5**（修 `performance_audit` 列名 + 审计不许静默） | 一行级修复，立刻恢复观测；且是后续所有判断的依据 |
| 3 | **P4 L4-1**（provider 配置落盘） | 消除"改了就生效"的假象；小而关键 |
| 4 | **P2 L2-2**（补 dsfolder/AGENTS.md + 修失效路径） | 纯文档，收益立现，无风险 |
| 5 | **P1 L1-2/L1-3**（读模型 + 看板） | 依赖 1 与 2 |
| 6 | **P3 L3-1…L3-4** + **P3 L3-2**（僵尸收敛） | 契约先行，工作量最大的一批 |
| 7 | **P2 L2-1/L2-3/L2-4** → **P5** | P5 依赖 P2 的登记 |
| 8 | **P4 L4-3/L4-4**（文档锚 + ADR 处置） | 横切约束，放后面让前几批的文档一次到位 |

---

## 四、与现有账本的关系

- 本批**不替代** `docs/architecture/2026-10-06-architecture-boundaries-and-gaps.md` 的 P0/P1/P2 清单；两者是**不同层面**：那份是 **los 内部**的缺口，本批是 **跨项目 / DSH / 工作区**层面，外加把盘点新发现的 los 缺陷（B1/B2/B3/B4）落成批次。
- 与 10-07 session closeout 的"剩余工作 4 项"重叠处：滚动设计剩余 → P5 L5-4；摘要口径审计 → P5 L5-4；DSH 投递记账 → P2 L2-4；P1 清单 → 分散在 P3/P5。
- 与对抗审查修复 DAG 的重叠：P1-12（AP12 回写）→ P3 L3-4；P2-17（SSRF）与 P2-18（needsApproval）**未纳入本批**，仍在 DAG 里等待。
