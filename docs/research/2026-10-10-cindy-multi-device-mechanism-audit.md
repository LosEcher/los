# Cindy 多设备 / 远程设备管理机制审计 —— 对 los 的可迁移性评估

> 审计对象：`/Users/echerlos/syncfolder/project/cindy`（开源客户端 monorepo：Electron 桌面端 + Expo 手机端 + 共享 packages；**服务端在另一个不在此仓的仓库**）
> 审计目标：`/Users/echerlos/syncfolder/project/los-workspace/projects/los`（TypeScript 模块化单体 + 执行节点网格）
> 方法：`transferable-pattern-audit`（机制 → 领域无关化 → 同构问题匹配 → 四级判定 → 落点 + 验收）
> 日期：2026-10-10
> 证据分级：**CONFIRMED** = 本次直接读过该文件/行；**INFERRED** = 由已读证据推断。

---

## 0. 结论先行

1. **Cindy 的多设备方案与 los 的节点方案是"反着长"的，架构层不可照搬。**
   Cindy 的每台设备各自持有任务真相（本地 SQLite），server 只是哑中继（device-link README 明说 "server 是哑中继：只看路由头，不看 payload"），所以它必须自建一条"设备到设备"的隧道、可靠传输和 IPC 白名单。
   los 的真相在 PostgreSQL，节点只是执行器（`contracts/node-registry.yaml`、ADR 0010）。把 Cindy 的 relay/mesh/可靠传输搬进 los 会制造第二真相源，与 ADR 0001/0033 冲突。

2. **Cindy 真正值得抄的是"设备是用户资产时的治理层与客户端正确性体系"，而不是它的传输层。**
   最同构、可测的一批是：presence 三态语义、列表级/会话级读模型分档、默认拒绝的能力面 + **可执行的全表扫描不变式**、预算表 ⊆ 权限表的子集不变式、超时预算跨端一致性、非幂等请求的 in-flight 区分、操作名 × 角色权限矩阵、"仅由推送建立的 UI 状态必须有快照重建"、整表快照与增量的纪元栅栏、故障半径分级与多 peer 门禁。
   完整清单见 §3.1（15 条 `可直接落地`，每条带落点与机械验收）。

3. **"手机端跨设备查看与管理任务"对 los 的正确形态不是设备网格，而是中心读模型 + 订阅分档 + 推送契约。**
   los 已经有一半基础（per-session WS/SSE + stream lease + 事件账本 + responsive web），缺的是：列表级轻量活动流、节点在线态的三态语义、面向手机的通知契约、以及"把某个节点当可驱动对等体"时的能力面设计。
   若 los 未来要让用户在手机上**驱动某台设备上的 agent**（而不只是看中心库），Cindy 的 allowlist / capabilities / 故障半径三件套就从"仅设计原则"升级为"直接相关"。

4. **一个反直觉的差异：在"单 gateway 内跨设备看任务"这件事上，los 现在是 Cindy 的超集。**
   Cindy 要自建隧道才能让手机看到电脑上的任务；los 里**任何已认证客户端本来就看得见全部任务**（`GET /tasks` 是 `SELECT *`）。
   所以 los 的真实缺口排序是：① **把任务面安全地暴露给手机之前的用户级隔离**（`listTaskRuns` 无 WHERE，A 能看到 B 的任务）；② 手机形态与推送；③ 跨 gateway 聚合；④ 节点在线态实时化。
   把①当成"体验问题"而不是"授权问题"处理，是这个方向最大的风险。

5. **顺带发现一处文档/实现漂移**（见 §5.3）：`docs/research/2026-08-19-komodo-review-observability-and-node-management.md:111` 仍写"los 无外部用户（单 operator token 模式）"，但 `packages/infra/migrations/047_users.sql` 已引入 `users` 表与 JWT 角色（`operator` / `user`），`request-context.ts` 也已按 tenant/project/user 三元组解析。
   准确表述是：**授权面**已不再是单 operator token（有多用户 + 首个注册用户强制 operator）；**数据隔离面**仍然接近单租户（读模型全局）。任何"los 是单用户"的推论需要重新核实。
   另外，**Cindy 侧的文档也不能当实现读**——本次复核出 6 处文档/代码不一致（含心跳参数、workingDir 守卫通道、推送深链格式），详见 §5.3。

---

## 1. Cindy 参考实现拆解（机制，不是文件清单）

### 1.1 拓扑与角色

| 角色 | 职责 | 证据 |
| --- | --- | --- |
| 控制端 | 发 `link-open` / `invoke`，收 `push` / `presence-changed`。桌面与手机都是控制端 | `packages/device-link/README.md`（角色与拓扑节）**CONFIRMED** |
| 被控端 | 桌面端开启"允许被控"后，把本机 renderer 广播按 topic 转发给控制端 | 同上；`packages/device-link/src/topics.ts:1-17` |
| relay server | 哑中继：只解析 `v / kind / id / src / dst`，按 `userId` 命名空间隔离、按 `deviceId` 路由（presence + Redis pub/sub） | `packages/device-link-protocol/src/protocol.ts:37-56`、`:74-81` |

关键机制：
- **`Envelope.src` 由 server 在转发时回填**，客户端传值被覆盖 ⇒ 防伪造。`protocol.ts:58-71` **CONFIRMED**
- **`ROUTED_KINDS` 与 `CONTROL_KINDS` 是两个独立的判据集**：前者决定"要不要按 dst 转发"，后者决定"转发前是否必须校验目标 `remoteControlEnabled=true`"。回程帧（`link-accept` / `invoke-result` / `push`）不受被控开关限制，否则开关关掉后无法收尾。`protocol.ts:74-91` **CONFIRMED**
- **控制端-only 是一等公民**：手机 `remoteControlEnabled=false`，天然只发不收，无需为它做特例。README **CONFIRMED**

### 1.2 身份、账号与区域

- 身份在 WS 握手时由 server 用 JWT 固化（`hello` → `hello-ack` 带 `deviceId/userId`）。`protocol.ts:106-146`
- **跨账号以"范围字段"扩权，而不是新建协议**：`Envelope.sharedTask` / `Envelope.providerShare` 是可选的、与 `src/dst` **并列**的作用域；角色与成员由 server 按已验证账号重写；**非法范围直接拒绝，不能降级为全设备远控**。`protocol.ts:65-70`、`docs/product-rules/shared-task-mode.md:81`
- **区域（realm）与安装包（build region）分离**：安装包决定更新通道与品牌，登录后 `sessionRealm` 决定 auth / device-link / OSS / 推送等所有带令牌的服务端点；**区域身份不由远端清单自报，而由构建期注入的受信任地址表决定**；双区发现歧义时 `ORG_REALM_AMBIGUOUS` 不自动猜、任一区异常则 `ORG_REALM_UNAVAILABLE` **fail closed**。`docs/auth-realm-routing.md:7-44`
- 认证记录是**单一原子记录** `{version, realm, refreshToken}`，冷启动先按记录中的 realm 加载端点再 refresh，**禁止退回 buildRegion 发送 token**。`auth-realm-routing.md:120-134`

### 1.3 连接生命周期与弱网可靠性

- 状态机：`connect → hello 握手 → online`；断线指数退避 1s→30s；online 后 20s `ping`，**连续 2 周期无 `pong` 判僵死**。README **CONFIRMED**
- **版本不一致不应进 online**：`hello-ack.serverProtocolVersion` 不匹配时客户端防御性断连重连。README
- **可选能力分层协商**（append-only）：`reliable-transport-v1`、`reliable-link-confirm-v1`、`transport-timeout-close-v1`、`background-link-v1`、`maker-event-batch-v1`、`session-text-snapshot-v1` 等，都在 `link-open`/`link-accept` 的 `capabilities` 里双向声明；**旧端不声明就永远收不到新 wire 字段**，因此两端可独立升级，relay 不需要理解新字段。`packages/device-link/src/protocol.ts:124-166`
- `link-close.reason` 的**默认语义是"永久关闭"**，新枚举值对存量客户端 fail-generic 到这一档；所以**任何可恢复语义的新 reason 都必须先经能力协商才允许发送**（`transport-timeout` 就是这么加进去的）。`protocol.ts:183-198`
- `allowlistHash`（FNV-1a）在 `link-accept` 回传，让控制端**探测两端 allowlist 不一致并提示**，而不是静默 `CHANNEL_NOT_ALLOWED`。README

### 1.4 能力面治理：默认拒绝 + 三条准入判据 + 双层校验

`packages/device-link/src/allowlist.ts:1-30` 是本次审计里**最可复用的一段治理文本** **CONFIRMED**：

