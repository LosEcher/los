# 2026-08-05 运行时盘点:服务 / 待办 / 周期任务 / 验证任务设计

日期:2026-08-05 20:40 CST(Asia/Shanghai)
性质:读-only 盘点(未改动任何运行状态;仅新增本文档)
证据约定:所有结论标注 `[E]`(命令/API/DB 直接验证)、`[I]`(推断)、`[U]`(未验证)。

## 0. 落地状态(21:00 更新)

| 项 | 状态 | 证据 |
|---|---|---|
| D1 僵尸 run 修复 | ✅ 已落地 | `recoverStaleRunningRunSpecs()`(gateway,60s,AP1 状态机);重启后 60s 内将 `run-todo-d4963bde`(卡 running 14h)自动转 blocked:`[12:48:29] WARN Stale-running sweep: blocked 1/1`;测试 `stale-running sweep blocks orphaned run_specs and preserves active ones` 通过(83/83) |
| V2 僵尸巡检 | ✅ 已落地 | 同 D1:gateway 内 60s interval,无需 token、确定性执行;结果经 `transitionExecutionState` + 日志 + run_specs 状态可查 |
| V3 日志新鲜度巡检 | ✅ 已落地 | `runtime_readiness` 模板为确定性内置检查(不执行 goalTemplate 自定义指令),故 V3 落地为两层:① `/health` 新增 `logBackpressure.stdoutWritableLength/stderrWritableLength`(进程内 write-queue 深度,持续高位 = 日志管道阻塞);② 新增 scheduled_work_item `schedule-78ffede5`(interval 10m,`runtime_readiness`)持久化节点/服务在线快照到 `scheduled_work_item_runs.result_summary_json`,首跑 20:58:31 succeeded,可查 |
| V5 eval-backlog 快照 | ✅ 已执行 | `POST /eval-backlog/run` 入库 20 条:**11/11 automated probe 全过**(E02/E03/E08 绿),9 条 manual 正常标记 |
| 盘点文档 | ✅ 本文件 | |

## 0.5 双 postgres 清理(21:30 更新)

- 事实:`127.0.0.1:55432` = 本机 Homebrew postgres(权威,6-15 至今);docker `los-postgres` = 早期库(6-06 起)+ **8-02/03 K4/Execution Lab 实验存档**(experiments=4、candidates=127、gates=2、evals=19,本机均为 0),8-04 02:46 后 gateway 切到本机,容器闲置
- 处理(operator 授权):`pg_dump` 全量备份 → `.los-runtime/db-backups/los-postgres-20260805-212609.dump`(4.5MB,61 表,sha256 `c4469d07...fe06af6`)→ `docker stop los-postgres`(数据卷保留,可随时重启);gateway 不受影响
- 区分增强:`.env` 头部注释已标注权威实例与备份位置;后续 `pnpm run doctor` 建议固化实例标识(未实现)
- CI 用 runner 内 `postgres:16` 服务,与本地容器无关

## 0.6 待办与分支清理(21:35 更新)

- file-size 类 74 条 ready todo 降级 backlog(metadata 记录 demotedFrom/demotedBy/rationale),migration-drift 21 条保留 ready
- Forgejo 远端 3 个已合并分支(docs/ci-vm-repair-note、feat/kimi-subscription-models-sync、fix/stale-running-recovery)经 `jj git push --deleted` 清理,ls-remote 验证 0 匹配

## 1. 服务状态盘点

