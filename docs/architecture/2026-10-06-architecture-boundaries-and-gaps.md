# los 架构、边界与缺口清单

Date: 2026-10-06
Baseline: `main` = `df45e3a2`（本轮改动前），全文证据取自本机只读盘点 + 集群实测。
Scope: 现状架构与成文边界、竞品/历史调研对标、8 台节点的执行面现实、集成矩阵、后续定位建议。

---

## 0. 摘要（先读这 6 条）

1. **los 已经不是一个"跑 agent 的脚本"，而是一个带证据账本的多节点执行面**：三层平面（service / execution / run orchestration）、46 篇 ADR、40 个契约、9 类硬门禁。
2. **最刺眼的事实不是缺功能，而是能力与使用严重不匹配**：8 台在线 executor 里 **6 台近 30 天零任务**，实际负载集中在 `gateway-local`(160) + `node34`(87) + `mbp`(22)；而升级/治理投入是按 8 台配置的。
3. **节点选择只有资源与队列排序，没有任何成本/配额/拓扑/地理策略**；`target_version`/`rollout_state` 是纯台账，无消费点，升级靠人工 promote。
4. **治理面很厚，但"未确认死信不自动升级、维护窗口不阻断调度、约束型节点识别是死代码"三处让治理的机械保证漏气**（详见 §3）。
5. **产品定位在 ADR 0038 已经写清**（Web-first、持久、可验证的日常编码/项目 agent，首要替代 Pi 与 Codex 的核心日常流），但今天真正被高频使用的却是"DSH 的模型网关 + 定时治理 + 多节点执行"这条**基础设施型**路径 —— 定位与使用之间存在一条未成文的裂缝。
6. 本轮已把"集群版本身份"从 4 个版本收敛到 1 个，并补上 promote/权限/参数解析三处脚本与护栏缺口；**未做的 12 项按 P0/P1/P2 列在 §3，可直接开工**。

---

## 1. 现状：架构与边界

### 1.1 三层平面与包边界

| 平面 | 归属 | 证据 |
| --- | --- | --- |
| Service plane | gateway / web / scheduler / artifact proxy | ADR 0012 `docs/adr/0012-...:99-150`：设计规则原文「service availability protects request entry / executor availability protects compute placement」 |
| Execution plane | `executor_nodes` + executor 进程（systemd/launchd/Windows 服务 + tsx 直跑 TS） | 8 台在线节点，见 §2.1 |
| Run orchestration plane | run specs / run state / tool state / task graph / checkpoint / retry / verification / eval | `packages/agent/src/run-contract.ts:42-64`（11 态状态机） |

包依赖：`@los/infra` 是叶子（fan-in 497 / fan-out **0**），`@los/agent` 是内部枢纽（fan-in 224 / fan-out 309），`gateway`/`executor`/`cli` 是入口。门禁 `tools/check-coupling.sh:44-56` 断言 infra 不得 import 任何上层包。单 Node 进程 + 可强制包边界（`AGENTS.md` Architecture）。

### 1.2 核心不变量（可执行的门禁，不是口号）

| 不变量 | 落地方式 |
| --- | --- |
| 状态迁移单入口 | AP1：必须走 `transitionExecutionState()`；`tools/check-state-machine-bypass.sh` 拦截直写 |
| 计划先持久化 | AP2：`approveRunSpecPhase()`/`reviseRunSpecPlan()` 写 `run_specs.run_contract_json` 后才能 `plan_approved` |
| 先验证后成功 | AP3：`canMarkSucceeded()` + verification record |
| contract-first | 40 个 `contracts/*.yaml`，`tools/check-contracts.sh`（信封校验 + 生成物漂移；**只有 run-spec/run-stream 做双向覆盖**） |
| 不建并行调度器 | `docs/governance/periodic-analysis.md:340-341`：`governance_jobs` 管治理节奏、`scheduled_work_items` 管工作项执行 |
| 外部 runtime 只认权威契约 | `docs/architecture/external-runtime-capability-model.md`：只选 `implementation=runnable && available=true` |

### 1.3 成文的非目标（这是"边界"的正面表述，值得复用）

