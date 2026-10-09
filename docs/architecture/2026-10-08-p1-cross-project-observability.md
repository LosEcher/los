# P1 设计：跨项目状态可观测（DSH session 历史 → los 读模型 + 项目健康看板）

- **状态**：设计（待评审）
- **归属**：跨项目。L1-1/L1-2 主体在 **DSH 侧**（session-index + 插件 + 看板），只读投射落点在 **los 侧**（read model 表 + 日报）
- **批次**：P1（第一批，性价比最高，无破坏性）
- **依据**：2026-10-08 los 全量盘点（`docs/operations/2026-10-08-los-inventory.md`）+ DSH `session-index.db` 实测查询 + `dsplugins/dsh-session-index`
- **前置**：无（纯增量、只读）

---

## 1. 问题陈述（有数字）

### 1.1 两个 session 库互不相通，跨项目历史对 agent 不可见

| 库 | 位置 | 规模（2026-10-08） | 消费者 |
| --- | --- | --- | --- |
| **DSH session log** | `~/.dsh/sessions/<cwd-slug>/<session>/`（JSONL/zstd） | 1097 sessions / 592,447 events | `session-index` 投影 |
| **session-index** | `~/.dsh/storages/session-index.db`（SQLite，274MB） | 同上 + FTS5 + `ingest_files` 水位 | `dsh-session-index` 插件（**仅 web/headless profile**） |
| **los session 账本** | Postgres `sessions` / `session_events` | 307 sessions / 229,152 events | los 自身 |

**缺口**：`grep -rln "session-index\|dsh/sessions" packages/*/src tools/` = **0 命中**。

⇒ los（以及任何要在 los 账本里做跨项目结论的流程）**完全看不到 DSH 的历史会话**。今天要回答"近两周跨项目最常撞的坑是什么"，只能靠人工 sqlite3 手查（本设计就是这么做出来的）。

### 1.2 跨项目现场是活跃的，但没有任何跨项目视图

近 14 天 DSH 会话按项目分布（实测）：

| 项目 | sessions | 末次 |
| --- | --- | --- |
| `.dsh/scheduler-reports`（headless 定时） | 122 | 10-08 08:42 |
| **dsfolder**（含 unirun/rustopt/fmtguard/sandbox-run/verify-gate…） | 66 + 7 + 7 + 2 = **82** | 10-08 10:26 |
| lot2extension | 42 | 10-08 07:07 |
| cantool | 29 | 10-08 06:50 |
| lzlyx | 23 | 10-08 11:44 |
| deepseek-harness(-0.2.1) | 16 + 3 = 19 | 10-07 15:03 |
| **los** | 12 | 10-08 07:08 |
| wechatdp | 9 | 10-07 07:07 |
| cankey | 8 | 10-06 13:25 |
| los-memory | 4 | 10-07 12:30 |

单日峰值：10-07 = **148 sessions / 20,597 次 tool 调用**。

⇒ 活跃开发面是 **9 个仓**，但 los 只覆盖自己（12 sessions）。**"跨项目"在数据上已经是常态，在工具上还是空白。**

### 1.3 跨项目重复失败模式无人聚合（这是最有价值的一条）

同一类失败在不同项目反复出现，但没有任何机制把它上升为一次修复：

| 失败模式 | 实测证据 | 跨项目分布 |
| --- | --- | --- |
| 沙箱拒绝写工作区外路径 | FTS `SANDBOX` 995 命中 / `workspace-write` 253 命中 | 至少 cantool / wechatdp / dsfolder / los 四仓 |
| **拒绝被脚本误判成"幂等命中"** | 会话原话："file sandbox（workspace-write）禁止写 `~/.dsh/storages/feishu-push/`，`mkdir` claim 失败被脚本误判为 `inFlight → dedup:true exit 0` —— **今天这条故障通知根本没发出去，却报了成功**" | dsfolder（DSH 投递链），但同一 guard 形态在 los `run_specs`/死信侧也存在 |
| ssh ControlMaster socket 被拒 | 会话原话："首次 ssh 被沙箱拦截，原因是它要往 `~/.ssh/cm-*` 写 ControlMaster socket；改用 `-o ControlMaster=no`" | dsfolder / los node-deploy |
| `ps` 被拒导致门禁假红 | 会话原话："4 个失败是已知沙箱产物 —— `ps` 在非升级 shell 里被 block；同一棵树非沙箱下 77/77 通过" | dsfolder / cantool |
| 上下文压缩丢结论 | `This is an automatically generated checkpoint…` 出现 **29 次**，跨 5 个 session | 全院 |

⇒ **单仓修复 = 反复重付**。P1 的价值就是把"跨项目重复"变成一次可查、可归并的信号。

### 1.4 上下文注入开销无度量

实测近 14 天：

- `Current runtime context. This snapshot supersedes…` 注入 **573 次**
- skill catalog（`A skill is a reusable set of…`）注入 **353 次**
- `assistant/message` 平均 355 字符，**单条最大 8,000 字符（截断上限）**

