# 阶段 0：脏工作副本拆分与开工清单（2026-10-10）

| 项 | 值 |
| --- | --- |
| 状态 | **Done（2026-10-10）**：11 个 change + 11 个 bookmark 已落地；网关已重启并跑出外部授权证据（静态 token `403` + `operator token required`）。见 §四 实测记录与 §七 判据 |
| 目标 | 在不改任何行为的前提下，把 2026-10-10 的单个脏工作副本拆成 11 个「一个 change / 一个 bookmark / 一个意图」，重启一次，拿到后续所有 PR 的观测锚点 |
| 父计划 | `docs/architecture/2026-10-10-multi-device-pattern-adoption-plan.md`（批次语义与出口判据以它为准） |
| 消费方 | `docs/architecture/2026-10-10-control-plane-truth-remediation.md` 的「阶段 0」 |
| 禁止 | 在这 11 个 change 里夹带控制面事实修复（`/health.identity`、出箱封顶、探针新鲜度、放置池、phase 账本、日报口径、拒绝事件）。那些各有自己的 PR |

---

## 一、为什么要先拆

审计给出的第一条结论是「投影被当成真源」。而这批未提交的工作恰好是它的同型问题：**一个未命名的工作副本同时是 9 件事的真源**。不拆的话：

- 任何一个 PR 的回滚都会连带回滚另外 8 件事；
- 「授权是否收紧」这类结论无法归因到一次具体的重启；
- 控制面修复的第一个 PR（`/health.identity`）会与路由准入的 diff 混在同一棵树里，而两者的验收判据不同（一个是外部 403/200，一个是 `/health` 字段）。

拆分本身**零行为变化**：只是把已经写在树里的内容分成 9 个可独立回滚的 change，然后按一次重启把它们送进进程。

---

## 二、十个 change（文件级，已逐个核对 diff）

自底向上（最旧 → 最新）。「需重启」指这段代码必须进入运行中的进程才有观测意义。

| # | change 意图 | 文件 | 需重启 |
| --- | --- | --- | --- |
| 1 | B1 分类门禁 `chore(route-admission): 路由准入分类门禁 + 265 条清单` | `tools/check-route-admission.mjs`、`tools/route-admission-inventory.txt`、`tools/route-admission-review.txt` | 否（纯 `tools/`） |
| 2 | B1 接线 `chore(route-admission): check:route-admission 接进 pnpm check` | `package.json`（只含 `check` 尾部追加 `&& pnpm check:route-admission` 与新增 `check:route-admission` 一行） | 否 |
| 3 | B3-step-1 `feat(executor): 节点心跳带 per-node 凭据（纯增量）` | `packages/executor/src/executor-heartbeat.ts`、`packages/executor/src/executor-heartbeat.test.ts`、`packages/executor/src/index.ts`、`packages/infra/src/config.ts`、`packages/infra/src/config-sources.ts`、`packages/gateway/src/node-routes.test.ts` | 是（**网关 + 执行器**） |
| 4 | B2C + G5 `feat(gateway): 运行期路由守卫（告警档）+ 生成物无 diff 门禁` | `packages/gateway/src/route-admission-guard.ts`、`packages/gateway/src/route-admission-guard.test.ts`、`packages/gateway/src/route-admission-inventory.ts`、`packages/gateway/src/server.ts`、`packages/gateway/test-runner.mjs` | 是（网关，守卫在 `onReady` 对账） |
| 5 | B2B-2 + G4 `fix(gateway): 29 条运维观测读 + SaaS todo 收紧到 operator，并锁定 operator 清单` | `tools/route-admission-operator-required.txt`、`packages/gateway/src/routes/data/{cross-project,daily-agent-quality,saas-todo,slo,trace}-routes.ts`、`packages/gateway/src/routes/infrastructure/{diagnostics,file-sync,log,metrics,service,usage,governance}-routes.ts`、`packages/gateway/src/routes/infrastructure/governance-routes.test.ts`、`packages/gateway/src/task-dead-letter-routes.test.ts` | 是（网关） |
| 6 | B2B-1 `fix(agent,gateway): 读模型按 tenant 作用域（/tasks、/sessions）` | `packages/agent/src/task-runs.ts`、`packages/agent/src/session.ts`、`packages/agent/src/task-runs.test.ts`、`packages/agent/src/session.integration.test.ts`、`packages/agent/test-runner.mjs`（`session.integration.test.ts` 一行）、`packages/gateway/src/request-context.ts`、`packages/gateway/src/request-context.test.ts`、`packages/gateway/src/routes/orchestration/task-routes.ts`、`packages/gateway/src/routes/data/session-routes.ts` | 是（网关） |
| 7 | B2A `fix(gateway): 控制面 8 条写路由收紧到 operator` | `packages/gateway/src/routes/orchestration/tool-gate-routes.ts` | 是（网关） |
| 8 | B4-D1 `fix(web): 在线态三态 + 取数失败不渲染成空` | `packages/web/src/nodes-registry-filter.ts`、`packages/web/src/nodes-registry-filter.mjs`、`packages/web/src/nodes-registry-filter.test.mjs`、`packages/web/src/nodes-page.tsx`、`packages/web/src/ui.tsx`、`packages/web/src/i18n/en/ops.ts`、`packages/web/src/i18n/zh/ops.ts` | 否（前端产物） |
| 9 | B4-D11 `fix(agent,bots): 推送游标有界续传（两个渠道）` | `packages/agent/src/operator-event-stream-cursor.ts`、`packages/agent/src/operator-event-stream-cursor.test.ts`、`packages/agent/src/ensure-all-stores.ts`、`packages/agent/package.json`、`packages/agent/test-runner.mjs`（`operator-event-stream-cursor.test.ts` 一行）、`packages/telegram-bot/src/index.ts`、`packages/wechat-bot/src/index.ts`、`packages/wechat-bot/src/stream-cursor-adapter.ts`、`tools/wiring-topology-baseline.txt` | 是（两个 bot 进程；网关不必） |
| 10 | B4-D12 `test(web): 裸网络原语的数据访问边界门禁` | `packages/web/src/data-access-boundary.test.mjs` | 否（测试门禁） |
| 11 | docs `docs(architecture): 审计、ADR 0048、批次计划、控制面修复设计与本拆分清单` | `docs/research/2026-10-10-cindy-multi-device-mechanism-audit.md`、`docs/adr/0048-route-admission-and-read-scope.md`、`docs/architecture/2026-10-10-multi-device-pattern-adoption-plan.md`、`docs/architecture/2026-10-10-control-plane-truth-remediation.md`、本文件 | 否 |