- 准入判据三条：① handler 不依赖 `event.sender`/窗口对象；② 无本机 UI/shell/对话框副作用；③ 语义在"被控端执行"才正确。
- **永不放行类别逐条列出**：窗口/UI 类、本机对话框、shell 副作用、账号与密钥（唯一例外是只回 boolean 的 `api-key:present`）、updater、被控端全局设置写、`local-db` 裸写、通用 migration/session-import。
- **双层校验**：控制端发送前（快速失败）+ 被控端执行前（权威）。
- **新增 channel 不进表即天然不可远程调用**（默认拒绝由枚举结构保证，而不是靠人记得加判断）。另有 `__tests__/allowlist.test.ts` 不变式守卫 + `allowlistHash` 用于跨版本探测。
- 入参收敛有独立兜底：`remote-workdir-guard.ts` 把远程 `create-session`/`fork` 的 `workingDir` 限定到本机已知目录。

### 1.5 数据面：topic 路由、读模型分档、资源投影

**（a）topic 是协议契约的一部分，放在共享包里**（`topics.ts:1-17`）：
- `sessions`（轻）：会话**列表读模型**变更 + 列表级活动摘要 `local-db:sessions:activity`（`{sessionId, phase, compactDetail, interactionKind?, attention?}`）；侧边栏订阅，低频。
- `session:<id>`（重）：单会话实时流（maker 事件 / 状态 / 输入投影 / 交互审批 / 消息创建）；打开该会话才订阅，且触发"正在被控"横幅。
- `fs-watch:<workdir>`：**订阅驱动的文件树变更**——首个订阅者到达才启动 watch，最后一个退订即停，无常驻成本。
- `topicForPush(channel, payload)` 是 fan-out 的唯一依据，**算不出 topic 就丢弃、不转发**（fail-closed）。`topics.ts:226-245`

**（b）列表级 channel 宁可合并进轻 topic，也不新开一档**：账号级无 sessionId 的低频信号（provider 目录、用量、定时任务事件、插件资源失效…）全部并入 `sessions` topic，注释逐条写明理由。`topics.ts:139-204`

**（c）会话活动摘要与正文分离**：`SESSION_ACTIVITY_CHANNEL` 只给列表行显示低频活动，**不承载 maker 事件、消息正文或工具结果**；会话详情必须订阅 `session:<id>`。`topics.ts:66-67`

**（d）微批是"削减出站帧数"的唯一手段**：`maker:event:batch` 把"每事件一帧"压成"每窗口一帧"，注释记录线上数据（单毫秒 119 帧 / 单小时 5168 次 BACKPRESSURE）；批**不得跨会话合并**否则算不出 topic；拆包时**只保留顶层 sessionId 与批一致的条目**（防批内混入未订阅会话的数据），fail-closed 逐条跳过。`topics.ts:79-139`

**（e）传输出口做字典编码，但解码必须在再授权之前**：`sessionListTransport.ts` 把会话标签从内联对象编码成 `{format, sessions, tags}` + `tagIds` 索引，注释明确 "Decode before consumers and before cached results are re-authorized"。`packages/device-link/src/sessionListTransport.ts:22-92`

**（f）远程资源投影协议**（`remoteResources.ts`）——让新业务模块接入手机端**不用发版**：
- 稳定入口只有 5 个 channel：`manifest` / `list` / `get` / `invoke` / `changed`。`remoteResources.ts:16-27`
- 兼容规则写在文件头：字段只增不改、未知字段必须忽略、`primitive` 与 `kind` 是开放字符串、**每个非核心展示块必须带 `fallbackMarkdown`**、**描述符只是展示提示，永远不是授权**（host 在执行时重新校验）。`remoteResources.ts:6-12`
- 动作是**闭联合**（`refresh-collection` / `refresh-resource` / `navigate` / `toast`），不是任意 UI DSL；有界常数（id 160 字符、cursor 1024、query 1000、primitives 128、action input 64 KiB、list limit ≤200）。`remoteResources.ts:209-232`
- `resolveRemoteText` 让**主机侧决定文案**，新标签不需要客户端发版。`remoteResources.ts:393-403`

### 1.6 跨设备任务查看与操作

- **控制端是纯镜像，被控端是单一真相**（topics.ts 头注）。手机端一个 `DeviceLinkClient` 单连接，按设备分域缓存（`deviceProvidersCache` / `deviceModelMetaCache` / `taskTagCatalogCache`…），**切账号/撤权时按设备逐项 evict**。`apps/mobile/src/device-link/DeviceLinkContext.tsx:1-110`
- 读操作走 invoke（`local-db:sessions:list` / `sessions:get-many` / `messages:list` / `history:messages`）；实时走 push 订阅；**列表级 push 只表达"变了"，控制端据此重拉**（`sessions:created` 只带 sessionId）。`topics.ts:141-148`
- 跨设备批量读有明确预算：`get-many` 最多 32 个 ID、每轮补读最多 8 个、单条 SQL 授权过滤最多 200 个 ID。`docs/dev-rules/remote-and-mobile-adaptation.md:254-261`
- **跨电脑任务复制**（`maker:task-copy`）与旧交接协议**隔离**，旧端拒绝时提示升级而**不退回旧协议或本机执行**；复制是快照、不持续同步；接收端按复制 ID 幂等导入。`docs/product-rules/task-device-migration.md:79-97`

### 1.7 请求策略：三个边界互不推导

`packages/device-link/src/invokePolicy.ts` 把三件事**显式列举、互不推导** **CONFIRMED**：
1. `isPeerResetRetryableInvoke` —— peer reset 后可重试的**读**（显式白名单；remote agent 的 `poll` 按游标幂等所以例外）。
2. `canCoalesceRemoteListing` —— 可共享在途结果的 listing（注释：**"不能从可重试推导"**；`sessions:get` 是 read-after-write 边界，`fresh` 列表不得复用写之前的快照）。
3. `isBackgroundInvoke` —— 可让位于用户操作的查询（**与重试无关、与新鲜度无关**）。
另有 `ACTION_INVOKE_TIMEOUTS_MS`：**主机的 orphan/outbox 上限由控制端全部预算的并集推导**，保证"主机绝不比控制端先放弃"。`invokePolicy.ts:114-146`

### 1.8 失败模型与故障半径

`docs/dev-rules/remote-and-mobile-adaptation.md:43-69` 是**本次审计里治理价值最高的一段** **CONFIRMED**：

- 设备互联是 **1:N** 拓扑（被控端到 relay 只有一条连接，同账号全部控制端共用它）。故障域四层：单请求 → 单 peer 的 link → 整条 relay 连接 → **relay 聚合背压**（第四层：任何"立即重连+全量重放"都会复现故障，形成自放大循环）。
- 三个必答问题：① 触发条件是哪一层？② 恢复动作作用在哪一层（默认同半径最小动作）？③ 多 peer 拓扑下测过吗（必须有"≥2 控制端共享被控端、其中一个静默，断言其它 peer 零感知"的用例）？
- 判例：`#1187`（2026-07-31）引入"可靠重试耗尽→强拆整条 relay 连接"，wire 向后兼容、单测全绿、多轮 review 通过，上线后**一台休眠手机把同账号所有设备一起打掉线**，由 `#1405` 收窄止损。原文结论："协议兼容、allowlist、单测三层防线对这类问题全部免疫，只有 review 时点名问『半径』才拦得住。"
- **PR 门禁**：功能类 PR 必须对"SSH 远程 / 设备互联 / 手机版"三选一给出结论（已适配 / 已开 issue / 说明为何不涉及），缺这段 = P1；触及重试/超时/断链恢复的必须写"故障半径三问"，缺失 = P1。`remote-and-mobile-adaptation.md:289-301`

### 1.9 非幂等写与"结果未知"

- `DeviceLinkError.inFlight`：**已发出**的请求在断连时被批量 reject 时置位，用来区分"可能已送达、只是响应丢了"与"发送前本地拒绝"。注释明确：对非幂等操作（如 enqueue）盲重前者会造成对端重复执行。`packages/device-link/src/protocol.ts:96-118`
- 超时不等于远端未执行；`invokePolicy.ts:36-84` 为每个"合法慢且非幂等"的 channel 逐条写明预算与误超时后果（fork / rewind:commit / create-session / message:delete …）。

### 1.10 区域、通知与推送生命周期

- 通知是**一类帧**（`notify`），**server 消费不转发**：`category`（session-done / session-error / session-needs-reply）、`title/body` 长度上限、`deepLink`、`collapseId`（APNs collapse-id / thread-id）、`targetDeviceId`。**发送门槛是 `hello-ack.capabilities` 含 `notify`**——旧 server 收到未知 kind 会静默丢弃（黑洞），所以没有能力声明时客户端不得发送。`protocol.ts:139-178`
- 通知正文经第三方通道，**server 不落盘通知内容**；发送端自行裁剪长度与敏感度。`protocol.ts:160-170`
- **切账号/切区域时先撤销旧区推送 token**，用旧 token 向旧区域 `DELETE /api/device-link/push-token`，失败不阻断退出；CN token 绝不发到 Global 端点。`auth-realm-routing.md:152-162`

### 1.11 远程桌面的权威模型（另一条产品线，作为对照）

