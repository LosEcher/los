# los 竞品调研与多维探索策略

> 设计日期：2026-06-20
> 基于：历史 9 份研究/分析文档 + 2 轮竞品快照 + toolchain-matrix 框架
> 关联：[[los-competitive-landscape-2026-06]] [[los-mimo-code-analysis]] [[los-cbm-analysis]] [[los-periodic-analysis]]

---

## 一、历史研究全景盘点

### 1.1 已完成的深度分析（按时间线）

| 日期 | 分析对象 | 文档位置 | 深度 | 核心发现 |
|------|---------|----------|:---:|---------|
| 2026-06-09 | **Codex CLI / Claude Code / LangGraph** | `docs/research/2026-06-competitive-landscape.md` | Trace-case 5 维对比 | los 唯一有 Phase Enforcement + 持久化 Tool State + Memory Compaction |
| 2026-06-11 | **MiMo-Code** | `docs/research/2026-06-11-mimo-code-analysis.md` | 5 角色深度分析 | 12 actionable TODOs，P0-1/P0-2 已启动 |
| 2026-06-11 | **lsclaw / vpsagentweb / pi / los-memory** | `docs/research/agent-execution-records-findings.md` | 执行记录协议层对比 | 识别出 projection/read-model 层缺失根因 |
| 2026-06-12 | **los 自身** | `docs/architecture/2026-06-12-full-audit.md` | 4 路并行静态审计 | H1 delta 静默丢弃 / H2 契约无强校验 / H3 无 DLQ |
| 2026-06-15 | **pi + lsclaw** | `docs/operations/2026-06-15-phase2-range-analysis.md` | 架构模式抽取 + 静态扫描 | 13 个可吸收模式，3 个反模式 |
| 2026-06-17 | **MiMo-Code P0 评估** | `projects/los/docs/research/2026-06-17-mimo-p0-evaluation.md` | P0 3 项评估 | Checkpoint ✅启动, Judge ✅启动, Auto Compaction ⚠️推迟 |
| 2026-06-19 | **codebase-memory-mcp** | `projects/los/docs/research/codebase-memory-mcp-analysis.md` | 全架构 7 层分析 | 5 Phase 联动路线图 + 5 个核心算法 + ADR 建议 |
| 2026-06-19 | **CBM H1-H3 验证** | `projects/los/docs/research/cbm-validation-2026-06-19.md` | 实验验证 | 符号识别 100%、token 节省 10-100x、符号映射 100% |
| 2026-06-19 | **los 全项目结构化索引** | `docs/structured-project-context-2026-06-19.md` | 项目全景快照 | 362 TS 源文件、67K 行、8 包、12 迁移文件 |

### 1.2 被分析项目的分类

```
                    ┌─────────────────────────────┐
                    │      Agent CLI 工具          │
                    │  Codex CLI ✅                │
                    │  Claude Code ✅              │
                    │  MiMo-Code ✅✅ (深度)        │
                    │  pi ✅ (架构模式抽取)         │
                    │  OpenCode ❌ (仅提及)         │
                    │  Reasonix ❌ (仅提及)         │
                    │  Gemini CLI ❌ (仅提及)       │
                    └─────────────────────────────┘
                    
                    ┌─────────────────────────────┐
                    │      Agent 平台/框架         │
                    │  LangGraph ✅                │
                    │  lsclaw ✅ (深度对比)         │
                    │  vpsagentweb ✅ (事件 API)    │
                    │  OMX ❌ (仅 ADR 0016 沾边)    │
                    └─────────────────────────────┘
                    
                    ┌─────────────────────────────┐
                    │      基础设施/工具            │
                    │  codebase-memory-mcp ✅✅    │
                    │  los-memory ✅               │
                    │  los-ast ✅ (legacy)         │
                    └─────────────────────────────┘
                    
                    ┌─────────────────────────────┐
                    │      未覆盖 (Gap)            │
                    │  Aider, Cursor, Continue     │
                    │  Codeium/Windsurf, Devin    │
                    │  Copilot, CrewAI, AutoGPT   │
                    │  TaskWeaver, Goose, Qwen     │
                    └─────────────────────────────┘
```

### 1.3 分析方法的演进

