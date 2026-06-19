# CBM-los 联动任务分解 & 优先级重排

> 基于 `docs/research/codebase-memory-mcp-analysis.md` 的分析结论
> 日期：2026-06-19
> 关联：[[los-remaining-backlog-2026-06-17]] [[los-mimo-p0-evaluation-2026-06-17]] [[los-bootstrap-capability-roadmap-2026-06-15]]

---

## 一、任务分解（全量）

### Phase 0 — 基础对接

| ID | 任务 | 预估 | 依赖 | 产出 |
|----|------|:---:|------|------|
| CBM-0.1 | 在 los 开发环境安装 codebase-memory-mcp 二进制 | 0.5h | 无 | `which cbm` 可用 |
| CBM-0.2 | 在 los 项目上运行 `index_repository`，生成 graph.db.zst | 0.5h | CBM-0.1 | `.codebase-memory/graph.db.zst` 存在 |
| CBM-0.3 | 验证 14 个 MCP tools 全部可调用（手动调用或脚本） | 1h | CBM-0.2 | 14/14 tools 返回有效 JSON |
| CBM-0.4 | 新增 `config.memory.codeGraphEnabled` feature flag (Zod + 默认 false) | 0.5h | 无 | `getConfig().memory.codeGraph.enabled` 可用 |
| CBM-0.5 | 在 gateway 启动时检测 CBM 是否可用，写入 `codeGraphAvailable` | 1h | CBM-0.4 | 启动日志显示 CBM 检测结果 |
| CBM-0.6 | 编写 `cbm-client.ts` 封装 MCP stdio 调用（`@los/memory/src/cbm/`） | 2h | CBM-0.3 | `cbm-client.ts` + 基础单元测试 |

**Phase 0 退出条件**：
- [ ] `config.memory.codeGraphEnabled=true` 时 gateway 启动不报错
- [ ] `config.memory.codeGraphEnabled=false` 时所有现有测试仍然通过
- [ ] `cbm-client.ts` 可发起 `get_architecture` 调用并解析返回 JSON

---

### Phase 1 — 代码感知的系统提示词

| ID | 任务 | 预估 | 依赖 | 产出 |
|----|------|:---:|------|------|
| CBM-1.1 | `augmentChatSystemPrompt()` 增加 CBM 查询：提取任务描述中的文件路径/符号名 | 2h | CBM-0.6 | 路径提取逻辑 + 单元测试 |
| CBM-1.2 | `get_architecture` 调用封装：仅当 task 涉及新模块时查询，缓存结果 | 2h | CBM-1.1 | architecture cache per task |
| CBM-1.3 | 代码结构段落的 prompt 渲染（`formatCodeStructureForPrompt()`） | 1.5h | CBM-1.2 | 结构化 markdown 输出 |
| CBM-1.4 | Token budget 控制：最多注入 500 token 的代码结构信息 | 1h | CBM-1.3 | 截断逻辑 + 测试 |
| CBM-1.5 | `config.memory.codeGraph.injectArchitecture` feature flag | 0.5h | CBM-0.4 | sub-flag 可用 |

**Phase 1 退出条件**：
- [ ] `injectArchitecture=true` 时系统提示词多出 "Code Structure Context" 段落
- [ ] `injectArchitecture=false` 时系统提示词与当前完全一致
- [ ] 注入内容不超过 500 token（用 tokenizer 验证）
- [ ] CBM 不可用时优雅降级，不影响 chat 正常执行

---

### Phase 2 — 代码符号关联记录

| ID | 任务 | 预估 | 依赖 | 产出 |
|----|------|:---:|------|------|
| CBM-2.1 | `cbm-symbol-resolver.ts`：file_path + line_number → CBM symbol node 列表 | 3h | CBM-0.6 | resolver + 测试 |
| CBM-2.2 | Tool call 后处理：解析 `write_edit`/`replace` 参数中的 file_path → CBM symbols | 2h | CBM-2.1 | 集成到 `onSessionEvent` |
| CBM-2.3 | Observation 写入增强：`metadata_json.symbolRefs` 填充 | 1.5h | CBM-2.2 | observation 含结构化符号引用 |
| CBM-2.4 | `searchObservations()` 增加按 CBM symbolId 过滤 | 1.5h | CBM-2.3 | 可按符号检索历史观测 |
| CBM-2.5 | blast radius 检测：`detect_changes` 查询受影响符号并写入 `metadata_json.blastRadius` | 2h | CBM-2.2 | observation 含影响范围 |