- 控制权是**租约作用域的能力，不是会话本身**：租约绑定 relay 校验过的来源 peer + 随机 lease ID，3s 续期 / 12s 过期；每次输入与每次完成的采集都**重新校验当前授权**；本地停止、撤权、relay 丢失、peer 离线、显示变化都会停止租约；**迟到的操作不能让已停止的租约复活**；输入序号防重放。`docs/remote-desktop.md:351-356`
- 三个标识符生命周期分离：lease（观看/控制）、`attemptId`（一次 offer/answer 与它的 peer connection）、`exchangeId`（一次 candidate 请求/回复）；**替换 attempt 会让前驱的异步结果失效**；host 在异步工作后重新校验 lease。`remote-desktop.md:216-231`
- 文档**显式写出自己的边界**："这些检查认证的是调用面，不是每次 JS 调用背后的人……compromised-main-renderer 的 opt-in 路径仍是安全 review 关注点，**这些来源检查不得被表述为已解决该威胁**。"`remote-desktop.md:358-375`

### 1.12 手机端的一手证据（决定"控制端"该长什么样）

- **纯控制端在协议里是一等公民，不是降级端**：手机 `hello` 里 `remoteControlEnabled: false`（`apps/mobile/src/device-link/DeviceLinkContext.tsx:941`，CONFIRMED），`presence-set` 在 mobile 全目录**零调用点** ⇒ 手机没有路径把自己变成被控端；帧分发器结构性丢弃非 push 帧（`DeviceLinkContext.tsx:1642`：`if (env.kind !== 'push' || !env.src) return;`）。
- **一条 WS 多路复用，不是一个设备一条连接**：`DeviceLinkClient` 只持一个 `ws`，按 `dst` deviceId 维护多份 peer 状态；`peerFailurePolicy: 'isolate-peer'`（`DeviceLinkContext.tsx:949`）让单 peer 故障只复位该 peer。代价是拥塞域共享——这正是后面必须发明 per-peer 背压与微批的根因。
- **订阅是引用计数 + 焦点驱动的**：每设备 topic 归属表 `deviceId → (topic → Set<ownerId>)`，最后一个 owner 释放才真正退订（`apps/mobile/src/device-link/topicRegistry.ts:15-25,54-69`）。这使"多个界面共用一个订阅"不会互相拆台。
- **"中途加入"是手机的主路径，不是边缘情况**：pending 审批若只由实时 push 建立，则挂起之后才打开会话的窗口会永久错过 → 必须有 `maker:get-pending-interactions` 快照重建路径（`MOBILE-PARITY-CHECKLIST.md:41` 的 ★ 项）。
- **整表快照 vs 增量 push 的竞态用"变更纪元栅栏"解决**：拉 `sessions:list` 前记录 epoch，返回时若 epoch 已前移则**丢弃这次整表响应**并补一次权威拉取，理由写在代码里——"applying this older whole-list response would roll back `sessions:patched` or hide a just-created task"（`apps/mobile/src/session/HomeSurface.tsx:844,871-884`）。
- **授权按"操作名"裁决，不按"接口名"**：`sharedTask.ts:82-95` 是共享角色集合 / 所有者专属集合 + 行级归属判定，拒绝原因是**类型化枚举**；并显式声明"这只是任务级授权，文件祖先关系、附件归属、工具风险、队列事务身份**必须由执行 handler 另行校验**"。

---

## 2. los 现状核实（逐实例）

只有一台相关实例需要核实：本仓（los 主仓）。审计范围内**没有第二个持有不同版本库的 los 实例**；节点是运行期实体，不是版本实例，但它们**各自部署不同 build**，这一点在下文按"多实例"处理。

### 2.1 拓扑与实体

| 层 | 现状 | 证据 |
| --- | --- | --- |
| 真相源 | PostgreSQL；`session_events` append-only + 投影 | ADR 0002；`docs/research/2026-08-19-komodo-review-observability-and-node-management.md:57` |
| 节点模型 | 四层分离：`nodeKind` / `connectModes`+`connectConfig` / `capabilities` / `verified`，另有 `resourceClass` | `contracts/node-registry.yaml:9-145`、ADR 0010 §1-§6 |
| 执行候选 | 显式判据 + blockers（`heartbeat:stale`、`capability:run_agent_missing`、`resource:memory_pressure` …） | `contracts/node-registry.yaml:157-171` |
| 注册 | 节点主动 `POST /nodes/heartbeat`（push 模型，网关是中心） | `packages/gateway/src/routes/infrastructure/node-routes.ts:198`；`packages/executor/src/executor-heartbeat.ts` |
| 一次性注册 | `POST /nodes/enrollment-tokens`（TTL、绑定 nodeId、一次性消费）→ `POST /nodes/enroll` | `node-routes.ts:99-123` |
| 生命周期命令 | 固定枚举 `status/probe/drain/promote/restart/upgrade/rollback`，网关→节点直连 `agent_http.commandUrl`（Bearer `executorAgentKey`）或落库待拉取，需 `requireOperator` | `packages/gateway/src/routes/orchestration/node-command-routes.ts:54-113` |
| 健康视图 | `GET /nodes/health` 派生 0-100 健康分 + 声明式规则 findings；`GET /ops/runtime-health` 舰队块 | `node-routes.ts:124`；`packages/web/src/fleet-card.tsx:1-30` |
| 探针与 SSH | `POST /nodes/:id/probe`、`POST /nodes/:id/ssh-run`、`POST /nodes/import-ssh-config` | `node-routes.ts:231,277,298` |
| 服务面 | `service_instances`（gateway/web/scheduler/artifact_proxy/worker 各自的 `status/role/rollout_state/capabilities_json`），Web 有 `/services` 页（10s 轮询 + drain/promote） | `packages/infra/migrations/014_executor_infrastructure.sql:34-61`；`packages/web/src/service-page.tsx` |
| **调度方向** | **push，不是 pull**：**没有节点侧 claim 端点**。gateway 解析候选后**主动**以 HTTP NDJSON 调节点 `/v1/tasks/run-agent`；SSH 路径则是 gateway 本机 `spawn('ssh', …)` 跑 `los-executor run-agent --stdin` | `packages/agent/src/scheduler/executor-client.ts:37-175,255`；`packages/agent/src/scheduler/ssh-client.ts:132-222` |
| 执行可靠性 | 双租约 fencing（`lease_version`，执行器按 `leaseMs/3` 续租，失败即中止）+ outbox at-least-once | ADR 0027:16-31 / 0028:16-31；`packages/executor/src/lease-fencing.ts:6-25` |
| 节点间通道 | **不存在**。`mesh_links_json` 只被 heartbeat/upsert/merge 透传，在 Web 节点编辑器里以 JSON 文本框展示，**没有任何路由/传输代码读它** | `packages/agent/src/executor-nodes.ts:238,279,296,340`；`packages/web/src/node-editor.tsx:275-276,371` |
| **per-node 身份** | **已实现但完全未接线**：`POST /nodes/enrollment-tokens` → `POST /nodes/enroll` → `verifyNodeCredential()` 三件套齐备，但 `x-los-node-credential` **全仓只有 1 处命中且是读取方**；executor 侧 0 命中 ⇒ 实际部署所有节点共享同一把 `agentKey`，节点身份不可区分。且未携带 credential 的心跳**不会被拒** | `node-routes.ts:99-118,203-211`；`packages/agent/src/node-enrollment.ts:35-88`（本条已由父代理独立复核 **CONFIRMED**） |
| 判活阈值 | `EXECUTOR_NODE_STALE_MS = 60_000`；网关每 60s 扫一次标记 offline；另有节点自动探测 120s 与出站熔断（5s→5min） | `packages/agent/src/executor-nodes.ts:19,302-320`；`packages/gateway/src/node-auto-probe.ts:57`；`remote-executor-circuit.ts:9-12` |

**结论（CONFIRMED）**：los 的"多设备"是**中心网关 + 车队式执行节点**，节点是**被管理对象**（被 push 任务、被执行生命周期命令），不是**可被用户驱动的对等体**。节点侧对外能力面只有 7 个生命周期命令。

### 2.2 客户面