| 阶段 | 时间 | 方法 | 适用场景 |
|------|------|------|---------|
| **Trace-case 对比** | 6/9 | 5 个固定维度打分 ✅/⚠️/❌ | 快速定位差异化 |
| **5 角色深度分析** | 6/11 | Memory/Context/Runtime/DX/Self-Improvement 五个角色视角 | 可借鉴特性挖掘 |
| **协议层逆向** | 6/11 | 提取执行记录协议 → 对照 los 协议层缺口 | 架构差距分析 |
| **架构模式抽取** | 6/15 | 静态扫描 + 模式识别 + 反模式过滤 | 可吸收设计模式 |
| **全架构分层分析** | 6/19 | 物理层→解析层→存储层→索引层→查询层→同步层→集成层 | 集成可行性评估 |
| **实验验证** | 6/19 | H1-H3 假设 + 实测数据 + 门槛判定 | 去风险化 |

---

## 二、未覆盖的竞品空白 (Gap Analysis)

### 2.1 完全未触达的竞品

| 竞品 | 未覆盖原因 | 调研优先级 | 调研价值 |
|------|-----------|:---:|---------|
| **Aider** | 未被纳入 scope | 🔴 高 | 最成熟的 OSS coding agent，diff 编辑策略、repo map 设计业界领先 |
| **Cursor** | 闭源 IDE 不易反向分析 | 🔴 高 | 产品定义最成功的 AI coding 工具，tab 补全 + inline edit UX 标杆 |
| **Windsurf (Codeium)** | 未被纳入 scope | 🟡 中 | Flow 模式 + Cascade 多步推理，与 los 的多 agent 编排相关 |
| **Devin (Cognition)** | 闭源，定位不同 | 🟡 中 | 全自主 agent 产品化最前沿，任务规划 + 浏览器操作模式 |
| **Continue** | IDE 插件 | 🟢 低-中 | OSS IDE agent，VS Code/JetBrains 集成模式 |
| **OpenCode** | 有提及但无分析 | 🟡 中 | MiMo-Code 的上游 fork，工具注册 + Hooks 机制 |
| **Goose (Block)** | 较新 | 🟢 低 | Block 开源的 agent 框架，MCP 原生集成 |
| **Qwen Coder** | 较新 | 🟢 低 | 阿里 Qwen3-Coder 模型开源，与 los 的 provider 兼容性相关 |

### 2.2 已有但不够深入的分析维度

| 已分析对象 | 盲区 | 补全方向 |
|-----------|------|---------|
| **Codex CLI** | 仅 trace-case 对比，未分析其 hook/sandbox/exec mode 实现 | Hook 注入机制、sandbox 隔离设计 |
| **Claude Code** | 仅 trace-case 对比，未分析其 hooks/memory/skills/plugin 体系 | hooks 生命周期、MCP 工具编排、skills 注册 |
| **LangGraph** | 仅 trace-case 对比，未分析 DAG 调度 + conditional edge 具体实现 | 状态图调度 vs los agent-task-graph 的差异量化 |
| **MiMo-Code** | P0 评估完成但 P1-P2 未推进 | 上下文重建协议、Compose Mode、/distill 实现 |
| **pi** | 模式抽取完成但未评估迁移成本 | 13 个可吸收模式的优先级排序 + 迁移工作量 |

---

## 三、多维调研策略设计

### 3.1 调研架构：五维并行

```
                    ┌──────────────────────────────────┐
                    │          los 调研决策中心          │
                    └──────────────┬───────────────────┘
                                   │
          ┌────────────┬───────────┼───────────┬────────────┐
          │            │           │           │            │
    ┌─────▼─────┐ ┌────▼────┐ ┌───▼────┐ ┌───▼─────┐ ┌───▼──────┐
    │ 维度 1    │ │ 维度 2  │ │ 维度 3 │ │ 维度 4  │ │ 维度 5   │
    │ 竞品快照  │ │ 深度吸收│ │ 集成   │ │ 生态    │ │ 自省     │
    │ (广度)    │ │ (深度)  │ │ 评估   │ │ 趋势    │ │ (内视)   │
    └─────┬─────┘ └────┬────┘ └───┬────┘ └───┬─────┘ └───┬──────┘
          │            │           │           │            │
    每月 1 次      每季 1 次    按需触发    持续监控    每周审计
    轻量打分       深度逆向     可行性实验   信息摄入    内部漂移
```

