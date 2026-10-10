# los 全量盘点汇总（2026-10-08）

> 取证方式：**只读**。现场 = gateway/CLI 探针 + PostgreSQL 真库查询 + `.los-runtime/` 报告 + 源码/文档回读。
> 快照时间：**2026-10-08 12:24 CST**；`main = eae54786ab4c`（origin/forgejo 一致），工作副本 16 条未交付改动（algorithmic-hotpath / shaders-pattern / turbo-env 三条并行线，与本盘点无关）。
> 口径纪律：**代码实现 = 运行时行为**；ADR = 设计意图；`.los-runtime` 报告取结论/verdict 行。凡本文件未标证据的行，均来自当场命令输出。

---

## 0. 摘要（先读这 8 条）

1. **los 今天没坏**：gateway :8080 healthy、8/8 executor online、18 个 governance job 全 active 且 circuit 全 closed、0 待审批。
2. **但有 4 笔必须收口的账**：① 本机 `mbp-executor-1` 版本漂移（≥12h）+ 27 个 ssh_target 幽灵节点 + `grok-cloud-executor-1` 离线无再入册路径；② 14 条未确认死信 + `scheduled_execution` 的 self-check 把已完成 run 记 failed（近 7 天 27 failed / 781 no_op）；③ **`performance_audit` 查错列名 ⇒ provider 性能观测自 2026-10-03 起静默报空**；④ **provider 配置只写内存不落盘（重启即丢）** + 模型清单/compat 证据面停更（最后一条 compat evidence = 2026-07-19）。
3. **真实使用分布窄**：近 30 天只有 3 个执行位置有活（`mbp-executor-1` 221、in-process `gateway-local` 176、`node34-executor-1` 87），**8 台在线 executor 里 6 台零任务**（m3pro / desktop-r45553o / desktop-srsbe20 / oracle / tencent-sin / vultr）。
4. **los 今天的真实身份 = 「DSH 的模型网关」+「项目级执行与证据面」**，不是日常编码入口。ADR 0038 规划的 Web-first 日常编码路径**尚未成为日常入口**（30 天 1022 个 task_run 零代码改造类，首个 E3「los 出代码改动」案例是 2026-10-06）。
5. **架构不需要推翻内核，需要三件事**：修订 ADR 0038；给 0039/0043 做状态回填与编号清理；对 **0042/0044/0045/0046 四个长期 Proposed** 给出「排期 / Deferred / Rejected」的明确处置。
6. **ADR 0044（ACP）与 gap analysis G14 直接矛盾**（G14 明写 ACP 是 rejected/intentional、los-mcp 是唯一程序化接口）——必须二选一。
7. **自动更新能力极不对称**：只有 `kimi` 与 `xai` 的**凭证**支持自动刷新；**模型清单全仓无自动化**；ADR 0045 的 provider/tool 热重载**未实现**（G10 仍 open）；渠道无自更新（G11 deliberate-manual）；provider 升降级**禁止自动**（决策先落 `proposed`，须 operator enforce）。
8. **kimi 与 packycode 的答案**：kimi = 订阅型 provider（不是 IM 渠道），**凭证自动更新 ✅ / 模型清单自动更新 ❌**；packycode = 第三方 OpenAI 兼容中转，**不支持任何自动更新**（无 OAuth resolver、无专属 env key、端点与模型别名全手工）。

---

## 1. 项目现状：体量与身份

| 维度 | 数值 | 证据 |
| --- | --- | --- |
| 包 | 12 个 | `packages/` |
| src 规模 | **1007 文件 / 195,395 行** | `find packages/*/src -name '*.ts'` |
| 最大包 | `agent` 583 文件 / 119,941 行；`gateway` 187 / 36,008；`web` 41 / 7,964；`memory` 39 / 7,752；`cli` 37 / 7,321 | 逐包统计 |
| 数据库 | 72 张表；61 个迁移 | `\dt`；`packages/infra/migrations/*.sql` |
| 契约 | 41 个 | `contracts/` |
| 文档 | 250 篇 md；ADR 0001–0046 | `docs/` |
| 工具脚本 | 99 | `tools/` |
| 身份 | identity 两级（`default` = 「los / Agent Execution Platform Operator」、`child` = los-child），四层解析 project→user→system→builtin，级别 `none\|minimal\|standard\|full` | `.los/identity/`；`identity-loader.ts:255-300` |
| 场景角色 | `planner \| worker \| reviewer` | `scenario-economics-types.ts:3` |

**版本身份（今天的第一个坑）**：
- gateway :8080 = `0.1.0+b59bdf4e9c9b9`（pid 25370）= **当前工作树版本**
- 7 台执行器 = `0.1.0+bca2863af4194`（fleet 声明的 target）
- **`mbp-executor-1`（本机主执行器 + 同时是控制面节点）= `0.1.0+b59bdf4e9c9b9`，落后于自己的 `target_version`**
- 方向提示：**本机工作树比 fleet 目标旧一天**，不要按本地版本"收敛"集群；正确动作是 `bash tools/los-fleet-rollout.sh --node mbp-executor-1`。
- 证据：`.los-runtime/fleet/fleet-versions.json`（`capturedAt=2026-10-07T22:23:36Z`，mbp health==registry==b59bdf4e 而 targetVersion==bca2863a）；连续 3 份 6h 报告（10-07T10/16/22）均 `Overall verdict: drift`。

---

## 2. 节点状态盘点

### 2.1 executor_nodes（36 行）

| 分类 | 数量 | 状态 |
| --- | --- | --- |
| `node_kind='executor'` online | **8** | mbp / m3pro / desktop-r45553o / desktop-srsbe20 / node34 / oracle / tencent-sin / vultr |
| `node_kind='executor'` offline | 1 | `grok-cloud-executor-1`（心跳停在 2026-09-29 02:47，`verified_json` 无 TTL，无再入册路径） |
| `node_kind='ssh_target'` | **27** | **全部 offline 且心跳集体停在 2026-08-19 22:28:45** ⇒ 是"从未探测"而非"探测通过" |

在线节点 connect_modes 统一为 `["agent_http","agent_http_ndjson"]`；queue_depth 与 active_task_count 全 0。

**陈旧/幽灵行**：27 个 ssh_target（hh-sgp1-*、vultr-*、oracle-*、localnode34-*、nas-*、tencent-sh-r、100-90-170-58、glkvm、win-los）+ 1 个离线 grok-cloud。

### 2.2 近 30 天真实负载分布（本轮 DB 定案，回答 open 的 P1-1）

| 执行位置 | runs | succeeded | blocked | failed | 末次 |
| --- | --- | --- | --- | --- | --- |
| `mbp-executor-1` | 221 | 154 | 53 | 14 | 2026-10-08 |
| `gateway-local`（**in-process，不在 registry**） | 176 | 142 | 26 | 8 | 2026-10-08 |
| `node34-executor-1` | 87 | 62 | 8 | 17 | 2026-10-08 |
| 其余 6 台在线 executor | **0** | — | — | — | — |

⇒ **P1-1「6/8 节点零负载」确认成立且未改善**；同时暴露一个此前未登记的事实：`gateway-local` 是**进程内执行**的伪 node_id（`executor_nodes` 里 0 行），它承担了 36% 的负载 ⇒ "集群执行"实际上仍是本机为主。

### 2.3 service_instances（3 行，2 行陈旧）