| 客户 | 现状 | 证据 |
| --- | --- | --- |
| Web 控制台 | 有 `nodes-page.tsx` / `node-editor.tsx` / `fleet-card.tsx` / `mobile-nav.tsx`；有 `LoginPage`/`isAuthenticated`。节点页 **8s 轮询**（无节点在线态推送） | `packages/web/src/`（glob + `App.tsx:55`）；`nodes-page.tsx:51-52` |
| 会话实时面 | **已有** per-session WS（`GET /sessions/:id/stream/ws`）与 SSE，共用 `session_events` + `stream_checkpoints`，带 stream lease、reconnect info、`eventBus`，WS 还能回传 operator steering/cancel | `packages/gateway/src/routes/streaming/ws-routes.ts:1-14,62`、`sse-routes.ts:331` |
| 会话列表 | REST `GET /sessions`（拉取式，无列表级变更流） | `packages/gateway/src/routes/data/session-routes.ts:71` |
| 任务页 | 显示任务跑在哪个节点（`task.nodeId`），但数据源是 `GET /tasks` **8s 轮询** | `packages/web/src/pages/tasks-page.tsx:137,223,78-85` |
| 手机可用性 | PWA 已有 `manifest.webmanifest`（`display: standalone`）+ `sw.js`；`mobile-nav.tsx` 存在；但节点页在 `nav-config.ts` 标为 `status:'partial', audience:'operations'` | `packages/web/public/manifest.webmanifest`、`mobile-nav.tsx`、`nav-config.ts:124` |
| CLI | `los nodes <list|commands|command>`；`--gateway` 可指向远端（认证 `--operator-token`） | `packages/cli/src/help.ts:20,28`；`node-commands.ts:11,78-81` |
| IM | `telegram-bot` / `wechat-bot` 消费**全局**运维事件 SSE `GET /operator/events/live`，支持 approve/deny/escalate 与 todo 派活；**两个 bot 都不调 `/nodes`，看不到也选不了执行节点** | `operator-events-sse.ts:1-10,46`；`telegram-bot/src/index.ts:197`；`wechat-bot/src/index.ts:270,616-632` |
| 原生手机 App | **不存在**。无 `apps/` 目录，无 react-native/expo 依赖 | 目录与 package.json 核查 |

**其中一条被低估的现有资产**：`wechat-bot` 自带一个真·手机页面 `/m/`（Events/Actions/Sessions 三视图，viewport 已适配），但注释明确 **"The web channel is pull-based (mobile browser refreshes the page)"**，且只覆盖运维事件与审批，**没有任务列表、没有节点视图、没有跨设备**。这是本仓最接近"手机端管理任务"的现有落点。证据：`packages/wechat-bot/src/channel/web.ts:4-11,76-134,157`。

### 2.3 鉴权与身份

- `RequestContext` 已含 `tenantId / projectId / userId / isOperator / isAuthenticated`，按 JWT（`sub` / `role`）+ 静态 operator token + 静态 access token 解析；**scope header 只是路由提示，只有校验过的 operator 才能覆盖 tenant/project**。`packages/gateway/src/request-context.ts:13-90`
- `users` 表 + 角色（`operator` / `user`）落地在 `packages/infra/migrations/047_users.sql`；首个注册用户强制 operator，其后建用户需 operator；`session_events` 与 task runs 有 `tenant_id / project_id / user_id` 列。`packages/gateway/src/routes/auth-routes.ts:44-57`；`packages/agent/src/execution-persistence.ts:72,129,263`
- **但读模型没有按用户隔离（本次已独立复核 CONFIRMED）**：`GET /tasks` → `listTaskRuns()` = `SELECT * FROM task_runs ORDER BY updated_at DESC LIMIT 50`，**无任何 tenant/user WHERE**；`GET /nodes` 同样返回全部节点；`GET /operator/events/live` 注释直接承认 "across ALL sessions/tenants"。证据：`packages/agent/src/task-runs.ts:333-341`；`packages/gateway/src/routes/orchestration/task-routes.ts:89-92`；`node-routes.ts:93-97`；`operator-events-sse.ts:47-51`
  ⇒ **多用户目前只在"能不能调这个端点"这一层成立，不在"能看到谁的数据"这一层。** 这与 Cindy 的 `userId` 命名空间隔离 + 逐设备可见性过滤是**结构性差异**。
- **节点之间没有对等信任模型**：节点到网关是 `executorAgentKey` 单向 Bearer；网关到节点是同一 key 反向调用。没有"两个用户的设备互相可达"的概念；也不存在跨节点调用，因此没有节点间鉴权问题。

### 2.4 与 cindy 的差异对照表

| 维度 | Cindy | los |
| --- | --- | --- |
| 数据真相 | 每台设备本地 SQLite，**server 是哑中继** | **PostgreSQL 单一真相**，节点是执行器 |
| 拓扑 | 同账号设备网格 1:N（控制端/被控端共用同一客户端）+ 哑 relay | 中心网关 + 车队节点（节点主动 heartbeat；**调度是网关 push，无节点侧 claim 端点**） |
| 跨网关/跨实例视图 | 不适用（relay 按 `userId` 全局命名空间，天然一套） | **不存在**：每个客户端绑定单一 gateway，无联邦/聚合读模型（grep `federation|peer gateway` 0 命中）；换一台 gateway 就看不到另一台上的任务 |
| 身份 | `deviceId` + JWT 握手固化，`src` 由 server 回填 | `nodeId` + 一次性 enrollment token + `executorAgentKey`；**per-node credential 已实现但未接线**（所有节点共享一把 key） |
| 数据可见性隔离 | 按 `userId` 命名空间 + 逐设备可见性过滤（列表/搜索/缓存回复都重投影） | **读模型全局**：`listTaskRuns` 无 WHERE；`/nodes` 全量；operator 事件流 cross-tenant |
| 在线态 | presence **三态**（unknown / online / offline）+ `lastSeenAt` + WS 广播 | `status: online\|draining\|offline` + `heartbeat_at` + reaper 判 stale；另有派生健康分 |
| 版本策略 | 客户端**不可强升** ⇒ capabilities 数组 + append-only + 旧端降级 | 车队**协调升级** ⇒ 要求 `/health.version == executor_nodes.version`（ADR 0010 §7） |
| 远程能力面 | `REMOTE_INVOKE_ALLOWLIST`（数百 channel，覆盖会话/输入/审批/模型/rewind/文件…）默认拒绝 | `node-commands` **7 个生命周期命令** + `requireOperator` |
| 实时事件 | topic 订阅（`sessions` / `session:<id>` / `fs-watch:<dir>`）+ push 转发 | per-session WS/SSE（`session_events` + stream lease + cursor 重放） |
| 跨设备查看任务 | 控制端**镜像被控端**的会话列表与消息（要建隧道才做得到） | 中心读模型：任何已认证客户端直接看全部任务（`GET /tasks` = `SELECT *`，**当前未按 tenant/user 过滤**） |
| 推送 | `notify` 帧 → APNs/FCM，深链 `cindy://devices/<id>/sessions/<id>`，按 realm 撤销 token | 无移动推送（`apns`/`fcm`/`webpush`/`expo` 全仓 **0 命中**）；实际通道是 IM 消息投递；PWA 有 manifest+SW 但无 Web Push |
| 在线态推送 | presence 变更经 WS 广播给同账号设备 | 节点在线态**无 WS/SSE**，节点页 8s 轮询；唯一服务端推送是**会话级** WS/SSE |
| 用户模型 | 账号 + realm（cn/global）+ 组织 SSO + 跨账号共享任务 | `users` + JWT 角色（首个注册用户强制 operator）+ tenant/project/user 列；**旧文档仍写"单 operator token"（漂移）** |
| "设备"是否用户可见 | 是：设备列表页 + 设备详情 + 远程控制开关 | **基本不是**：全仓 `device` 仅 5 处，Web 侧只有微信绑定文案；节点页 `audience:'operations'`、`status:'partial'` |
| 手机端资产 | 独立 Expo 原生 App（纯控制端，~11k 行 device-link 模块） | 响应式 Web（`mobile-nav.tsx`）+ `wechat-bot` 的 `/m/` 拉取式面板；无原生 App |
| 任务搬家 | `maker:task-copy` 跨电脑复制（文件 + 原生上下文 + 幂等导入） | ADR 0011 工件传输 + execution outbox；**没有"把任务搬到另一台设备"的对等物**，且 ADR 0012 明列"不宣称活任务迁移" |

### 2.5 los 侧"刻意不做"清单（有 ADR 或测试门禁，不是遗漏）

做机制迁移前必须先知道哪些门是**主动关上的**——否则会把"已裁决不做"重新提成 todo：

1. 不做 SQLite / 本地单机第二套持久化（`docs/adr/0001-postgresql-single-node-mesh.md:9-24`）。
2. **SSH 可达 ≠ 执行能力**；`ingress` / `proxy` / `socks5` 节点不得成为调度候选；不加任意远程 shell 作为节点操作（`0011:237-243`、`0012:632-644`）。
3. 本地 executor 对齐验证之前**不做多节点 claim**（`0010:186-188`、`0011:242`）。
4. **不宣称活任务迁移**（`0012:639-640`）。
5. messaging 渠道广度 / 更多远程执行后端被划到独立轨道，**不得拖慢 Web-first 日循环**（`0038:36-39,145-150,164-174`）。
6. **ACP / IDE 客户端面被显式否决并用测试锁死**：ADR 0044 仍 Proposed，但 `packages/gateway/src/programmatic-interface-boundary.test.ts:8-20` 断言 `server.ts` 不得出现 `registerAcpRoutes|'/acp'` 且 `src/routes/acp.ts` 必须不存在。
7. 节点视图非 Web-first 主线（`packages/web/src/nav-config.ts:124`：`status:'partial', audience:'operations'`）。