### 3.2 维度 1：竞品快照矩阵（广度优先，月度）

**目标**：快速感知竞品版本变化和方向性移动，不需要深度逆向。

**目标竞品池**（分 Tier）：

| Tier | 项目 | 监控频率 | 监控方式 |
|------|------|:---:|---------|
| **Tier 0** (核心差异化对手) | Claude Code, Codex CLI | 每月 | release notes diff + changelog 扫描 |
| **Tier 1** (直接可比) | MiMo-Code, Aider, LangGraph | 每月 | release notes + 关键 PR/issue 扫描 |
| **Tier 2** (方向参考) | Cursor, Windsurf, Devin, OpenCode | 每季 | 产品更新 + 技术博客 |
| **Tier 3** (趋势信号) | Goose, CrewAI, Continue, Qwen Coder | 每季 | 仅显著版本发布 |

**快照模板**（10 个固定维度，每个 1-3 分 + 备注）：

```
| 维度 | los 当前 | Claude Code | Codex CLI | Aider | MiMo-Code |
|------|:---:|:---:|:---:|:---:|:---:|
| 1. Phase Enforcement / 生命周期 | 3 | 1 | 1 | 1 | 2 |
| 2. 持久化 Tool State | 3 | 1 | 1 | 1 | 1 |
| 3. Memory Compaction / 记忆压缩 | 3 | 2 | 1 | 1 | 2 |
| 4. 多 Agent 编排 (DAG) | 2 | 1 | 1 | 1 | 2 |
| 5. Provider 兼容性验证 | 3 | 2 | 2 | 2 | 1 |
| 6. Run Replay / 可恢复性 | 3 | 2 | 1 | 1 | 1 |
| 7. 上下文窗口管理 | 1 | 2 | 2 | 3 | 3 |
| 8. 工具生态 / MCP 集成 | 2 | 3 | 2 | 2 | 2 |
| 9. 代码编辑策略 (diff/inline) | 1 | 2 | 2 | 3 | 1 |
| 10. Operator UX / 产品化 | 1 | 3 | 3 | 3 | 1 |
```

**实现方式**：
- 新增 `competitive_snapshot` governance job type，cadence=monthly
- Auditor 函数：扫描 Tier 0-2 的 GitHub releases / changelogs → 更新得分矩阵
- 产出：`docs/research/competitive-snapshot-YYYY-MM.md`

### 3.3 维度 2：专项深度吸收（深度优先，按需触发）

**目标**：对 los 有直接吸收价值的竞品特性做逆向工程级分析。

**触发条件**（满足任一条即启动）：
1. 竞品发布了一个 los 规划中但未实现的核心能力
2. 月度快照发现某一维度差距 ≥ 2 分
3. 操作者明确要求吸收某个外部设计
4. los 自身模块设计遇到瓶颈，需要外部参考

**吸收流程**（4 阶段，参考 MiMo 分析和 CBM 分析的经验）：

```
阶段 A: 协议层逆向 (1-2天)
  ├─ 阅读源码中的类型定义 / schema / 接口契约
  ├─ 提取核心对象模型 (实体、关系、生命周期)
  └─ 输出: 协议对照表 (竞品 vs los 当前 vs los 目标)

阶段 B: 机制层分析 (1-2天)
  ├─ 追踪关键流程的完整调用链
  ├─ 提取状态机 / 触发条件 / 异常路径
  └─ 输出: 机制差异报告 + 可迁移设计模式

阶段 C: 实验验证 (1-2天)
  ├─ 在隔离环境安装/运行竞品
  ├─ 用固定场景 (golden fixture) 验证关键行为
  └─ 输出: 行为证据 + 误判风险

阶段 D: 迁移设计 (1-2天)
  ├─ 评估迁移成本 (工作量、影响范围、破坏性)
  ├─ 与现有 ADR 的一致性检查
  └─ 输出: 吸收 ADR + 分阶段实施计划
```

**当前队列**（按优先级）：