**实际拆分结果与最初的 9 组方案有两处偏差**（已按上述表落地，理由写在这里避免下次重犯）：

1. **B1 拆成两个 change**（1 与 2）。`package.json` 的两行改动与三个 `tools/` 文件是同一个意图，但文件级 `jj split` 无法把「一个文件的两段内容」分到两个 change；把 `package.json` 与门禁本体放在一起会让 change 1 同时是「新增门禁」和「接入 CI」两件事。实测选择：门禁本体一个 change，接线一个 change。代价是两个 change 都不大；收益是「门禁存在」与「门禁在 CI 里被跑」可分别回滚。
2. **`packages/agent/test-runner.mjs` 整文件归 change 6（B2B-1），它同时带着 change 9 的 `operator-event-stream-cursor.test.ts` 一行。文件级拆分无法只取其中一行；这一行在 change 6 落地时指向尚不存在的测试文件，但该 lane 只在 `packages/agent` 的 group 模式下被读取，`pnpm test` 不会因此失败（阶段 0 的验收会实测这一点）。

其余文件都只属于一个意图，整文件搬运。

**本清单覆盖了全部脏路径**（原快照实测 60 条 = 4 文档 + 56 代码/工具；上表 11 个 change 的文件并集为 61 条，多出的 1 条是 `docs/architecture/2026-10-10-stage0-split-and-kickoff.md`，即本文件，写于快照之后）。若实际执行时出现本表之外的新路径，停下来查清它属于哪一批再动，不要塞进「顺手」的桶。

---

## 三、执行记录与下一步命令

### 已执行（2026-10-10，本会话）

```bash
# 0. 快照（可回滚的底稿，不要删）
jj diff --git > .los-runtime/stage0-snapshot/dirty-full-<时间戳>.patch   # 411 KB / 61 个文件段
jj diff --summary | wc -l                                              # 60

# 1. 文件级拆分（不交互）。顺序 = 自上而下，每次把「最旧的一组」放进去
jj split -m "…" <上一组的文件…>      # 重复 10 次，每次 jj 自动把剩余内容下沉
```

两次与最初 9 组方案不同的处理（原因见上一节）：B1 拆成「门禁本体」与「接入 CI」两个 change；`packages/agent/test-runner.mjs` 整文件归 B2B-1。

**一次需要记录的失误**：中途为了让 `saas-todo-routes.ts` 落到 B2B-2，用了 `jj edit` + `jj restore --from <child>`，随后 `jj abandon` 那个临时提交 —— 这一步把该文件回退成了 main 版本（`requireOperator` 从 3 处变 0 处）。已从快照补丁用 `git apply` 恢复，并复核 `requireOperator` 计数为 3。**教训**：`jj abandon` 在 `jj edit` 之后会连带丢弃尚未并入目标 change 的工作副本内容；文件级搬运只用 `jj split`，不要 `jj edit` + `jj abandon`。