| service_id | status | version | 备注 |
| --- | --- | --- | --- |
| `gateway-echers-mbp-local-8080` | online | `0.1.0+b59bdf4e9c9b9` | 当前主网关 |
| `gateway-echers-mbp-local-18080` | offline | `0.1.0` | 2026-07-12 停 |
| `gateway-echers-mbp-local-8081` | offline | — | standby / `phase3-gateway-b`，2026-07-19 停 |

---

## 3. 服务状态盘点

| 服务 | 进程 | 健康 | 版本 | 端口归属 |
| --- | --- | --- | --- | --- |
| gateway | running pid 25370，managed | ok | `0.1.0+b59bdf4e9c9b9` | 8080 owned_by_pid=25370 |
| executor | running pid 24986，managed | ok | `0.1.0+b59bdf4e9c9b9` | 8090 owned_by_pid=24986 |
| wechat channel | **stopped** | unavailable | mode=disabled | — |
| telegram channel | **stopped** | unavailable | mode=disabled | — |
| WeClaw（`WECLAW_API_ADDR=127.0.0.1:18011`） | **无监听** | — | — | **残留配置，会误导排障** |
| PostgreSQL | 本机 homebrew @ 127.0.0.1:55432 | 正常 | — | docker los-postgres 已于 2026-08-05 退役（有 dump 存档） |

网络出口：全部 HTTPS 经本机 Surge 代理 `127.0.0.1:6152`（api.x.ai 直连不可达）；国内 provider 直连。

**日志实证**：
- `gateway.log` 02:45–03:01 一批 `Connection terminated due to connection timeout`（feed-analysis 回调 / execution outbox / orphan reaper / lease reaper / scheduled-work tick / service heartbeat 全线）⇒ **Postgres 中断事故**，与 10-07 closeout 的 `a377f9a0` 修复对应，进程未崩（修复生效）。
- `gateway.log:3032` `[04:06:31] WARN [governance-jobs] Performance: provider_call_telemetry query failed: column "latency_ms" does not exist` ⇒ **本节 §5.3 的根因证据**。
- `executor.log` 有 `Agent hit maxLoops (20)` 与 `provider fallback configured: provider=undefined chain=(none)`；file-sync 扫描每轮 48,664 文件 / 115–547s（单轮最慢 547s ≈ 9 分钟）。

---

## 4. 治理面状态盘点

`bash tools/los-governance-daily.sh` 汇总：

```
治理异常=0 待审批=0 死信=14 治理todo=0 fleet漂移=1(todo 1) 网络=attention surge=attention 桥接=ok(0h)
```

### 4.1 governance_jobs（21 行：18 active + 2 retired + 1 active?）

- **18 个 active，circuit 全 closed，consecutive_failures 全 0**。cadence 覆盖 hourly（branch_cleanup）/ daily（adversarial_review、event_retention、file_size、hotspot、memory_integrity、memory_retention、migration_drift_fix、reflection、self_bootstrap、static_analysis）/ weekly（architecture_drift、code_topology_audit、dead_letter、language_audit、performance_audit、related_project_scan、supply_chain_audit）/ monthly（consistency_audit）。
- 2 条 retired 的 dead_letter 历史行（consecutive_no_ops=6）。
- `consistency_audit` consecutive_no_ops=1（其余 0）。

### 4.2 死信（dead_letter_events：146 acked / **14 unacked**）

| reason | 数量 | 时间窗 | 错误 |
| --- | --- | --- | --- |
| `unrecoverable_error` | 13 | 10-07 07:37–08:26（12 条）+ 10-08 07:50（1 条） | `Invalid planning output: submit_run_contract was not accepted` |
| `lease_expired` | 1 | 10-08 07:43 | （空） |

⇒ `submit_run_contract` 未被接受是**唯一高频死信源**，且集中在 10-07 早晨的一次任务风暴里。

### 4.3 定时任务（scheduled_work_items：8 enabled / 2 paused / 7 retired）

| 任务 | 触发 | circuit | 备注 |
| --- | --- | --- | --- |
| surge log error analysis (6h) v4 | interval 6h | **open，failures=3** | `next_run_at` 已过期（10-08 09:40）——日报把它列在"启用任务"表但**未计入第 1 节异常**（口径缺口） |
| dogfood runtime readiness check | 15m | closed | 大量 no_op |
| observability: gateway/executor log freshness (V3) | 30m | closed | — |
| NAS34 drift check | 6h | closed | failures=1 |
| fleet consistency check (6h) | 6h | closed | — |
| fleet host check (remotes) | 6h | closed | — |
| daily execution digest (feishu) | cron 30 8 * * * | closed | **渠道全 disabled 却仍 enabled** |
| network-observe daily trend analysis v5 | cron 30 10 * * * | closed | — |
| E3 promote must validate node version | — | paused | 2026-10-06 |
| Rust tool repos: snapshot governance read | manual-only | paused | next=2099 |

**近 7 天 run 台账**：succeeded 113 / failed 27 / **no_op 781**（约 85% 空转）。
**failed 的 27 条里 14 条是 `Goal self-check failed`**，形态集中：
- `[self_check_parse] invalid self-check contract: response is not a JSON object`
- `[Staleness gate] Agent determined current time by creating .now-probe.tmp…`（要求用真 ISO 时间戳）
- `[Goal requirement (N): write JSON results to <path>]` transcript 里无写入该路径的 run_shell/write_file 具体证据
- `[self_check_parse]`、`Confidence gate`、`failed -> cancelled (terminal_state)`

⇒ **self-check 契约在把已完成的 run 记 failed**，与 10-07 closeout 沉淀的"run 失败 ≠ 产物无用"是同一笔账，但**没有 owner、没有 todo**。

### 4.4 run_specs 生命周期（本轮 DB 定案，回答 open 的 P2-3）

| status | 总数 | 近 30 天 | 说明 |
| --- | --- | --- | --- |
| succeeded | 392 | 153 | — |
| **created** | **150** | **20** | **非终止态，跨 2026-06-16 → 2026-10-08，永不收敛** |
| blocked | 59 | 45 | — |
| failed | 16 | 14 | — |
| cancelled | 15 | — | — |

- **非终止态占比 = (150+59)/615 = 34.0%**（文档记 36%，同量级，确认成立）。
- `created` 的 150 条里 **21 条是 gate-probe/revision 形态**；**近 30 天新增的 20 条里 14 条（70%）是 gate-probe/revision**（prompt 形如 `Gate FAILED for <tool>. This run exists so a revision can be…`、`Gate probe for <tool>. Required checks: …`）。
- 全部 150 条 `run_contract_json->>'status'` 为空、无 plan 标记 ⇒ **是修订期产生的僵尸 spec，不是待审批的计划**。
- 对照组：`task_runs` 近 30 天 only 3 个终态（succeeded 358 / blocked 87 / failed 39），**无 created** ⇒ 僵尸只存在于 run_specs 一侧，是 `run_specs` 状态机在 revision 路径上缺少终态收敛。

---

## 5. 近期发现的问题

### 5.1 已修复（有提交号或可复现证据）