**这条清单对本次评估的意义**：Cindy 的很多机制（对等网格、跨设备任务接管、活迁移）在 los 里**已经被裁决为不做**。所以本报告的可迁移项刻意避开了这些方向——D1～D9 全部落在"读模型 / 在线态语义 / 能力面治理 / 预算一致性 / 故障半径"这类**不触碰既有否决**的地带。

---

## 3. 机制映射与四级判定

判定口径：`可直接落地` / `作决策依据` / `仅设计原则` / `不可迁移`。落点必须是本仓真实存在的路径。

### 3.1 `可直接落地`

| # | 机制（领域无关表述） | los 同构问题 | 落点 | 机械验收 |
| --- | --- | --- | --- | --- |
| D1 | **在线态必须是三态，"未知"不等于"离线"**：没有收到该连接代的 presence 时只能做单飞探测，不得据此渲染离线，也不得据此停发 | Web/手机在弱网或新开页面时，`GET /nodes` 的 null/缺失会被 UI 直接渲染成"离线" | `packages/web/src/fleet-card.tsx`、`nodes-page.tsx`、`packages/web/src/nodes-registry-filter.ts` | 新增 UI/投影测试：无 presence 输入 ⇒ 渲染 `unknown` 而非 `offline`；只有显式 `offline` 才禁用操作 |
| D2 | **读模型按"列表轻 / 单项重"分档**：列表级只发"变了"的低频摘要，重流只在打开单项时订阅并显式退订 | 会话列表靠 `GET /sessions` 轮询；手机端打开列表会反复拉全量 | `packages/gateway/src/routes/data/session-routes.ts`（列表级变更投影）+ `packages/web/src` 订阅消费 | 计数断言：一个客户端在列表页每分钟的列表请求数从 N 降到 O(变更数)；打开会话时才建立该 session 的流 |
| D3 | **默认拒绝由"枚举结构"保证，且把"永不允许"的类别从注释固化成可执行的全表扫描不变式（含显式豁免清单）**——未来任何一次"顺手加一项"红在 CI，而不是红在生产 | `requireOperator` 逐路由手写，缺少"全量路由分类完备"的机械证明；也没有"危险模式扫描"这层防线 | `packages/gateway/src/request-context.ts` + 新增 `packages/gateway/src/routes/**` 的分类表与测试 | ① 枚举 server 注册的全部变更类路由，断言每条 ∈ (requireOperator 路径 ∪ 显式公开白名单)；② 对受保护表做**全表正则扫描**（如 `/^auth:/`、裸写库、`*:set$`），命中即失败，已知合法例外进显式 `EXEMPT` 集合；③ 覆盖 `auth.enabled=false` 的降级路径。Cindy 样本：`packages/device-link/src/__tests__/allowlist.test.ts:367-400`（我复核过：`FORBIDDEN` 正则数组 × 遍历全表 × `FORBIDDEN_EXEMPT`） |
| D3b | **权限表与预算表之间加子集不变式**："不给权限表外的项配超时/重试/审计策略"，并给关键预算加"必须大于对端执行预算"的回归锁 | 超时、重试、退避常数散落在多个文件，缺"配了预算但不在受管表里"的机械约束；跨端预算关系靠人记 | `packages/gateway/src/routes/streaming/stream-backoff.ts`、`packages/agent/src/execution-outbox.ts` | Cindy 样本（我复核过）：`allowlist.test.ts:460-470` 断言 `Object.keys(INVOKE_TIMEOUT_OVERRIDES_MS) ⊆ REMOTE_INVOKE_ALLOWLIST`，以及 `:457-490` 的"隧道超时 > 被控端执行预算"逐项锁。los 侧等价物：断言每个自定义超时项都登记在受管通道表内 |
| D4 | **超时/租约预算跨端一致**：接收方的 orphan/outbox 上限必须由发送方全部预算的并集推导，保证接收方绝不先放弃 | stream lease TTL / heartbeat stale 阈值与客户端重连、outbox 重试预算各写各的 | `packages/gateway/src/routes/streaming/ws-routes.ts`、`packages/agent/src/execution-outbox.ts`、`stream-backoff.ts` | 新增断言测试：`max(所有客户端预算) ≤ 接收方放弃上限`；越界即失败（纯常数测试，无需网络） |
| D5 | **非幂等请求必须能区分"发出后结果未知"与"发送前本地拒绝"** | at-least-once outbox + 双租约下，超时被当作"未执行"会造成重复副作用 | `packages/agent/src/execution-outbox.ts`、`packages/agent/src/dead-letter*.ts` | 回归测试：构造"已投递但响应丢失"与"未投递"两种失败，断言前者的重试分类不是"可直接重放" |
| D6 | **失败按爆炸半径分级 + 多实例门禁**：恢复动作默认与故障同半径；扩大半径必须给理由；必须有"≥2 实例、其一静默、其余零感知"的用例 | 车队自愈/部署脚本对单节点症状做全队动作（重启、重连、重放） | `packages/agent/src/fleet-*.ts`、`tools/deploy-to-remote.sh`、`packages/gateway/src/routes/infrastructure/node-routes.ts` | 新增回归：2 节点、其一心跳停止/命令不回，断言另一节点的 lease、命令队列与健康视图零变化 |
| D7 | **"声明的东西必须真的被执行到"**：对每个声明的消费者/队列/通道，启动期断言消费者数 ≥1，否则启动失败并打印是谁声明、谁本该消费、为何没启动 | 治理 job、定时任务、IM 渠道、outbox 消费器存在"注册了但没跑"的静默可能 | `packages/agent/src/governance-jobs-schema.ts`、`packages/gateway/src/server.ts` 的注册面 | 启动期自检 + 测试：故意禁用某消费者 ⇒ 启动失败且错误信息包含声明者与配置原因 |
| D8 | **投影协议的边界规则（窄口径）**：字段只增不改 / 未知字段忽略 / 每个非核心展示块必须带可读兜底 / 修订号对消费端不透明 / 描述符是展示提示而非授权 / 主机侧决定文案 | 每个新模块（todo、work item、scheduled work、feed analysis、governance）都要自带页面 + API + i18n；新增字段缺少统一兼容规则 | `contracts/`（新增或扩展契约约束）+ `packages/web/src/api/` | 契约检查：新增字段只允许可选；契约测试覆盖"缺字段/未知字段"两侧；含 `fallback` 文本的展示块缺失即失败 |
| D9 | **身份必须由服务端在受信通道上绑定，绝不由对端自报**（Cindy：`Envelope.src` 由 server 回填、客户端传值被覆盖；跨账号角色由 server 按已验证账号重写） | **具体缺口已接线验证**：`/nodes/enrollment-tokens` + `/nodes/enroll` + `verifyNodeCredential()` 三件套齐备，但 `x-los-node-credential` 全仓仅 1 处命中（读取方），executor 从不发送 ⇒ 所有节点共享一把 `agentKey`，节点身份不可区分；且未携带 credential 的心跳**不会被拒** | `packages/executor/src/executor-heartbeat.ts`（发送侧）、`packages/gateway/src/routes/infrastructure/node-routes.ts:203-211`（校验侧）、`packages/agent/src/node-enrollment.ts` | 回归：节点 A 用 B 的 credential 心跳 ⇒ 401；缺失 credential（已启用 enrollment 时）⇒ 401 而非放行；`executor_nodes` 能按 token 区分 nodeId |
| D10 | **授权按"操作名 + 角色矩阵"裁决，不按"接口名 + 布尔门"裁决**；拒绝原因是类型化枚举；并显式声明"这只是任务级授权，行级归属必须由执行方另行校验" | 多用户已存在（`operator` / `user`），但授权是逐路由 `requireOperator` 布尔判断，没有"用户 X 对该资源能不能做操作 Y"的矩阵，也没有"执行方需二次校验行级归属"的书面契约 | `packages/gateway/src/request-context.ts:158-168`、`packages/gateway/src/routes/**` | 机械测试：对每个受保护操作断言"角色 × 操作"矩阵的判定结果；未知操作默认拒绝；拒绝原因可被测试枚举（不是自由文本） |
| D11 | **任何"只由实时推送建立"的 UI 状态，必须有等价的快照重建路径**，并在每次中途加入（冷启动/重连/回前台）时调用 | Web 控制台的运行中标记、待审批项、舰队红点等状态若只靠 WS/SSE 建立，刷新或断线后就会永久缺失或永久停留 | `packages/web/src/`（会话页 / 舰队卡）、`packages/gateway/src/routes/streaming/` | 回归：建立仅由推送产生的 UI 状态 ⇒ 断开推送 + 重连（不刷新页面）⇒ 状态被快照重建恢复；反向断言"缺失≠有" |
| D12 | **整表快照与增量推送并发时，用"变更纪元栅栏"拒绝过期的整表响应**，而不是丢弃增量或加锁 | 现状是轮询整表（`GET /tasks` 8s、`GET /nodes` 8s）+ 部分 WS/SSE；一旦给这些页面加增量推送，就会出现"旧整表覆盖新增量"的竞态 | `packages/web/src/api/`、`packages/gateway/src/routes/data/session-routes.ts` | 回归：快照请求在飞行中时注入一条增量 ⇒ 断言旧快照被丢弃并安排补拉，增量不丢 |
| D13 | **昂贵的服务端副作用由"订阅/关注的存在"驱动启停**（首个订阅者到达才启动，最后一个离开即停），而非固定周期轮询 | 节点自动探测是固定 120s（`node-auto-probe.ts:57`），与"是否有人在看"无关；节点页 8s 轮询也永远在跑 | `packages/gateway/src/node-auto-probe.ts`、`packages/gateway/src/routes/streaming/` | 断言：无人订阅/无人在看时昂贵检查停跑；有订阅时恢复；引用计数保证多消费者不互相拆台 |
| D14 | **跨命名空间的凭证/注册类副作用要分区记账 + 为"响应丢失"预留可补偿中间态 + 登出路径必须能绕过串行队列** | 节点 enrollment 凭据、IM 渠道注册、服务实例注册都存在"发出去了但不知道成没成"的窗口；若按单一命名空间记账或把登出排进同一串行队列，会产生错发与自等待死锁 | `packages/agent/src/node-enrollment.ts`、`packages/infra/migrations/047_users.sql` 相邻的注册面、`packages/gateway/src/routes/infrastructure/node-routes.ts:99-123` | 回归：注册请求响应丢失 ⇒ 后续幂等注销收敛；跨命名空间不串用凭证；登出路径不被自身队列阻塞 |