**Phase 2 退出条件**：
- [ ] Agent 执行 write_edit 后，observation.metadata_json.symbolRefs 不为空
- [ ] `searchObservations({symbolId: "los:..."})` 返回关联观测
- [ ] blastRadius 检测在修改多个文件时准确反映受影响符号

---

### Phase 3 — 代码感知的 Compaction

| ID | 任务 | 预估 | 依赖 | 产出 |
|----|------|:---:|------|------|
| CBM-3.1 | `compactSession()` 增加 symbolRefs 收集步骤 | 1.5h | CBM-2.3 | 收集 session 内所有符号操作 |
| CBM-3.2 | 热点符号检测：同一符号连续 N 个 session 被修改（N=3） | 2h | CBM-3.1 | "hotspot" pattern |
| CBM-3.3 | 遗漏检测："修改了 A 但 CBM 调用图显示调用者 B/C 未检查" | 3h | CBM-3.1 | "blast-radius-gap" pattern |
| CBM-3.4 | 知识差距检测："Agent 反思声称影响范围 < CBM 实际 blastRadius" | 2h | CBM-3.1, CBM-2.5 | "knowledge-gap" pattern |
| CBM-3.5 | ProceduralCandidate.codeContext 字段填充 | 1h | CBM-3.2, CBM-3.3, CBM-3.4 | candidate 含代码上下文 |
| CBM-3.6 | 新增 `symbol_refs_json` 列到 `memory_compactions`（或 JSONB 内字段） | 1h | CBM-3.1 | DDL + migration |

**Phase 3 退出条件**：
- [ ] 一次包含代码修改的 session compact 后，compaction.observedPatterns 含代码级模式
- [ ] 热点符号（≥3 次修改）生成 ProceduralCandidate
- [ ] blast-radius-gap 检测在 Agent 遗漏调用者时触发
- [ ] 不违反 ADR 0020 的 operator attestation 硬约束（CBM 证据只增加 confidence 权重，不自动 promote）

---

### Phase 4 — 图增强的记忆检索

| ID | 任务 | 预估 | 依赖 | 产出 |
|----|------|:---:|------|------|
| CBM-4.1 | 2-hop 图扩散实现：目标符号 → Cypher `trace_path` 2-hop → 邻居符号集合 | 3h | CBM-0.6 | 扩散算法 + 测试 |
| CBM-4.2 | `routeMemoryRetrieval()` 增加 `code_graph` 检索策略 | 2h | CBM-4.1, CBM-2.4 | 新检索通道 |
| CBM-4.3 | 图距离加权排序：距离 1 权重=1.0, 距离 2 权重=0.5, 时间衰减 0.9/day | 1.5h | CBM-4.2 | 排序算法 + 测试 |
| CBM-4.4 | `POST /memory/retrieve/code-aware` API 端点 | 1.5h | CBM-4.3 | 新 API |
| CBM-4.5 | `config.memory.codeGraph.enhanceRetrieval` feature flag | 0.5h | CBM-0.4 | sub-flag |

**Phase 4 退出条件**：
- [ ] `code-aware` 检索返回的历史观测与当前 task 操作的文件有图结构关联
- [ ] 图距离 1 的关联观测排在距离 2 之前
- [ ] CBM 不可用时回退到原有层级检索

---

### Phase 5 — 跨项目模式迁移 + 规则验证

| ID | 任务 | 预估 | 依赖 | 产出 |
|----|------|:---:|------|------|
| CBM-5.1 | 规则交叉验证：提取 ActiveRule 中的符号 → CBM 定位 → 检查是否存在/边是否匹配 | 3h | CBM-0.6, CBM-2.1 | 验证算法 + 测试 |
| CBM-5.2 | `code_graph_rule_validation` governance sweeper job（每周） | 2h | CBM-5.1 | 自动标记 stale 规则 |
| CBM-5.3 | 子图同构匹配：源项目 CBM 子图 → 目标项目搜索相似结构 | 4h | CBM-5.1 | 迁移算法 + 测试 |
| CBM-5.4 | `los memory migrate-rules --from <proj> --to <proj> --dry-run` CLI | 2h | CBM-5.3 | CLI 命令 |
| CBM-5.5 | 迁移规则的 confidence 衰减公式：源 confidence × 结构相似度 × 0.8 | 1h | CBM-5.4 | 衰减逻辑 + 测试 |