| # | 问题 | 状态 | 证据 |
| --- | --- | --- | --- |
| A1 | 维护窗口不阻断调度（只抑制告警） | ✅ P0-1 | `8ea266a5`；`scheduler/executor-client.ts:87-119` |
| A2 | drain 后无自动 promote | ✅ P0-2 | `1d930fc6`；`tools/deploy-to-remote.sh:829-831` |
| A3 | promote 不校验版本 | ✅ P0-3 | `node-commands.ts:152,284`；`node-commands.test.ts:73-125`（10 例） |
| A4 | 部署零内容校验 | ✅ P0-4 | `deploy-to-remote.sh:852-879`（build-version 摘要比对，MISMATCH 即失败） |
| A5 | `resourceClass` 死代码 | ✅ P0-5 | `ff65a325`；`executor-nodes.ts:486` |
| A6 | `target_version` 无消费点 | ✅ P0-6 | `8855fc9a`；`los-governance-daily.sh:209-253` 自动出 todo + 自动关闭 |
| A7 | sync 不校验远端收敛（半截树致崩溃） | ✅ P0-7 | `050a5f5a`；`deploy-to-remote.sh:324-362`（sha256 不符绝不解包） |
| A8 | 对抗审查升权面（chat mcpServers / MCP registry / provider CRUD / todo dispatch / node cmd / file-sync / project） | ✅ P0-01…P1-08 | `2026-08-13-adversarial-remediation-dag.md:12-19`；代码复核对上 |
| A9 | `spawn_agent` 让只读父代理升到 project-write | ✅ | `tools/core/registry-policy.ts:143` |
| A10 | session 事件脱敏只认 key 名 | ✅ 大部分 | `event-redaction.ts` 全量重写（值模式 + JWT + 深度/大小上限 + fail-closed）；残留见 B5 |
| A11 | GitHub main 连续 9 次 123 个"新失败"（turbo globalEnv 收窄） | ✅ | `globalPassThroughEnv` + `tools/check-turbo-env-passthrough.mjs`（本轮工作副本新增） |
| A12 | Forgejo 全部 job 因 runner podman store 缺镜像失败近一月 | ✅ workaround | `docs/operations/2026-10-05-forgejo-runner-ci-image-restore.md` |
| A13 | Postgres `57P01` 致网关 + 6 执行器同时崩且 systemd 放弃 | ✅ | `a377f9a0`；本轮 gateway.log 02:45–03:01 实证"进程存活 + 自动重连" |
| A14 | 全集群 4 版本摘要不收敛 / 滚动无锁无计划 | ✅ | `08ac9035` 编排器 `tools/los-fleet-rollout.sh`；`2bc4400d` 可移植盖章 |

### 5.2 未修复 / 部分修复（按严重度）

| # | 问题 | 严重度 | 状态与证据 |
| --- | --- | --- | --- |
| **B1** | **`performance_audit` 查错列名 ⇒ provider 性能观测自 2026-10-03 起静默报空**（`provider_call_telemetry` 无 `latency_ms`/`cost`/`is_error`/`prompt_tokens`/`completion_tokens` 五列；真实列 = `duration_ms`/`usage_json`/`status`）。错误被 catch 吞成一行 WARN，结果 providerStats/slowProviders/errorProneProviders 全 0、totalProviderCalls=0。**同类正确写法**：`metrics-trends.ts:150-155`、`usage-summary.ts:236-241` | **P1（观测门禁静默失效）** | `governance-auditors-performance.ts:36-40`（错）vs `:59-61`（吞错）；`gateway.log:3032`。**本轮新发现，未登记在任何文档** |
| **B2** | **provider 配置只写内存不落盘**：`POST/PATCH/DELETE /providers`、`PATCH /settings`、`models/sync applyModel` 全部只调 `setConfig()`（`config.ts:375-377` = `_config = config`）⇒ **改了就生效是假象，重启即丢**，多进程不一致 | **P1** | `provider-crud-routes.ts:112,132,144`、`settings-routes.ts:121`、`provider-model-sync-routes.ts:131`。**本轮新发现** |
| **B3** | **compat 证据面停更 80 天**：`provider_compat_evidence` 26 行，最后一条 2026-07-19，全部 `verified_advisory`；`provider_promotion_decisions` **0 行** ⇒ ADR 0017 的晋升阶梯事实上停摆，`required` 只剩 `deepseek:deepseek-v4-flash` | **P1** | DB 查询。**本轮新发现** |
| **B4** | `run_specs` 僵尸：150 条 `created` 永不收敛（34% 非终止态），近 30 天新增的 20 条里 14 条来自 gate-probe/revision 路径 | **P1** | §4.4。文档 P2-3 只记了现象，**未定位到 revision 路径是源头** |
| **B5** | 脱敏残留：以密钥命名的 key 存放**数组**原始值时父 key 丢失 ⇒ 不脱敏 | P1 | `event-redaction.ts:109-112`（递归时 `key` 传 `null`） |
| **B6** | visibility 分类未在全部读端生效：store 默认 `includeInternal !== false`；仅 HTTP 读端收口 | P1 | `session-events.ts:372,419,450`；`session-routes.ts:102`；SSE/WS/trace 读端未复核 |
| **B7** | operator 门禁不完整：`memory-routes.ts` 用内联 `isOperator`；`skill-routes.ts`/`rule-routes.ts`/`service-routes.ts`/`usage-routes.ts` **operator 引用为 0** | P1 | DAG `P1-09 待做` |
| **B8** | 调度 run 终态无 fence / `blocked` 不清 lease / chat-persist 与 run-resume 的 AP12 回写缺失 | P1 | DAG `P1-10…P1-13 待做` |
| **B9** | query token 接受 `?operator_token`/`?access_token` + `===` 比较；非 loopback 未禁止关 auth 启动（`auth.enabled` 默认 false） | P1 | DAG `P1-15/P1-16`；`config.ts:62` |
| **B10** | 探针/主机检查覆盖与新鲜度：`last_probe_at` 全部停在 2026-09-27；`fleet_host_check_state` 仅 5/9 | P1 | 本轮 DB 复核：27 个 ssh_target 心跳停在 **2026-08-19**，比文档记的更早 |
| **B11** | `grok-cloud-executor-1` 离线无再入册路径，`verified_json` 无 TTL | P1 | 心跳 2026-09-29；DB |
| **B12** | 三个原语仍缺：幂等键、工具级决策三态审计（allowed/refused/failed）、租约过期的收敛路径（`lease_expired` 的 `requeueEligible=0`，因为候选要求 `run_spec_id` 非空） | P1 | 本轮死信里就有 1 条 `lease_expired` |
| **B13** | feed-analysis 回调死信 18/87，无告警/SLO 面 | P1 | 架构文档 I-7 |
| **B14** | 节点命令语义不对等（`promote`/`drain` 只改 registry；`restart`/`upgrade`/`probe` 无 runner 直接 denied）；`contracts/node-command.yaml` 仍 `status: draft` | P1 | `contracts/node-command.yaml:3` |
| **B15** | DSH `job-440be80b` 每周验证 job 失败（`failed` 与 `exit=0` 并存，真因 feishu-push `.sent` 投递记账缺失） | P1（DSH 侧） | 10-07 closeout:86 |
| **B16** | SSRF：`isSafeUrl` 仅正则 hostname（缺 10./127./::ffff:），`redirect:'follow'` 跟随到内网 | P2 | `tools/external/web-tools.ts:417-419,141,254` |
| **B17** | `needsApproval` 只是元数据、broker 自动放行；`run_background`/`run_runtime_task` 是 L2 in-loop 工具 | P2 | DAG `P2-18 待做` |
| **B18** | wiring 豁免**在扩张**：`tools/wiring-topology-baseline.txt` = **396 行**（架构文档记 384），与"逐步收紧"反向 | P2 | 本轮复核 `wc -l` = 396 |
| **B19** | CI 观测机制建好即停摆：`.los-runtime/ci-metrics/runs.jsonl` 共 14 行，**末行停在 2026-08-17**（run 642 仍标 running） | P2 | 本轮复核 |
| **B20** | CLI `--help` 遗漏 4 个已 dispatch 的命令（`auth`/`memory`/`scan`/`cbm`） | P2 | `cli/src/index.ts:82,118,130,134` vs `help.ts` |
| **B21** | CLI 恒 `--help`；`/v1/chat/completions` 硬编码 `toolMode:'read-only'` + `persistMemory:false`，调用方无法提权（设计如此，但仍是产品限制） | P2 | `openai-compat-route.ts:209,217` |
| **B22** | `los mcp serve` 4 个工具（`los_run`/`los_run_state`/`los_run_replay`/`los_operator_control`）**零消费者** | P2 | 架构文档 I-3 |
| **B23** | los 自身 IM 能力为零（wechat disabled / telegram 未配置 / feishu 仅 `planned`）+ `WECLAW_API_ADDR` 残留 + 8080 无监听 | P2 | 本轮实测 |
| **B24** | los→DSH 事件 webhook 的唯一发送方在被停用的 wechat-bot | P2 | 架构文档 I-5 |
| **B25** | 11 个 DSH 调度 job 只有 2 个碰 los，且都绕过 los API 直连 DB | P2 | 架构文档 I-6 |
| **B26** | 节点命令契约 draft（见 B14）；DSH `/los-events` 接收端无鉴权 | P2 | 架构文档 I-9 |
| **B27** | `sandboxMode:'sandbox'` **只是 aspirational**，无真实 container/VM 隔离（ADR 0046 未落地） | P2 | `resolveSandboxBackend` 只是 OS 后端选择器（`shell-sandbox.ts:132`）|
| **B28** | 媒体能力无对外入口（`@los/media` 无路由/CLI，唯一消费者是 disabled 的 wechat-bot） | P2 | 架构文档 P2-1 |
| **B29** | 渠道全 disabled 但存在依赖渠道的 enabled 任务（feishu digest） | P2 | 本轮 DB 实证 |
| **B30** | E3「改代码」外部 runner 仍需人工跑三步 | P2 | 10-07 closeout:85 |
| **B31** | 非阻塞噪音：`bash: line 6: : No such file or directory`（sync 路径空变量）、Windows 无 stale-file 剪枝、macOS `could not copy systemd unit` | P2 | 10-07 closeout:82-84 |
| **B32** | 网络面两处活跃告警（见 §6） | P1（观测） | `.los-runtime/network-observe/` |

