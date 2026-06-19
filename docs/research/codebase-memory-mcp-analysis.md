# Codebase-Memory-MCP 设计分析 & los 记忆联动策略

> 分析日期：2026-06-19
> 分析对象：https://github.com/DeusData/codebase-memory-mcp (v0.8.1, MIT)
> 联动目标：los memory 模块 (PostgreSQL, ADR 0020, 五层记忆)

---

## 一、codebase-memory-mcp 架构分层

### 1.1 物理层：纯 C 静态二进制

```
源文件结构：
src/
├── main.c              # 三合一入口：MCP stdio / CLI / install
├── mcp/                # 14 个 MCP tools (JSON-RPC 2.0)
├── cli/                # 11 种 agent 自动检测 + hooks 注入
├── store/              # SQLite 图存储 (nodes/edges/traversal/search/Louvain)
├── pipeline/           # 六阶段索引流水线
├── cypher/             # openCypher 子集 (lexer/parser/planner/executor)
├── discover/           # 文件发现 (.gitignore/.cbmignore/symlink)
├── watcher/            # 后台自动同步 (git polling + 自适应间隔)
├── traces/             # 运行时 trace 摄取 (验证 HTTP_CALLS edges)
├── ui/                 # 嵌入式 HTTP server + 3D 图可视化
└── foundation/         # 平台抽象 (threads/fs/logging/memory)

internal/cbm/           # 158 种语言的 vendor tree-sitter 语法
vendored/               # 编译进二进制的第三方依赖 (含 nomic-embed-code)
```

关键设计决策：
- **零运行时依赖** — 所有 vendor 编译进二进制，不依赖 Docker/API key/Ollama
- **RAM-first pipeline** — LZ4 HC 压缩读取 → 内存 SQLite → 单次刷盘，索引完释放内存
- **本地优先** — 数据库在 `~/.cache/codebase-memory-mcp/`，代码不出机器

### 1.2 解析层：双层 AST → 知识图谱

```
第一层：Tree-sitter (语法级，158 语言全覆盖)
  ├─ 提取 definitions (函数/类/接口/枚举/类型/路由)
  ├─ 提取 calls (函数调用关系)
  └─ 提取 imports (跨文件依赖)

第二层：Hybrid LSP (语义级，10 语言深度解析)
  ├─ Python, TS/JS/JSX/TSX, PHP, C#, Go, C/C++, Java, Kotlin, Rust
  ├─ 解析 imports → 解析泛型 → 解析继承 → 类型推导
  └─ 产出 REFINED_CALLS, USAGE, RESOLVED_CALLS edges
```

这是 codebase-memory-mcp 最核心的设计：**Tree-sitter 是广度（158 语言），Hybrid LSP 是深度（10 语言）**。浅层解析足够支撑调用图遍历和变更影响分析；深层解析解决多态、泛型、类型推导等语义问题。

### 1.3 存储层：SQLite 图数据库

**节点标签**（13 种）：
| 层级 | 标签 | 含义 |
|------|------|------|
| 项目 | `Project` | 代码仓库 |
| 包 | `Package` | npm/cargo/go module 等 |
| 目录 | `Folder` | 文件系统目录 |
| 文件 | `File` | 源文件 |
| 模块 | `Module` | 具名导出模块 |
| 符号 | `Class`, `Function`, `Method`, `Interface`, `Enum`, `Type` | 代码符号 |
| 基础设施 | `Route` | HTTP 端点 |
| 基础设施 | `Resource` | Docker/K8s 资源 |

**边类型**（10+ 种）：
| 类型 | 含义 | 来源 |
|------|------|------|
| `CALLS` | 函数/方法调用 | Tree-sitter + LSP |
| `IMPORTS` | 模块导入 | Tree-sitter + manifest |
| `DEFINES` | 符号定义 | Tree-sitter |
| `IMPLEMENTS` | 接口实现 | Hybrid LSP |
| `INHERITS` | 类继承 | Hybrid LSP |
| `HTTP_CALLS` | 跨服务 HTTP 调用 | 路由匹配 + traces |
| `DATA_FLOWS` | 数据流 | AST 数据流分析 |
| `SIMILAR_TO` | 代码相似 | MinHash + AST profile |
| `SEMANTICALLY_RELATED` | 语义相关 | Embedding 向量搜索 |
| `CONFIGURES`, `WRITES` | IaC 资源配置 | Docker/K8s/Kustomize |

