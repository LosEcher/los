# 竞品快照 2026-08（framework-reference-watch sweep #3）

> 调研窗口：2026-07-15 ~ 2026-08-07（sweep 日 2026-08-07）
> 方法：Tier 0 源码（Grok Build mirror）+ Tier 1 官方 changelog/releases/arXiv（web 交叉核实）
> 关联：`todo-los-framework-reference-watch`（monthly，上轮 2026-07-16）、`docs/research/competitive-snapshot-2026-06-20.md`、`docs/research/deep-dive-grok-build-agent-runtime-2026-07.md`

## 一、可吸收性 Top 发现（对 los 直接有用）

### 1. 记忆安全成为行业级主题（最高优先级新空白）
- **MAFIA（arXiv:2608.03844, 08-04）**：query-only 记忆投毒攻击——探测定位 + 检索竞争注入，把审计检测从 83.3% 压到 7.4%。攻击目标是记忆存储本身。
- **MutMem（arXiv:2608.02843, 08-03）**：Ed25519 签名授权每次记忆变更 + 投毒内容带标签保留（不删除、可归因）。
- **Anthropic containment 文（2026-05-25）**："persistent memory poisoning 跨会话持久内存被注入后每次启动重载"列为前瞻首要威胁；"任何在信任对话框之前解析的项目配置都是攻击面"。
- **los 对照**：memory 写入路径（observation/compaction）应默认视为不可信输入先过 L1 再落盘；跨 agent 消息同样过门禁（Claude 2.1.222 auto mode 分类器）。→ **建议产出：los memory 防御 checklist + 写入门禁**（对应 Cindy #205 记忆防御待办）。

### 2. compaction 演进：分层已成共识，los 已覆盖前两层
- **Codex 0.147/0.145**：remote conversation compaction（云端压缩）+ 分页 thread history（不压缩而是结构化分页）——los 三层 compaction 的第三层对标；compaction 模型退役重试语义（0.144 #30319）。
- **Claude 2.1.224**：fullscreen 模式跨多次 compaction 保留完整 pre-compaction 历史；compaction 边界对客户端可见。
- **OpenAI（2026-07-29 blog）**：compaction 成推理 API 正式设置（"enabling compaction tripled ARC-AGI-3 scores"）——模型层一等公民。
- **ScrubJay-MEM（arXiv:2608.04746, 08-05）**：按内容类型区分的衰减率（π_i/τ_i）——los 刚完成的 decay 触发是同轨实现，新方向是**按 kind 分衰减曲线** + GenGap 式 eviction 效果基准。
- **los 对照**：sd-trigger 已闭合（2026-08-07）；下一增量 = compaction 边界可见性（pre/post compact SSE 已有）+ 失败回退语义 + 按 kind 衰减。

### 3. 远程 sandbox：凭据 sentinel + egress 替换是缺失拼图
- **Claude 2.1.221/224**：sandbox credential `mode:"mask"`——sandbox 内读 sentinel 副本，egress 时 proxy 用真实值替换（macOS 回退 deny）；`extract`/JWT/AWS SigV4 重签名；tail-slash 绕过漏洞。
- **Codex 0.146**：WebSocket 远程 Code Mode host；secrets 脱敏 + 项目信任确认（0.147）。
- **Anthropic containment (c)**：egress 白名单须做请求级 capability 校验（Cowork 曾因 API key 白名单外泄）。
- **los 对照**：远程执行已接线（PR #203/#214），但 run_shell 仍 L1 门禁 + 凭据保护缺失。→ **建议产出：远程 sandbox 凭据 mask/egress 替换设计**（对照 B backlog sandbox 升级）。

### 4. L1 门禁加固：行业绕过清单 = los 回归测试集
- Claude 2.1.208/221/223 修复：Bash tabs/不可见 Unicode 隐藏命令、zsh `[[ ]]` 正则条件内执行、`$(…)`/backtick/`<(…)` 在 `rm -rf` 强制确认、workflow 动态 `import()` 逃逸。
- Reasonix v1.21：结构化 Shell 执行契约（shell 身份/平台/退出码/失败阶段/变更风险/验证状态）——los 工具执行层现成范本。
- **los 对照**：L1 门禁 parser 的加固测试集可直接移植。