### 5.3 文档漂移（会误导"只读文档判状态"的流程）

| # | 漂移 | 证据 |
| --- | --- | --- |
| D1 | 10-06 架构缺口清单 P0 行未回填 ✅（只 P0-1/5/7 带标记），`:218` 仍写"待办即 P0-1…P0-6"，而 10-07 closeout 已宣告"P0 全清" | `2026-10-06-architecture-boundaries-and-gaps.md:114-119,218` vs `2026-10-07-session-closeout.md:32-40` |
| D2 | 架构文档代码行号已漂移 13–25 行（`:174` 引 `openai-compat-route.ts:60,74`／`:184,192`；实测 `/v1/models` 在 `:73`、`/v1/chat/completions` 在 `:87`、硬编码值在 `:209,217`） | 本轮复核 |
| D3 | ADR 0043/0044/0045/0046 仍带"编号冲突"提示（2026-08-26 已去重）；且架构文档 `:145` 说"0042–0046 都声称"，**0042 实测无该段** | `grep -c "Numbering conflict"`：0042=0，0043/0044/0045/0046=1 |
| D4 | P1-8「40 契约里 22 个零引用」与独立复核不一致（basename grep 得 **6/40**：coordinator-context-policy / coordinator-resume-guard / coordinator-resume-plan / integration-feed-analysis / provider-account-runtime / skill-mcp-distribution） | 方法不同，需重放原始判据 |
| D5 | gap G10 把 hot reload ADR 记作 "ADR 0033"，实为 **0045**（0033 现是 web-first work-item read model） | `2026-08-06-daily-use-gap-analysis.md:58,82` |
| D6 | 2026-06-21 架构基线仍列已移除的 `@los/input-preprocessor`（2026-07-05 移除） | `2026-06-21-project-context-baseline.md:34,37,72` |
| D7 | `scheduler/provider-selection.ts:30` 注释仍写 "(ADR 0031)"，应为 **0043** | 本轮复核 |

> **治理建议（本轮最重要的推论）**：D1–D7 组合意味着"只读文档判断状态"会系统性得出错误结论。建议把「文档状态段必须与 VCS 提交号绑定」落成一条治理规则（与 `AGENTS.md` 的 "Persisted evidence outranks UI state or agent summaries" 同源）。

---

## 6. 网络 / surge 观测（两套口径，别混用）

| 报告 | 最新 | verdict | 头号结论 |
| --- | --- | --- | --- |
| `network-observe/reports/` | 2026-10-08T02:03Z | **ATTENTION** | **Surge NETWORK-ERROR 34628/h**（此前 13 样本中位 147–189/h ⇒ ≈184×）；`localnode34-lan` avg 12.23×（+60ms）、`localnode34-tail` 11.95×、`vultr-tail` jitter 9.75×、`hh-r-public` 丢包 25%、`oracle-public` 12.5%；Wi-Fi 掉到 802.11n / 2GHz / ch1 / SNR 52dB（窗口最低）。判读指向**本地 Wi-Fi/代理路径**（`wan-1.1.1.1` 反而改善） |
| `surge-reports/` | 2026-10-07T18:03 | attention | **非速率驱动**：144.0/h = MEDIUM 的 9.6% 且系列在下降；唯一告警源 = 自建端点 **`219.139.213.119:5050` connection refused（POSIX:61），占 288/288 = 100%，自 10-07T04:01Z 起连续 ≈14h**（端口监听已死，主机可达）。代理路径失败全 0（airport 0 / DIRECT-leak 0 / AI 0） |

**判读纪律**：两份报告的 attention **不是同一件事**（前者是 34628/h 尖峰，后者是单端点长尾），且 surge 报告比 network 报告旧 8h。处置前先确认哪份描述当下。

**桥接**：`bridge: ok(0h)`，最新输入快照 2026-10-08T04:03Z。

---

## 7. 可用 agent 与能力面

### 7.1 agent 身份与角色

| 项 | 内容 | 证据 |
| --- | --- | --- |
| identity 层 | `.los/identity/default`（name=los / role=Agent Execution Platform Operator / style=direct, evidence-based, precise）、`.los/identity/child`（name=los-child） | `IDENTITY.md` |
| 解析 | 四层 project→user→system→builtin，逐层部分覆盖 | `identity-loader.ts:255-300` |
| 级别 | `none \| minimal \| standard \| full` | `identity-loader.ts:28` |
| 强制路径 | `resolveAgentIdentity()` + `formatIdentityForPrompt()`（AP9，禁硬编码 prompt 散文） | `loop/setup.ts:95-96`；`chat-memory-augment.ts:125` |
| 场景角色 | `planner \| worker \| reviewer` | `scenario-economics-types.ts:3` |
| agent_tasks | 31 行，全 succeeded | DB |

**执行内核**：`ExecutionKernelKind = 'los'`（**默认只暴露 LOS**，Pi 仅在 K4 授权路径可达）——`execution-kernel-registry.ts:23,46`。