**索引与搜索**：
- BM25 FTS5 + 自定义 `cbm_camel_split` tokenizer（驼峰/蛇形感知分词）
- Nomic `nomic-embed-code` (768d int8)，编译进二进制，无外部 API
- 11 信号组合评分：TF-IDF, RRI, API/Type/Decorator 签名, AST 轮廓, 数据流, Halstead-lite, MinHash, 模块邻近度, 图扩散

### 1.4 索引层：六阶段流水线

```
阶段 1: structure   → 文件树、目录结构
阶段 2: definitions → 符号定义 (Class, Function, Type, Route...)
阶段 3: calls       → 调用关系图 (CALLS edges)
阶段 4: http_links  → 跨服务 HTTP 调用匹配
阶段 5: config      → IaC 索引 (Dockerfile, K8s, Kustomize)
阶段 6: tests       → 测试关系检测
```

全部在内存中执行，最后一次性写入 SQLite。

### 1.5 查询层：三种检索范式

**范式 1 — 结构化总览**：`get_architecture` 一次返回语言、包、入口点、路由、热点、边界、层、社区集群。

**范式 2 — 语义搜索**：`semantic_query` 向量搜索 + 11 信号评分，返回语义相近的代码符号。

**范式 3 — 图查询**：openCypher 子集 (`MATCH-WHERE-RETURN` + 聚合 + 可变长度路径 + 存在性子查询)，例如：
```cypher
MATCH (f:Function) WHERE NOT EXISTS { (f)<-[:CALLS]-() }
RETURN f.name, f.file  -- 死代码检测
```

### 1.6 同步层：后台感知

- **watcher**：git polling + 自适应间隔，检测变更后自动增量索引
- **team artifact**：`.codebase-memory/graph.db.zst` (zstd 压缩)，支持 Best (zstd -9) 和 Fast (zstd -3) 两档
- **traces**：运行时 trace 摄取，验证 HTTP_CALLS edges 的正确性

### 1.7 集成层：11 种 Agent 的自动化注入

对 Claude Code 的注入最为深度 — `PreToolUse` hook 拦截 Grep/Glob 调用，在图谱中找到结果后注入上下文增强，不阻塞原始工具。声称 99.2% token 节省（3,400 vs 412,000）。

---

## 二、解构与归集机制分析

### 2.1 如何解构（Decomposition）

codebase-memory-mcp 采用 **多维度交叉解构**：

| 维度 | 解构方式 | 产出 |
|------|---------|------|
| **文件结构** | 目录树遍历 → Folder/File 节点 + CONTAINS edges | 物理视图 |
| **符号定义** | Tree-sitter AST → Class/Function/Type 节点 | 逻辑视图 |
| **调用关系** | AST 遍历 + LSP 类型解析 → CALLS/IMPLEMENTS/INHERITS edges | 依赖视图 |
| **HTTP 路由** | 路由模式匹配 → Route 节点 + HTTP_CALLS edges | 服务视图 |
| **基础设施** | Docker/K8s 解析 → Resource 节点 + CONFIGURES edges | 部署视图 |
| **代码相似** | MinHash + 嵌入向量 → SIMILAR_TO/SEMANTICALLY_RELATED edges | 语义视图 |
| **社区发现** | Louvain 算法聚类 → 功能模块社区 | 架构视图 |

这七种维度的解构是互补而非冗余的。物理视图告诉你"文件在哪"，逻辑视图告诉你"代码是什么"，依赖视图告诉你"谁调谁"，服务视图告诉你"系统间怎么通信"，语义视图告诉你"哪些代码长得像但没直接调用"。

### 2.2 如何归集（Collection）

归集通过两层机制实现：

**a) 忽略规则叠加**（控制采集范围）：
```
硬编码忽略 (.git, node_modules, ...)
  → .gitignore 层级（从根目录逐级合并）
    → .cbmignore（项目特定，gitignore 语法）
      → 符号链接始终跳过
```

