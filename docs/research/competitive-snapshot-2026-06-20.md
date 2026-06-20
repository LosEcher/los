# 竞品调研快照 — 2026-06-20

> 执行时间：2026-06-20
> 方法：6 路并行 web search + 7 篇深度 scrape + 4 篇 Exa 深度搜索
> 覆盖：Aider（首次）、Claude Code 2026（更新）、Codex CLI 2026（更新）、MiMo-Code（跟进）、LangGraph（跟进）、Context Compaction 学术界
> 关联：[[competitive-research-strategy-2026-06-20]] [[competitive-landscape-2026-06]] [[los-mimo-p0-evaluation-2026-06-17]]

---

## 一、10 维竞品得分矩阵（2026-06-20 更新）

| 维度 | los 当前 | Claude Code | Codex CLI | Aider | MiMo-Code | LangGraph |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 1. Phase Enforcement / 生命周期 | **3** | 1 | 1 | 1 | 2 | 2 |
| 2. 持久化 Tool State | **3** | 1 | 1 | 1 | 1 | 2 |
| 3. Memory Compaction / 记忆压缩 | 2 | **3** | 2 | 1 | **3** | 1 |
| 4. 多 Agent 编排 (DAG) | 2 | 2 | 2 | 1 | 2 | **3** |
| 5. Provider 兼容性验证 | **3** | 1 | 1 | 2 | 1 | 1 |
| 6. Run Replay / 可恢复性 | **3** | 2 | 2 | 1 | 2 | 2 |
| 7. 上下文窗口管理 | 1 | **3** | 2 | 1 | **3** | 2 |
| 8. 工具生态 / MCP 集成 | 2 | **3** | **3** | 1 | 2 | 2 |
| 9. 代码编辑策略 | 1 | 2 | 2 | **3** | 1 | 1 |
| 10. Operator UX / 产品化 | 1 | **3** | **3** | **3** | 1 | 1 |

> 得分说明：1=无/基础，2=有但不够成熟，3=业界领先。los 当前在 Phase Enforcement、Tool State 持久化、Provider 兼容性验证 3 项保持领先。

---

## 二、各竞品关键发现

### 2.1 Aider — **首次深入分析** 🔥

Aider 是当前 OSS coding agent 中**编辑策略最成熟**的工具，有两个可直接吸收的设计：

**① Architect/Editor 双模型分离**

这是 Aider 最核心的创新——将 coding task 拆成两个推理步骤：

```
User Request → [Architect Model] 提出解决方案思路
                      ↓ (自然语言描述)
                [Editor Model] 转化为结构化 diff 编辑指令
                      ↓
                应用到源文件
```

关键设计细节：
- Architect 使用推理强但编辑弱的模型（如 o1/DeepSeek-R1）
- Editor 使用编辑强但推理弱的模型（如 GPT-4o/DeepSeek-V3）
- Editor 使用专属的简化 prompt（`editor-diff`/`editor-whole` 格式），比标准 diff 格式更窄、更聚焦
- DeepSeek 被测试为**意外优秀的 Editor 模型**

**对 los 的启示**：los 的 P0-2 Judge Model 已启动但范围不同——los 的 Judge 评估"是否该停止"，Aider 的 Editor 执行"如何编辑"。两者可合并思考：los 未来可让更强的 reasoning model 规划，更快的 editing model 执行具体修改。

**② Diff 编辑格式矩阵**

Aider 不是用一种编辑格式，而是**根据模型特性自适应选择**：

| 格式 | 适用场景 | Token 效率 |
|------|---------|:---:|
| `diff` (search/replace) | 大部分模型 | 高 |
| `udiff` (unified diff) | GPT-4 Turbo 系 | 高（3x less lazy） |
| `diff-fenced` | Gemini 系 | 中 |
| `whole` | 回退方案 | 低 |
| `editor-diff` | Architect 模式专用 | 高 |

关键经验：**统一的 diff 格式使得 GPT-4 Turbo 的 "lazy coding" 减少 3x**——模型不再输出"…add logic here…"注释。这是因为 diff 格式让模型聚焦于输出具体代码块而非高层描述。

**对 los 的启示**：los 当前只有基础的 write_edit 工具。可以根据 provider/model 自适应选择编辑格式，并为 reasoning-first 模型（如 o1/DeepSeek-R1）引入 architect/editor 分离。

---

### 2.2 Claude Code — **2026 架构全景更新**

Claude Code 的生态已经从单一 CLI 演化为完整的 agent 编排平台。以下是与 los 最相关的新进展：