### 7.2 skills（DB `skills` 表：35 条）

全部 `enabled=true`、`run_mode=manual`、`usage_count=0`、`updated_at=2026-10-06`。分布：general 34 + integration 1（`los-external-runtime-delegation`）。含 cloudflare 系 7 条、browser 系 5 条、sandbox 系 3 条、`kimi-webbridge` 系 3 条、`codebase-memory`、`opkg-operations`、`pr-self-merge`、`toolchain-governance`、`web-search-practices`、`xlsx` 等。
注意：**`usage_count` 全 0** ⇒ 登记了但没有消费证据；`.los/skills/` 目录下只有 1 个文件（`los-external-runtime-delegation.md`），与 DB 35 条不一致。

### 7.3 MCP（DB `mcp_servers`：1 条）

| server | transport | enabled | status | tools | source |
| --- | --- | --- | --- | --- | --- |
| `cantool.smoke.local` | stdio | **false** | connected | 61 | `app:/Applications/CanTool.app/2.0.0-alpha` |

- 61 个 capability 中 **7 个 data-classification=`local_private` 因 `data_grant_forwarding_unavailable` 判 `availability: blocked`**（clipboard.get/search、file.read_excerpt/recent/search、snippet.get/search），其余 54 available。
- tool_policy = `allow: [agent.resource.read, calculator.evaluate]`、`deny: []`、`riskLevel: L0`；envKeys 空、`inspected: true`。
- **问题**：`enabled=false` 却 `status=connected` ⇒ **能力申报与实际可用不一致**，需人工确认是遗留 smoke 行还是应启用。
- 另有一个测试行 `smoke-mcp-distribution-1784399789660`（指向 fixtures 的 echo server，路径还写着 `~/projects/...` 旧根）。

### 7.4 程序化入口

`los mcp serve` 暴露 4 个工具（`los_run` / `los_run_state` / `los_run_replay` / `los_operator_control`）——**零消费者**（B22）。CLI 入口 `bin/los`；`/v1` 两个端点。

---

## 8. 服务商 / 渠道状态与自动更新清单

### 8.1 五个 provider 真相面

| # | 面 | 文件 | 作用 |
| --- | --- | --- | --- |
| 1 | canonical defaults | `packages/infra/src/provider-defaults.ts:8-35` | baseUrl / defaultModel / apiKeyEnv / checkUrl（**23 条**） |
| 2 | model profile | `packages/agent/src/model-profiles.ts:210-385` | 协议、apiShape、tool/cache/vision/session 能力、pricing、retry |
| 3 | discovery | `discovery.ts:81-140` + `discovery/scanners.ts` + `discovery/provider-parsers.ts` | 从本机工具/账号/环境变量发现 provider 与凭证（**只在 `loadConfig()` 跑一次**，`config.ts:337`） |
| 4 | gateway core set 与路由 | `gateway/src/server.ts:540-546` + `routes/providers/*` | `selectAgentModelProviders()` + `/providers/*` |
| 5 | 契约 | `contracts/provider-account-runtime.yaml`、`provider-compat-evidence.yaml`、`run-spec.yaml` | account / model sync / compat evidence / promotion |

> `packages/` 下**没有**独立 `provider-*` 包；适配器在 `@los/agent/src/providers/`（index/anthropic/responses/registry/delta-repair/provider-health/provider-probe/provider-fallback/provider-policy/provider-probe-circuit），发现与配置在 `@los/infra`。`pi-*` 是**执行内核**（ADR 0039），不是 provider 注册表。

### 8.2 接入清单（`/v1/models` 实测 12 个 + canonical defaults 23 条）

| provider | 类型 | 注册位置 | 成熟度 | 凭证自动更新 | 模型清单自动更新 |
| --- | --- | --- | --- | --- | --- |
| `deepseek` | OpenAI 兼容云 | defaults:9 / profiles:211 / `DEEPSEEK_API_KEY` | **required**（唯一 merge gate：`deepseek-v4-flash`） | ❌ | ❌ |
| `deepseek-anthropic` | Anthropic 协议（deepseek 中转） | defaults:21 / profiles:345 | advisory | ❌ | ❌ |
| `deepseek-v4-pro` | compat 目标 | compat targets | **verified advisory**（有 live 通过、未晋升） | ❌ | ❌ |
| `kimi` | **订阅 OAuth**（Kimi Code CLI） | defaults:10 / profiles:238 / `scanners.ts:498-529` / `auth/kimi-code.ts` | advisory（**不在任何 compat target**） | **✅** | ❌ |
| `moonshot` | OpenAI 兼容云 | defaults:26 / profiles:335 | advisory（仅登记） | ❌ | ❌ |
| `minimax` | Anthropic 协议 | defaults:22 / profiles:346；core set | advisory；日报 watch 内 | ❌ | ❌ |
| `zhipu` / `qwen` | OpenAI 兼容云 | defaults:27-28 / profiles:336-337 | advisory（仅登记） | ❌ | ❌ |
| `openai` | OpenAI 官方 | defaults:11 / profiles:263 | advisory | ❌ | ❌ |
| `codex` | OpenAI Codex 路由（`~/.codex/auth.json`） | defaults:18 / profiles:312 / `scanners.ts:32-95` | advisory | ⚠️ 静态导入、代码自注 `may expire`、**无刷新** | ❌ |
| `packycode` | **第三方 OpenAI 兼容中转** | defaults:17 / profiles:281 / `provider-parsers.ts:25-32` | advisory（core set，无 compat target） | **❌ 全手工** | ❌ |
| `anthropic` / `claude` | Anthropic 官方 | defaults:19-20 / profiles:343-344 | `anthropic` blocked→advisory；`claude` 被明确排除 | ❌ | ❌ |
| `xai` | OAuth 订阅（los store / Grok CLI） | defaults:29 / profiles:347 / `auth/xai-oauth.ts:318,322` | advisory；**account `xai` active** | **✅** | ❌ |
| `groq` / `together` / `openrouter` | OpenAI 兼容云 | defaults:23-25 / profiles:332-334 | advisory（canonical 模板） | ❌ | ❌ |
| `opencode-zen` / `nvidia-nim` / `lmstudio-win` | 显式注册（`~/.los/config.yaml`） | config.yaml `providers:` | advisory；免费兜底链成员 | ❌ | ❌ |
| `ollama`/`lmstudio`/`vllm`/`llamacpp`/`localai` | 本地端点 | defaults:30-34 | advisory；**探测默认 OFF**（需 `LOS_ENABLE_LOCAL_ENDPOINT_PROBE=1`） | ❌ | ❌ |
| `custom` | 只出现在治理检查清单的占位名 | `governance-adversarial-review.ts:118` | **未注册**（无 defaults/profile） | ❌ | ❌ |

**运行时证据**：
- `/v1/models` 实测：custom, deepseek, deepseek-anthropic, kimi, lmstudio-win, minimax, nvidia-nim, openai, opencode-zen, openrouter, **packycode**, xai（全部 `owned_by: los`）。
- `provider_accounts` **只有 1 行**：`xai` / `external_ref` / "Grok CLI login" / active / 2026-08-07 verified。**kimi 与 packycode 都没有 account 行**。
- `providerFallbacks`（`~/.los/config.yaml`）：kimi→deepseek→xai→minimax→opencode-zen；xai→deepseek→minimax→packycode→opencode-zen；packycode→deepseek→minimax→opencode-zen；minimax→deepseek→packycode→opencode-zen；deepseek→opencode-zen→openrouter（注释明确 nvidia-nim 不挂 los 链，因为经 Surge 代理会 2 分钟超时）。

