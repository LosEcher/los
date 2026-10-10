# DSH ↔ los 桥接修复与治理口径补口（2026-10-09）

- **触发**：2026-10-09 的 los/DSH 协作评估（6 条建议），operator 指示"逐个完成"。
- **口径**：实现=运行时行为；本文件每条结论附可复现命令或 DB/台账取值。`[E]`=当场命令/DB 行可复现，`[I]`=推断，`[U]`=未验证。
- **没有做的事**（有意）：不改 fleet 24h 冷却策略、不改 surge 自检契约、不动 `mbp-executor-1` 滚动（原因见 §5）。

---

## 1. P0-1 DSH「los 治理日报」投递链

**症状**：10-08 与 10-09 两天 08:30 的 DSH 作业 `job-67166722-f58` 全失败；失败告警本身也没送出去。

**根因 [E]**：不是凭据、不是配置，是**约 24 分钟的本机直连出网/DNS 中断**：

- Surge 错误窗口（`.los-runtime/network-observe/surge-input/surge-errors-2026-10-09T02-20-29.json`）：
  `windowStart=2026-10-09T00:20:30Z`，`totalMatches=14538`（≈7,650/h，超过 HIGH 阈值 4000/h），
  kinds=`connect_failure 14520`；分钟直方图 00:20–00:44Z 每分钟 ~600 条，之后骤降。
- 同一窗口内 **`api.deepseek.com:443 via DIRECT` 与 `open.feishu.cn:443 via DIRECT` 超时**（42/6 条），
  另有 `DNS timeout` 到 `dns.alidns.com`/`doh.pub`（696/695 条）。
- DSH 台账（`~/.dsh/storages/dsh-scheduler/runs.jsonl`）里两次尝试的 `outputHead` 均为
  `dsh: TRANSPORT: DeepSeek Messages transport failed`；08:35 的失败告警 stderr = `{"ok":false,"error":"token_fetch_failed"}`。
- 旁证：`lark-channel` 看门狗同一时段连败 9 次（08:15:57→08:45:48 才恢复），失败的正是 `open.feishu.cn`。
- 排除凭据因素：手工用 `~/.dsh/.env` 的 `LARK_APP_ID/SECRET` 请求 `tenant_access_token` → `code:0` **[E]**。

**结论**：故障窗口（~25 min）远大于作业的重试跨度，且**失败告警与失败原因共用同一条出网路径** ⇒ 自盲。

**已做（含 DSH 侧告警自盲根治）**：

| 动作 | 证据 |
| --- | --- |
| 作业重试跨度 3×10min → **4×10min**，并显式 `catchUpPolicy=run_once` | `PATCH /scheduler/jobs/job-67166722-f58` → `maxAttempts=4, retryDelayMs=600000`；落盘校验（`jobs.json`）一致；web 宿主重启后 API 仍报 `maxAttempts 4` |
| prompt 增加**步骤 0「补报检查」**：读 runs.jsonl 最近 3 次结果 + 昨日/前日报告是否存在，缺失就写「补报：<日期> 日报未产出（原因）」 | 手工触发一次，运行的输出里已出现补报行 |
| **补齐当天缺口**：手动触发一次 | run `run-d27d6e54-f9c`：`succeeded`、`exitCode=0`、`assertExitCode=0`、77.8s；`push={"status":"delivered","channel":"feishu","messageId":"om_x100b63bef78f6ca0b369f1b6ce55664"}`；报告 `~/.dsh/scheduler-reports/los-governance-daily-20261009.md`（8962 B） |
| **修掉告警自盲**（DSH 侧插件 `dsplugins/dsh-scheduler`）：新增 `alertWatermarkAfterPush()` —— 只有 `feishu-push.sh` **exit 0** 才推进 `alertedFailures` 水位，未投递（出网中断/脚本缺失/非零退出）保持原水位 ⇒ 下一次失败运行补发；同时 `pushFailureAlert` 改为返回投递结果、日志不再把 `exit=1` 写成 "pushed" | 改动前：水位在推送**之前**推进 + 推送 fire-and-forget ⇒ 告警丢失且永不重试（10-09 08:35 实测 `token_fetch_failed` 却记 `alertedFailures=2`）。改动后：插件套件 **109/109**（含 4 条新用例）；web 宿主重启（pid 62648→15613）后插件树 `active=190 failed=0`、`include:dsh-scheduler active on` |