**① Skills 统一化（2026 重大架构变化）**

Slash commands 和 skills 已合并为统一的 `SKILL.md` 格式。Frontmatter 控制全部行为：

```
关键 frontmatter 字段：
- description:        Claude 据此判断是否自动 invoke
- disable-model-invocation: true  → 仅手动 /skill-name
- context: fork      → 在独立 subagent context 中运行
- user-invocable: false → 仅背景知识，不出现在 / 菜单
- allowed-tools:     → 工具白名单
- paths:             → Glob 过滤（如 src/**/*.ts）
- agent: Explore     → fork 时指定 subagent 类型
```

**对 los 的启示**：los 的 `SKILL.md` 已有类似的 description 和 allowed-tools 机制，但缺少 `context: fork`（隔离执行）、`paths` 过滤、和 `user-invocable` 控制。Skills 统一化是值得跟踪的方向。

**② Hooks 生命周期（已扩展至 12 个事件）**

```
Tool 生命周期：    PreToolUse, PostToolUse
Session 生命周期： SessionStart, Stop, SubagentStart, SubagentStop
Task 生命周期：    TaskCreated, TaskCompleted
环境变化：         CwdChanged, FileChanged
权限事件：         PermissionDenied
上下文事件：       PreCompact, PostCompact  ← 新版
用户输入：         UserPromptSubmit, Notification
```

Hook 类型 4 种：`command`（shell）、`prompt`（LLM 决策）、`HTTP`（POST JSON + auth headers）、`async`（后台不阻塞）

**PreToolUse hooks 可以返回 `updatedInput` 修改工具参数**——这是比 los 当前 tool gate 更灵活的拦截机制。

**对 los 的启示**：
- `PreCompact`/`PostCompact` 是 los compaction 流程可直接借鉴的钩子点
- `FileChanged` 可驱动 los 的 auto checkpoint
- PreToolUse `updatedInput` 比 los 的 block/allow 二元 gate 更灵活

**③ Deferred Tool Loading（2026 新增）**

Claude Code 不再在启动时加载所有 MCP tool schema。改为先加载 tool name only，按需通过 `ToolSearch` 获取完整 schema。50+ MCP tools 时，context overhead 降低一个数量级。

**对 los 的启示**：los 的 tool 注册在 `registry.ts` 中全量加载。如果未来 tool 数量增长（50+），可按需 lazy load。

**④ Worktree Isolation（2026 新增）**

Subagent 可设置 `isolation: worktree`，在自己的 git worktree 中编辑文件，多个 subagent 并行编辑不冲突。无变更时自动清理；有变更时返回 worktree path + branch。

**对 los 的启示**：los 的多 agent 编排（agent-task-graph）目前没有文件隔离机制。worktree isolation 是解决并行 agent 文件冲突的优雅方案。

**⑤ Scheduled Tasks + Channels**

云端 cron job + MCP Channels（Telegram/Discord/webhook → Claude session）。与 los 的 governance jobs 调度器目标一致但方向不同——Claude 的云端执行，los 的本地执行。

---

### 2.3 Codex CLI — **2026 沙箱 + 多 Agent 架构更新**

**① 3 层沙箱架构（最详细的外部参考）**

```
Codex 主进程 (unsandboxed)
  └─ shell tool → 平台沙箱
       ├─ Linux: Bubblewrap + Landlock + seccomp
       └─ Windows: Restricted Tokens + ACL + Job Objects
```

两个预建沙箱账户：`CodexSandboxOffline`（无网络）、`CodexSandboxOnline`（经代理有网络）。ACL 管理：`apply_read_acls` 授予读权限，`audit_everyone_writable` 预检。

关键设计：**主 agent loop 有完整访问权限，只有唤起的 shell 命令在沙箱中运行**。这与 los 的 executor node 隔离模型不同——los 的隔离粒度是整个 executor node，Codex 的隔离粒度是单个 tool call。

**对 los 的启示**：los 的 executor node 目前无沙箱。Codex 的 per-tool-call 沙箱更细粒度，但复杂度更高。短期可先做 executor-level 隔离，中长期参考 per-tool 沙箱。

**② Compaction：加密服务端 + 本地回退双路径**

```
路径 A (OpenAI 托管模型):
  POST /v1/responses/compact → AES 加密的 compressed blob
  → 客户端不解密，直接传回下次请求
  → 服务端解密 → prepend handoff message → feed 模型

路径 B (第三方 provider):
  本地 append summarization prompt → 模型产出 handoff summary
  → 存为 user-role message (prefixed _summary)
```