### 8.3 渠道清单

| 渠道 | 形态 | 状态 | 自更新 |
| --- | --- | --- | --- |
| `wechat-bot` | WeClaw 外部二进制出站 + WxPusher 回调入站 + Web 移动面板 | **disabled / stopped**（.env 起停用；iLink ret=-2 长期故障） | ❌（仅发送重试退避） |
| `telegram-bot` | webhook/polling 入站 + inline keyboard | **disabled / stopped** | ❌（启动时 `setWebhook` 属"重启才刷新"） |
| DSH `dsh-channel-wechat` | DSH 侧插件 | **已彻底卸载**（2026-10-06，源码归档在 `~/.dsh/backups/wechat-uninstall-20261006-134701/`） | — |
| DSH `dsh-channel-telegram` | DSH 侧插件 | web profile 有依赖但**未挂载**（注释掉） | — |
| feishu | los 侧仅 `status:'planned'` | 未实现 | — |

### 8.4 自动更新能力逐项结论

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 模型清单自动拉取/刷新 | **❌ 不支持**。`GET /v1/models` 不是上游代理，只是"已发现 + 已配置 provider 名单"；`GET /providers/models` 同理；唯一入口 `POST /providers/:name/models/sync`（operator 鉴权、**除路由与测试零调用方**、无 UI/CLI/job）；`applyModel` 只改内存；无 models.json 缓存；`modelAliases` 全硬编码（packycode 手写 10 个）；18 类 governance job **无** provider/model 同步类 | `openai-compat-route.ts:69-85`、`provider-model-sync-routes.ts`、`config.ts:375-377`、`model-profiles.ts:293-304`、`governance-jobs-schema.ts:144-292` |
| provider/tool 热重载（ADR 0045） | **❌ 未实现**（Proposed）。全仓无 `fs.watch`/`chokidar`/`providerConfigVersion`/`toolRegistryVersion`；`~/.los/providers/` 不存在；且 configure-surface 设计把它明确列为 Non-Goals | ADR 0045:9；`2026-08-06-daily-use-gap-analysis.md:58`（G10 open）；`2026-08-08-configure-surface-p0-p1-design.md:95` |
| 凭证轮换/自动刷新 | **⚠️ 部分**：仅 `kimi`（per-request、≤60s 续期、single-flight、写回 CLI 凭证文件）与 `xai`（异步 + generation 栅栏 + 跨进程文件锁）自动；其余全部静态 apiKey（含 packycode）；`codex` 的 ChatGPT token 无刷新 | `auth/kimi-code.ts:105-175,191-240`、`auth/xai-oauth.ts:318,322`、ADR 0030:265-279、`providers/registry.ts:16-24` |
| provider 自动升降级 | **❌ 禁止自动**：决策先落 `proposed`，须 operator `enforce`；无自动降级/退役（只靠日报与对抗审查发现） | `provider-promotion-decisions.ts:83,181-190`、ADR 0017:80-96 |
| health-aware 自动熔断/恢复 | **✅ 检测与选路自动，配置变更不自动**：60s/300s 探测、三信号 health score（RTT 40% + 成功率 40% + 可用性 20%）、5s→5min 熔断闩锁（5 连败闩锁 / 5min 半开）、`provider.health_changed` 事件、fallback 跳过 unhealthy、多候选按 health 排序（0.05 内按成本破平）；自动熔断=**仅停止探测，不改 `enabled`**（operator 所有） | `provider-health.ts:111-177`、`provider-probe.ts:37-40,361-380`、`provider-probe-circuit.ts`、`provider-policy.ts:122-152`、`loop/setup.ts:387` |
| 渠道自更新 | **❌ 无**（G11 deliberate-manual）；唯一"自愈"是 wrapper 30s 健康重启，不是版本更新 | `2026-08-16-deployment-convergence.md:44-52` |

### 8.5 kimi / packycode 专项结论

**kimi**
- **是订阅型 provider，不是 IM 渠道**（本仓无 kimi channel 包）。`baseUrl=https://api.kimi.com/coding/v1`，`defaultModel=kimi-k3`，`authMode=oauth`，凭证 `~/.kimi-code/credentials/kimi-code.json`。
- **凭证自动更新：✅ 支持。** `refreshKimiCodeAccessToken()` 走 `https://auth.kimi.com/api/oauth/token`（`grant_type=refresh_token`）；`resolveKimiCodeCredential()` 每请求解析、距到期 ≤60s 自动换新、single-flight 去重、best-effort 写回。
- **模型清单自动更新：❌ 不支持。** `kimi-k3` 是硬编码 default + `modelAliases: ['kimi-k3']`。
- 成熟度 **advisory**，**不在** compat target 列表（无 compat 证据、非 merge gate）。
- 已知假象：有 refresh_token 但 access_token 已过期时 discovery 仍报 ready（2026-08-06 案件，已固化为对抗审查项）。恢复路径是在真实终端跑 `kimi -p "hi"` 自动刷新。
- 近 7 天用量：11 次 / 0 错 / avg 10.6s / 末次 2026-10-05 —— 基本闲置。
- 历史注记：`~/.los/config.yaml` 注释写 "kimi is currently out of monthly quota"，故请求命名 kimi 会降级到 deepseek 链。

**packycode**
- **是第三方 OpenAI 兼容 API 中转，不是渠道。** 当前端点 `https://www.packyapi.ai/v1`（legacy `www.packyapi.com` 被注释为"poisoned 解析 + 403 前置"不可用；cc-switch `grokbuild` 走 `slb-v1.api.fan/v1` + `apiShape=responses`）。识别靠 URL 家族（`packyapi` / `api.fan` / 名字含 packy）。
- **不支持任何自动更新。**
  - **凭证**：无 OAuth resolver；`providers/registry.ts:16-24` 只为 `xai`/`kimi` 注册 credentialResolver；来源是 ① `~/.codex/auth.json` + `config.toml` ② cc-switch 行（`cc-switch/codex/PackyCode`、`cc-switch/grokbuild/PackyCode`）③ 手写 `~/.los/accounts/*.json` 或 `config.providers.packycode.apiKey`。**无专属 env key**（`provider-defaults.ts:17` 只有 baseUrl/defaultModel；`flattenEnv` 把 `OPENAI_API_KEY` 映射到 `openai`）。
  - **模型清单**：`modelAliases` 手写 10 个（`gpt-5.5/5.4/5.4-mini/5.6-sol/5.6-luna/5.6-terra/grok-4.6/4.5/4.3/4-fast`）。
  - **改配置只写内存**（B2），重启即丢。
- 能力面是保守手调：`supportsParallelToolCalls: false`、`supportsToolStreaming: false`、`cachePolicy: 'none'`（为规避 streaming split-call bug）。
- 成熟度 advisory，无 compat evidence、无 promotion decision、非 merge gate。
- 运维实证：2026-08-10 记录其 cc-switch 端点漂移到 `slb-v1.api.fan` + responses（需人工确认并覆盖默认）。

---

## 9. los 当前适用场景

### 9.1 定位（文档收敛后的一句话）