**b) 团队共享图快照**（消除重复索引）：
```
开发者 A: index → .codebase-memory/graph.db.zst → commit
开发者 B: clone → decompress graph.db.zst → 增量索引（只索引 diff）
```

### 2.3 如何汇总（Summarization/Query）

汇总不是"压缩"而是**多入口查询**：

1. **架构全景**：`get_architecture` 一键输出项目全局视图
2. **语义搜索**：自然语言 → 嵌入向量 → 相关代码符号
3. **图遍历**：Cypher 查询，支持路径追踪（`trace_path` BFS/DFS）
4. **变更影响**：`detect_changes` 映射 git diff → 受影响符号 + 爆炸半径 + 风险分类
5. **社区发现**：Louvain 算法自动发现功能模块边界

---

## 三、los 当前记忆模块对比

### 3.1 los 记忆的操作层面

| 维度 | codebase-memory-mcp | los memory |
|------|---------------------|------------|
| **记忆对象** | 代码结构（符号、调用、路由） | 操作经验（会话、决策、模式、规则） |
| **数据类型** | 知识图谱（节点+边） | 关系型（observations 表 + JSONB） |
| **采集方式** | AST 解析 + LSP 类型推导 | Agent 会话事件 + API 写入 + 自省 |
| **存储引擎** | SQLite (WAL, 内存索引) | PostgreSQL (tsvector FTS, JSONB) |
| **检索方式** | BM25 + 向量搜索 + Cypher | SQL FTS + JSONB 路径查询 + 层级路由 |
| **时间维度** | 快照式（当前代码状态） | 累积式（全量历史会话） |
| **生命周期** | 索引→查询 (无压缩/归档) | 写入→分类→压缩→归档→清理 (五阶段) |
| **学习机制** | 无（纯静态分析） | Compaction→Candidate→Operator Approved Rule |
| **嵌入模型** | nomic-embed-code (768d) | 无（仅 tsvector 词汇搜索） |

### 3.2 互补关系

两者不是竞争关系，是**互补分层**：

```
┌─────────────────────────────────────────────┐
│          Agent 上下文窗口                     │
│  ┌─────────────────────────────────────┐    │
│  │  系统提示词 (identity + rules)       │    │
│  ├─────────────────────────────────────┤    │
│  │  los procedural rules               │ ← 操作经验（los memory）  │
│  │  "上次这个模式失败了，应该先检查 X"    │    │
│  ├─────────────────────────────────────┤    │
│  │  代码结构知识 (codebase-memory-mcp)  │ ← 代码知识（CBM）        │
│  │  "这个函数被 47 个地方调用，修改要小心" │    │
│  ├─────────────────────────────────────┤    │
│  │  los episodic/semantic observations │ ← 会话经验（los memory）  │
│  │  "上次改这个模块时遇到了 Y 问题"      │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

los 的记忆回答 **"我们做过什么，学到了什么"**；codebase-memory-mcp 回答 **"代码是什么样的，改了会怎样"**。

---

## 四、LLM 输入输出与记忆联动分析

### 4.1 当前 los 的 LLM 输入处理

从 `chat-memory-augment.ts` 的 prompt 组装链：

```
identity block (IDENTITY.md)
  → base system prompt (config/API/default)
    → procedural rules (active procedural_candidates)
      → memory observations (by task-state layer priority)
```

**问题**：这三层全部是操作记忆。当 Agent 需要理解代码结构时，它只能通过文件读取/grep 探索，每次消耗数千 token。

### 4.2 当前 los 的 LLM 输出处理

从 `chat-route-persist.ts` 和 `chat-service.ts`：

```
Agent 响应
  → persistChatSuccess() → addObservation(kind='note')
  → 会话事件 (tool_call, tool_result, ...)
    → onSessionEvent → 自动 checkpoint / compaction
    → compactSession() → 模式检测 → procedural candidates