| 面 | 状态 | 证据 |
|---|---|---|
| gateway 进程 | `[E]` PID 54116 存活,监听 `0.0.0.0:8080`;`/health` 200,`ready:true`,uptime ≈12.5h(08:03 启动) | `lsof -i :8080`、`curl /health` |
| executor | `[E]` PID 存活,`.los-runtime/executor.log` 20:12 仍有 file-sync 扫描(30 分钟周期,35507 文件) | `lsof`、日志 mtime |
| launchd 守护 | `[E]` `com.los.daemon` KeepAlive + wrapper 每 30s 健康检查;08-05 07:14 / 07:51 两次自动重启 gateway/executor | `launchd-wrapper.log` |
| DB(gateway 实际使用) | `[E]` **本机原生 postgres(PID 913)监听 `127.0.0.1:55432`**,非 docker 容器 | `lsof -i :55432`、gateway 连接 |
| docker `los-postgres` | `[E]` 独立容器(55432 映射被本机 postgres 抢占),内含另一套 los schema + `los_test`,数据停在 08-03 前后,与真实库**完全不同** | `docker exec` vs 宿主机 psql 行数对比 |
| 节点注册 | `[E]` 3 节点在线且心跳新鲜:mbp-executor-1(7s)、node34-executor-1(9s)、oracle-executor(7s),均 `run_agent=true`;其余 8 节点 offline 正常 | `executor_nodes` |
| 服务实例 | `[E]` `gateway-echers-mbp-local-8080` online(hb 1s);26 个 `eval-e02-*` 离线残留行(测试遗留,可清理) | `service_instances` |

**可观测性警报(重要)**:
- `[E]` gateway.log 最后一条实时日志为 12:37:15,之后 stdout 写入被阻塞/缓冲约 8 小时;20:37:15 才 flush 出 12:37:15 的一行。**gateway.log 不是实时可靠的可观测面**;同期 DB 证据(scheduled-work run 20:35 成功、governance hourly 19:56 成功)证明运行循环本身正常。
- `[E]` 根因线索:`tools/los.sh` 每次 start 用 `: >` truncate 并重开 gateway.log,`start_daemon_perl` 用 `>` 打开;日志缓冲/管道背压无保护。
- `[I]` 记忆文件 mtime 证实:标题/正文标注 "2026-08-08" 的 5 个场景记忆实际写于 08-05 凌晨-早上,**记忆日期字段不可信,内容与 DB 吻合**。

## 2. 周期任务与定时任务盘点

### 2.1 governance_jobs(23 个,真实库)
- `[E]` 9 个 daily:last_run_at=08-05 09:40:45,next=08-06 08:40 — **今日已跑,健康**
- `[E]` 1 个 hourly `branch_cleanup`:last=19:56,next=20:51 — 健康
- `[E]` 7 个 weekly:last=08-04,next=08-10 — 健康
- `[E]` 5 个 paused / 1 个 retired(consistency_audit daily paused、event_retention manual ×2 paused、branch_cleanup weekly paused、dead_letter weekly ×2 paused)— 停用属有意配置,但**无 owner 标记**
- `[E]` 全部 circuit_state=closed,consecutive_failures=0
- 结论:governance 周期循环**真实健康**;注意与 docker 容器库(15 个 job 且 08-04 停摆)的观测差异,再次印证"连错库"风险。

### 2.2 scheduled_work_items(3 个)
- `[E]` `schedule-c86f9f56` "dogfood runtime readiness check":enabled,interval 5m,circuit closed,failures 0,next 20:40:15;swir 173 条(07-20 → 08-05 20:35 持续成功)— **核心自治定时任务运转正常**,且是现有最好的 dogfood 观测点
- `[E]` `schedule-d24adaec` P3 feed smoke:paused(once,2099)
- `[E]` `schedule-68143b77` P2 authenticated smoke:retired
- 结论:仅 1 个 enabled schedule;治理类定时任务全部走 governance_jobs,无重复体系。

### 2.3 其他周期面
- `[E]` executor file-sync:每 30 分钟扫描(35507 文件,15700ms 级),08-05 20:12 仍在跑
- `[E]` 07:14 / 07:51 wrapper 重启后 gateway 恢复;重启窗口内 in-flight run 无恢复机制(见缺陷 D1)

## 3. 待办完成情况(todos,580 条)