- 不替代 Codex/Claude/OpenCode/OMX/browser，只做**项目自有的执行与证据面**（`docs/architecture/2026-07-03-project-status-and-roadmap.md:283-289`、README「Primary Use」）。
- 不存原始外部 transcript / auth snapshot / cookie / API key / provider 账号 dump；外部 runtime 只留 ≤2000 字符脱敏摘要。
- 不在 run spec / 状态迁移 / verification 稳定前上完整 workflow 引擎。
- `sandboxMode: 'sandbox'` 目前**只是 aspirational**，无真实 container/VM 隔离（ADR 0046 状态 Proposed）。
- 非交互流限制：stdin ≤64KB，**不支持长驻交互命令（REPL）**。
- provider 账号选择与 provider-loop 替换 out of scope（ADR 0030）。
- 单租户默认（`tenant_id='local'`），非 operator 请求不可跨租户。

### 1.4 端到端链路（谁调用谁）

```text
DSH (web/headless) --OpenAI 兼容 /v1/chat/completions--> los gateway
los gateway --provider profiles/fallback--> 上游 LLM（deepseek 为主；近 24h provider_call_telemetry 172 次）
los gateway --run-agent/命令--> executor 节点 --> 沙箱（macos-sandbox-exec / linux-bwrap / windows-acl / tool_policy）
executor --heartbeat--> gateway --> PostgreSQL（executor_nodes / task_runs / session_events / usage / governance）
los gateway --> 渠道 bot（当前全 disabled）
los CLI / MCP --> 同一账本（人/脚本/agent 三个入口）
```

---

## 2. 集群现实（执行面）

### 2.1 节点矩阵（registry + 实测校验）

| node | 平台/运行方式 | 内存(实测可用) | 沙箱后端 | heavy_task_safe | 端口 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| mbp-executor-1 | darwin，主仓工作树直跑，launchd 30s 自愈 | 21.3G | `macos-sandbox-exec` | true | 8090 | **同时是控制面**；`file_sync_folders` 2 条 |
| node34-executor-1 | linux，/opt/los + systemd | 5.1G | `linux-bwrap` | true | 8090 | 唯一有真实远程负载的节点；swap 6G 已用 1.68G |
| oracle-executor | linux，`ubuntu`+sudo，systemd | 0.36G | **`tool_policy`** | false | **8091** | 1G 内存；`.env` 600 需 sudo 才能读 |
| vultr-executor | linux，/opt/los + systemd | 0.42G | `linux-bwrap` | false | 8090 | 实测 nproc=1；swap 2.4G |
| tencent-sin-executor | linux，systemd | 1.9G | **`tool_policy`** | **true** | 8090 | 3.6G 机器被判 heavy safe（阈值副作用，见 §3-P1-2） |
| m3pro-executor-1 | darwin，launchd，`~/.local/share/los` | ~14.7G | `macos-sandbox-exec` | true | 8090 | **无 VCS、无自动部署通道** |
| desktop-r45553o | win32，nssm 服务 + PowerShell 看门狗 | 16.7G | `windows-acl` | true | 8090 | 无 bash/shasum；默认 shell 是 cmd.exe |
| desktop-srsbe20 | win32，同左 | 17.8G | `windows-acl` | true | 8090 | 同上 |
| grok-cloud-executor-1 | linux（offline） | — | `tool_policy` | true | 8090 | 心跳停在 09-29，**无自动再入册路径** |

registry 与实测不一致 5 处：缺 `cpuCores`（vultr/tencent-sin/grok-cloud）；`heavy_task_safe` 由 `memTotalMb <= 2048` 推导而非能力评估；`deploy_safe` 在 ≤2G Linux 上只看 swap；`fleet_host_check_state` 只覆盖 5/9 台；`last_probe_at` 全部停在 2026-09-27。

### 2.2 角色声明 vs 实际负载（30 天）

| node | 声明角色 | 任务数 | 成功率 | 平均时长 |
| --- | --- | --- | --- | --- |
| gateway-local | 控制面默认执行 | **160** | 83.8% | 139.4s |
| node34-executor-1 | 通用执行器 | 87 | 71.3% | 92.8s |
| mbp-executor-1 | 控制面 + 本地执行 | 22 | 100% | 24.5s |
| vultr / oracle / m3pro / tencent-sin / 2×Windows | 各自声明的执行器角色 | **0** | — | — |