**Codex 的 compaction 是完全不透明的**——客户端看不到压缩后的内容。这与 los 的透明 compaction（compacted summary 可读、可审计）形成对比。

**对 los 的启示**：los 的透明 compaction 是差异化优势（可审计）。但 Codex 的服务端 compaction 利用了 GPT-5.2-Codex 的原生 compaction 能力，质量可能更高。两者不互斥——los 可以考虑混合：本地透明 compaction + 可选的服务端 compaction。

**③ 多 Agent via Agents SDK**

Codex 通过 OpenAI Agents SDK 实现多 agent 编排：
- `codex` tool：启动新 Codex session → 返回 `threadId`
- `codex-reply` tool：继续已有 session（保持文件状态、对话历史、工具上下文）
- `handoffs` 参数定义哪些 agent 可以接管控制
- 每个 agent 有独立的 `approval-policy` 和 `sandbox` 配置

**对 los 的启示**：`threadId` 作为 session 连续性 token 的模式，与 los 的 `session_id` + SSE `Last-Event-ID` 类似。Agents SDK 的 handoff 机制比 los 的 agent-task-graph 更灵活（agent 间可以相互传递控制权），但 los 的 DAG 模型更适合确定性编排。

---

### 2.4 Context Compaction 学术前沿 🔥

这是本轮调研中**对 los 最直接可用的知识增量**。

**① 三大 Compaction 流派对比（Zylos Research 2026-05）**

| 流派 | 方法 | 优点 | 缺点 |
|------|------|------|------|
| **Claude Code 精密遗忘** | 3 层 cascade：tool result trimming → cache-preserving tail trim → LLM summary | 缓存友好，经济最优 | 复杂度高 |
| **Codex CLI 交接备忘录** | 单体 handoff summary 替换全部历史 | 简洁可预测 | 不可逆，细节丢失 |
| **OpenCode 阶梯治理** | 先隐藏（可恢复）→ 不够才 summary | 可逆可审计 | 存储开销，实现复杂 |

**② 核心实验证据：Masking > Summarization**

JetBrains Research (Dec 2025) 在 SWE-bench 250-turn agent 轨迹上测试：

| 策略 | 成本降低 | 解决率变化 | 运行时间 |
|------|:---:|:---:|:---:|
| **Observation masking** (用占位符替换旧 tool 结果) | 52% | **+2.6%** | 无变化 |
| Pure LLM summarization | 相似 | 无改善 | **+15%** |
| Hybrid (masking 为主 + summary 回退) | 59% | +2.6% | 无变化 |

**解决率提升的原因**：移除过时的 tool output 降低了 attention window 中的噪音，让模型聚焦于当前 task state。Summarization 反而延长运行时间，因为摘要模糊了 agent 判断"何时停止"的信号。

**对 los 的启示**：los 当前的 compaction 是纯 LLM summary——直接走 summarization 路径。可以在 summary **之前**加一个 masking 层：对于"效果已持久化到环境的 tool 调用"（如已写入文件的 write_edit、已返回结果的只读 grep），先用简短占位符替换，仅对"仍有未解决状态的 tool 调用"保留完整内容。

**③ CWL（Context Window Lifecycle）论文（arXiv 2026-05）**

提出了一种**无 LLM 参与的、确定性的语义逐出策略**：

```
Agent 在执行中标注每个 action 的 episode 类型和依赖关系
  → 形成 dependency-linked episode graph
  → 当 token budget 超限时，确定性策略按优先级逐出：
      1. 优先保留：user turns + agent 正在推理的探索性 context
      2. 优先丢弃：效果已持久化到环境的 action episodes
  → 不需要 LLM 参与逐出决策（零额外成本）
```

与 summarization 对比，CWL 避免了 4 个已知限制：不可预测的信息丢失、因果结构破坏、阻塞性 LLM 成本、压缩诱导的幻觉。

实证结果：**单个 agent session 在 80M token 的跨度内完成 89 个顺序任务，相对于 per-task 隔离 session 无性能退化**。

**对 los 的启示**：这是 los 可以直接实现的最重要优化。los 的 `session_events` 天然有 event type 和工具调用状态：
- write_edit → 效果已持久化（文件已修改）→ 可安全逐出原始内容
- read_file → 效果已返回（模型已看到内容）→ 可替换为占位符
- tool_call_state.cancelled → 无需保留 → 可完全逐出
- user message → 始终保留