**Phase 5 退出条件**：
- [ ] `code_graph_rule_validation` 能检测到符号已不存在的失效规则 → 标记 `stale`
- [ ] `migrate-rules --dry-run` 输出候选规则列表含结构相似度评分
- [ ] 不自动 promote 迁移规则（仍走 operator attestation）

---

## 二、优先级重排

### 评审原则

对比 CBM 联动任务与当前 P0/P1 backlog（来自 [[los-remaining-backlog-2026-06-17]] 和 [[los-p0-security-fixes-2026-06-19]]）：

| 维度 | CBM 联动 | 当前 P1 backlog |
|------|---------|----------------|
| 阻塞性 | 无阻塞 — los 无 CBM 仍正常运作 | file-sync P0 阻塞 34 节点部署 |
| 差异化 | 高 — 是 los 独有的双层记忆能力 | SSH executor 是 vpsagentweb 迁移的刚需 |
| 基础依赖 | Phase 0 轻量（1 天），后续 Phase 不做也成立 | module readiness 直接影响 Web UI 可信度 |
| 风险 | 低 — feature flag 全隔离 | P0 security fixes 刚完成，需稳定期 |

**结论**：CBM 联动不应挤占当前 P0/P1 的 file-sync 和 SSH executor。Phase 0 可以立即做（轻量、无风险），Phase 1-2 与 MiMo P1 并行推进，Phase 3-5 排队到 Phase 1-2 验证效果后。

### 重排后的优先级

```
优先级轴（左=先做，右=后做）

P0 (本周)
├─ CBM Phase 0 (1-2天)       ← 零风险，可独立完成
├─ file-sync P0 部署验证      ← 阻塞 34 节点
└─ Module readiness 8 gaps    ← 影响 Web UI

P1 (下周)
├─ CBM Phase 1: 系统提示词     ← 第一个用户可见联动效果
├─ SSH executor               ← vpsagentweb 迁移依赖
├─ MiMo P0-3 stale detection  ← 已降为 P1
└─ MiMo P1 上下文重建          ← 依赖 Judge Model 稳定

P2 (两周内)
├─ CBM Phase 2: 符号关联       ← 依赖 Phase 1 跑通
├─ CBM Phase 3: 代码感知 Compaction ← 依赖 Phase 2 数据积累
└─ 沙箱隔离                   ← vpsagentweb 安全需求

P3 (本月)
├─ CBM Phase 4: 图增强检索     ← 需要 Phase 2-3 的数据
└─ 多实例 failover             ← 运维基础

远期
├─ CBM Phase 5: 跨项目迁移     ← 需要多项目 CBM 索引
└─ Phase 5: 多 Gateway 集群     ← 自举路线图终点
```

### 判断条件（每个 Phase 的入口 gate）

| Phase | 入口条件 | 不可启动的反条件 |
|-------|---------|----------------|
| **Phase 0** | ✅ 无前置依赖 | CBM 二进制无法在 macOS 上编译/下载 |
| **Phase 1** | Phase 0 完成 + `injectArchitecture` flag 可用 | `pnpm check` 因 CBM 集成引入 type error |
| **Phase 2** | Phase 1 跑通 ≥ 3 个真实 chat session，注入的代码结构信息被 Agent 实际引用 | Phase 1 注入的信息在 3 个 session 中从未被引用 |
| **Phase 3** | Phase 2 积累 ≥ 10 个含 symbolRefs 的 observation + ≥ 3 个 compacted session | symbolRefs 覆盖率 < 50%（即大部分 write_edit 未被关联到符号） |
| **Phase 4** | Phase 3 产生 ≥ 5 个含 codeContext 的 ProceduralCandidate | 图扩散查询延迟 > 500ms（影响 chat 响应） |
| **Phase 5** | Phase 4 稳定 + ≥ 2 个项目有完整 CBM 索引 | 多项目不在同一 workspace（无法做子图匹配） |

---

## 三、新任务清单（纳入现有 backlog）

### 新增 P0（CBM Phase 0）

| # | 任务 | 来源 | 状态 |
|---|------|------|:---:|
| C0 | **CBM Phase 0 基础对接** — 安装/索引/验证/feature flag/cbm-client | CBM 分析 | 待实现 |