### 3.2 `作决策依据`（它证明了某个方向已被关掉）

| # | 结论 | 证据 |
| --- | --- | --- |
| A1 | **"哑中继 + 每设备持有真相"这条路线对 los 是错的方向**：Cindy 必须自建隧道、可靠传输、IPC 白名单，是因为它的 server 不看 payload。los 的 server 看得到一切（`session_events`），复制这套会引入第二真相源与一整层无收益的传输复杂度 | `packages/device-link-protocol/src/protocol.ts:1-14`；本仓 ADR 0001 / 0002 / 0033 |
| A2 | **"强一致版本门禁"与"能力协商"是二选一，取决于能否强制对端升级**：Cindy 无法强制用户升级手机，所以走 append-only capabilities + 旧端降级；los 的车队可协调升级，所以 ADR 0010 §7 直接要求版本相等。**不要把 Cindy 的协商模式套到车队路径上**；反之，一旦 los 出现"用户自带、不可强升"的客户端，就必须改走协商 | `docs/adr/0010-...md:165-183`；`packages/device-link/src/protocol.ts:124-166` |
| A3 | **不要为了新协议新建共享协议仓**：Cindy 明确"两仓同名协议包是各自消费者的本地实现，不允许跨仓源码 import、Git submodule 或运行时共享依赖；需要相同约束的 parser/validator 应在两仓分别落地，并用相同的有效/无效 fixture 覆盖边界"，并明确"不要建立新的公共协议仓来重新引入发布耦合"。los 的 `contracts/` + 生成物在单仓内是更强形态，**保持现状即为正解** | `docs/dev-rules/protocol-compatibility.md:665-674` |
| A4 | **push 驱逐只能是白名单 + fail-closed**：Cindy 只允许一个"流内自相似、无键控终态、丢帧可由受保护通道自愈"的通道参与 latest-wins，新通道默认不可驱逐。los 的 `session_events` 是 append-only 账本，**丢帧是正确性损失而非退化**，所以不该引入驱逐 | `packages/device-link/src/client.ts:64-120`；ADR 0002 |

### 3.3 `仅设计原则`（只能论证设计合理性，无具体落点）

| # | 原则 | 出处 |
| --- | --- | --- |
| P1 | 区域身份由**构建期受信任地址表**决定，不由远端清单自报；发现歧义不自动猜、任一源异常 fail closed | `docs/auth-realm-routing.md:18-44` |
| P2 | 文档必须显式写出"这不能解决什么"（Cindy 在 remote-desktop 里主动声明来源检查不等于人类同意；共享任务声明"不承诺撤回访客已看到的内容"） | `docs/remote-desktop.md:358-375`；`docs/product-rules/shared-task-mode.md:59` |
| P3 | 凭据记录是单一原子记录并携带作用域（realm），冷启动先按记录作用域解析端点再刷新，禁止退回默认域发 token | `auth-realm-routing.md:120-134` |
| P4 | 多端一致性追求"同一件工作自然继续"，而不是"每端机械拥有相同页面"；冲突与操作归属必须有确定规则 | `docs/product-rules/core-product-principles.md:106-113` |

### 3.4 `不可迁移`（与源领域强绑定，明确排除，防止被误引用）

| # | 机制 | 为什么不可迁移 |
| --- | --- | --- |
| N1 | relay 中继 + 设备网格 + `invoke`/`push` 隧道 | 依赖"每设备持有真相 + 用户账号下的设备互为对等体"这一语义；los 无此语义（见 A1） |
| N2 | `reliable-transport-v1`（分片 / 累积 ACK / 重传 / 代际 / submission 分期确认 / 背压水位） | 它存在的原因是 relay 不持久化、移动网络会丢帧。los 的 WS 已有服务端事件账本 + cursor 重放（`session_events` + `stream_checkpoints` + lease），重放语义由账本给出；自建传输层会**复制**一份保证并制造两套序号体系 |
| N3 | `REMOTE_INVOKE_ALLOWLIST`（驱动对端应用的 IPC 面） | los 没有"对端应用"可驱动；它的对等物是 7 个生命周期命令的枚举，已经更窄且默认拒绝 |
| N4 | `sharedTask` / `providerShare` 跨账号作用域 | los 当前无跨账号共享任务的产品需求；引入即新增授权面。若未来要做，可迁移的只是**形状**（作用域字段与 src/dst 并列、角色由服务端按已验证身份重写、非法范围拒绝且不降级为全设备） |
| N5 | `maker:task-copy` 跨电脑任务复制协议 | 与"用户本地会话记录格式（Codex rollout / Claude / Pi）"强绑定；los 无同等物，其工件传输（ADR 0011）已覆盖所需 |
| N6 | 远程桌面（WebRTC / ICE / 原生采集 / 锁屏与凭据保险库 / 输入注入租约） | 另一条产品线，需要原生模块与 OS 权限面；los 是 web-first，无此需求 |
| N7 | 区域/组织 SSO 双区路由（cn / global） | 依赖"两个独立安装包 + 两个独立数据面 + 组织 SSO"的产品结构 |
| N8 | 远端媒体/语音凭据穿透（`media:fetch`、`voice:credential-sync` 等） | 由"桌面上有本机媒体与已登录的旁路服务"驱动；且 Cindy 自己已把语音凭据穿透标注为待退役的历史例外 |
| N9 | 文件字节走 WebRTC data channel 的 `device-link:file-peer` | 依赖"两端都有浏览器级 WebRTC 与直连可能"；los 是服务端权威 + 工件代理（ADR 0011），bulk 字节走 peer 直连会绕过服务端配额与审计。**可迁移的只有它的方针**："大流量字节绝不走控制/信令通道" |
| N10 | 非对称设备身份（P-256 JWK + thumbprint + challenge）与同 userData 单持有者仲裁（`BEGIN EXCLUSIVE` first-wins、抢不到者不发 relay 连接） | 前者依赖"客户端生成并保管设备密钥"的 native 能力；后者依赖"同一份 userData 目录"这一 Electron 前提。**可迁移的原理**用 D9/D14 表达即可，不需要其实现 |

**比例诚实性**：本次共列出 **15 条 `可直接落地`（D1–D14 + D3b）**、**4 条 `作决策依据`**、**4 条 `仅设计原则`**、**10 条 `不可迁移`**。即约 **45% 可落地**、**42% 用于关闭方向或明确排除**——与"参考实现里 30–50% 不可迁移或仅设计原则"的经验区间大体一致（本样本偏高，因为 Cindy 与 los 在"读模型分片、能力面治理、恢复纪律"这一层确实同构）。

---

## 4. 针对"手机端跨设备查看与管理任务"的具体建议

### 4.1 先明确 los 的手机端形态（现在的实现差异）

- Cindy 的手机端是**原生控制端**（`apps/mobile`，~11k 行 device-link 模块），本地没有 agent、没有会话、没有 DB，一切经隧道到桌面。
- los **没有原生手机端**，也不该以 Cindy 的形态为目标：los 的任务真相在中心库，手机需要的是一条**读模型 + 订阅 + 通知**的路径，而不是隧道。
- **关键反转**：在"看到任务"这一点上 los 现在**比 Cindy 更容易**——`GET /tasks` 本来就返回全部任务，而 Cindy 要建隧道才做得到。los 缺的不是"能不能看到"，而是"**该不该让这个手机看到**"（用户级隔离）、"手机形态"、"推送"和"跨 gateway"。
- 现成最接近的资产是 `wechat-bot` 的 `/m/` 面板（Events / Actions / Sessions + 审批），但它**拉取式、只覆盖运维事件**，可作为补齐起点而不是新建一套。