### 5. 多 agent 并发：fail-fast 取消是防死锁关键
- OpenAI Agents SDK v0.19.1/0.19.4：并发 guardrail 失败时取消兄弟任务（#3982/#4185）、handoff 不进 tool_called 事件流（#4146）。
- AG2 v1.0：Network tracing（跨 agent 网络 span + Prometheus）+ Agent Evaluations（judge+threshold scorer）。
- **los 对照**：agent-graph 已验证 3/3 并行，但 completion 死锁问题（2026-08-08 记录）→ 补"分支失败取消兄弟任务"语义；trace 可加跨 agent span。

## 二、按项目明细

### Grok Build（Tier 0，本地 mirror）
- mirror `origin/main` 有 **7-29~8-03 大更新**（e5478ef 起 19 commits "Synced from monorepo"，461 files / +83K / -49K），从未合并追踪。
- 信号（测试名/文件变化）：`test_session_load_memory.rs`（+716）、`test_nonblocking_startup.rs`、`test_refusal_stop_reason.rs`、`test_stop_hook_e2e.rs`、`test_session_end_hook_e2e.rs`、`xai-tool-types/task.rs`（+279）。
- CHANGELOG 0.2.98（c1b5909 时点已有）：subagent 可指定 `model`、`pre_tool_use` deny 反馈给模型重试、plan mode 严格边界。
- **下一步**：下轮 sweep 深入 e5478ef 的 session_load_memory / nonblocking_startup / stop_hook 实现。

### Claude Code（v2.1.208 → 2.1.224，08-07）
- 2.1.224：credential masking（extract/JWT/SigV4）、sandbox 违规详情写入 Bash 结果、全屏模式 pre-compaction 历史保留、移除 200 子代理上限、self-hosted-runner。
- 2.1.223/221：权限绕过批量修复（见上）、credential `mode:"mask"`。
- 2.1.216/212：`sandbox.filesystem.disabled`（FS/网络隔离解耦）、subagent/WebSearch 配额 200 防 runaway、MCP 超 2 分钟转后台。
- containment 综述（05-25）：信任前配置解析攻击面、用户本人是注入向量、egress capability 校验。

### Codex CLI（0.144.0 → 0.147.0，08-07）
- 0.147：MCP 2026-07-28 协议（分页/非阻塞启动）、会话分节 + 增量浏览、remote compaction、secrets 脱敏、`--approve-for-me`。
- 0.146：WebSocket 远程 Code Mode、executor-provided skills、MCP 热刷新。
- 0.145：分页 thread history + memories、多 agent V2 稳定、Windows exec-server sandbox。
- 0.144：compaction 模型退役重试、tool schema compaction 阈值。

### OpenAI Agents SDK（v0.18.2 → 0.19.4）
- 0.19.1/0.19.4：并发失败取消兄弟任务（#3982/#4004/#4185）、guardrail 时序修复（#4184）。
- 0.19.0：ProgrammaticToolCallingTool（模型生成 JS 协调工具）、@tool decorators。
- 0.18.3：流式输入跨重试保留（#3857）、span 配置化。
- hosted multi-agent beta（0.18.2）——方向信号。

### LangGraph / AutoGen / AG2
- LangGraph：`trace_policy`（节点级输入变换/降采样，500-1000ms/middleware 开销动机）；功能增量小。
- **AutoGen（Microsoft）冻结**：近一年零发布（python-v0.7.5 = 2025-09）。
- **AG2（活跃 fork）v1.0.0（07-27）**：包名改 `ag2`、NLIP/ACP 协议、Network tracing（#2895，高可吸收）、Agent Evaluations judge+threshold（对照 los pairwise eval）。