### 新增 P1（CBM Phase 1-2）

| # | 任务 | 来源 | 状态 |
|---|------|------|:---:|
| C1 | **CBM Phase 1 代码感知提示词** — augmentChatSystemPrompt + 500 token cap | CBM 分析 | 待实现 |
| C2 | **CBM Phase 2 符号关联** — symbolRefs 记录 + blastRadius 检测 | CBM 分析 | 待实现 |

### 新增 P2（CBM Phase 3-4）

| # | 任务 | 来源 | 状态 |
|---|------|------|:---:|
| C3 | **CBM Phase 3 代码感知 Compaction** — hotspot/blast-radius-gap 模式检测 | CBM 分析 | 待实现 |
| C4 | **CBM Phase 4 图增强检索** — 2-hop 扩散 + code-aware API | CBM 分析 | 待实现 |

### 新增 P3（CBM Phase 5）

| # | 任务 | 来源 | 状态 |
|---|------|------|:---:|
| C5 | **CBM Phase 5 跨项目迁移** — 规则交叉验证 + stale 检测 + migrate CLI | CBM 分析 | 待实现 |

---

## 四、与现有 backlog 的交叉影响

### Phase 0 对其他任务的影响

- CBM-0.6 `cbm-client.ts` 将是一个新的 `@los/memory/src/cbm/` 子模块
- 文件大小：预估 `cbm-client.ts` ~150 行，`cbm-symbol-resolver.ts` ~120 行，不会触发 warn 门禁
- 测试隔离：需要 `ensureMemoryStore()` 但不需要新表 — 对 test-setup.ts 无影响

### Phase 3 对 compaction 的影响

- `compactSession()` 当前 573 行（已超 400 行 warn）。CBM-3.1~3.4 新增 ~100-150 行
- **需要先瘦身**：将 `observedPatterns` 检测逻辑提取到 `compaction-patterns.ts`（~150 行）+ `compaction-cbm-patterns.ts`（~100 行）
- 这个瘦身本身是好的 — 让 compaction.ts 回到 450 行左右

### Phase 2 对 input-preprocessor 的影响

- Tool call 参数中的 file_path 提取可能与 [[los-input-preprocessor-2026-06-18]] 的 IP3 (Code 检测器) 有重叠
- 建议：CBM-2.2 使用 input-preprocessor 的 tokenizer，不重复实现
- 如果 IP3 未实现，CBM-2.2 先做简单正则提取，不依赖 IP3

### Phase 5 对 MiMo P1-6 的影响

- CBM-5.3（子图同构匹配）与 MiMo P1-6（重复工作流发现/Distill）目标相似但方法不同：
  - CBM 用代码结构同构 → 适合跨项目规则迁移
  - MiMo P1-6 用会话模式识别 → 适合同项目内重复工作流
- 两者不冲突，且 CBM-5.3 的子图同构匹配算法可为 MiMo P1-6 提供代码级特征

---

## 五、下一步计划

### 立即行动（本次会话或下次）

**任务 C0 — CBM Phase 0 基础对接**（预计 1 天，5.5 工作小时）：

```
CBM-0.1  安装 codebase-memory-mcp 二进制        0.5h
CBM-0.2  在 los 项目上运行 index_repository      0.5h
CBM-0.3  验证 14 个 MCP tools 可用              1.0h
CBM-0.4  新增 config.memory.codeGraph feature flag 0.5h
CBM-0.5  gateway 启动时检测 CBM 可用性           1.0h
CBM-0.6  编写 cbm-client.ts 封装 MCP 调用        2.0h
```

**为什么 Phase 0 优先于 file-sync P0**：
1. CBM Phase 0 是完全独立的 — 不影响任何现有功能，feature flag 默认为 false
2. 安装 + 验证 CBM 是最低成本的实验 — 如果 CBM 在 los 项目上的索引质量不够好，后续 Phase 不用做
3. File-sync P0 需要 34 节点环境的实际部署，依赖运维窗口；CBM Phase 0 纯本地开发

**实际执行顺序**：
```
1. CBM Phase 0 (本次会话)       ← 验证 CBM 索引质量，决定是否继续
2. file-sync P0 (下次会话)      ← 需要运维窗口
3. Module readiness 8 gaps      ← 持续修复
4. CBM Phase 1 (Phase 0 通过后) ← 第一个用户可见效果
```