**残留**：出网中断期间告警仍发不出去（物理限制），但现在**恢复后会自动补发**，且日志/台账不再假报"已推送"。

---

## 2. P0-2 日报 [STALE] 判据 + DSH 投影调度

**两个缺陷 [E]**（均为"看起来正常其实是旧数据"）：

1. `tools/los-governance-daily.sh` 第 8 节读的是 `${DATABASE_URL:-}`，而正常调用靠 `.env` 回退（脚本头部解析成 `$DB_URL`）⇒ 第 8 节长期打印 `SKIP: DATABASE_URL 未设置`，跨项目事实面在日报里不可见。
2. 新鲜度判定先把时间戳 `tr -d ' '`，把 `2026-10-08 17:47:44+08` 打成 `2026-10-0817:47:44+08`，`fromisoformat` 抛错 → 返回 `-1` → **`[STALE]` 永不触发**（实测：带空格解析 OK=19h，去空格 FAIL）。

**根因（第 3 点）**：`pnpm project:dsh-sessions`（DSH session-index → los 三张投影表）**没有任何调度**：DSH 12 个作业的 prompt 0 命中、launchd 无、los 侧无 ⇒ `dsh_session_catalog.as_of` 停在 2026-10-08 17:47，而源库 `~/.dsh/storages/session-index.db` 是新鲜的（每小时由 `com.echerlos.dsh-session-index` 维护）。

**已做**：

| 动作 | 证据 |
| --- | --- |
| 第 8 节连接串改用 `$DB_URL`；年龄改在 **SQL 里**算（`EXTRACT(EPOCH FROM (now()-max(as_of)))`），阈值可用 `LOS_DSH_PROJECTION_STALE_S` 覆盖；计算不出来时打 `[STALE?]`（按"未知"处理，不当"新鲜"） | 默认跑：`- **[STALE]** 投射已 23h 未更新（阈值 6h）`；负向控制 `LOS_DSH_PROJECTION_STALE_S=99999999` → 无徽标；`=1` → 有徽标（两侧都验过） |
| 新增 `tools/los-dsh-session-projection.sh` + `tools/los-dsh-session-projection.plist` + `tools/install-los-dsh-session-projection.sh`（launchd `com.echerlos.los.dsh-session-projection`，每小时；PATH 补齐；单实例锁；回读 as_of 落日志；源库缺失即 fail） | 安装 + `launchctl kickstart`：`runs = 1`、`last exit code = 0`；日志 `projection ok rc=0 as_of=2026-10-09 16:54` |
| 投影刷新后 as_of 前进 | `as_of` 2026-10-08 17:47 → **2026-10-09 16:54**；`catalog sessions=1152 byState={current:367, resolved:343, unknown:442}`；日报第 8 节默认跑已无 `[STALE]` |

维护：`bash tools/install-los-dsh-session-projection.sh --status | --uninstall`。

---

## 3. P1-1 `surge log error analysis (6h) v4` circuit open

**定性纠正**：不是"永久冻结"。`CIRCUIT_RECOVERY_WINDOW_MS = 24h`（`packages/agent/src/scheduled-work/policy.ts`）：open 期间被调度 SQL 排除（`circuit_state IN ('closed','half_open')`），冷却到期转 `half_open` 并**只放一次**探测，探测失败重新计时 **[E]**。本机实例：opened 10-09 03:45 → 冷却至 **10-10 03:45**，期间 4 个 6h 槽位被跳过。

**失败构成（近 7 天 25 条 failed）[E]**：主流不是 lease，而是**自检/置信门禁拒绝**（~13 条），形态是
`[Staleness gate] … run_shell is unavailable, so the agent could not obtain authoritative current UTC time`
（调度执行沙箱无 shell ⇒ 拿不到权威时钟，只能用探针文件 mtime，被判不合格）与
`[Step 1: read EACH surge-errors-*.json once]`（24 个快照只读 6 个）。
`lease lost` 仅 2 条，且 6 条历史 lease-lost 集中在 2026-09-30–10-03（**10-03 之后未再出现**）**[E]**。
另有 2 条 `Invalid execution transition task_run: failed -> cancelled`（AP1 状态机拒绝了非法迁移）**[E]**。