**结论：声明了 8 台，用了 2 台。** 这直接决定后续投入方向（见 §5）：要么让放置策略真正用到它们，要么承认它们是待命/专用池而不是"统一升级"的负担。

### 2.3 放置与调度机制（现状）

- 选择入口：`packages/agent/src/scheduler/executor-client.ts:36` → `listExecutorNodes(100)` → `filter(candidate)` → 排序 → 逐节点硬门禁。
- 硬门禁 9 条（fail-closed，`packages/agent/src/executor-nodes.ts:353-421`）：status online、心跳新鲜、kind=executor、agent_http 模式、非 wildcard、`run_agent`、**verified_json 该模式已确认**、内存未临界、磁盘 ≥1G。
- 能力门禁：`executor-client.ts:151-172` —— readonly→`workspace_read`；sandbox→`shell`+`sandbox`；`requiresBuild`→`heavy_task_safe`；`requiresDeploy`→`deploy_safe`。注意 `sandbox` 需求会把 `tool_policy` 节点（oracle/tencent-sin）**直接拒掉**。
- 排序（软信号，`executor-nodes.ts:437-462`）：内存压力 warning 靠后 → `preferredNodeId` → queue_depth → activeTaskCount → capacity 字段数 → 心跳新鲜。
- **没有**：成本、配额、机房/区域、RTT、地缘、数据驻留。`grep cost|quota|region|latency|topolog packages/agent/src/scheduler/` 只命中**模型 provider** 的成本平局打破，节点层零命中。

---

## 3. 缺口与优化清单

分级口径：P0 = 让现有机械保证漏气/会误判的事；P1 = 能力缺失但有明确低成本方案；P2 = 结构性/体验面。

### P0

| # | 缺口 | 证据 | 建议落地 |
| --- | --- | --- | --- |
| P0-1 | **维护窗口不阻断调度** | `isNodeInMaintenance` 仅 3 个调用点（`runtime-health.ts:184`、`fleet-inventory.ts:265`、`fleet-host-checks.ts:337`），全在告警/自修复侧；候选过滤链无调用；`node_maintenance_policy` 实际 0 行从未启用 | 在 `resolveExecutor` 的候选过滤里加维护窗口门禁（与 drain 同语义）；否则"维护窗口"这个名字在误导运维 |
| P0-2 | **drain 后无自动 promote** | `node-commands.ts:151-160` promote 只手工；`upgrade` 写 draining 后返回"人工继续"；rollout 期间 8 台全部需要人工 promote | 本轮已给 `deploy-to-remote.sh` 加 `promote` 子命令 + verify 末尾警示；下一步在 verify 成功后自动 promote（需带 node id + 版本校验） |
| P0-3 | **promote 不校验版本** | `node-commands.ts:152` 只要求 nodeId；实测 promote 输出的是 registry 里的**陈旧**版本（`b8883f8d4612c`） | promote 前拉节点 `/health`，版本不符则拒绝或标 `rolloutState:'verifying'` |
| P0-4 | **零内容校验** | `deploy-to-remote.sh` 的 verify 只比版本字符串；Windows/macOS 无 sha 路径；实测 srsbe20 出现"`.env` 已盖章 + `/health` 报新版本，但代码仍是旧的" | verify 增加内容摘要比对（Linux/macOS 用 `build-version`；Windows 用"目标修订新增文件存在性"探针） |
| P0-5 | **约束型节点识别是死代码** | `resourceClass` 从未落库（`capacity_json ? 'resourceClass'` 9 台全 false），`executor-nodes.ts:383` 判 `=== 'constrained_executor'` 恒 false → `capability:heavy_task_safe_false` 等 3 条 warning 永不产生 | 落库 `resourceClass`（或直接在读侧由 `capacity.memoryTotalMb` 推导），让 1G 节点的约束语义进入 warnings 与排序 |
| P0-6 | **`target_version` 无消费点** | `grep targetVersion packages/{agent,gateway,cli}/src` 只有写入/透传，无收敛逻辑；升级全靠人工 | 让 daily governance/fleet 检查比对 `version` vs `target_version` 并出 todo；再考虑自动收敛（本轮已把 8 台显式写入同一 `target_version`，使该比对立刻可用） |
| P0-7 | **sync 不校验远端收敛，失败会留下半截树** | `deploy-to-remote.sh` 用 `cat tar \| ssh … 'tar xzf -'` 单管道；2026-10-06 实测 tencent-sin 连传两次得到两个不同摘要（`b5131ca`/`b960509`），留下半同步的 `packages/` 使执行器崩溃重启 5 次被 systemd 放弃；vultr 同类问题表现为"树已更新但 `.env` 未盖章" | sync 结束后强制比对远端 `build-version` == 目标，不符即失败；把 upload-then-extract（scp → 双侧 sha256 → 本地解包）作为 `sync` 的默认或回退路径 |