| 状态 | 数量 | 说明 |
|---|---|---|
| done | 180 | |
| backlog | 261 | 积压主体 |
| ready | 107 | **大量为 08-05 09:40 governance daily 自动生成**(file-size extract submodule ×N、migration-drift align),属"机器生成的待办",owner 未定 |
| blocked | 17 | |
| cancelled | 9 | |
| in_progress | 6 | 见下 |

in_progress 6 项(全部长期未闭环,最早 07-16):
1. `todo-los-context-engineeri` 上下文三层策略 — 07-16 起(20 天)
2. `todo-los-ci-cd-observabili` CI/CD 可观测计划 — 07-26
3. `todo-los-ci-resource-basel` GitHub CI 资源基线 — 07-26
4. `todo-los-daily-agent-produ` Web-first 日常 Agent — 07-27
5. `todo-los-execution-lab` Execution Lab — 07-27
6. `todo-los-review-20260728-r` 07-28 两日变更审查修复 — 08-04

`[E]` run_specs 152 条:succeeded 74 / created 54 / cancelled 14 / blocked 7 / failed 2 / **running 1(僵尸)**。

## 4. 记忆 vs 持久化证据对账

| 记忆声称 | 持久化事实 | 判定 |
|---|---|---|
| 多 agent 图 3/3 worker 成功,记录 completion 死锁 | worker 消息 07:00-07:01 全部 worker_done,但 run `run-todo-d4963bde` 06:46 创建后 **14h 仍 running**,task 全 blocked | 部分相符:worker 确实完成,但**图 completion 死锁仍真实存在,run 未被回收** |
| scheduled-work 场景全通,schedule 保留运行 | swir 173 条持续成功至 20:35 | 相符 |
| subagent 场景修复 4 缺陷 | 05:53-06:15 多 run blocked/失败(`submit_run_contract not accepted`、`terminated`、NUL 字节),06:15 后一次成功;06:46 图 run 仍卡 | 修复有成效但 planning 失败率仍高 |
| "2026-08-08" 日期 | 文件 mtime 均为 08-05 | **记忆日期字段不可信** |

## 5. 缺口与缺陷清单(按优先级)

**D1 [P0] 僵尸 run 无回收**:`run-todo-d4963bde` running 14h,provider/model/node 全空,task 全 blocked;进程重启(07:14/07:51)后 in-flight run 无恢复/超时路径。→ 需要 running 超时回收器(stale run → blocked + 证据),可查 `run_specs.updated_at`。
**D2 [P0] gateway.log 可观测性失效**:stdout 缓冲/背压无保护,8h 延迟;故障诊断依赖 DB 兜底,但日志面不可信。→ 需日志落盘旁路(file fd 直接写)或 flush 监控告警。
**D3 [P1] 连错库风险**:本机 postgres(55432,真实)与 docker `los-postgres`(空/测试)并存,同一 DATABASE_URL 语义下 docker exec 查询结果完全不同;任何脚本/盘点若连错库会得出完全错误的治理结论(本次即被误导一次)。→ 需在 `pnpm run doctor`/status 输出中固化"实际连接实例"标识。
**D4 [P1] subagent/planning 失败率高**:05:53-06:15 连续 5 个 run blocked(`submit_run_contract was not accepted`)+ 1 failed(`terminated`)+ NUL 字节错误;修复后仍有残留。→ 需要 planning 失败率指标 + 失败原因归类。
**D5 [P1] run_evals 语义混乱**:192 条全部 `success=false`,其中 96 条 daily_agent_scenario 实际 verification_status=succeeded(字段语义冲突);eval-backlog 快照在真实库**零记录**(从未 POST /eval-backlog/run)。→ 需统一 success 语义,并把 eval-backlog 快照纳入周期任务。
**D6 [P2] outbox legacy 2658 条**永不发布、无清理路径(health 持续报 legacyCount,仅统计);非 legacy 2711 条已全部 published(正常)。→ 确认是否属设计,若属历史垃圾则加清理 job。
**D7 [P2] ready 107 条机器生成待办无 owner**;governance daily(file_size/migration_drift)自动产出 todo,是否应自动关闭/降级需人工决策。
**D8 [P2] service_instances 26 条 eval-e02 残留 offline 行**;可清理。
**D9 [P2] 记忆日期不可信**:5 个场景记忆标题超前 3 天;属外部记忆工具问题,盘点时以 DB 为准(AGENTS.md 已规定证据优先级)。