```

**问题**：输出只记录了"Agent 做了什么"，但没有记录"Agent 操作了哪些代码符号"。代码操作被扁平化为文本摘要。

### 4.3 联动点：哪些 LLM 输入输出可以和代码记忆联动

#### 输入侧联动（6 个触点）

| 触点 | 当前行为 | 联动后 |
|------|---------|--------|
| **1. Grep/Glob 工具调用** | 直接搜索文件系统，返回原始文本 | CBM PreToolUse hook 拦截 → 返回结构化符号信息 + 调用者/被调用者上下文 |
| **2. 系统提示词** | 仅操作规则和会话记忆 | 注入当前任务涉及的代码模块结构摘要（受影响符号、调用关系、变更风险） |
| **3. 任务规划阶段** | Agent 自己探索代码 | `get_architecture` 预注入项目结构全景，减少探索轮次 |
| **4. 错误排查** | Agent grep 搜索错误信息 | `semantic_query` 定位语义相关的代码段，即使错误信息措辞不同 |
| **5. 代码审查** | Agent 逐个文件读取 | `detect_changes` 给出受影响符号 + 爆炸半径，Agent 只读相关文件 |
| **6. 重构任务** | Agent 手动追踪调用链 | `trace_path` BFS/DFS 自动追踪完整调用链，避免遗漏 |

#### 输出侧联动（4 个触点）

| 触点 | 当前行为 | 联动后 |
|------|---------|--------|
| **7. 工具调用记录** | 记录工具名+参数文本 | 关联到具体代码符号（file_path → CBM File 节点，function_name → Function 节点） |
| **8. 会话观察** | 文本摘要"修改了 X 文件" | 结构化记录：{action: "modified", symbols: ["funcA", "classB"], blastRadius: ["caller1", "caller2"]} |
| **9. 模式检测** | Compaction 只看观测文本 | 结合代码结构变化模式：哪种重构模式反复出现？哪些模块频繁被修改？ |
| **10. 自我反思** | Agent 反思基于文本经验 | 增加代码级验证："我声称修改只影响 module A，CBM 调用图显示还影响了 module B" |

### 4.4 按项目/按 Agent/按会话的分层适配

这是问题的核心——不同粒度的记忆需要不同的管理策略：

```
                    ┌──────────────┐
                    │  Operator    │
                    │  (跨项目)    │
                    └──────┬───────┘
                           │ 操作规则、决策记录
           ┌───────────────┼───────────────┐
           │               │               │
    ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
    │  Project A  │ │  Project B  │ │  Project C  │
    │  (代码图谱)  │ │  (代码图谱)  │ │  (代码图谱)  │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
     ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
     │ Agent 会话 │   │ Agent 会话 │   │ Agent 会话 │
     │ (操作记忆) │   │ (操作记忆) │   │ (操作记忆) │
     └───────────┘   └───────────┘   └───────────┘
```

**按项目分层**（Codebase-Memory-MCP 天然支持）：
- 每个项目独立的 `.codebase-memory/graph.db.zst`
- SQLite 数据库天然隔离
- los 已有的 `project_id` 字段对接

**按 Agent 分层**（los 需要新增）：
- 代码图谱是共享的（所有 Agent 看同一份代码结构）
- 操作记忆需要按 Agent 角色隔离：
  - `default` agent：通用编码经验
  - `child` agent：子任务专用上下文
  - `judge` agent：审查维度的记忆
  - `auditor` agent：治理维度的记忆
- los 当前缺少 `agent_identity` 维度的记忆隔离

**按会话分层**（los 已有但可增强）：
- `session_id` 字段已存在
- 当前：同一 session 的观测在 compaction 时被摘要
- 增强：会话内触发的代码符号（CBM 节点 ID）关联到 session，compaction 时生成代码级模式

---

## 五、数据结构与算法层面的联动设计

### 5.1 双层图结构

```
los 操作图 (PostgreSQL)          CBM 代码图 (SQLite via MCP)
┌──────────────────────┐        ┌──────────────────────┐
│ Session              │        │ Project              │
│  ├─ TaskRun          │        │  ├─ Package          │
│  ├─ Observation      │────────│  ├─ File             │
│  ├─ Compaction       │ 关联   │  ├─ Module           │
│  └─ ProceduralCandidate│      │  ├─ Class/Function   │
│                      │        │  └─ Route            │
│ Edges:               │        │                      │
│  - produces          │        │ Edges:               │
│  - supports          │        │  - CALLS             │
│  - contradicts       │        │  - IMPORTS           │
│  - refines           │        │  - HTTP_CALLS        │
└──────────────────────┘        └──────────────────────┘
         │                              │
         └──────────┬───────────────────┘
                    │
          ┌─────────▼──────────┐
          │  Cross-Graph Link  │
          │  (symbol_refs in   │
          │   observation      │
          │   metadata_json)   │
          └────────────────────┘