### P1

| # | 缺口 | 证据 | 建议落地 |
| --- | --- | --- | --- |
| P1-1 | **6/8 节点零负载**，放置策略没有理由把活派出去 | §2.2 的 30 天分布 | 要么给远程节点明确的专用场景（构建/Windows 专用/低资源巡检），要么收编为待命池并在 runbook 登记"未使用"状态，避免"统一升级"的假工作量 |
| P1-2 | **能力判定是阈值副作用** | `packages/executor/src/resource-metrics.ts:89,101`：`isConstrained = memTotalMb <= 2048`；3.6G 的 tencent-sin 因此 heavy safe；`deploy_safe = !isConstrained \|\| swapTotalMb >= 2048` 让 1G 机器仅凭 swap 获得部署资格 | 改为多维能力画像（内存/CPU/磁盘/swap 组合 + 实测采样窗口），并把 `deploy_safe` 与"能否装依赖"绑定而非只看 swap |
| P1-3 | **无成本/配额/拓扑放置** | §2.3 | 优先做"数据/网络亲和"：LAN 内节点 vs 跨 tailnet 节点、机房 proximity、按 provider 出网路径；成本维度等有真实多节点负载后再做 |
| P1-4 | **幂等键原语缺失** | 历史调研 #29（InstantDB 形态：client-event-id + tx-id + token + resync-table）；los 有 DLQ/resume 但无通用幂等键 | 在 scheduled_work / feed-analysis 回调这两个真实重复源上先落一个 `client-event-id` 表 |
| P1-5 | **工具级决策审计三态缺失** | 历史调研 #31（OpenBot 的 allowed/refused/failed 决定→记录→执行） | 与现有 tool-gate 合并，先落三态事件，不做策略引擎 |
| P1-6 | **租约过期无自动重排** | `dead_letter_events` 里 `lease_expired` 的 `requeueEligible=0`（候选要求 `run_spec_id` 非空）；22 条里绝大多数无 `run_spec_id` | 给 lease 过期补一条"无 run_spec 时如何收敛"的路径（标记 superseded 或重建 spec），否则会长期只增不减 |
| P1-7 | **变更端点缺 operator 门禁** | skill-routes 8 个变更端点、memory-routes 9、rule-routes 5、tool-gate-routes 3、artifact-routes 3、saas-todo 2、service 2、usage push 1，均只依赖全局 token | 这批按"是否影响执行/记忆/分发"排序补 `requireOperator` |
| P1-8 | **40 个契约里 22 个零引用** | 逐文件 `grep -rl <basename> packages tools` = 0；其中 `external-runtime.yaml` 被文档称为 authoritative 却无读取方 | 要么接线（读契约校验），要么显式标注为"文档型契约"并移出门禁预期 |
| P1-9 | **探针/主机检查覆盖与新鲜度** | `last_probe_at` 9 台全部停在 2026-09-27；`fleet_host_check_state` 仅 5/9；oracle 采集 19.7s、tencent 9.6s | 给 probe 加 TTL 与计划任务，让"从未探测"和"探测通过"可区分 |
| P1-10 | **grok-cloud offline 无再入册** | 心跳停在 09-29，`verified_json` 无 TTL；唯一路径是人工 promote | 加"再入册"检查清单 + verified 过期时间 |

### P2