| 序号 | 目标 | 吸收点 | 触发条件 | 状态 |
|:---:|------|--------|----------|:---:|
| 1 | **Aider** | diff 编辑策略、repo map 设计 | 月度快照发现差距 ≥ 2 分 | ❌ 未启动 |
| 2 | **Claude Code hooks** | hooks 生命周期、MCP tools 编排 | los 的 tool policy 模块设计需要参考 | ❌ 未启动 |
| 3 | **MiMo-Code 上下文重建** | 上下文压缩+重建协议 | P1-4 推进时触发 | ⏳ MiMo P0 已评估 |
| 4 | **Cursor tab 补全** | inline edit + 预测 UX | los Web UI 重构时触发 | ❌ 未启动 |
| 5 | **LangGraph DAG 调度** | conditional edge + checkpoint | los agent-task-graph 升级时触发 | ❌ 未启动 |

### 3.4 维度 3：集成可行性评估（技术验证）

**目标**：验证外部工具/库是否可以作为 los 的运行时依赖或 MCP 资源。

**历史经验**（CBM Phase 0 的模式可复用）：

```
Phase 0: 基础对接 (1-2天)
  ├─ 安装二进制/库 → 验证可用
  ├─ 手动调用所有 API/工具 → 记录延迟和可靠性
  ├─ 设计 feature flag 隔离
  └─ 输出: 可用性报告 + 对接客户端代码

Phase 1: 影子模式 (3-5天)
  ├─ 封装调用 (feature flag 默认为 false)
  ├─ 在不影响主流程的前提下记录双轨数据
  ├─ 测量性能影响和 token 节省
  └─ 输出: 双轨对比数据 + 决策建议

决策点: 继续 (进入深度集成) / 降级 (保持影子模式) / 终止 (移除依赖)
```

**候选集成目标**：

| 目标 | 集成方式 | 受益模块 | 可行性 |
|------|---------|----------|:---:|
| **codebase-memory-mcp** | MCP stdio | memory (双层记忆) | ✅ Phase 0 已验证 |
| **MCP servers (通用)** | MCP stdio/HTTP | agent tools | 🟡 待探索 |
| **Tree-sitter 语法** | npm 包 | static-analysis | 🟡 可替换 ast-grep |
| **nomic-embed-code** | 本地模型 | memory retrieval | 🟢 远期 |
| **OpenTelemetry** | SDK 集成 | trace/observability | 🟢 远期 |

### 3.5 维度 4：生态趋势监控（持续信息摄入）

**目标**：追踪 AI coding agent 领域的宏观趋势，防止方向性盲区。

**信息源分层**：

| 层级 | 来源 | 频率 | 用途 |
|------|------|:---:|------|
| **L1 官方发布** | GitHub releases, changelogs, official blogs | 自动 (RSS/GitHub watch) | 准确版本事实 |
| **L2 社区信号** | Hacker News, Reddit r/LocalLLaMA, r/programming | 每周浏览 | 趋势感知 |
| **L3 深度内容** | 技术博客, arXiv, 架构决策记录 | 每月精读 | 设计启发 |
| **L4 竞品源码** | 直接阅读关键 PR/commits | 按需 | 实现细节 |

**实现方式**：
- `ecosystem_trend` governance job type，cadence=weekly
- 利用现有 Firecrawl search + exa search 工具自动拉取
- 输出格式：`docs/research/trends/YYYY-WW.md`（每周一条摘要记录）

**当前需追踪的关键趋势信号**：

1. **MCP 协议演进** — Anthropic 的 MCP 2.0 路线图是否改变 agent 工具生态
2. **本地模型能力跃迁** — Qwen3-Coder / DeepSeek-Coder-V3 对 provider 层的冲击
3. **Agent-to-Agent 协议** — Google A2A / Anthropic Agent Protocol 标准化进展
4. **上下文窗口经济学** — 100K→1M→2M token 窗口扩大对记忆策略的影响
5. **代码编辑原语进化** — 从 apply-patch 到 AST-level edit 到 semantic diff

### 3.6 维度 5：内部自省（内视审计，每周）

**目标**：确保 los 自身的分析能力不退化，不被外部趋势带偏。

**已有机制**（不应重复建设）：
- `consistency_audit` (daily) — seed/DB 一致性
- `memory_integrity` (daily) — compaction 完整性
- `architecture_drift` (weekly) — ADR 与实现一致性
- `reflection` (daily) — todo reconciliation
- `file_size` (daily) — 文件大小门禁

**需新增的自省维度**：