### Kimi（MoonshotAI）
- **kimi-code v0.33.0（08-05）：agent-core-v2 引擎默认转正**（`KIMI_CODE_LEGACY_FLAG=1` 回退）——los K3 适配应对齐 v2 语义。
- 0.29.0（07-22）：ACP thinking effort 分级、Markdown+frontmatter 自定义 agent、全局工具 gating。
- 0.31-0.32：插件自定义 agent、hooks 事件（TurnStarted/UserPromptQueued/TaskStarted/SessionHeartbeat）、token_counting 策略。
- 0.34.0（08-06）：会话恢复保留终态、MCP 动态变更语义。
- Kimi-K3 本体窗口内无新 release；新增 Kimi-K2.5（视觉 agentic）与 Kimi-Vendor-Verifier。

### Reasonix（DeepSeek-Reasonix，宿主工具，迭代极快）
- v1.21.0（08-06）：**结构化 Shell 执行契约**（shell 身份/退出码/失败阶段/变更风险/验证状态）、中断流原子重放≤5 次、会话级临时文件生命周期、移除 Goal token 硬上限、e2ebench SWE-bench Verified。
- v1.19.4（08-03）：模型感知推理（DeepSeek V4/GLM thinking.type）、128KB 推理守卫 + 每模型输出预算。
- v1.19.5：每日 JSONL 用量面板、上下文压缩阈值默认 80%、system_prompt_file 越界拒绝。

### Aider
- v0.86.0/0.86.1（08 上旬）：GPT-5 家族 reasoning_effort、kimi-k2/grok-4 模型别名；增量低（architect/editor 已吸收）。

### arXiv / 学术信号（memory 方向集中爆发）
| 论文 | 日期 | 对照 los |
|---|---|---|
| ScrubJay-MEM 2608.04746 | 08-05 | 按类型衰减率（sd-trigger 下一步） |
| ARC 2607.25066 | 07-27 | observation mask → ID 可寻址归档 + 免重执行恢复 |
| MemTX 2607.23929 | 07-27 | 写入事务化/提交门控/级联回滚 |
| MutMem 2608.02843 | 08-03 | 签名授权记忆变更（新方向） |
| InMind 2607.24368 | 07-27 | 隐式关联检索盲点——确定性保活优于纯检索 |
| MAFIA 2608.03844 | 08-04 | 记忆投毒威胁（新空白） |
| Self-GC 2607.00692 | 07-01 | fold/mask/prune + 可恢复 sidecar（CWL 互补） |

## 三、转化为 los 工作项（候选）

1. **memory 防御 checklist**（高）：L1 门禁覆盖 memory 写入 + 跨 agent 消息；MAFIA 对抗清单；对应 Cindy #205。
2. **远程 sandbox 凭据 mask/egress 替换**（高）：Claude 2.1.221 模式设计；B backlog sandbox 升级的一部分。
3. **L1 门禁回归测试集**（高）：Claude 绕过清单（tabs/Unicode/zsh/子 shell）+ Reasonix shell 契约。
4. **agent-graph fail-fast 取消**（中高）：分支失败取消兄弟 worker（对照 #4185）。
5. **按 kind 衰减率**（中）：ScrubJay 思路进 decay.ts（下轮 sd 迭代）。
6. **K3 适配对齐 v2 引擎**（中）：kimi-code 0.33 转正。
7. **compaction 边界可见性/失败回退**（中）：SSE 已有 pre/post，补模型退役重试语义。
8. **ARC 式 ID 可寻址归档**（中）：observation masking 的工程升级。

## 四、方法与残留

- 方法：Tier 0/1/2 分层 + 官方源交叉核实（releases API 与 CHANGELOG 日期互证）；arXiv listing + 关键词检索。
- 残留：
  - Grok Build e5478ef 内容未深读（本次仅测试名信号；下轮 deep dive）。
  - Aider/部分 Reasonix 版本（1.19.6-1.20.0）未逐一核对。
  - Cursor/Windsurf/Devin 等 Tier 2 未更新（快照级，低优先）。
- 下次 sweep：2026-09-16（monthly）。