| # | 缺口 | 证据 | 建议 |
| --- | --- | --- | --- |
| P2-1 | 媒体能力无对外入口 | `@los/media` 无 gateway 路由、无 CLI；唯一消费者是 disabled 的 wechat-bot | 要么开一个 `/v1/media/*` 或 CLI，要么在文档里明确"库内能力，暂无产品面" |
| P2-2 | 渠道全 disabled 但仍有依赖渠道的启用任务 | `daily execution digest (feishu)` enabled；feishu 在 `communication-routes.ts:172` 只是 `planned` 占位 | 让 digest 任务的依赖状态可校验（渠道 disabled 时该任务应 no_op 并说明），或补 feishu 实现 |
| P2-3 | run_specs 36% 非终止态 | 430 行里 `created` 142 + `blocked` 14 | 收敛策略（超时 → cancelled/blocked 并留因） |
| P2-4 | help 遗漏 4 个命令 | `auth`/`memory`/`scan`/`cbm` 在 dispatch 但不在 `help.ts` | 补 help，成本极低 |
| P2-5 | 架构基线文档与现状不符 | baseline 列了不存在的 `@los/input-preprocessor`，漏了 `contracts`/`redaction` | 更新基线 |
| P2-6 | ADR 状态段模板化错误 | 0042-0046 都声称与 0031-0034 编号冲突，实际无重号 | 清掉错误断言 |
| P2-7 | 静态分析门禁 error-only + 384 条 wiring 豁免 | `ci-gate.sh:298-299`；`tools/wiring-topology-baseline.txt` 384 行 | 逐步收紧，先处理 orphan 里影响执行面的 |
| P2-8 | 无趋势图/流式回放 | 全仓无 chart；回放 12s 轮询整段重载 | 已有 scrubber，下一步做增量流式 |
| P2-9 | `no_op` 占比过高 | `scheduled_work_item_runs`：succeeded 5490 / no_op 5182 | 审视哪些任务本就该低频，避免"成功"掩盖无操作 |

---

## 4. 集成矩阵：los 与各应用如何配合

| 应用 | 能否接 | 接法（具体） | 当前状态 | 摩擦点 |
| --- | --- | --- | --- | --- |
| **DSH（web/headless）** | 已接 | OpenAI 兼容：`~/.dsh/profiles/desktop/cordis.patch.yml:120` `baseURL: http://127.0.0.1:8080/v1` → `GET /v1/models`、`POST /v1/chat/completions` | 在用（本会话即经此调用 los） | 需配置 token；DSH 侧模型清单与 los provider 清单需手工对齐 |
| **任意 MCP 客户端**（Claude Code/Codex/DSH） | 可接 | `los mcp serve`（stdio），暴露 4 个工具：`los_run`/`los_run_state`/`los_run_replay`/`los_operator_control`；协议 2024-11-05 | 能力就位 | 每次调用必须带 `projectId`；默认 `read-only`；工具面只有 4 个，检索/治理/节点类能力未暴露 |
| **外部编码 agent**（Codex / Claude Code / Grok CLI） | 可接 | `POST /runtimes/:kind/run` + `/runtimes/capabilities`；runnable：codex、claude-code、grok；planned：gemini、reasonix、pi-external | 已实现 | planned 项需在 `contracts/external-runtime.yaml` 与实现同时更新；grok 依赖 active 账号 |
| **脚本 / CI** | 已接 | `bin/los` 子命令（run/sessions/tasks/nodes/governance/evals/usage/digest/health…） | 在用（治理巡检、部署、runbook 全走 CLI） | `--help` 漏 4 个命令；operator 类命令需 token |
| **CRON / DSH scheduler** | 已接 | `scheduled_work_items` + `dsh-scheduler` 触发 headless 会话；审批 gate `/scheduled-work-item-runs/:id/approve` | 在用（每日治理日报 08:30） | confidence gate 会把"产物已落盘"的 run 记 failed（见 P0-4 类问题） |
| **微信（weclaw）** | 半接 | 推送走 `curl http://127.0.0.1:18011/api/send`（headless 无渠道插件） | 在用（日报推送） | 渠道 bot 本体 disabled，靠外部服务绕行 |
| **Telegram / 飞书** | 未接 | telegram bot 包在，模式未配置；feishu 仅 `planned` 占位 | 未用 | 有依赖渠道的启用任务（P2-2） |
| **cbm（codebase-memory-mcp）** | 半接 | `memory.codeGraph.{enabled,shadowMode,injectArchitecture}` 默认全 false；`los cbm` 只读 shadow 日志 | 本机有 2 个 cbm 进程在跑，但 los 侧默认关闭 | 打开开关需要索引成本与注入预算评估 |
| **媒体生成（TTS/图像/视频）** | 未接 | 无入口 | 未用 | P2-1 |
| **win 采集节点 / ego-browser / kimi-webbridge** | 间接 | 通过 DSH 技能驱动，不经 los；los 只提供模型与执行面 | 在用（另一条链） | 无 los 侧证据留痕，跨系统可观测断裂 |
| **ZMS 等业务后台** | 间接 | 浏览器自动化在 DSH 侧，los 不参与 | — | 同上 |