⇒ 每次请求都背一份 runtime context + 一份 skill catalog，但**没有任何地方能回答"这批注入占了多少 token、有没有冗余"**。los 已有 `provider_call_telemetry`（含 `usage_json`）却因 B1 缺陷（列名错）**报空**——两条链都断。

### 1.5 agent 长循环无成本可见性

最重的 session（近 14 天）：

| 项目 | session | tool/call | request/header |
| --- | --- | --- | --- |
| wechatdp | `session-fffab0f3…` | **1796** | 14 |
| cantool | `session-e9fce8a2…` | 1646 | 7 |
| wechatdp | `session-f567119d…` | 1506 | 7 |
| lot2extension | `session-dbbc13db…` | 1421 | 107 |
| cankey | `session-8749b08e…` | 1157 | 6 |

**tool/LLM 比最高达 ~256:1**（1796 次工具调用只对应 14 次模型请求）⇒ 单轮 agent 走极长时域。另：`bash` 29,589 次 vs 全部 typed 工具合计 ~13,978 次 ⇒ **68% 的操作走裸 shell**，这是"用 bash 代替类型化工具"的信号。
轮次健康度尚可：turn/end = completed 815 / interrupted 33 / aborted 13 / error 9 ⇒ **坏轮 6.3%**。

### 1.6 模型路由事实与网关定位不符

近 14 天 `request/header` 的 model 分布：

| model | 次数 |
| --- | --- |
| `deepseek-official/deepseek-flash` | **590** |
| `deepseek-official/deepseek-v4-flash` | 6 |

⇒ **DSH 真实流量几乎 100% 走 `deepseek-official` 直连，而不是 los gateway**。同时 los 侧 12 个已注册 provider（deepseek/xai/kimi/minimax/packycode/…）在近 7 天只有 deepseek 1372 次 + kimi 11 次。**"los 是 DSH 的统一模型入口"这个定位在流量上不成立**——需要么修路由，么修订定位（见 P5 的 ADR 0038 修订）。

---

## 2. 设计目标与非目标

**目标**
1. 让 agent **能查**跨项目历史会话（结构化 + 全文），不需要人工 sqlite3。
2. 让"跨项目重复失败模式"成为**可聚合、可归并**的机械信号，而不是靠人读会话。
3. 让上下文注入开销、长循环成本、轮次健康度有**可对比的时间序列**。
4. 全部只读：**不写 DSH session log**（那是 canonical），**不改 DSH profile**（除加载插件）。

**非目标**
- 不做跨项目语义检索（embedding/RAG）——先做结构化 + BM25，够用再谈。
- 不把 DSH session 正文复制进 Postgres（AP 与 los 非目标：不存原始外部 transcript）。
- 不做实时（小时级足够；session-index 已经是小时增量）。
- 不替代 `session_search` 插件；本批次是**在 los 侧加一个受治理的只读投射**，让 los 的日报/治理能引用跨项目事实。

---

## 3. 交付物

### L1-1 `session-index` 插件装进全部活跃 profile（DSH 侧，最小改动）

**现状**：`dsplugins/dsh-session-index` 已存在（3 个工具：`session_search` / `session_events` / `session_stats`），README 的安装步骤只覆盖 web + headless；**desktop（= 当前 GUI 宿主）profile 未装**。

**动作**
```
dsh plugin --profile web      add -w link:/Users/echerlos/syncfolder/project/dsplugins/dsh-session-index
dsh plugin --profile headless add -w link:/Users/echerlos/syncfolder/project/dsplugins/dsh-session-index
dsh plugin --profile desktop  add -w link:/Users/echerlos/syncfolder/project/dsplugins/dsh-session-index
```
注意 README 记录的两个坑：① 必须用 profile 自身那版 pnpm（fnm default，非 `~/Library/pnpm`）；② web 侧需重启宿主才生效。

**验收**
- `dsh --profile <p> --dump-config | grep -A6 'id: session-index'` 三档都有
- 端到端唯一可信证据：**真实会话真的调用过** —— `sqlite3 ~/.dsh/storages/session-index.db "SELECT name,count(*) FROM events WHERE kind='tool/call' AND name LIKE 'session_%' GROUP BY name"` 出现 3 个工具名
- 负向控制：`session_events --args-hash` 查不到明文参数（插件边界声明必须成立）

### L1-2 los 只读投射 + 日报纳入跨项目事实（los 侧）

**新增只读读模型**（不改 DSH canonical；los 只**读**那个 274MB SQLite，或读它导出的窄视图）：

| 表 | 内容 | 粒度 |
| --- | --- | --- |
| `dsh_session_catalog` | `session_id, cwd_slug, project_key, created_at, last_event_at, tool_calls, llm_requests, interrupted_turns, duration_ms, as_of` | 每 session 一行 |
| `dsh_session_pain` | `project_key, pattern_key, occurrences, sessions, first_seen, last_seen, as_of` | 每（项目 × 模式）× 时间窗一行 |
| `dsh_context_injection` | `day, project_key, runtime_context_injections, skill_catalog_injections, avg_assistant_chars, max_assistant_chars` | 每（天 × 项目）一行 |