```

### 5.2 关键数据结构扩展

**Observation 扩展**（`metadata_json` 已有 `entities` 字段）：

```typescript
// 当前
metadata_json: {
  entities: ["src/server.ts", "packages/memory/"],
  entityType: "file"
}

// 扩展后
metadata_json: {
  entities: ["src/server.ts"],
  entityType: "file",
  // 新增：CBM 符号引用
  symbolRefs: [
    { symbolId: "los:src/server.ts:startServer", type: "Function", action: "modified" },
    { symbolId: "los:src/server.ts:applyMiddleware", type: "Function", action: "called" }
  ],
  // 新增：受影响符号（来自 detect_changes）
  blastRadius: [
    { symbolId: "los:src/gateway/routes.ts:registerRoutes", relation: "CALLS", risk: "medium" }
  ]
}
```

**ProceduralCandidate 扩展**：

```typescript
// 当前
{
  name: "executor-failover-pattern",
  content: "当 executor 返回 502 时，先检查 node 在线状态再重试",
  supportingSessionIds: ["sess-1", "sess-3"]
}

// 扩展后 — 关联代码符号
{
  name: "executor-failover-pattern",
  content: "...",
  supportingSessionIds: ["sess-1", "sess-3"],
  // 新增：这个规则涉及的代码结构
  codeContext: {
    symbols: ["los:executor/health.ts:checkHealth", "los:agent/loop.ts:handleError"],
    graphPattern: "CALLS chain from handleError → checkHealth → HTTP_CALLS → executor:8080/health"
  }
}
```

### 5.3 算法层面：五个核心算法

**算法 1：代码感知的 Compaction（增强 compactSession）**

```
输入: session_id, session 内的观测 + 代码符号引用
输出: 代码感知的 ProceduralCandidate

1. 收集 session 内所有观测的 symbolRefs
2. 对每个被修改的符号，在 CBM 图中查询:
   - 调用者 (← CALLS)
   - 被调用者 (CALLS →)
   - 同模块符号 (同一 File 节点的其他 Function/Class)
3. 检测模式:
   - 如果 Agent 只修改了函数 A 但没有修改它的调用者 → 可能遗漏
   - 如果连续 N 个 session 都修改了同一个 File → 热点模块
   - 如果 Agent 反思声称"改动只影响 X"但 CBM blastRadius 显示也影响 Y → 知识差距
4. 生成 ProceduralCandidate，confidence 与 CBM 证据交叉验证
```

**算法 2：会话感知的符号热度（los 计算 + CBM 查询）**

```
输入: project_id, 时间窗口
输出: 热点符号排行

1. 查询 los.observations: 时间窗口内所有包含 symbolRefs 的观测
2. 聚合: symbol_id → {修改次数, 关联 session 数, 关联错误数}
3. 交叉 CBM: 对每个热点符号，查询其调用者数量、依赖深度
4. 输出热度分数 = 修改频率 × log(调用者数量) × 错误关联因子

用途:
- 系统提示词注入: "以下是最常修改的模块，改动时需要特别小心: ..."
- 治理检测: 同一个符号在 5 个 session 内被修改 3 次 → 设计不稳定信号
```

**算法 3：操作规则与代码结构的交叉验证**

```
输入: ActiveRule (los procedural_candidates)
输出: 规则的有效性评分 + 代码证据

1. 提取规则中的文件路径/符号名
2. 在 CBM 图中定位对应节点
3. 检查规则断言与图结构的一致性:
   - 规则说 "修改 A 前先检查 B" → 图中有 A → B 的 CALLS/IMPORTS 边吗?
   - 如果没有 → 规则可能是失效的（代码已重构但规则未更新）
   - 如果有 → 规则有代码级证据支撑，confidence 可以提升
4. 对规则中引用的符号在 CBM 中做变更检测:
   - 符号是否还存在？是否被重命名？签名是否改变？
```

**算法 4：基于图扩散的会话记忆检索增强**

```
输入: 当前 task 涉及的代码符号集合
输出: 相关的历史会话记忆