**一句话**：los 当前真正被使用的身份是 **「DSH 的模型网关 + 定时治理执行面 + 多节点执行台」**，而 ADR 0038 规划的 **「Web-first 日常编码 agent」** 这条产品路径尚未成为日常入口。

### 4.1 集成面实测缺口（2026-10-06 取证）

| # | 缺口 | 证据 | 影响 |
| --- | --- | --- | --- |
| I-1 | `/v1` 只有 2 个端点，无 embeddings / rerank / vision（**tools 转发已于 2026-10-06 恢复到主线并实测 live**） | `packages/gateway/src/openai-compat-route.ts:60,74`；转发实现 `openai-compat-tool-forward.ts` + `route.ts:165-166`；探针 400 `tool_forward_unavailable` 已验证 | 该能力曾长期只活在未提交的工作副本，切回 `main` 重启后静默消失过一次；修复方式是把它并进主线（本轮）而非依赖工作副本 |
| I-2 | `/v1/chat/completions` 硬编码 `toolMode:'read-only'`、`persistMemory:false`，调用方无参数可提权 | `openai-compat-route.ts:184,192` | 外部调用者无法通过 `/v1` 触发写路径，产品能力被压在只读档 |
| I-3 | **`los mcp serve` 零消费者** | DSH/Claude/Codex 的 MCP 配置里都没有 los server（Claude=`context7,cbm,exa,nowledge-mem,pencil`；Codex 无；DSH patch 有 cbm/jj/webbridge/nowledge-mem/lot） | 4 个 MCP 工具（`los_run/los_run_state/los_run_replay/los_operator_control`）属于"建好没人用"，是低成本的接入机会 |
| I-4 | **los 直发 IM 能力为零** | wechat `disabled`（`.env:34`）、telegram 未配置、feishu 在 los 侧仅 `status:'planned'`（`communication-routes.ts:172`）；`WECLAW_API_ADDR=127.0.0.1:18011` 仍在配置但端口无监听 | 治理日报的"推送"实际由 DSH 侧飞书渠道完成，los 自身链路是死的；配置残留会误导排障 |
| I-5 | los→DSH 事件 webhook 的**唯一发送方在被停用的 wechat-bot** | `packages/wechat-bot/src/index.ts:425-455`；`DSH_EVENTS_WEBHOOK_URL=http://127.0.0.1:3080/los-events` | `governance.*` 事件无法再推到 DSH（接收端还在，等待一个不存在的发送方） |
| I-6 | **11 个 DSH 调度 job 只有 2 个碰 los，且都绕过 los API** | job-67166722 直接 `psql` 读真库跑脚本；job-440be80b 跑 verify-los/cantool 技能（lastStatus=failed） | 治理读的是 DB 而不是 los 自己的 API，等于绕开了契约面与鉴权面 |
| I-7 | feed-analysis 回调死信 18/87，无告警导出面 | `feed_analysis_callback_deliveries`（attempt=8、last_http 500/"fetch failed"）；有 replay 接口但无告警 | 一个真实在跑的双向集成（lot2extension → los → lot2-go-backend）缺 SLO |
| I-8 | 节点命令语义不对等：`promote`/`drain` 只改 registry 行、不触达节点；`restart`/`upgrade`/`probe` 无 executor-side runner 时直接 denied；契约仍是 `draft` | `packages/agent/src/node-commands.ts:137-163`；DB 2 条 denied；`contracts/node-command.yaml: status: draft` | 运维动作的"成功"含义分裂（有的改了 DB 有的真做了事） |
| I-9 | DSH `/los-events` 接收端**无鉴权** | `dsplugins/dsh-los-ops/index.mjs:89-112`（只解析 JSON + 限 256KB） | 本机回环内风险有限，但不该靠"回环"当安全边界 |
| I-10 | executor_nodes 表 36 行里只有 8 个 candidate，12 台 8-19 的陈旧 offline 行混列 | DB 全表；`GET /nodes` 对普通 token 返回 operator required | 看板/巡检需要自己过滤，误判风险高 |