可以在不增加 LLM 调用成本的情况下，将 los 的 compaction 效率提升 50%+。

**④ 上下文压力经济学**

关键发现：
- **0-60% 填充率**：正常性能
- **60-70%**：长距离依赖开始不可靠（30 个 turn 前的文件引用）
- **70-85%**：结构化输出质量下降（JSON 格式错误、不完整 tool call、漏指令）
- **85-100%**：临界区（可能无法遵循 system prompt 或输出截断）

200K context 窗口的**有效可用量约 140-160K tokens**。

Cache TTL 与 compaction 的交互：**每次 compaction 摧毁缓存前缀，触发全价重读**。5 分钟 cache TTL 形成一个"死亡区间"——刚好 5 分钟的等待是最坏情况（付了 cache miss 但没有获得任何好处）。

**对 los 的启示**：
1. 在 60% context fill 时开始 warn，75% 时写 checkpoint，85% 前触发 compaction
2. 监控 cache hit rate（低于 70% = TTL mismatch 或频繁 compaction 或 tool result 增长）
3. 考虑在 compaction 前先用 masking 做 Layer 1，减少不必要的 cache 重建

**⑤ projectmem（arXiv 2026-06-10）**

一个与 los memory 模块高度相关的独立项目：append-only event log → 确定性 projection → AI-readable summary（MCP 服务）。核心理念是 **Memory-as-Governance**：memory 不止回答 agent 的查询，还在 agent 将要重复一次已失败的操作或编辑一个已知脆弱的文件时**主动拦截**。

**对 los 的启示**：los 的 memory compaction + procedural rules 已部分实现这个模式，但缺少"pre-action gate"——在 tool call 执行前检查是否与已知失败模式匹配。这是对 los tool gate 的自然扩展。

---

### 2.5 MiMo-Code — 跟进更新

自 6/11 深度分析和 6/17 P0 评估以来无重大新版本发布。核心状态不变：
- P0-1 Checkpoint-Writer ✅ 已启动评估
- P0-2 Judge Model ✅ 已启动（缩小范围）
- P0-3 Auto Compaction ⚠️ 推迟→P1

MiMo 的"unlimited context"是通过 checkpoint + context reconstruction 实现的，与 CWL 的语义逐出是不同路径。两者可以互补：checkpoint 保证恢复质量，CWL 降低 compaction 频率。

---

### 2.6 LangGraph — 跟进

LangGraph 最新版本 v1.1.6（2026-04），核心进展：
- Thread-scoped memory（checkpoint 持久化）vs long-term memory（跨 session）
- LangMem 提供 memory management 抽象
- 仍然是 Python-first，对 TypeScript monorepo 的直接参考价值有限

对 los 的参考价值集中在：状态机设计模式（conditional edge、checkpoint + thread state），与 los 的 agent-task-graph 差异化在于 LangGraph 是通用框架，los 是具体 agent 执行平台。

---

## 三、对 los 的可吸收设计清单（按优先级）

### P0：立即评估（本周可启动）

| # | 来源 | 吸收点 | los 受益模块 | 工作量 |
|---|------|--------|------------|:---:|
| 1 | CWL 论文 | **Semantic eviction Layer 1** — 在 LLM compaction 前用 masking 替换已持久化的 tool result | compaction.ts | 2-3天 |
| 2 | JetBrains Research | **Context fill 监控** — 60% warn / 75% checkpoint / 85% compact 阈值 | chat-service.ts, loop.ts | 1-2天 |
| 3 | projectmem | **Pre-action gate** — tool call 前检查已知失败模式 | tool-call-gate.ts, memory | 1-2天 |

### P1：本月评估

| # | 来源 | 吸收点 | los 受益模块 | 工作量 |
|---|------|--------|------------|:---:|
| 4 | Aider | **Architect/Editor 双模型分离** — 扩展 P0-2 Judge 概念到编辑分离 | loop.ts, agent tools | 3-5天 |
| 5 | Claude Code | **PreCompact/PostCompact hooks** — compaction 生命周期钩子 | compaction.ts, gateway hooks | 2-3天 |
| 6 | Claude Code | **Deferred Tool Loading** — tool name only → 按需 ToolSearch | registry.ts | 2-3天 |
| 7 | Codex CLI | **Compaction 双路径** — 可选的服务端 compaction (Anthropic compact endpoint) | compaction.ts, provider | 2-3天 |

### P2：中长期关注