### 4.2 最小可落地路径（按依赖顺序）

0. **先做用户级读模型隔离（前置，不是体验问题）**：`GET /tasks` / `GET /nodes` / `/operator/events/live` 目前全局可见（§2.3）。**在把任务面暴露给任何手机形态之前**，读模型必须按 `tenant/project/user` 过滤；否则"给手机加个视图"等于把多用户共用的全部任务发给每一台手机。落点 `packages/agent/src/task-runs.ts:333-341`、`task-routes.ts:89-92`、`operator-events-sse.ts:47-51`。
1. **手机可用的读模型（D1 + D2）**：给舰队与会话列表加"未知/离线/在线"三态语义与列表级低频变更流；`mobile-nav.tsx` 已经存在，缺的是数据面分级。
2. **会话重流复用现有 WS/SSE**：`GET /sessions/:id/stream/ws` 已有 lease + cursor + 重放，手机进会话详情时订阅它即可，**不要另造传输**（N2）。
3. **通知契约（若要做）**：目前唯一低成本通道是既有 IM 渠道（telegram / wechat）。若要照 Cindy 的模型，最小字段集是 `category`（done/error/needs-reply）、`collapseId`、`deepLink`、长度上限，且**服务端不落通知正文**（`protocol.ts:139-178`）；再往上才是原生推送 token 与其按账号/域撤销（`auth-realm-routing.md:152-162`）。
4. **能力面治理（D3）**：手机（或任何远程调用方）能触发哪些服务端操作，必须是一张**默认拒绝的枚举 + 完备性测试**；`requireOperator` 的逐点手写升级为"全量路由分类 + 机械校验"。注意 `auth.enabled=false` 时 `requireOperator` 恒真（`request-context.ts:166-168`），分类测试必须覆盖这条降级路径。
5. **节点身份接线（D9）**：在讨论"某台设备属于某个用户"之前，先让节点身份真正可区分——三件套已就绪，只差发送侧与"缺失即拒"。
6. **只有在"要驱动某台设备上的执行体"时才引入节点侧能力面**：届时可迁移的是 Cindy 的 `allowlist` 三条准入判据 + 双层校验 + `allowlistHash` 式跨版本探测 + `inFlight` 非幂等区分（D5）+ 故障半径门禁（D6）。**传输层仍应复用 los 的账本，而不是照搬 reliable-transport**（N2）。

### 4.3 现在就该做的治理投入（成本最低、收益最确定）

- **D6 故障半径门禁**：把 Cindy 的"三个必答问题 + PR 描述门禁"写进本仓 review 约定（落点：`docs/governance/anti-patterns.md` 或 `SKILL.md`），因为 Cindy 用**一次线上事故**证明了三层防线（协议兼容 / allowlist / 单测）对"半径选错"完全免疫。
- **D4 预算一致性 + D7 声明即执行**：两条都是纯常数/启动期断言，成本极低，且正好补上 los 车队"配了但没跑 / 主机先放弃"两类静默故障。

---

## 5. 证据强度与不确定性

### 5.1 高置信（CONFIRMED，本次直接读过）

- Cindy 侧：`device-link` 与 `device-link-protocol` 的协议与策略文件、`topics.ts`、`allowlist.ts` 头注、`invokePolicy.ts`、`remoteResources.ts`、`sessionListTransport.ts`、`client.ts` 前 130 行；`docs/dev-rules/remote-and-mobile-adaptation.md`、`docs/dev-rules/protocol-compatibility.md`（部分）、`docs/product-rules/{core-product-principles,shared-task-mode,task-device-migration}.md`、`docs/auth-realm-routing.md`、`docs/remote-desktop.md`（部分）。
- los 侧（父代理直接读）：`contracts/node-registry.yaml`、ADR 0010、`node-routes.ts`（路由清单 + enrollment 段）、`node-command-routes.ts`、`request-context.ts`（前 90 行）、`streaming/ws-routes.ts`（前 50 行）、`docs/research/2026-08-19-komodo-...md`、`fleet-card.tsx` 头注、`migrations/047_users.sql` 的存在、CLI `help.ts`。
- **父代理独立复核的两条高影响断言**（子代理报告 → 本人重跑证据）：① `listTaskRuns` = `SELECT * FROM task_runs ... LIMIT $1` 无租户过滤（`task-runs.ts:333-341`）；② `x-los-node-credential` 全仓仅 `node-routes.ts:204` 一处且为读取方，`packages/executor/src` 中 `credential` **0 命中**。
- los 侧（子代理提供、父代理抽样复核）：`service_instances` / `node_enrollment_tokens` / `node_commands` / `stream_leases` 等 DDL；`resolveExecutor()` 的 push 选点与 `resolveSSHExecutor()` 的 `spawn('ssh')`；`EXECUTOR_NODE_STALE_MS=60_000` 与 60s reaper；`auth-middleware.ts` 三级鉴权与公开白名单；`operator-events-sse.ts` 的 cross-tenant 注释；`wechat-bot/src/channel/web.ts` 的 `/m/` 拉取式面板；`programmatic-interface-boundary.test.ts` 的 ACP 否决门禁。

### 5.2 中/低置信（INFERRED，动手前必须核实）

- **Cindy 服务端（relay / auth / OSS / 推送）实现不在本仓**，其行为全部来自客户端侧的契约与文档描述。任何"服务端一定如何"的结论都需要另找服务端仓库核实。
- `/nodes/heartbeat` 在"`agentKey` 未配置 + `auth.enabled=true`"时的实际行为：代码路径会落入通用鉴权（非公开白名单，因此需要 operator/JWT/静态 token），但**未起服务实测**——这是安全敏感点，改动前应实测。
- 网关约 300 条路由未全量分类：本次只穷举了 node/service/auth/realtime/task/session/run 相关路径；`/todos`、`/work-items`、`/schedules`、`/provider*`、`/mcp`、`/skills`、`/rules` 的 operator 覆盖情况未逐条核对（D3 的完备性测试落地前必须先做这件事）。
- 多 gateway 是否真的并发跑过未验证：ADR 0012 自述 Phase 2 有 readiness smoke，但未验证真实 `/chat` failover 与跨 gateway 流重放（`0012:13-16,673-675`）。
- `ngrok`(35) / `rsync`(135) 的命中未逐条核对；"运行时传输层无隧道抽象"基于对 `packages/` 的抽样。
- `packages/redaction`、`packages/media`、`packages/memory` 未纳入本次审计；若要做跨设备数据暴露面审计应补查。
- 本报告未运行任何 los 或 cindy 的服务/测试；所有结论均为静态阅读所得。

### 5.3 需要注意的漂移（两个方向都有）

**方向一：Cindy 的文档是带日期的裁决记录，不是当前实现。** 引用时必须连同日期，否则会把已被取代的口径当成现状。本报告中引用的 Cindy 结论均取自文件头的兼容性与规则段，未引用被标注为"已被取代"的验收记录。

**方向二（更重要，且本次已逐条复核）：Cindy 自己的文档与代码也存在多处不一致。** 任何"照 Cindy 文档抄"的做法都会踩到这些坑：

| # | 文档说 | 代码是 | 复核状态 |
| --- | --- | --- | --- |
| 1 | `README.md:23`：online 后每 20s ping、连续 2 周期无 pong 判死 | 桌面覆写 `pingIntervalMs = 15_000`（`apps/desktop/src/main/device-link/index.ts:716-720`），`pongMissLimit = 3`（`client.ts:329`），判死条件是**两个都满足**：misses > 3 且空闲 ≥ 15s×(3+1)=60s（`client.ts:2057-2058`） | **CONFIRMED（本人复核）** |
| 2 | `README.md:124`：被控端对 `create-session` / `fork` 的 `workingDir` 限定到本机已知目录 | `PATH_GUARDED_CHANNELS` 实际是 `maker:create-session → workingDir` + `worktree:create → baseRepo`，**`fork` 不在列**（签名里没有 workingDir，目录继承自源会话）——`apps/desktop/src/main/device-link/dispatch.ts:303-306` | **CONFIRMED（本人复核）** |
| 3 | `device-link-protocol/src/protocol.ts:177`：深链示例 `cindy://devices/<deviceId>/sessions/<sessionId>` | 真实契约是**无 scheme 的应用内路径** `/sessions/<id>?deviceId=<id>`（`mobileNotify.ts:102-108`），且手机端**显式拒绝**任何含 `://` 的深链（`pushRegistrationModel.ts:96`）——照注释改发送端会让推送点击静默失效 | **CONFIRMED（本人复核）** |
| 4 | `index.ts:716-719` 注释：15s ping 把判死"缩到 ~45s" | 按公式实为 60s | CONFIRMED（子代理提供，与 #1 同源） |
| 5 | 手机端计划文档称 worktree 创建、Orca worker 编排"暂不做/V1 不做" | `mobileMakerTransport.ts:1277-1280` 已有 `worktree:*`，allowlist 已放行 `worktree:create`（含 60s 超时）与 `maker:worker:create` | INFERRED（漂移方向明确，但 UI 是否已放出入口未验证） |
| 6 | `MOBILE-PARITY-CHECKLIST.md` 的条目多为未勾选 checkbox，且自述某些能力"尚未实现" | 其中至少 `maker:get-pending-interactions` 已被实现（`mobileMakerTransport.ts:1306`、`[sessionId].tsx:3777`）⇒ 该文件是**契约清单**，不能读作当前 gap 列表 | CONFIRMED |