**已做**：日报新增 **1b 节**（异常项内）：列出 circuit open 的 schedule、打开时间、失败数、已过期时长、**冷却到期时刻**，并写明恢复动作（冷却自动转 half_open；或人工置回 closed 立即重跑）**[E]**。
另：circuit 打开时系统本来就创建 recovery todo（surge 的那条 `todo-651f6216` 建于 10-03、仍是 backlog）——它此前被 4,873 条机器 todo 淹没，P1-2 已解决可见性。

**待决策（未做）**：① 6h 任务是否该用 24h 冷却（改 `CIRCUIT_RECOVERY_WINDOW_MS` 属调度策略，按 SKILL 需要 harness/回归）；② surge 任务的自检契约与可用工具不匹配（要么给 shell/权威时钟，要么把"时钟不可得"写成合法降级）——属任务契约决策。

---

## 4. P1-2 todo 收件箱治理

**根因 [E]**：`createScheduleWorkItem` 对**每次成功运行**都落一条 `status='backlog'`/`priority='P2'` 的 todo，`dedupeKey='schedule-run-result:<runId>:succeeded'` —— runId 每次都不同 ⇒ 完全不去重。两条自检任务（15m+30m，一天 ~144 次）累积 **4,873 条 backlog（仅 110 个标题）**，把人工待办挤出视野（AP12 僵尸行的 todo 侧翻版）。

**已做**：

| 层 | 改动 | 证据 |
| --- | --- | --- |
| 代码 | 新增 `packages/agent/src/scheduled-work/result-work-item.ts`：可执行项（failed / awaiting_approval）留收件箱；**成功结果建后立即归档**（`archive_reason='schedule-run-result'`，保留 run↔work item 链接与可查性）；归档失败不抛（结果已在 run 台账）。`runner.ts` 改为引用它（本地函数删除，700→672 行） | 单测 4/4；`@los/agent` 套件 **441/441** |
| 测试分类 | `packages/agent/test-runner.mjs` 补 4 条未分类测试（我的新文件 + 3 个**既有孤儿**：`dsh-session-catalog`(隔离组C)/`isolation-backends`/`session-path-resolver`）——该 lane 在 HEAD 上本就 red（`unclassified test`） | 重跑：`tests 441 / pass 441 / fail 0`，0 条 unclassified |
| 数据 | 归档 4,870 条结果行（`archived_at`+`archive_reason='schedule-run-result'`）；6 条**条件已不成立**的 recovery todo 归档（`schedule-recovered`：3 条指向已 retired 的 schedule，3 条 circuit 已 closed） | 生效后非归档总量：**backlog 231 / ready 68 / in_progress 7 / blocked 2**（原 backlog 5,101 口径）；仅剩 1 条 scheduled-work 可执行项 = surge 的 recovery todo（其 circuit 确为 open） |
| 真库 E2E | tsx 脚本用真实 store 走一遍 `createScheduleResultWorkItem('succeeded')` | `archived_at=2026-10-09T09:04:07.953Z`、`archive_reason=schedule-run-result` → **PASS**，探针行已清理 |
| 生效 | 网关重启（tsx 直跑 src，改完重启即生效） | pid 65036 → 21058（后为 P2-2 再启一次 → 69420），`/health ready=true`、outbox 0 |

**残留**：归档行仍占表空间（约 4.9k 行，~1k/周增量已止于源头）；如需彻底瘦身，可给 `event_retention` 类治理 job 增加"归档 todo 保留 N 天"的清理策略（未做）。

---

## 5. P2-1 节点账本

**已做（非破坏性，保留 SSH 派发能力）[E]**：