**结论**：los 的集成面是"**窄而深**"——入口少（`/v1` 两个端点、MCP 4 个工具、一个人/脚本 CLI），但每个入口背后都有账本、鉴权、契约与门禁。缺的不是更多入口，而是**把已有入口接上消费者**（I-3）与**让入口的能力声明与实际一致**（I-1/I-2）。

---

## 5. 后续定位与边界（建议）

### 5.1 定位：一句话收敛

> **los 是这台机器（以及它的小集群）的项目级执行与证据面**：所有"我需要证明这件事真的跑过/真的通过了"的场景走 los；所有"我需要一个顺手的日常编码对话"的场景仍可以走 DSH/Codex/Claude，但**一旦结论依赖执行、节点、provider 门禁或治理节奏，就必须落进 los 的账本**。

这既符合 README「Primary Use」的原文，也解释了今天的真实使用分布。

### 5.2 边界（建议显式化）

**做**：多节点执行与放置、run 契约与验证、治理节奏与升级闭环、provider 路由/配额/健康、跨机制品与 file-sync、DSH 侧模型网关。
**不做**（延续成文非目标）：不做通用 workflow/agent 编排引擎替代品；不做浏览器自动化与采集（那是 DSH 技能与 ego/kimi 的活）；不做多租户 SaaS 化（单租户默认）；不存原始外部 transcript/凭据；不在沙箱多后端契约落地前声称 container/VM 隔离。

### 5.3 三条路线优先级

1. **收口执行面**（P0 全部）：维护窗口真正生效、promote 自动且校验版本、内容校验、约束型节点识别落库、`target_version` 有消费点。**目的：让 8 台的运维投入不再白花。**
2. **让节点有活干或有名分**（P1-1/P1-3）：要么按场景分派（Windows 专用、构建主机、低资源巡检、网络出口），要么在 registry/runbook 里明确待命，并在日报里区分"待命"与"漂移"。
3. **补三个原语**（P1-4/P1-5/P1-6）：幂等键、工具三态审计、租约过期的收敛路径。这三个是把"能跑"变成"可重复、可审计、可自愈"的杠杆点。

### 5.4 两个需要立刻定调的问题

1. **工具转发（I-1）二选一**：合并 `wip/gateway-tool-forward-20260927` 恢复能力（需评审 + 会再次改变集群摘要），或**明确放弃并把 `/v1` 定位为"纯模型网关"**，同时让带 `tools` 的请求返回显式错误而不是静默忽略（`400 tools_unsupported`）。
   —— **静默忽略是当前最差选项**：调用方以为工具生效，实际退化为文本。
2. **IM 链路（I-4/I-5）二选一**：承认"los 只做模型 + 执行面，IM 交给 DSH 渠道"（则应清掉 `WECLAW_API_ADDR` 与 wechat-bot 的 webhook 发送职责，并在文档写明），或补一条官方的 los→渠道路径。

---

## 6. 本轮已落地 vs 待办

已落地（本轮提交）：集群版本身份收敛（prune/mode/AppleDouble/哈希输入，8 台 → 1 个版本）、`deploy-to-remote.sh` 增 `promote` 与 `LOS_SSH_OPTS`、`fleet-host-check.mts --maint-set` 静默写坏行修复 + policy 层 nodeId 护栏、本 runbook 的 Windows/macOS/promote/内容校验补章、governance paused 语义区分（见同日另一份记录）。

待办即 §3 的 P0-1…P0-6、P1-1…P1-10、P2-1…P2-9；其中 P0 六项建议下一个迭代整体做掉。