## 6. 验证任务设计(可查询 / 可追溯 / 可观测)

设计原则:每个验证任务有唯一 ID、触发面、断言、证据落点、失败动作;优先注册为 los 自己的周期任务(scheduled_work_items 或 governance_jobs),让 los 自我验证。

| ID | 验证任务 | 触发 | 断言(通过标准) | 证据落点 | 对应缺口 |
|---|---|---|---|---|---|
| V1 | **图 completion 回收验证**:跑一个 3-worker 图 run,等待完成 | 手动/每周 | 全部 worker_done 后 run 在 ≤10min 内转 succeeded 或 blocked;无 running 超 30min 的 run | run_specs.status、task_edges、worker_messages 时间戳 | D1 |
| V2 | **僵尸 run 巡检**:每小时扫描 running 且 updated_at > 60min 的 run_specs | governance hourly | 发现即转 blocked 并记录证据(或告警),存量僵尸归零 | run_specs + governance_jobs result_summary | D1 |
| V3 | **日志实时性监控**:对比 scheduled-work run 的 DB 完成时间与 gateway.log 中对应行出现时间 | 每 5 分钟 | 日志延迟 ≤ 60s;若 > 5min 触发告警并记录 | gateway.log mtime/内容 vs swir.started_at | D2 |
| V4 | **subagent planning 可靠性**:连续 5 次 spawn_agent 派生 + 查询 | 手动/每周 | planning 失败率 ≤ 20%,失败原因可归类(submit_run_contract/NUL/terminated 各计数) | run_evals(summary_json.failure_class)、task_runs | D4 |
| V5 | **eval-backlog 快照入周期**:每日 POST /eval-backlog/run,断言 E02/E03/E08 probes 结果入库 | governance daily | run_evals 当日存在 `runSpecId=eval-backlog` 行,自动 probe 用例通过率可查 | run_evals | D5 |
| V6 | **库实例一致性**:断言 DATABASE_URL 实际连接实例与预期一致(postgres PID/容器名/库内 sentinel 行) | doctor/status | `pnpm run doctor` 输出实际实例标识,与 .env 一致 | 命令输出 + 文档 | D3 |
| V7 | **schedule 熔断演练**:人为制造连续失败(如错误模板),验证 circuit_state 打开 → half_open 恢复全链路 | 手动/月度 | circuit_state 按 G4 语义流转,consecutive_failures 正确复位 | scheduled_work_items | 回归保障 |

落地建议:
1. 先做 V2 + V3(纯观测、零侵入,直接修复 D1/D2 的"看不见"问题),并把 V2 注册为 governance_jobs hourly 或 scheduled_work_items。
2. V1 手动复现一次,验证 D1 修复有效后再考虑自动化。
3. V5 把 eval-backlog 快照挂到已有 daily governance 循环(改 `governance-jobs` 的 daily 任务或加一个 job),完成 D5。
4. V4 数据采集可先用手动脚本,积累一周后再决定是否转常驻。

## 7. 残留风险
- `[U]` 远端 3 个 executor(node34/oracle)与本地 gateway 的连接质量未实测(仅心跳新鲜);本地网络(Nebula 100.x)到远端节点延迟未测。
- `[U]` 07-28 两日变更审查(in_progress todo)的具体未修复项未展开(仅记录存在)。
- `[U]` governance daily 09:40 生成的 107 条 ready todo 中,file-size 类是否全部有效未逐条核对。
- `[I]` 日志阻塞根因推断为 stdout 管道背压/缓冲,未抓取到进程级证据(需复现或加探针)。