- 27 个 `ssh_target`（2026-08-19 从 `~/.ssh/config` 一次性导入，无心跳源）逐行写 `last_probe_error='no-probe-path: imported from ~/.ssh/config 2026-08-19; row has no heartbeat source (ssh_target)'`（18 行新写；9 行本已有 `ssh exit null:`）⇒ 27/27 行有原因标记。
- `grok-cloud-executor-1`（offline since 2026-09-29）写 `last_probe_error='stale: offline since 2026-09-29; re-enroll via skill grok-cloud-node-onboarding (verified_json has no TTL)'`。
- 日报第 7 节新增**「账本陈旧行（心跳 >7d）」**：按 node_kind 报行数/心跳区间/有原因标记行数 ⇒ "8/8 executor online" 不再掩盖 27 个从未探测过的行 **[E]**。

**未做（有理由）**：

- **`mbp-executor-1` 版本对齐延后**：`bash tools/los-fleet-rollout.sh --plan` 显示本机 `digest=0.1.0+bcb589a33f42c`（**当前工作树摘要**）而 registry 是 `0.1.0+b59bdf4e9c9b9`，动作是 `restart+promote`。但工作树当前是**未交付的脏改动** ⇒ 现在滚动会把 mbp 钉在一个不可复现的摘要上，且与 fleet 声明 target（`bca2863af4194`）不一致。正确顺序 = 先交付（commit/PR）再滚：`bash tools/los-fleet-rollout.sh --node mbp-executor-1`。
- **grok 再入册阻塞在外部状态**：tailnet 显示 `grok-vm-1`（offline, last seen 10d）与 `grok-vm`（offline, 20d），注册行里是 `grok-bot-vm-413085443`——VM/节点已不存在，需先有可用的云主机，再按 skill `grok-cloud-node-onboarding` 装配。

---

## 6. P2-2 `/v1` 调用方可观测

**缺口 [E]**：`provider_call_telemetry` 与会话 metadata 都只记 los 自己的 sessionId，**没有字段能回答"这次 /v1 调用是谁发起的"** ⇒ 之前只能靠"有无流量"间接判断 DSH 是否在用网关（且"零流量"与"没记账"两种解释无法分离）。

**已做**：新增 `packages/gateway/src/client-label.ts`（只读 `x-los-client` → 回退 `User-Agent`，单行化+截断 80，缺省 **null** 而不用 `unknown` 兜底）；`openai-compat-route.ts` 把标签放进 runChat 参数（+3 行，499 行仍 ≤500 门禁）；`chat-service.ts` 落到会话 `metadata.client`。

**验证 [E]**：

- 单测：`packages/gateway/src/openai-compat-route.test.ts` **15/15**（含 3 条新用例：优先级/回退/null、空白与数组头与截断、路由接线断言）。
- 真机：重启网关后 `POST /v1/chat/completions`（`x-los-client: verify-p2-2-probe`，model=deepseek，max_tokens=8）→ `200`，返回 `OK`；
  `sessions.metadata_json->>'client' = 'verify-p2-2-probe'`（历史会话为 NULL = 诚实"没读到"）；
  同时新增遥测行 `chat-deepseek-1791536808373 | deepseek | deepseek-flash | status=200 | 2277ms` ⇒ **再次确认 `/v1` 路径会记账**，因此"近 7 天零流量"是"没请求"而不是"没记账"。

---

## 7. 检查与残留

- `pnpm --filter @los/agent test`：441/441（含我把 4 条测试重新分类后清掉的 lane red）。
- `pnpm --filter @los/gateway exec tsc --noEmit`：clean；`pnpm --filter @los/agent exec tsc --noEmit`：clean。
- `./tools/check-structure.sh`：exit 0，0 ERROR（仅 `chat-service.ts` 510 行的 grandfathered WARN）。
- `./tools/ci-gate.sh`（完整门禁）：见会话报告。
- VCS：当前改动跨三个意图（① DSH 桥接/日报口径 ② 结果 todo 归档 ③ 节点账本+客户端标签），交付前需按意图拆分（`jj split`），一个 bookmark 一个意图。

---

## 8. 交付记录（2026-10-09 17:30–21:45，**已完成**）

### 8.1 进 main 的 4 个 PR