> **los 是这台机器（及其小集群）的项目级执行与证据面**：所有"我需要证明这件事真的跑过 / 真的通过了"的场景走 los；"顺手的日常编码对话"仍可走 DSH/Codex/Claude，但**一旦结论依赖执行、节点、provider 门禁或治理节奏，就必须落进 los 的账本**。
> —— `docs/architecture/2026-10-06-architecture-boundaries-and-gaps.md:191-195`

### 9.2 三层执行面（这是今天最实用的心智模型）

| 层 | 形态 | 特征 |
| --- | --- | --- |
| **E1 转发** | `POST /v1/chat/completions` 带 `tools` 直转 provider | 调用方持工具，**无 los 账本** |
| **E2 los agent loop** | 不带 `tools` 或 `los chat` | 有 `task_runs`/`session_events` 证据 |
| **E3 受治理执行** | Work Item → run_spec（须 `plan_approved`）→ task_runs → executor → verification record | 可恢复、可审计 |

### 9.3 今天真正能干什么（有证据）

| 场景 | 层 | 证据 |
| --- | --- | --- |
| DSH / 任意 OpenAI 兼容客户端的**模型网关** | E1 | DSH 经 `127.0.0.1:8080/v1` 调用；tools 转发已并回主线 |
| 定时治理巡检（job 异常/死信/待审批/todo/fleet 漂移） | E3 | 每日 08:30；`tools/los-governance-daily.sh` |
| 网络/surge 观测判读（"沙箱外采集 → 沙箱内判读"两段式） | E3 | `.los-runtime/network-observe/reports/`、`surge-reports/` |
| fleet 版本一致性 6h 判读（带 STALENESS GATE） | E3 | `schedule-fleet-consistency-001`；`.los-runtime/fleet-reports/*.md` |
| feed/情报分析回调（lot2extension → los → 回调） | E3 | 22 dispatches / 87 deliveries（但有 18 条回调死信） |
| 多节点执行台 + 滚动发布 | E3 | `tools/los-fleet-rollout.sh`（reconcile/canary/fail-fast/锁/报告） |
| **产出代码改动**（los 出改动 + 证据，外部 runner 验收） | E3 | `docs/governance/2026-10-06-job-template-los-code-change.md`；首例 857/857 |
| 远程节点巡检/诊断、Windows 专用任务、跨节点构建 | E2/E3 | 能力就位但**零使用** |
| MCP stdio 客户端接 4 工具 | — | `los mcp serve`，**零消费者** |

### 9.4 成文非目标（不要越过）

1. 不替代 Codex/Claude/OpenCode/OMX/browser，只做**项目自有的执行与证据面**。
2. 不存原始外部 transcript / auth snapshot / cookie / API key / provider 账号 dump；外部 runtime 只留 ≤2000 字符脱敏摘要。
3. 不在 run spec / 状态迁移 / verification 稳定前上完整 workflow 引擎。
4. `sandboxMode:'sandbox'` **只是 aspirational**，无真实 container/VM 隔离。
5. 不支持长驻交互命令（stdin ≤64KB、无 REPL）；Windows 无 `bash`。
6. provider 账号选择与 provider-loop 替换 out of scope（ADR 0030）。
7. 单租户默认（`tenant_id='local'`）。
8. **不属于 los**：浏览器自动化/采集（ZMS、后台盘点）、IM 交互、本机磁盘/进程审计、冷层数据搬运 → 走 DSH 技能。
9. 不做多租户 SaaS 化。
10. 不因别的工具存在就加 CLI fallback（ADR 0018 五条门禁）。

### 9.5 最硬的落地边界（2026-10-06 四轮实测钉死）

```
sandboxMode=readonly / toolMode=project-write  → L0/L1（run_shell 被拒）
sandboxMode=sandbox                            → L2 + OS 沙箱，但沙箱内无网络、/dev/null 不可写
toolMode=all（无 sandboxMode）                 → 设计上 L2 无沙箱，定时执行路径实测到不了
```

推论（已成通用形态）：
- **los 定时执行 = "工作区内的文件作业"**，不是任意脚本执行器；
- 需要网络/DB 的检查必须"**沙箱外采集（launchd/CI）→ 沙箱内判读（los）**"两段式；
- 改代码类任务：**los 出改动 + 证据 → 外部 runner 跑测试 → 结果回写 verification**。

---

## 10. 架构设计方案是否需要更新

### 10.1 结论

**内核设计不需要推翻；需要更新的是「产品边界」与「未落地 ADR 的处置」**：

1. **ADR 0038 必须修订**（把真实使用身份写进边界，把 Web-first 编码流标为"已交付、采用未验证"）。
2. **ADR 0039 / 0043 已落地**，只需状态回填与编号/注释清理。
3. **ADR 0042 / 0044 / 0045 / 0046 四个长期 Proposed 必须明确处置**（排期 / Deferred / Rejected），否则持续制造"已承诺未交付"的假象。
4. **新增一条 ADR 级"执行面契约"**：E1/E2/E3 判据 + "沙箱外采集 → 沙箱内判读" + "los 出改动、外部 runner 验收"——这三条已由实测确立，但**只存在于 dated 文档里**，不是 ADR 级承诺。

### 10.2 逐 ADR 判定

| ADR | 现状 | 判定 | 证据 |
| --- | --- | --- | --- |
| **0038** Web-first 日常编码 agent 产品边界 | Accepted 2026-07-21 | **需修订** | 已落地：Web 一键 Work Item 闭环（goal→contract→plan→approve→execute→verify→diff→done）、Web diff 行级渲染、`work-page.tsx`/`work-plan-review.tsx`/`work-review-panel.tsx` 存在。**但采用未成立**：30 天 1022 个 task_run **零代码改造类**；首个 E3「los 出代码改动」是 2026-10-06。建议改写成双身份：(a) DSH 的模型网关 + (b) 多节点受治理执行与证据面；把 Adoption（任务分布）写成验收指标 |
| **0039** pluggable execution kernel / Pi adoption | Accepted + Implementation status | **已实现（K0–K4），无需推翻；需状态回填** | `execution-kernel.ts`/`registry.ts`/`selection.ts`/`pi-execution-kernel.ts`/`contracts/execution-kernel.yaml`；**默认只暴露 LOS**（`execution-kernel-registry.ts:23,46`）；K4 金丝雀真实执行过（baseline LOS 与 candidate Pi `0.81.1+los.3` 各 1 次、零写、identity 匹配）；影子语料 17/17。残留：planning canary 因"planning disposition 要求 phase=planning，与 plan-approved 冲突"**延期** ⇒ 需登记独立待办 |
| **0043** provider health-aware routing | Accepted（2026-09-01 追加熔断段） | **已实现且已接线；只需清理编号残留** | `provider-health.ts:111`；接线 `scheduler/provider-selection.ts:9,38`；`provider-policy.ts:1`；有防孤立的边界测试 `provider-routing-boundary.test.ts:35-50`。需删 `:5-8` 编号冲突提示 + 修 `provider-selection.ts:30` 的 "(ADR 0031)" |
| **0045** provider/tool hot reload | **Proposed** | **未实现**；必须显式处置 | 全仓零 `fs.watch`/`chokidar`/version counters；G10 open；configure-surface 列为 Non-Goals。要么排期（附"重启成本 vs 收益"证据），要么 Deferred 并写明"接受重启作为 provider 变更路径" |
| **0046** executor sandbox multi-backend | **Proposed** | **未实现 + 命名碰撞需修订** | ADR 要求 `process`/`docker`/`firecracker` 三后端；实际 `resolveSandboxBackend`（`shell-sandbox.ts:132`）只是 **OS 级**后端选择器（`macos-sandbox-exec`/`linux-bwrap`/`windows-acl`/`native`/`native-denied`），**无 container/VM 后端**。需把命名碰撞写清、把 docker/firecracker 降级为"未批准候选"或正式立项；并把 `sandboxNetwork:'host'` 放宽面纳入风险段 |
| **0042** declarative flow DSL | **Proposed** | 未实现、无消费点证据 | 保持 Proposed 但需明确"与 run-contract plan 数组的关系"是否仍是路线 |
| **0044** ACP endpoint | **Proposed** | **与 G14 直接矛盾，必须二选一** | G14（`2026-08-06-daily-use-gap-analysis.md:62`）明写 ACP 是 rejected/intentional、los-mcp 是唯一程序化接口。要么把 0044 标 Rejected，要么撤回 G14 表述 |
| **0007** provider-loop profiles | Implemented 2026-06-15，partially superseded by 0039 | 符合现状 | — |
| **0008** single-node mesh | Implemented stage 0-2，superseded by 0021 | 符合现状 | — |