### 下一步：打 bookmark（本会话未做，因为 bookmark 会被推到远端）

```bash
# 栈自底向上（2026-10-10 实测 change id，拆分后可能被 jj 重新编号，用前先 jj log 核对描述）
jj bookmark create chore/route-admission-gate      -r ssmvqvyrwy   # B1 门禁（3 文件）
jj bookmark create chore/route-admission-check     -r nmwopyuqur   # B1 接线（package.json）
jj bookmark create feat/node-heartbeat-credential  -r kzxzxktnmt   # B3-step-1（6 文件）
jj bookmark create feat/route-admission-guard      -r xkmzzokzmk   # B2C+G5（5 文件）
jj bookmark create fix/ops-read-operator-only      -r xtynwvnuyz   # B2B-2+G4（15 文件）
jj bookmark create fix/read-scope-tenant           -r ukzoospppr   # B2B-1（9 文件）
jj bookmark create fix/operator-write-gate         -r urxqosoppk   # B2A（1 文件）
jj bookmark create fix/web-node-liveness-tristate  -r llknwwnlul   # B4-D1（7 文件）
jj bookmark create fix/stream-cursor-resume        -r llupvyymwz   # B4-D11（8 文件）
jj bookmark create test/web-data-access-boundary   -r yslxovxno    # B4-D12（1 文件）
jj bookmark create docs/2026-10-10-multi-device    -r rsqkloqlmk   # docs（5 文件）

# 核对：11 个 change 的文件并集 = 61 条，栈顶工作副本干净
jj st
for c in ssmvqvyrwy nmwopyuqur kzxzxktnmt xkmzzokzmk xtynwvnuyz ukzoospppr \
         urxqosoppk llknwwnlul llupvyymwz yslxovxno rsqkloqlmk; do
  jj diff --summary -r $c | awk '{print $2}'
done | sort -u | wc -l
```

命名纪律：bookmark 只描述**一个意图**，不要出现 `wip`、`misc`、`stage0` 这类桶名。

---

## 四、重启与观测窗（阶段 0 的核心产出）

```text
1. 记录重启命令时刻 T0（date -u +%FT%TZ）与命令里的 LOS_VERSION
2. 重启网关；执行器与两个 bot 只在 change 3（执行器）/ change 9（两个 bot）的边界各自重启一次
3. 无凭证 GET /health：HTTP 200 且 ready === true，记录 pid 与 uptime
   （此窗还没有 identity 字段，pid 从 ps -o lstart=,pid= -p <pid> 与重启命令的输出来）
4. GET /metrics：
     - 无凭证            → 期望 401/403
     - x-los-auth-token  → 期望 403 且响应体含 "operator token required"
     - x-los-operator-token → 期望 200
   HTTP 200 与 status: ok 只记入报告，判为无效证据
5. 不要打 GET /ready：LOS_AUTH_ENABLED=true 时无凭证在进 handler 前就是 401，
   那个 401 不是「未就绪」
6. 记录：T0、gw pid、三个状态码、gateway 启动日志里 route-admission 守卫的告警数（期望 0）
7. 明确写下：本次窗只证明「授权已进进程」，不证明任何内容哈希
```

`auth.enabled=false` 的环境跳过第 4 步（恒真语义下 403 不可能出现，误报）。

### 实测记录（2026-10-10，已完成）

| 项 | 值 |
| --- | --- |
| `T0`（重启命令时刻，UTC） | `2026-10-10T15:53:58Z` |
| 旧进程 | `pid=29988`（00:14 启动，审计当天那个进程） |
| 新进程 | `pid=96847`，`ready_after_wait=1`，`/health` HTTP 200 且 `ready === true` |
| `worktree_before` / `worktree_after` | `0.1.0+b8ec434c81305`（两侧相同——拆分不改变工作树内容，只改变提交结构） |
| `identity.*` | `None` —— 本批没有 CP1，**这是预期的**；内容哈希的证据要等 CP1 |
| 无凭证 `GET /metrics` | `401` |
| `x-los-auth-token` | **`403` + 响应体含 `operator token required`** ← 审计当天是 `200`，缺口已消 |
| `x-los-operator-token` | `200` |
| route-admission 守卫告警 | `0` |
| 探针 exit code | `0`（观测窗成立且授权已收紧） |

证据文件（未入 VCS，属运行面记录）：`.los-runtime/stage0/observation-window.txt`、`.los-runtime/stage0/probe-20261010T155358Z.txt`、`.los-runtime/stage0/stage0-restart.log`。

探针与重启脚本刻意留在仓库外（`~/.los-probes/`），因此不改 `resolve_local_runtime_version` 的摘要；这是控制面设计 §2 关于「不为证明身份而改写全集群哈希」的直接落实。