| PR | 内容 | 合并时间 |
| --- | --- | --- |
| [#327](http://192.168.31.34:3022/los/los/pulls/327) | `fix(scheduled-work)`: 结果 todo 归档（本次 P1-2） | 19:54 |
| [#323](http://192.168.31.34:3022/los/los/pulls/323) | `deliver`: `boundary/consumption-b2-b3` 线进 main + gate 修复 | 20:49 |
| [#326](http://192.168.31.34:3022/los/los/pulls/326) | `fix(ops)`: 日报三处口径 + launchd 投影调度 + 本文档/SKILL（本次 P0-2/P1-1） | 21:09 |
| [#328](http://192.168.31.34:3022/los/los/pulls/328) | `feat(gateway)`: `/v1` client label（本次 P2-2） | 21:19 |

- 关键前提：本机检出的是**未交付的边界线**（89 文件 / +11.2k 行 vs main），日报第 8 节与门禁
  基线/测试分类都依赖该线 ⇒ 该线必须随本次一起进 main（PR #323 的 head 就是「线 + gate 修复」）。
- 本仓 CI **只在 `base=main` 时触发**（`.forgejo/workflows/ci.yml` → `pull_request.branches: [main]`），
  且**改 base 不会补跑** pull_request 事件 ⇒ 每次改 base 后需要一个空提交重触发（本仓 SKILL 的
  "Retrigger a PR without touching content" 模式）。合并后 main 前进，后继 PR 需 rebase 再跑一轮
  （Forgejo 对 `head behind base` 返回 405）。
- 重复项 #324 / #325 仍开着：当前 TOKEN 无 `write:issue`，无法关闭或评论（需带该 scope 的 token）。

### 8.2 CI 阻塞的根因与修复

- **runner 离线**：Forgejo 只有一个 runner `win-los-canary`（labels win-ci/win-ci-jj/win-ci-playwright），
  宿主机 `desktop-r45553o`（100.90.170.58）tailnet 上 active、ping 37ms，但容器
  `forgejo-runner-win-canary` 状态 `Exited`（podman VM 正常）⇒ 是容器没起，不是机器不可达。
  已 `podman start`；**并加自愈**：Windows 计划任务 `los-forgejo-runner-ensure`（每 15 分钟检查，
  容器不在运行则 `podman start`；脚本 `%USERPROFILE%\los-forgejo-runner-ensure.cmd`，house 风格同 `lot2-portproxy-ensure`）。
- **gate-test 真红（不是环境噪音）**：`packages/agent/src/dsh-session-catalog.test.ts` 有两条断言
  依赖**开发机的真实 DSH 数据**（`~/.dsh/storages/session-index.db` 在场 + 已跑过投影）：
  「缺失别名表 ⇒ `status=no-alias-map`」在源库缺失时先返回 `degraded`（源码 :179 早于 :228）；
  「回滚后投影必须完好」断言 `sessions>0` 要求回滚前本来就有投影。CI 容器两者皆无 ⇒ 必然假红。
  修复按本仓 T2：显式声明前置条件（`skip` 计入 skipped 并写明原因，不伪装成通过），第二条改为
  「回滚后精确恢复回滚前状态」（与环境无关且更强）。验证：真实 HOME 145/145、0 skipped；
  HOME 指向空目录（复刻 CI）144 pass + 1 explicit skip + 0 fail。

### 8.3 fleet 版本对齐（P2-1 收口）

- `tools/los-fleet-rollout.sh --canary`（先滚 vultr 并验收）→ 通过后 `--canary` 之外的全量滚动。
- 结果：**8/8 online executor 全部 = `0.1.0+b20dcbe38f468`**（含 `mbp-executor-1`，也含两台 Windows 节点），
  `tools/los-fleet-consistency.sh` verdict = **all consistent** ⇒ mbp 漂移项随之关闭。
- 本地仓库：`main` 已对齐 `main@origin`（`aefe7583`），本次的 6 个特性 bookmark 已删除，
  工作副本在 main 上的干净空变更。

### 8.4 未做 / 残留

- 归档未做：`#324/#325`（需 `write:issue` token）。
- §8 早期版本（runner 离线时的记录）保留在 git 历史里，可追溯"当时以为阻塞"的事实。

---

## 9. P1-a / P1-b：把 los → DSH 的通路接上（2026-10-09 晚）

### 9.1 P1-a：los → DSH 事件投递（补上真实发送端）

- **机制**：复用 `execution_outbox` 的持久重试语义（`attempts` / `next_attempt_at` / `last_error` /
  `published_at`），用哨兵 `entity_type='dsh_event'` 与会话事件发布器隔离：
  会话侧 `excludeEntityTypes: ['dsh_event']`（否则这些没有 `session_event_id` 的行会被重试到死），
  DSH 转发器 `entityTypes: ['dsh_event']`。幂等靠迁移 `064_dsh_event_outbox.sql` 的部分唯一索引
  `idx_execution_outbox_dsh_event_id`（同一 `eventId` 只入队一次）。
- **唯一 emit 点**：`emitGovernanceOperatorNotify()`（治理升级 / self-bootstrap findings / 扫尾摘要 / 进度）——
  不为每个 emitter 重复埋点；入队失败不影响通知本身（best-effort，与会话事件同语义）。
- **投递判据**（对齐接收端 `dsh-los-ops/lib/events.mjs` 契约）：2xx + `handled=true` ⇒ 已投递；
  2xx + `handled=false` ⇒ 接收端明确拒收（不重试，原因写台账）；其它（非 2xx / 网络错 / 非 JSON）⇒ 抛出走退避重试。
  驱动：gateway 的 1s outbox 循环（同一循环顺带转发）；观测：`GET /health` 新增 `dshEventOutbox`
  （pending / claimed / published / failed / oldestPendingAgeMs / lastError）。
- **验证**（真库 + 真接收端）：死 URL（:3939 无监听）→ `attempts=1 / published_at=NULL /
  last_error='fetch failed'`；真 URL（DSH web 宿主 `/los-events`）→ `published_at` 落地（`attempts=2`）；
  接收端审计台账 `~/.dsh/storages/dsh-los-ops/events.jsonl` 出现该 `eventId`；
  **生产出口**（直接调 `emitGovernanceOperatorNotify`）入队后由网关循环投递成功（`attempts=1`, published）；
  同一 `eventId` 二次入队 `enqueued=false`。
- **残留**：接收端所在 **web 宿主**没有注册 weixin 通道 ⇒ 目前只落审计并返回 `handled=true`，
  不做 IM 播报（日志：`weixin push failed: weixin channel not registered`）。要在 DSH 侧播报需先注册通道。

### 9.2 P1-b：los-mcp 接进 DSH（DSH 侧零代码）

- **壳脚本** `tools/los-mcp-serve.sh`：宿主 spawn 环境 PATH 不含 fnm/pnpm，故显式补 PATH + 解析 tsx，
  按 `tools/los.sh` 同一套 blessed 调用跑 `packages/cli/src/index.ts mcp serve`；宿主没给 token 时
  **只**从本仓 `.env` 取 `LOS_AUTH_TOKEN` / `LOS_OPERATOR_TOKEN`（不整份 source）。
- **宿主接线**：web 与 desktop 两个 profile 各加一条 `mcp-los`
  （`@deepseek-ai/dsh-mcp-client`，`serverName=los`，stdio → 上面的壳脚本）；
  备份 `cordis.patch.yml.bak-20261009-mcp-los`。
- **工具面**：`los_run`（**可显式指定 `projectId` + `workspaceRoot`** —— 这才是"跨仓派任务"的正式入口）、
  `los_run_state` / `los_run_replay`（结构化读执行真相）、`los_operator_control`（operator 转向）。
- **验证**：本会话工具面出现 `mcp__los__*`（4 个）；真机调用 `los_run_state`
  → 网关返回 404（`run-does-not-exist…`）⇒ 通路成立；web 宿主重启后插件树
  `222 项 / active=191 / failed=0` 且 `include:mcp-los` active；los 侧
  `tools/boundary-audit.sh` 的孤儿入口检查由「已接线: codex」变为「**已接线: codex dsh**」。
- **注**：此前 DSH 会话只能用 `dsh-los-ops` 的 HTTP 工具，而 `los_chat` 只发
  `{model, messages}`（无 target repo 参数）⇒ 只能在 los 自身 scope 里跑；`los_run` 补的正是这个缺口。