1. 从当前 task 提取目标符号 (用户指定的文件/函数)
2. 在 CBM 图中做 2-hop 扩散: 目标符号 → 直接邻居 → 邻居的邻居
3. 扩散得到的符号集合 S_context
4. 在 los.observations 中搜索历史观测:
   SELECT * FROM observations
   WHERE metadata_json->'symbolRefs' @> ANY(S_context)
   ORDER BY created_at DESC
5. 返回的观测按图距离加权: 距离 1 的符号关联记忆权重 > 距离 2 的
```

**算法 5：跨项目模式迁移**

```
输入: 源项目的 ProceduralCandidate
输出: 目标项目的候选规则

1. 提取候选规则关联的代码结构模式:
   - 规则 "executor-failover-pattern" 对应 CBM 子图:
     agent/loop.ts:handleError → executor/health.ts:checkHealth → HTTP → :8080/health
2. 在目标项目的 CBM 图中搜索同构子图:
   - 不需要精确同构，只需要结构相似
   - 相似度 = (匹配节点类型占比 + 匹配边类型占比 + 语义相似度) / 3
3. 如果找到相似度 > 0.7 的子图 → 生成迁移规则
4. 迁移规则的 confidence = 源规则 confidence × 结构相似度 × 衰减因子(0.8)
```

---

## 六、分阶段实施路线

### Phase 0：基础对接（1-2 天）

**目标**：los 能调用 CBM MCP tools，不改变 los 现有逻辑。

```
具体任务:
├─ 在 los 开发环境安装 codebase-memory-mcp 二进制
├─ 在 los 项目上运行 index_repository，生成 graph.db.zst
├─ 验证 14 个 MCP tools 全部可调用
├─ 在 gateway 启动时检测 CBM 是否可用（feature flag: config.memory.codeGraphEnabled）
└─ 编写 cbm-client.ts 封装 MCP 调用（@los/memory 新增文件）
```

**不做**：修改任何 prompt 组装、compaction、retrieval 逻辑。

### Phase 1：代码感知的系统提示词（2-3 天）

**目标**：Agent 在开始任务时能看到涉及的代码模块结构。

```
具体任务:
├─ augmentChatSystemPrompt() 增加 CBM 查询步骤
│   ├─ 提取任务描述中的文件路径/符号名
│   ├─ 调用 get_architecture（仅当任务涉及新模块时）
│   └─ 将结构摘要追加到 memory augmentation 之后
├─ 新增 "代码结构" 段落在 prompt 中（在 procedural rules 之后）
├─ 合理性控制: 最多注入 500 token 的代码结构信息
└─ Feature flag: config.memory.codeGraph.injectArchitecture
```

**prompt 示例**：
```
## Code Structure Context
The following modules are relevant to this task:
- `packages/memory/src/core/store.ts` (600 lines, 1 class, 12 functions)
  - Called by: chat-route-persist.ts, chat-service.ts, memory-routes.ts
  - Key dependencies: @los/infra/db, @los/infra/logger
- `packages/gateway/src/chat-memory-augment.ts` (95 lines, 1 function)
  - Calls: routeMemoryRetrieval(), augmentSystemPrompt()