**对本次评估的影响**：本报告的可迁移项一律以 **Cindy 的代码 + 显式测试不变式**为准（`allowlist.test.ts`、`transport.ts` 常数、`topics.ts` 路由函数、`sharedTask.ts` 权限矩阵），并且在引用文档的地方都把它当作"设计意图"而非"当前行为"。

**方向三：los 侧的一处漂移**：`docs/research/2026-08-19-komodo-review-observability-and-node-management.md:111` 把"los 无外部用户（单 operator token 模式）"作为"不引入细粒度 RBAC"的依据，但 `migrations/047_users.sql` 已建 `users` 表并区分 `operator|user` 角色，`auth-routes.ts:44-57` 还有"首个注册用户强制 operator"的规则。**结论应拆成两句**：授权面已多用户化；数据隔离面仍近似单租户（读模型无 WHERE）。引用旧文档时不要把这两件事混在一起。

## 6. 行动建议（P0 / P1 / P2）

**P0（先堵住"给手机加视图"会放大的问题）**
- `todo-los-read-model-scope`：用户/租户级读模型隔离（§4.2 第 0 条）。落点 `packages/agent/src/task-runs.ts:333-341`、`packages/gateway/src/routes/orchestration/task-routes.ts:89-92`、`operator-events-sse.ts:47-51`；验收 = 非 operator 用户 A 的 `GET /tasks` 不含用户 B 的行（机械用例，不依赖 UI）。
- `todo-los-node-identity-wireup`：per-node 凭据接线（D9）。落点 `packages/executor/src/executor-heartbeat.ts` + `node-routes.ts:203-211`；验收 = 交叉 credential ⇒ 401；启用 enrollment 后缺失 credential ⇒ 401。
- `todo-los-device-unknown-vs-offline`：节点/会话在线态三态语义（D1）。落点 `packages/web/src/fleet-card.tsx`、`nodes-registry-filter.ts`；验收 = 无 presence 输入时渲染 `unknown`。
- `todo-los-budget-consistency-check`：超时/租约预算跨端一致性断言（D4）。落点 `streaming/`、`execution-outbox`；验收 = 纯常数断言测试。
- `todo-los-declared-consumer-selfcheck`：声明即执行自检（D7）。落点 `governance-jobs-schema.ts`、`server.ts`；验收 = 禁用消费者即启动失败。

**P1（补能力面与恢复纪律）**
- `todo-los-route-admission-invariant`：变更路由分类完备性测试 + 危险模式全表扫描（D3）；先补全 §5.2 里未核对的路由清单，并覆盖 `auth.enabled=false` 的降级路径。
- `todo-los-budget-subset-invariant`：权限表/预算表子集不变式（D3b，纯常数断言，成本极低）。
- `todo-los-operation-role-matrix`：把 `requireOperator` 布尔门升级为"操作 × 角色"矩阵 + 类型化拒绝（D10）；先裁决 operator/user 的能力矩阵，再落地。
- `todo-los-node-failure-radius-gate`：故障半径三问进入 review 门禁 + 双节点"其一静默"回归（D6）。
- `todo-los-session-list-change-feed`：列表级低频变更流与订阅分档（D2）+ 整表/增量纪元栅栏（D12）。
- `todo-los-push-state-snapshot-rebuild`：审计所有"仅由推送建立"的 UI 状态并补齐快照重建（D11）；Web 与 IM 面都适用。

**P2（面向未来的客户端形态）**
- `todo-los-subscription-driven-checks`：昂贵检查由订阅/关注驱动而非固定周期（D13）。
- `todo-los-namespace-scoped-credential-ledger`：跨命名空间凭证/注册分区记账 + 补偿中间态 + 登出绕队列（D14）。
- `todo-los-projection-contract-bounds`：投影协议边界规则（D8，窄口径）。
- `todo-los-mobile-surface-decision`：先裁决"手机面走 PWA/响应式 Web、IM 渠道、还是原生 App"；现有资产（`mobile-nav.tsx`、wechat `/m/`、PWA manifest 但无 Web Push）各自能走多远要写清楚，避免在未裁决前建设。
- `todo-los-node-drivable-peer-design`：若要让用户从手机驱动某台设备上的执行体，先出 ADR：能力面枚举 + 双层校验 + 非幂等 in-flight 语义 + 复用事件账本而非自建传输（§4.2 第 6 条）；并显式对照 §2.5 的既有否决（多节点 claim 前置、活迁移）。

---

## 7. 参考来源

**Cindy（参考实现）**
- `packages/device-link/README.md`（拓扑 / 生命周期 / 可靠传输 / 白名单分组 / link-open）
- `packages/device-link-protocol/src/protocol.ts`（`PROTOCOL_VERSION` / `MAX_FRAME_BYTES` / `Envelope` / `ROUTED_KINDS` / `CONTROL_KINDS` / `RelayErrorCode` / `NotifyPayload` / `PresenceSnapshot`）
- `packages/device-link/src/{protocol,topics,allowlist,invokePolicy,remoteResources,sessionListTransport,client,transport,sharedTask,deviceResponsiveness}.ts`
- `packages/device-link/src/__tests__/allowlist.test.ts`（全表扫描不变式 + 预算子集不变式，本人复核）
- `docs/dev-rules/{remote-and-mobile-adaptation,protocol-compatibility}.md`
- `docs/product-rules/{core-product-principles,shared-task-mode,task-device-migration}.md`
- `docs/auth-realm-routing.md`、`docs/remote-desktop.md`、`docs/remote-desktop-credentials.md`
- `apps/mobile/src/device-link/{DeviceLinkContext,topicRegistry}.tsx`、`apps/mobile/src/session/HomeSurface.tsx`、`apps/mobile/src/notifications/{pushNotifications,pushRegistrationModel}.ts`、`apps/mobile/src/device-link/remoteStatus.ts`
- 漂移复核点：`apps/desktop/src/main/device-link/{index,dispatch,mobileNotify}.ts`

**los（目标项目）**
- `docs/adr/{0001,0008,0009,0010,0011,0012,0027,0028,0033,0038,0044}-*.md`
- `contracts/node-registry.yaml`、`contracts/node-command.yaml`
- `packages/gateway/src/routes/{infrastructure/node-routes,orchestration/node-command-routes,orchestration/task-routes,streaming/ws-routes,streaming/sse-routes,streaming/operator-events-sse,data/session-routes}.ts`
- `packages/gateway/src/{request-context,auth-middleware,server-maintenance,remote-executor-circuit,execution-lease-reaper,node-auto-probe,programmatic-interface-boundary.test}.ts`
- `packages/agent/src/{executor-nodes,task-runs,node-enrollment,execution-persistence}.ts`、`packages/agent/src/scheduler/{executor-client,ssh-client}.ts`
- `packages/executor/src/{index,executor-heartbeat,executor-heartbeat-reporter,lease-fencing}.ts`
- `packages/infra/migrations/{002,014,018,023,047,057,058,059,060}_*.sql`
- `packages/web/src/{nodes-page,node-editor,fleet-card,mobile-nav,nav-config,service-page}.tsx`、`packages/web/src/pages/tasks-page.tsx`
- `packages/cli/src/{help,node-commands,cli-http}.ts`、`packages/wechat-bot/src/channel/web.ts`
- `docs/research/2026-08-19-komodo-review-observability-and-node-management.md`（既有节点管理现状表）

**方法**
- `~/.agents/skills/transferable-pattern-audit`
- 决策纪律（如已安装）：`~/.claude/rules/pattern-transfer-discipline.md`

---

## 附：本次审计的执行方式与证据纪律

- 三路并行只读深挖（Cindy 桌面被控/控制端、Cindy 手机端、los 现状），父代理同时直接读关键文档与协议源码；回收后对**将写入本报告的硬断言**逐条复核。
- **父代理独立复核的 4 条**：`listTaskRuns` 无租户过滤；`x-los-node-credential` 仅读取侧一处；Cindy `deepLink` 注释与实现不一致；Cindy `README:124` 与 `PATH_GUARDED_CHANNELS` 不一致。
- 未修改 Cindy 或 los 的任何源码；本报告是本次会话唯一的落盘产物。
- 未运行任何测试或服务；所有行为结论均为静态阅读所得，运行期行为需按 §5.2 的清单实测。