### 10.3 未闭环的 TODO / 风险（按归属）

**架构缺口清单 §3**：P0 全清（7/7）；**P1-1…P1-10 全 open**；**P2-1…P2-9 全 open**。
**对抗审查修复 DAG**：完成 P0-01…P0-06、P1-07、P1-08；**待做 P1-09…P1-16、P2-17、P2-18**（本轮复核：P1-09 部分已修、P1-14 部分已修、P2-17 确认未修）。
**10-07 closeout 剩余 4 项**：① DSH 投递记账 + 产物校验；② 滚动设计剩余（`--batch-size`、Linux/macOS 拆 `deploy-drivers/*`、canary 强制化）；③ 摘要口径继续收窄；④ P1 清单。
**滚动设计未落地**：Linux/macOS 驱动拆分、canary 强制化、`--batch-size`。

**本轮复核新增的活跃风险（未登记在任何 TODO）**：
1. **`mbp-executor-1` 漂移 ≥12h 未收敛**，且它是控制面节点 ⇒ 建议立即 `bash tools/los-fleet-rollout.sh --node mbp-executor-1`。
2. **`performance_audit` 观测静默失效**（B1）。
3. **provider 配置不落盘**（B2）。
4. **compat 证据面停更 80 天 / promotion 决策 0 行**（B3）。
5. **`run_specs` revision 路径产生僵尸 spec**（B4，34% 非终止态）。
6. **CI 观测机制建好即停摆**（B19，末行 2026-08-17）。
7. **wiring 豁免在扩张**（B18，384→396 行）。
8. **文档状态段与 VCS 不同步**（D1–D7）⇒ 建议"文档状态段必须绑定提交号"成为治理规则。

---

## 11. 立即行动清单（按性价比排序）

| 优先级 | 动作 | 判据 |
| --- | --- | --- |
| **P0** | 修 `governance-auditors-performance.ts:36-40` 的列名（`latency_ms`→`duration_ms`、`is_error`→`status>=400 OR status=0`、token 取 `usage_json`，**去掉不存在的 cost 列**） | `performance_audit` 的 `providerStats` 非空、`totalProviderCalls > 0`；加回归测试 |
| **P0** | 让 provider 配置变更落盘（`setConfig()` 后写回 `~/.los/config.yaml` 或引入 provider store） | 改 provider → 重启 → 变更仍在 |
| **P0** | `bash tools/los-fleet-rollout.sh --node mbp-executor-1` 收敛漂移 | fleet 一致性报告 `Overall verdict: consistent`；`todo-fleet-drift-mbp-executor-1` 自动 done |
| **P1** | 处置 14 条未确认死信（13 条 `submit_run_contract was not accepted` 归类为同一根因；1 条 `lease_expired`） | `dead_letter_events` unacked = 0；根因出 TODO 或修复 |
| **P1** | 修 `scheduled_execution` self-check 契约（把"已完成但缺交付物证据"与"真失败"分开） | 近 7 天 `Goal self-check failed` = 0；no_op 占比下降 |
| **P1** | 让 `run_specs` revision 路径收敛终态（gate-probe/revision 的 150 条 `created` 需 superseded 或关闭路径） | 近 30 天新增 `created` = 0；非终止态占比 < 10% |
| **P1** | 清 27 个 ssh_target 幽灵节点 + 给 `verified_json` 加 TTL + 定 `grok-cloud-executor-1` 再入册清单 | `last_probe_at` 不再集体冻结；日报能区分"待命"与"漂移" |
| **P1** | 给 8 台在线 executor 定"活干或有名分"（6 台零负载） | registry/runbook 明确专用场景，或在日报区分"待命/漂移" |
| **P1** | IM 配置面：清 `WECLAW_API_ADDR`/`WECLAW_DEFAULT_TO` 残留，建统一开关+健康面（见 P2 L2-3/L2-4）。**归属不再是问题**——用户 2026-10-08 定口径：**IM 按需配置，DSH 或 los 皆可，插件化可拔插** | 开关幂等可自证；`channel-registry.json` 能回答"现在有几条 IM 出站路径是活的"；渠道依赖任务 fail-loud |
| **P2** | ADR 处置批：修订 0038、回填 0039/0043、处置 0042/0044/0045/0046、新增"执行面契约"ADR | ADR 无长期悬置的 Proposed；G14 与 0044 不再矛盾 |
| **P2** | 文档漂移批：D1 回填 P0 ✅、D2 行号、D3 编号冲突段、D5 ADR 号、D7 注释 | 「文档状态段绑定提交号」规则落地 |
| **P2** | 网络面：查 Surge 34628/h 尖峰 + `219.139.213.119:5050` 端点；确认两份报告口径 | 下窗口 verdict 降级为 all_clear / 单端点归零 |
| **P2** | 恢复 CI 观测写入（`ci-metrics/runs.jsonl` 停在 08-17）+ 收紧 wiring 豁免（396→下降） | 台账连续；baseline 行数下降 |

> **IM 口径（2026-10-08 用户明示，supersedes 本文档早先把它列为"待定调"的表述）**：**IM 按需配置，可以在 DSH 也可以在 los，都是插件化可拔插的方案。** 因此缺口不是"归属"，而是**配置面**（统一开关 + 健康面 + 残留清理 + 渠道依赖任务 fail-loud）——设计与批次见 `docs/architecture/2026-10-08-p2-workspace-instructions-and-channel-routing.md` 的 L2-3/L2-4。

---

## 12. 本盘点的方法与证据边界

- **已独立复核**：§1–§4 全部（直接命令/DB 查询）；§5.1 全部；§5.2 的 B1/B2/B3/B4/B10/B11/B18/B19/B20/B23 与 §5.3 全部；§6/§7/§8 全部；§9/§10 的引用逐条回读源码。
- **仅文档陈述未独立复核**：B13–B17、B22、B24–B32 的部分（已逐条标来源）。
- **未做**：`pnpm build` / `pnpm test` / `pnpm check` / `pnpm run gate` 一律未跑（纯只读盘点）；未改任何仓库文件。
- **本轮补上的三个此前 open 的 DB 事实**：节点 30 天负载分布（P1-1 确认 + 发现 `gateway-local` 伪 node）、`run_specs` 非终止态 34%（P2-3 确认 + 定位 revision 路径）、僵尸 spec 的来源分布。