| # | 来源 | 吸收点 | 说明 |
|---|------|--------|------|
| 8 | Claude Code | **Worktree Isolation** — 多 agent 并行编辑文件隔离 | 依赖 git worktree 支持 |
| 9 | Aider | **自适应编辑格式** — 根据 provider/model 选择最优 diff 格式 | write_edit 工具增强 |
| 10 | Claude Code | **Skills `paths` 过滤 + `context: fork`** | los SKILL.md 扩展 |
| 11 | Codex CLI | **Per-tool-call 沙箱隔离** | 安全加固 |
| 12 | LangGraph | **Conditional edge + checkpoint** | agent-task-graph 升级 |

---

## 四、los 差异化位置更新

经过本轮调研，los 的差异化优势**更加清晰**：

| 能力 | los 领先幅度 | 竞品追赶速度 |
|------|:---:|:---:|
| Phase Enforcement (B0 gate) | **唯一拥有**（全竞品无等效实现） | 无追赶信号 |
| 持久化 Tool State (跨进程取消) | **唯一拥有**（Codex/Claude 均为进程级） | 无追赶信号 |
| Provider 兼容性验证 | **唯一拥有**（formalized compat harness） | 无追赶信号 |
| Memory Compaction | 被 Claude Code 3-layer cascade 超越 | Claude Code 领先 |
| 上下文窗口管理 | **严重落后**（los 无分层策略） | 所有主要竞品都有成熟方案 |
| Operator UX | **严重落后**（los 无 TUI，Web UI 基础） | Aider/Claude Code/Codex CLI 都很成熟 |

**核心结论**：los 在后端治理层（Phase gate + Tool state + Provider compat）保持无人能及的领先，但在前端体验层（上下文管理 + 编辑策略 + UX）与头部竞品差距明显。优先补齐上下文管理（P0），再逐步改善编辑策略和 UX（P1-P2），是当前最合理的策略。

---

## 五、信息源汇总

| 编号 | 来源 | URL | 类型 |
|------|------|-----|------|
| S1 | Aider 官方文档 — Edit formats | https://aider.chat/docs/more/edit-formats.html | 官方文档 |
| S2 | Aider 官方文档 — Chat modes | https://aider.chat/docs/usage/modes.html | 官方文档 |
| S3 | Aider 官方博客 — Architect mode | https://aider.chat/2024/09/26/architect.html | 官方博客 |
| S4 | Aider DeepWiki — Architect Mode | https://deepwiki.com/Aider-AI/aider/5.5-architect-mode | 社区深度文档 |
| S5 | Zylos Research — Context Window Management 2026 | https://zylos.ai/research/2026-05-05-ai-agent-context-window-management-compaction-continuity-cost | 独立研究 |
| S6 | alexop.dev — Claude Code Explained 2026 | https://alexop.dev/posts/understanding-claude-code-full-stack/ | 技术深度文章 |
| S7 | arXiv:2606.11213 — CWL: Structured Context Eviction | https://arxiv.org/html/2606.11213 | 学术论文 |
| S8 | arXiv:2606.12329 — projectmem: Memory-as-Governance | https://arxiv.org/abs/2606.12329v1 | 学术论文 |
| S9 | Anthropic — Effective Context Engineering | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | 官方工程博客 |
| S10 | Codex Knowledge Base — Compaction Architecture | https://codex.danielvaughan.com/2026/03/31/codex-cli-context-compaction-architecture/ | 社区深度文档 |
| S11 | Codex Knowledge Base — Internals: Sandbox | https://codex.danielvaughan.com/2026/04/10/codex-cli-internals-queue-pair-guardian-sandbox/ | 社区深度文档 |
| S12 | Codex Knowledge Base — Multi-Agent + Agents SDK | https://codex.danielvaughan.com/2026/06/04/codex-cli-openai-agents-sdk-mcp-server-multi-agent-handoffs-traces-pipelines/ | 社区深度文档 |
| S13 | Codex DeepWiki — Session Lifecycle | https://deepwiki.com/openai/codex/3.1-codex-interface-and-session-lifecycle | 社区深度文档 |
| S14 | Developers Digest — AI Coding Tools Matrix 2026 | https://www.developersdigest.tech/blog/ai-coding-tools-comparison-matrix-2026 | 行业对比 |
| S15 | Red Hat Memory Hub — Context Compaction Survey | https://github.com/redhat-ai-americas/memory-hub/blob/main/research/context-compaction-survey.md | 开源研究 |