**`pattern_key` 的判据必须机械化**（否则会变成主观标签）：从 `events.text` 用固定正则族匹配，命中即计数，规则版本随行落库：

| pattern_key | 判据（正则，大小写不敏感） |
| --- | --- |
| `sandbox_denied_outside_workspace` | `sandbox.*denied\|operation not permitted\|denied under .* mode` |
| `denial_misread_as_dedup` | `dedup:true` 或 `inFlight` 与 `denied\|permission` 同段共现 |
| `ssh_controlmaster_denied` | `cm-\*` / `ControlMaster` 与 `denied\|not permitted` 共现 |
| `pss_blocked_gate_false_red` | `\bps\b` 与 `blocked\|denied` 共现，且同 turn 有 `failed` |
| `context_compaction` | `automatically generated checkpoint condensing` |
| `timeout` | `timed out\|timeout after` |

**日报扩展**（`tools/los-governance-daily.sh` 第 8 节"跨项目事实"）：

```
## 8. 跨项目（DSH session，as_of=<ts>）
- 活跃项目 14d: dsfolder 82 / lot2extension 42 / cantool 29 / lzlyx 23 / los 12 / …
- 跨项目重复痛点 top3（按 sessions 去重）: sandbox_denied_outside_workspace 12 sessions / timeout 9 / context_compaction 5
- 长循环告警: wechatdp session-fffab0f3 tool/LLM=128（阈值 50）
- 上下文注入: runtime_context 573 次 / skill_catalog 353 次（14d）
- 若 as_of 落后 >6h → 标 [STALE]（session-index launchd 可能没跑）
```

**验收**
- `pnpm --filter @los/gateway check` 绿 + 新增投影的单元测试（含"SQLite 缺失 → 返回空并标 degraded，不抛异常"的负向控制）
- 日报第 8 节在真库上产出非空，且 `as_of` 与 `session-index.db` mtime 一致
- **不写 DSH 侧任何文件**（验证：跑完 `~/.dsh/sessions` 与 `session-index.db` 的 mtime 不变，除 session-index 自己的小时任务）

### L1-3 跨项目开发场景健康看板（DSH 侧 widget）

`dsh-dashboards` 加一个 widget（注意该插件有 **store 优先 + `widgetsVersion` 增量迁移**的硬约束：新增内置 widget 必须 bump `DEFAULT_WIDGETS_VERSION`，否则对已有安装静默不可见——这是 2026-10-05 踩过的坑）：

- 卡片 1：近 14 天各项目 sessions / tool 调用 / 坏轮率（横向条形）
- 卡片 2：跨项目重复痛点 top 5（按 sessions 去重，带 as_of 与新鲜度徽标）
- 卡片 3：上下文注入开销趋势（runtime context / skill catalog 次数）
- 卡片 4：长循环 top 5（tool/LLM 比）

**验收**：widget 路由 200 且**在 GUI 真的可见**（判据不是测试绿，而是 store 里 `widgetsVersion` 已 bump + 卡片出现在页面上）。

---

## 4. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 274MB SQLite 被 los 长期直读，与 session-index 写入竞争 | 只读连接 + `busy_timeout`；优先读 `SQLITE_RO` URI；若冲突则改读 session-index 导出的窄 JSON |
| `pattern_key` 正则族漂移导致历史不可比 | 规则版本随行落库（`dsh_session_pain.rule_version`），改规则必须写在设计文档里并 bump 版本 |
| 跨项目结论被误当"证据" | 三类表全部标 `as_of` + 来源；los 的 `run_specs`/verification 仍是权威，跨项目读模型只是**输入信号** |
| 隐私：正文进 los | 明确不做。只落**计数 + 模式 key + session id/cwd 摘要**，不落正文片段 |
| 又一个"建好就停摆"的机制（见 B19 CI 观测停在 08-17） | 日报第 8 节带 `[STALE]` 门禁；launchd 台账 `~/.dsh/storages/session-index-ingest.jsonl` 纳入治理检查 |

---

## 5. 验收门（整批）

1. 三个 profile 都能用 `session_*` 工具；真实会话调用过一次（DB 有记录）。
2. los 日报第 8 节在真库非空，`as_of` 新鲜度门禁生效（人为把 DB mtime 改旧 → 出现 `[STALE]`）。
3. 看板 4 张卡在 GUI 可见，且 `widgetsVersion` 已 bump、用户删过的卡不复活。
4. 负向控制三条：SQLite 缺失 / 表为空 / 规则版本不匹配 → 均返回 degraded 且**不抛异常、不误报 0**。
5. 全套检查：`pnpm check` 绿；`bash tools/los-governance-daily.sh` 退出码 0。