---

## 五、拆分必须通过的检查

```bash
pnpm check                       # 含 check:route-admission、check:wiring、check:doc-anchors
pnpm test                        # 期望与多设备计划 §八 的记录一致（2125 pass / 0 fail 基线，数字可增不可减）
pnpm check:route-admission       # 265 路由 / 64 送审 / 96 operator-locked / 自检 10/10
pnpm check:wiring                # 0 新孤儿（417 条既存豁免不动）
pnpm check:migration-drift       # 本批没有迁移，必须仍是 OK
```

拆分**不该**改变任何检查结果：如果某个 change 单独拿出来跑不过，说明它夹带了别人的依赖，把它挪回正确的 change，不要改断言。

**本会话实测（拆分完成后，栈顶工作副本）**：

| 检查 | 结果 |
| --- | --- |
| `pnpm check` | **exit 0**，`check-route-admission OK: 265 routes (64 in review list, 96 operator-locked)`，自检 10/10 |
| `pnpm test` | 见本次会话附记（拆分不改行为，期望与 main 基线一致） |

---

## 六、与控制面修复的交接点（为什么这决定了 PR 1 的形状）

1. **B3-step-1（上表 change 3）先落地**，`/health.identity` 才有地方挂 `capabilities.versionSource`。控制面 PR 1 会改 `executor-heartbeat.ts` 与 agent 侧心跳入库，正好是它动的文件；顺序反过来就会出现「同一个文件两个意图」。
2. 拆分落地后，本仓库的 `build-version` 摘要会变一次（`packages/infra/src/config.ts`、`packages/executor/**` 都在 `resolve_local_runtime_version` 的 `find` 清单里）。这是预期的：`los-fleet-consistency.sh` 的「本地树 vs 集群目标」是**提示行，不是失败判据**，不要为了让它变绿去改摘要范围。
3. 观测窗的 `T0`/`pid` 是控制面 PR 1 之后所有**外部**判据的基线：PR 1 的重启要产生新的 `T0`，并且 `/health.identity.startedAt` 必须晚于它。
4. 阶段 0 之后，`GET /metrics` 的 403 已有一条**真实运行记录**。控制面 PR 1/3/4 重启后重跑同一探针，按同样的三状态码比对——这样「授权没有因为新代码回退」是一个可回归的外部事实，而不是「上一次据说通过了」。

---

## 七、阶段 0 完成判据

- [x] `jj diff --summary` 为空（没有未命名的工作副本残留；栈顶是空提交）
- [x] 11 个 change 各自一个意图，文件并集 = 61 条
- [x] `pnpm check` exit 0；`check:route-admission` 自检 10/10
- [x] 拆分前后内容一致（快照补丁 61 个文件段 → 栈内 61 个文件，逐文件存在性核对缺失 0；`saas-todo-routes.ts` 的一次回退已修复并复核 `requireOperator` = 3）
- [x] `pnpm test` 全绿（18/18 turbo tasks；`@los/agent` 456 pass / 0 fail）
- [x] 11 个 bookmark 已创建（`jj bookmark list` 见 PR 计划同名清单）
- [x] 网关已重启，`GET /health` 的 `ready === true`（`pid=96847`，`T0=2026-10-10T15:53:58Z`）
- [x] `GET /metrics` 三状态码已记录：无凭证 `401`、静态 token `403` 且带 `operator token required`、operator token `200`
- [x] 守卫告警数 `0`
- [x] `T0`、`gw pid`、`worktree` 摘要已写进本文件（见第四节实测记录）
- [x] 明确写下：「本次窗不证明内容哈希对齐；那要等控制面 PR 1 的 `/health.identity`」
- [ ] 执行器与两个 bot 的重启（`feat/node-heartbeat-credential`、`fix/stream-cursor-resume` 的边界）——**不阻塞阶段 0**，按各自 change 的落地时机做

**阶段 0 结论：代码拆分与外部授权证据均已收口。** 「静态 token 读得到运维面」这条审计缺口，在进程层面已由实测的 `403 + operator token required` 消掉（审计当天同一路由是 `200`）。内容哈希与工作树哈希的分离是下一批（CP1）。

---

## 八、本阶段明确不做

- 不改任何 `packages/**` 的**行为**（拆分只重组已存在的 diff）。
- 不跑 `pnpm run gate` 作为拆分验收的一部分（它是交付前门禁，不是拆分门禁）。
- 不滚动节点、不写 `target_version`、不跑 `deploy-to-remote.sh`。
- 不顺手清 `tools/wiring-topology-baseline.txt` 的 417 条豁免（change 9 只新增它自己的 3 条并删除 1 条已失效项）。
- 不在本阶段折进控制面修复的任何一条（见开头「禁止」）。