| 审计维度 | 频率 | 检查内容 | 与竞品调研的关系 |
|----------|:---:|----------|-----------------|
| **research_freshness** | 每月 | 检查所有竞品快照的时效性，标记超过 3 个月未更新的条目 | 防止快照矩阵腐化 |
| **absorbed_pattern_coverage** | 每季 | 检查历史吸收的外部模式是否仍在 los 中存活（未被重构覆盖） | 防止吸收→遗忘 |
| **toolchain_matrix_drift** | 每月 | 已在 periodic-analysis.md 维度 8 中定义 | 确保外部工具路径未漂移 |
| **competitive_gap_trend** | 每季 | 追踪 los 与竞品的差距是扩大还是缩小 | 调整研发优先级输入 |

### 3.7 五种工具的搜索策略适配

基于 los 当前可用的 5 种搜索/信息获取工具，分配不同的调研角色：

| 工具 | 最适合的调研场景 | 典型查询 |
|------|-----------------|---------|
| **Firecrawl search** | Web 端公开信息 (release notes, blogs, docs) | "Claude Code June 2026 changelog new features" |
| **Exa search** | 需要干净全文的深度内容 | "Aider AI pair programming architecture analysis" |
| **Firecrawl agent** | 需要跨多页浏览的复杂调研 | "提取 LangGraph v0.3+ 的 DAG checkpoint 设计文档" |
| **Tavily research** | 综合多源研究 (含新闻/论文/技术博客) | "AI coding agent landscape 2026 memory management comparison" |
| **Firecrawl research papers** | arXiv 学术论文 (agent architecture, code generation) | "agentic code generation with persistent memory" |
| **GitHub search (Firecrawl)** | GitHub issues / PRs 中的设计讨论 | "MiMo-Code checkpoint-writer architecture decision" |
| **codebase-memory-mcp** | 本地/已索引项目的代码结构 | 查询 los 自身代码 → 对比外部设计 |

---

## 四、治理机制与周期设计

### 4.1 新 Governance Jobs

| Job Type | Cadence | Tier 覆盖 | 产出 |
|----------|:---:|------|------|
| **competitive_snapshot** | monthly | Tier 0-2 (5-7个项目) | `competitive-snapshot-YYYY-MM.md` |
| **ecosystem_trend** | weekly | L1-L3 信息源 | `trends/YYYY-WW.md` |
| **research_freshness** | monthly | 所有历史快照 | 过期标记 + 刷新建议 |
| **absorbed_pattern_coverage** | quarterly | 已吸收模式 | 存活模式检查报告 |

### 4.2 年度调研节奏

```
Q1 (1-3月)          Q2 (4-6月)           Q3 (7-9月)          Q4 (10-12月)
│                    │                    │                    │
├─ 月度快照 ×3       ├─ 月度快照 ×3       ├─ 月度快照 ×3       ├─ 月度快照 ×3
├─ 趋势周报 ×12      ├─ 趋势周报 ×12      ├─ 趋势周报 ×12      ├─ 趋势周报 ×12
├─ 深度吸收 1-2 项   ├─ 深度吸收 1-2 项   ├─ 深度吸收 1-2 项   ├─ 深度吸收 1-2 项
└─ 季度全景报告      └─ 季度全景报告      └─ 季度全景报告      └─ 年度全景报告
                     │                    │                    │
                     已完成:              ︙                    ︙
                     • 竞品全景 v1 (6/9)  ︙                    ︙
                     • MiMo 深度 (6/11)   ︙                    ︙
                     • pi+lsclaw (6/15)   ︙                    ︙
                     • CBM 分析 (6/19)    ︙                    ︙
```

### 4.3 文档产出规范

所有调研文档统一放在 `projects/los/docs/research/` 下，按以下命名约定：

```
projects/los/docs/research/
├── competitive-snapshot-YYYY-MM.md        # 月度竞品快照
├── deep-dive-<project>-<topic>-YYYY-MM.md  # 专项深度吸收
├── integration-<tool>-eval-YYYY-MM.md      # 集成可行性评估
├── trends/                                 # 生态趋势
│   └── YYYY-WW.md                          # 每周趋势摘要
├── adr/                                    # 吸收产生的 ADR
└── README.md                               # 本策略文档的索引
```