### Phase 0 完成后的决策点

CBM Phase 0 结束时，用以下标准判断是否继续 Phase 1：

| 判断项 | 继续 Phase 1 的条件 | 终止的条件 |
|--------|-------------------|-----------|
| CBM 索引覆盖 | los 项目 ≥ 80% TypeScript 文件成功索引 | < 50% 文件索引失败 |
| `get_architecture` 质量 | 识别出 ≥ 5 个 packages、≥ 20 个 entry points | 结构信息过于粗糙，不提供比 `ls` 更多的价值 |
| MCP 调用延迟 | `get_architecture` < 100ms | > 1s（会阻塞 chat 启动） |
| 整体判断 | 索引信息让我作为开发者觉得"有用" | 索引信息让我觉得"不如直接 grep" |

### Phase 1 完成后的决策点

| 判断项 | 继续 Phase 2 的条件 | 终止的条件 |
|--------|-------------------|-----------|
| 注入效果 | ≥ 1 个 chat session 中 Agent 明确引用了注入的代码结构 | 3 个 session 中 Agent 从未使用注入信息 |
| token 效率 | 注入 500 token 后减少了 > 500 token 的文件探索 | Agent 仍然做大量 grep — 注入信息没替代探索 |
| 用户反馈 | 操作者认为有帮助 | 操作者认为浪费 token |

---

## 六、决策记录

### 本次分析中做出的决策

1. **CBM 是外部 MCP 依赖，不 fork 不 embed**。los 通过 MCP stdio 协议调用。
2. **Feature flag 全隔离**。所有 CBM 功能默认关闭，不可用时不影响 los 核心功能。
3. **Phase 0 不排队到 file-sync 之后**。两者无依赖关系，CBM Phase 0 更轻量。
4. **Phase 3 compactSession 需先瘦身再增强**。当前 573 行，新增 CBM 模式检测前提取到子模块。
5. **CBM 联动不纳入自举路线图 Phase 4.5**。Memory 闭环已完成（7-step pipeline），CBM 是增强不是闭环缺口。
6. **ADR 0020 的 operator attestation 硬约束不变**。CBM 证据可增加 confidence 权重但绝不自动 promote。

### 需要新增的 ADR（建议 ADR 0024）

覆盖六个架构决策：
1. CBM 外部 MCP 依赖身份
2. 代码图谱共享 vs 操作记忆角色隔离
3. 优雅降级策略
4. symbolRefs 桥接机制
5. CBM 证据不替代 operator attestation
6. 图扩散 2-hop 上限

---

## 七、更新后的总 backlog

### P0 — 本周
1. ✅ ~~Phase 4.4 Reflection闭环~~ (2026-06-18)
2. ✅ ~~Phase 4.5 Memory闭环~~ (2026-06-18)
3. ✅ ~~P0 security fixes 6项~~ (2026-06-19)
4. 🔲 **CBM Phase 0** — 新增 (本次)
5. 🔲 file-sync P0 — 34节点部署验证 (下次运维窗口)
6. 🔲 Module readiness providers → live (P1 缺失项)

### P1 — 本月
7. 🔲 **CBM Phase 1** — 代码感知提示词 (新增)
8. 🔲 **CBM Phase 2** — 符号关联记录 (新增)
9. 🔲 SSH executor
10. 🔲 Module readiness 其余 gaps
11. 🔲 MiMo P1-4 上下文重建
12. 🔲 P0-3 stale detection (MiMo P1)
13. 🔲 Compaction 自触发 scheduler 层

### P2 — 持续
14. 🔲 **CBM Phase 3** — 代码感知 Compaction (新增)
15. 🔲 **CBM Phase 4** — 图增强检索 (新增)
16. 🔲 沙箱隔离
17. 🔲 Input-preprocessor P1 (IP1-IP7)
18. 🔲 retention/integrity 测试覆盖
19. 🔲 MiMo P2 items (Token-Budget, Runtime UI, config import, Compose Mode)

### P3 — 远期
20. 🔲 **CBM Phase 5** — 跨项目迁移 (新增)
21. 🔲 Phase 5: 多 Gateway 集群
22. 🔲 Nix Flakes, Oxlint, 审批工作流, 凭据加密