```

### Phase 2：代码符号关联记录（3-5 天）

**目标**：Agent 的工具调用能关联到具体代码符号。

```
具体任务:
├─ Tool call 后处理（chat-service.ts 的 onSessionEvent）
│   ├─ 解析 tool_call 参数中的 file_path → 调用 CBM resolve file → symbols
│   ├─ 提取被操作的具体符号 (Function/Class/Route)
│   └─ 写入 observation.metadata_json.symbolRefs
├─ Observation schema 扩展（DDL 不需要改，JSONB 足够）
├─ 新增 cbm-symbol-resolver.ts: file_path + line_number → CBM symbol node
└─ searchObservations() 增加按 CBM symbolId 过滤的能力
```

### Phase 3：代码感知的 Compaction（3-5 天）

**目标**：Compaction 能利用代码结构信息生成更高质量的规则。

```
具体任务:
├─ compactSession() 增强:
│   ├─ 收集 session 内所有 symbolRefs
│   ├─ 对热点符号（被频繁操作）查询 CBM 调用者/被调用者
│   ├─ 检测 "修改了 A 但没检查调用者" 的模式
│   └─ 生成带代码上下文的 ProceduralCandidate
├─ 新增模式: "hotspot" — 同一符号/模块连续 N 个 session 被修改
├─ 新增模式: "blast-radius-gap" — Agent 声称影响范围 < CBM 实际影响范围
└─ ProceduralCandidate.codeContext 字段填充
```

### Phase 4：图增强的记忆检索（3-5 天）

**目标**：检索历史记忆时利用代码图的扩散来发现相关但不直接匹配的记忆。

```
具体任务:
├─ 实现算法 4（图扩散检索）
├─ routeMemoryRetrieval() 增加 "code_graph" 检索策略
│   ├─ 如果 task 指定了文件/符号 → 图扩散 → 关联历史观测
│   └─ 按图距离加权排序
├─ 新增 API: POST /memory/retrieve/code-aware
└─ 与现有层级检索并行（不替代，作为增强通道）
```

### Phase 5：跨项目模式迁移 + 规则验证（5-7 天）

**目标**：在一个项目学到的规则可以迁移到结构相似的其他项目。

```
具体任务:
├─ 实现算法 3（规则交叉验证）
├─ 实现算法 5（跨项目模式迁移）
├─ governance sweeper 增加 code_graph_rule_validation job
│   ├─ 每周检查所有 active rules
│   ├─ 与 CBM 当前代码状态对比
│   └─ 标记失效规则 (status: 'stale') — 符号不存在或图结构已变化
├─ 跨项目迁移 UI（低优先级，CLI 命令先行）
└─ los memory migrate-rules --from <project> --to <project> --dry-run
```

---

## 七、架构决策记录（需要新增 ADR）

建议新增 ADR 0024，覆盖以下决策：

1. **CBM 是外部 MCP 依赖，不是 los 的子模块**。los 通过 MCP stdio 协议调用，不 fork 不 embed。
2. **代码图谱是共享资产，操作记忆是角色隔离的**。CBM 的 SQLite 对所有 Agent 共享只读；los 的 PostgreSQL 操作记忆按 agent_identity 隔离。
3. **CBM 不可用时，los 优雅降级到纯操作记忆**。所有 CBM 查询都是 best-effort，feature flag 控制开关。
4. **符号引用（symbolRefs）是连接两层记忆的桥**。`metadata_json.symbolRefs` 是 los observation 和 CBM symbol node 之间的外键。
5. **代码结构不进入 compaction 的置信度自动提升路径**。CBM 证据可以增加 confidence 权重，但不能替代 operator attestation（ADR 0020 的硬约束不变）。
6. **图扩散的距离上限为 2-hop**。超过 2-hop 的扩散产生过多噪音且边际价值递减。

---

## 八、风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| CBM 索引不完整（未索引或过期） | 中 | Feature flag 降级 + watcher 自动同步 |
| CBM 符号 ID 随时间变化（代码重构后） | 中 | CBM 的 qualified name 相对稳定（`<project>.<path>.<name>`），变化时标记规则 stale |
| 图扩散噪音（关联到不相关的历史记忆） | 低 | 2-hop 上限 + 图距离加权 + 时间衰减 |
| 额外 MCP 调用增加延迟 | 低 | CBM 查询 <1ms，索引为异步；prompt 注入限制 500 token |
| CBM 二进制安全供应链 | 低 | SLSA Level 3 + cosign + VirusTotal + SHA-256，已满足 los 的安全要求 |

---

## 九、总结

codebase-memory-mcp 和 los memory 是**互补的两个记忆层**：

- **CBM** 回答 "代码是什么样的" — 静态结构，快照式，图查询，零推理
- **los** 回答 "我们做过什么，学到了什么" — 动态经验，累积式，层级检索，规则演化

两者通过 **symbolRefs**（los observation → CBM symbol node）建立关联。最有价值的联动是五个算法：代码感知 Compaction、符号热度分析、规则交叉验证、图扩散检索、跨项目模式迁移。

建议从 Phase 0（基础对接 + feature flag）开始，每个 Phase 结束后评估效果再推进下一个 Phase。不改变 los 现有的记忆生命周期和 operator attestation 合约。