**每条记录的必备字段**：
- 日期、分析对象版本号
- 信息源 (URLs / commit hashes / release tags)
- 分析方法 (trace-case / role-based / protocol-reverse / pattern-extract / experiment)
- 核心发现 (≤ 1 页)
- 对 los 的建议 (吸收 / 关注 / 忽略 / 验证)

---

## 五、立即行动项

### 5.1 本周 (P0)

| # | 行动 | 说明 |
|---|------|------|
| 1 | **添加 `competitive_snapshot` governance job** | 在 SEED_JOBS 中新增 monthly job，创建 auditor 函数骨架 |
| 2 | **添加 `ecosystem_trend` governance job** | 在 SEED_JOBS 中新增 weekly job，先手动出第一期趋势周报 |
| 3 | **Aider 首次快照** | 完成 Aider 的首次 trace-case 打分，补全 Tier 1 缺口 |

### 5.2 本月 (P1)

| # | 行动 | 说明 |
|---|------|------|
| 4 | **Claude Code hooks 专项** | 逆向 Claude Code hooks 生命周期，评估 los tool policy 可吸收点 |
| 5 | **竞争快照自动化** | auditor 函数实现：扫描 GitHub releases → 更新 10 维矩阵 → 生成 markdown |
| 6 | **更新 toolchain-matrix.md** | 填充所有已提及但未记录的外部工具矩阵条目 |

### 5.3 本季 (P2)

| # | 行动 | 说明 |
|---|------|------|
| 7 | **MiMo P1 上下文重建深度分析** | 从 MiMo P0 评估结果继续推进，分析 context reconstruction 协议 |
| 8 | **季度全景报告 2026-Q2** | 汇总 Q2 所有调研发现，更新 los 优先级排序 |
| 9 | **吸收模式存活检查** | 第一次 `absorbed_pattern_coverage` 审计 |

---

## 六、判断矩阵：何时深入，何时跳过

| 信号 | 行动 |
|------|------|
| 竞品发布了一个 los 核心路径上的功能 (memory/tool recovery/phase gate) | **深度吸收 (维度 2 全流程)** |
| 竞品月度快照某一维度连续 2 次差距 ≥ 2 分 | **启动专项调研 + 决定是否吸收** |
| 竞品发布无直接竞争关系的新能力 (如 Voice/Image) | **趋势周报记录，不深度分析** |
| 社区热议但技术路线与 los 定位冲突 (如纯 in-memory agent) | **观察，不跟风** |
| 闭源竞品的产品更新 (Cursor/Devin) | **仅 Tier 2 季度快照，不做逆向** |
| 已有分析对象发布新大版本 | **差异分析 (delta)，不全量重做** |
| 学术论文提出新的 agent 架构范式 | **arXiv 检索 + 趋势周报 + 如相关则深度阅读** |

---

## 七、反模式与约束

### 7.1 不做的事

1. **不对闭源产品做逆向工程** — Cursor/Devin 的产品行为可观察，但源码/协议不逆向
2. **不因为竞品有了就盲目追** — 每个吸收决定必须经过"对 los 的差异化价值"评估
3. **不把所有趋势写入 ADR** — 趋势周报是轻量信号，只有经过验证的吸收决定才进 ADR
4. **不堆积未处理的调研文档** — 每份调研产出必须落到 吸收/关注/忽略/验证 四选一
5. **不为调研而牺牲 P0 交付** — 调研工作量上限：月度 ≤ 1 天，季度深度 ≤ 3 天

### 7.2 质量约束

- 每个深度吸收必须有实验验证 (H1-H3 假设 + 实测数据)
- 每个月度快照必须标注信息源版本和时效性
- 引用外部信息必须保留原始链接，不靠记忆复述
- 趋势判断必须区分"有证据的趋势"和"个人感知的信号"

---

## 八、总结

los 的调研能力已经从最初的单点快照进化到了**五维并行体系**：

1. **广度覆盖** — 月度竞品快照 (10 维度 × 8+ 竞品)
2. **深度吸收** — 按需触发的 4 阶段逆向分析
3. **集成验证** — H1-H3 假设驱动的实验评估
4. **趋势监控** — 每周生态信号 + 季度全景报告
5. **内省审计** — 防止自身分析和架构腐化

这个体系的输出直接反馈到 los 的研发优先级（通过 `cbm-los-task-breakdown.md` 中建立的优先级重排机制），确保外部视野不脱离内部执行。
