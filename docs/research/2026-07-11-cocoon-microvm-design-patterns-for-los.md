# Cocoon / Sandbox 设计学习：低开销高性能机制与 los 可吸收模式

> **日期**：2026-07-11  
> **对象**：  
> - https://github.com/cocoonstack/cocoon （MicroVM 引擎，Go + KVM，MIT）  
> - https://github.com/cocoonstack/sandbox （AI agent sandbox 控制面，建立在 cocoon 上）  
> **立场**：**不引入依赖**。本文只抽取设计机制，映射到 los 现有架构可落地的模式。  
> **边界**：外部代码库是 pattern reference only（`AGENTS.md`）。任何可选 MicroVM 后端需单独 ADR + operator consent，不在本文授权范围内。

---

## 0. 结论（先读这节）

| 问题 | 答案 |
|------|------|
| cocoon 是什么 | 轻量 MicroVM 编排：Cloud Hypervisor / Firecracker、OCI 镜像、COW/reflink 快照克隆、CNI 网络 |
| 高性能从哪来 | **分层热路径**：warm pool ≫ snapshot clone ≫ cold boot；共享只读层 + 写时复制；零常驻 daemon；后端按能力分档 |
| 低开销从哪来 | 每 VM 一进程、FC 路径无 UEFI/无网卡、balloon 归还内存、hugepages、O_DIRECT 控缓存、内容寻址去重 |
| 能否直接给 los 用 | **不要**把 cocoon 并入 monorepo 或替换 executor |
| 学什么 | warm-pool claim、golden snapshot、capability-driven 后端选择、跨模块 GC 协议、I/O 路径分层、协议 golden fixture |

**一句话**：cocoon 把「创建隔离环境」的成本从「冷启完整系统」压成「从预热池取一个已就绪实例」；los 应在 **executor claim / 工具策略 / 资源回收 / 证据分层** 上学习同一套经济模型，而不是搬运 hypervisor。

---

## 1. 系统定位与分层

### 1.1 两层产品，不要混谈

```
┌─────────────────────────────────────────────────────────┐
│  sandbox（agent 产品面）                                  │
│  warm pool · claim/release · silkd 客内 daemon · SDK/MCP │
└──────────────────────────▲──────────────────────────────┘
                           │ 调用
┌──────────────────────────┴──────────────────────────────┐
│  cocoon（基础设施面）                                     │
│  image · vm · snapshot · CNI · CH/FC · GC · doctor       │
└─────────────────────────────────────────────────────────┘
```

- **cocoon**：Docker 式 CLI 的 MicroVM 引擎；职责是「把镜像变成可起停的 VM，并支持快照分叉」。
- **sandbox**：在 cocoon 上叠加 **warm pool + 控制面 + 客内 agent 协议**，把 MicroVM 变成 agent 可 claim 的执行槽。

los 更接近 **sandbox 的控制面问题**（claim 节点、跑任务、回收），而不是 cocoon 的 **VMM 问题**。学习重心应放在 **调度与池化语义**，底层隔离实现可继续是 tool_policy / 未来可选后端。

### 1.2 与 los 的正交关系

| 维度 | cocoon / sandbox | los |
|------|------------------|-----|
| 语言与运行时 | Go / Rust 客内 daemon，Linux+KVM | TypeScript monorepo，Node，darwin+linux |
| 核心对象 | VM / snapshot / image blob | task_run / run_spec / session_event / node |
| 真相源 | 本机 DB + 文件系统 | PostgreSQL + contracts |
| 成功标准 | 启动延迟、密度、隔离边界 | 状态机不变量、可验证完成、证据可回放 |
| 默认隔离 | MicroVM（硬件虚拟化） | `sandboxMode` 策略（readonly / workspace-write / sandbox） |

二者互补，不重叠：los 缺的是 **可选的强隔离执行槽**；cocoon 缺的是 **RunContract / verification / 多通道 operator**。

---

## 2. 低开销与高性能是如何实现的

性能不是单点优化，而是 **成本阶梯 + 共享只读 + 按需写 + 能力分档**。

### 2.1 成本阶梯（最重要的产品设计）

sandbox 公开的延迟模型（文档声称，量级用于理解，非 los 本地复测）：

| 路径 | 大致成本 | 机制 |
|------|----------|------|
| **Warm claim** | 亚毫秒 | 池中已有就绪 VM，只做所有权移交 |
| **Pool miss → golden clone** | 数十毫秒 | 从 golden snapshot reflink/恢复，新身份 + 新网络 |
| **Cold boot** | ~200ms 量级（裸机） | 完整 VMM + 精简 boot chain |

**设计含义**：系统把「最常见请求」做在最便宜的路径上，贵路径只在 miss 时走。  
这与 los 的 `executor_nodes.candidate` + lease claim 是同一类思想——**先选 ready 槽，再创建新槽**——但 los 目前几乎没有「预热的执行槽池」，每次任务都是冷逻辑路径（进程可能已在，但 workspace/上下文未必预热）。

### 2.2 零常驻控制面 daemon（cocoon 本体）

- **一 VM 一 hypervisor 进程**，无全局常驻 VMM 守护。
- 控制逻辑在 CLI / 短生命周期操作里完成；状态落在 on-disk record + runDir。
- 收益：空闲时几乎零开销；崩溃域隔离（一个 VMM 挂了不拖垮「总控」）。
- 代价：没有中心进程时，跨操作一致性依赖 **文件锁 + 模块锁 + 显式 GC**。

**对照 los**：gateway/executor 是长驻的（正确，因为要心跳、队列、SSE）。可学的不是「去掉 daemon」，而是 **空闲路径不要占重资源**——例如 executor 上报 `memory_pressure` 时，调度应避开 heavy_task，而不是所有节点同等 claim。

### 2.3 共享只读层 + 写时复制（COW / reflink）

镜像与克隆路径的关键：

1. **内容寻址 blob**（SHA-256）：相同层只存一份。
2. **OCI → EROFS 只读层** + **ext4 COW 可写盘**：多数文件系统数据不复制。
3. **FICLONE ioctl（btrfs/xfs/bcachefs）**：`ReflinkCopy` 优先 O(1) CoW 克隆文件，失败再 SparseCopy。

源码意图（`utils/reflink_linux.go`）：

```text
ReflinkCopy(dst, src):
  try FICLONE  → 成功则几乎零字节拷贝
  else SparseCopy → 保底正确性
```

**性能本质**：克隆成本与「脏数据量」相关，而不是与「镜像全量大小」相关。  
golden snapshot + clone 之所以快，是因为 **内存快照恢复 + 盘 reflink**，不是 `cp -a` 整个 rootfs。

**对照 los**：

| 可学映射 | 说明 |
|----------|------|
| 只读 base + 可写 overlay | worktree / 任务 workspace 应用「共享只读依赖缓存 + 任务私有写层」，避免每任务 `pnpm install` |
| reflink 思想 | 大 artifact / file-sync 在同 FS 上优先 clonefile/copy-on-write，而不是全量读流 |
| content-addressed cache | provider probe 结果、compat evidence、eval fixture 按 hash 去重，避免重复落库 blob |

### 2.4 后端分档：按能力选实现，不让用户选实现

sandbox **禁止用户选择** CH vs FC，而由 claim 语义推导：

| claim 网络模式 | 后端 | 含义 |
|----------------|------|------|
| `net=none`（默认 hardened） | Firecracker | 无 NIC，vsock only，攻击面最小，密度最高 |
| `net=egress` | Cloud Hypervisor | 需要出站网络时才付更重成本 |

Firecracker 路径：

- ~125ms 启动量级、&lt;5 MiB 开销（文档）
- 无 UEFI、无 qcow2、无 Windows、单队列网卡（若有）
- 用功能换密度

**设计原则**：**默认走最便宜且最安全的路径；只有声明需要更强能力时才升级**。

**对照 los**：

| 现状 | 可学 |
|------|------|
| `sandboxMode: readonly \| workspace-write \| sandbox` | 语义正确，但 `sandbox` 真 OS 隔离常未落地 |
| 节点 `capabilities.run_agent` / `heavy_task_safe` / `sandbox` | 已有 taxonomy（ADR 0010），应用 **claim 时强制匹配**，不要「有节点就派」 |
| provider 全 advisory | 类似「后端分档」：未 promotion 的 provider 只允许只读探针类任务 |

### 2.5 内存与 I/O 路径工程

文档与实现中的具体手段：

| 机制 | 作用 |
|------|------|
| **virtio-balloon ~25%**（≥256MiB） | 空闲内存归还 host；deflate-on-OOM / free-page reporting |
| **hugepages 自动探测** | 有则用 2MiB huge pages 降 TLB 压力 |
| **只读 base：`direct=off`** | 共享页缓存，多 VM 读同一 base 受益 |
| **可写 COW：`direct=on`（默认）** | 避免 host page cache 被脏写撑爆 + guest flush 风暴 |
| **多队列 virtio-net/blk** | 每 vCPU 队列对；queue-size 可按 bulk vs latency 调 |
| **TC redirect 无桥数据面** | TAP↔veth ingress mirred，少一层桥转发 |
| **offload** | TSO/UFO/csum + VNET_HDR，减少主机 CPU 拷贝 |

**可学抽象（不依赖 KVM）**：

1. **读共享 / 写隔离** 的缓存策略（只读层可缓存，写层直通或限额）。  
2. **按工作负载调 buffer**：大 artifact 传输 vs 低延迟 RPC（los 的 SSE/WS/tool 结果）不要共用同一缓冲策略。  
3. **内存压力反馈进调度**：los 节点已有 `resource:memory_pressure` warning——应变成 **调度硬约束或降权**，而不是仅展示。

### 2.6 精简 boot chain（sandbox）

```
VMM → 未压缩 kernel (PVH)
    → ~1.5MB 静态 initramfs (sandbox-init)
    → 解析 virtio-blk serial（无 udev 轮询）
    → EROFS layers + overlay + COW → switch_root
    → 裁剪过的 systemd + silkd
```

冷启快不是因为「虚拟化免费」，而是 **砍掉用户态启动税**：无完整发行版冷启动路径、固定 cmdline 契约、可测的 phase timing（`sandbox.trace=1`）。

**对照 los agent loop**：

- 每次 run 的「冷启税」是：loadSpecs、provider discovery、工具 registry、session 装配。  
- 可学：对 **高频路径** 做预装配 / 缓存（session-scoped tool registry、spec load 按文件集缓存但 **AP5 要求每 phase 重载适用 spec**——缓存键必须含 mtime/version）。  
- 可观测：像 boot phase µs 一样，对 loop 的 setup / first-token / tool-batch 打阶段计时，进入 session_events 或 diagnostics。

### 2.7 快照作为一等公民

快照捕获：内存 + 盘 + 设备状态 + 拓扑元数据。  
clone：新身份、新 NIC/MAC/IP，CPU/内存/盘形状固定于快照时刻。  
export/import：跨机 golden；`--to-dir` 适合 NFS/rsync。

**经济模型**：把「昂贵的环境准备」资本化成 **可克隆资产**，运行时只付「差异 + 身份」。

**对照 los**：

| 资产 | 今日 | 可学方向 |
|------|------|----------|
| RunSpec / plan | 已持久化（AP2） | 把 **approved plan + tool policy + workspace digest** 当作可 resume 的「逻辑快照」 |
| answer resume | 部分 | durable wake/retry（P2-M1）= 逻辑层 restore |
| eval / firing-range | 弱 | golden workspace snapshot（git worktree 或 rsync 目录）+ claim 池，而不是每次从零装依赖 |
| procedural memory | ADR 0020 | 高置信候选类似 golden：不要每 session 重学 |

### 2.8 跨模块 GC：一致性优先于激进回收

`gc.Orchestrator.Run`：

```text
TryLock 全部模块（任一 busy → 整轮 abort，fail-closed）
→ 各模块 readSnapshot
→ 交叉 resolveTargets（例如 image 看 VM/snapshot 是否仍引用 blob）
→ collect
→ 结构化 summary 日志
```

特性：

- **忙则跳过整轮**，不做半一致性删除。  
- orphan / stale-pending / LRU 多准则可组合。  
- `LastAccessedAt` 仅在 restore/clone/export/import 更新，**list/inspect 不算访问**（避免监控拖活数据）。

**对照 los**：

| 表面 | 现状 | 可学 |
|------|------|------|
| migration_drift / wiring baseline | grandfather + ratchet | 已对齐「拦新增、旧债基线」 |
| outbox 历史水位 | P1-O0 待决策 | 同 GC：禁止启动全量广播；watermark + orphan 清理 |
| dead_letter / file-sync | 有部分 DLQ | 周期 reaper 应用 **跨表引用解析**（task 仍活则不 reap artifact） |
| session_events 噪声 | 已压 governance noop | LRU/age 策略可借鉴到 audit 可见性与压缩 |

### 2.9 控制面与客内协议分离（sandbox）

```
SDK/HTTP ──► sandboxd（节点）── byte relay ── vsock ──► silkd（客内）
                 │
                 └─ memberlist：warm-count gossip + MOVED 式 redirect
```

- **控制面**负责池、claim、计量、审计、placement。  
- **数据面**负责 exec/fs/pty 字节流，不绕控制面 JSON 灌大 payload。  
- **协议 golden fixture** 跨 Rust/Go/Python 共测，防 wire drift。

**对照 los**：

| 已有 | 缺口 / 可学 |
|------|-------------|
| gateway 注册 + executor HTTP/NDJSON | 大 artifact 已有独立 transfer 面（好） |
| OpenAI-compat / WS / SSE 多入口 | 应保持「控制意图」与「流式字节」分离（勿在 session_event 塞原始 transcript 大块——ADR 0015 已约束） |
| contracts YAML | 缺可执行 codegen（P1-C*）；golden fixture 思路可直接用于 run-stream event union 测试 |

### 2.10 运维预检与可调试性

- `doctor/check.sh`：环境 PASS/FAIL + `--fix` / `--upgrade`。  
- `vm debug`：生成可复制粘贴的 hypervisor 命令。  
- `vm status --event`：fsnotify 事件流给脚本/集成。  
- PID ownership 校验后再 signal，避免误杀。

**对照 los**：`pnpm run doctor` / `status` 已有；可加强：

1. doctor 输出与 `/nodes` API 一致（今日 doctor 曾显示 `0 nodes` 与 API 三节点 online 不一致）。  
2. 失败 run 输出「可粘贴的最小复现命令」（provider probe、单测、focused gate）。  
3. executor stop 路径写 offline 的证据可脚本化（SKILL Runtime Truth 已要求）。

---

## 3. 可在 los 中学习利用的关键片段

下列条目 **只谈模式落地**，不引入 cocoon 包或二进制。

### 3.1 高优先级（与现有 P1/架构直接咬合）

#### L1. Claim 成本阶梯（Warm → Clone → Cold）

**cocoon**：warm pool → golden clone → cold boot。  
**los 映射**：

| 阶梯 | los 含义 | 落地表面 |
|------|----------|----------|
| Warm | 已有 `candidate=true`、低 queueDepth、能力匹配的 executor | `selectExecutorNode` / lease claim |
| Clone | 可复用的 workspace 模板 / prebuilt worktree / 预装依赖缓存 | executor 本地 cache + file-sync |
| Cold | 新节点上线、ensure stores、首次 provider 探测 | bootstrap / `ensureAllAgentStores` |

**建议**：

1. 调度日志显式标记 `placement_tier=warm|degraded|cold`。  
2. `memory_pressure` / `heavy_task_safe=false` 时 **禁止 warm 假阳性**（节点 online 但不可接重活）。  
3. 与 P1-L* lease fencing 一起设计：claim 必须带 capability vector，不只 nodeId。

#### L2. 能力驱动后端选择（用户不选实现）

**cocoon**：`net=none`→FC，`net=egress`→CH。  
**los 映射**：

```text
run_spec.toolMode / sandboxMode / risk
  → 解析 required capabilities
  → 过滤 executor_nodes.capabilities
  → 无匹配则 block 并写 session_event，而不是静默降级到不安全路径
```

**特别注意**：`sandboxMode=sandbox` 但节点只有 `tool_policy` 时，应 **fail-closed 或显式降级事件**，与 cocoon「无能力不上车」一致。今日 `tool-resolver` 在无 OS sandbox 时 warn 并限制 L2——方向对，应把该决策 **持久化进 evidence**。

#### L3. 跨模块 GC 协议（Outbox / DLQ / drift）

**cocoon**：全模块 TryLock → 交叉引用 resolve → collect；busy 则整轮 abort。  
**los 映射（P1-O / L / 治理 job）**：

1. outbox publisher 与 session_events 的职责切分（通知 vs 回放）先决策（O0）。  
2. reaper 不得只看单表 lease 过期；要解析 **task_runs ↔ agent_tasks ↔ run_specs** 引用。  
3. GC/sweep job：任一相关锁忙则 skip，并记 `governance.gc.skipped` 类 audit 事件（已有 governance 噪声治理经验）。

#### L4. 读共享 / 写隔离 的资源策略

**cocoon**：只读 base 走 page cache，写盘 O_DIRECT。  
**los 映射**：

1. **Spec / identity / model-profile**：进程内只读缓存 + version 失效（AP5：phase 边界校验版本）。  
2. **CBM / 符号缓存**（P1-CA1）：key 必须 session 隔离；共享的是只读索引，不是 call 态。  
3. **file-sync**：大只读 tree 可内容寻址缓存；可写路径限速 + DLQ（已有部分）。

#### L5. 控制面与数据面分离

**cocoon**：sandboxd claim + vsock 字节中继。  
**los 已有雏形**：artifact 独立 URL、NDJSON run stream、SSE operator attention。  
**加固**：

- session_events 只存 **摘要与指针**，大输出进 artifact store（ADR 0015 一致）。  
- operator steering 走控制事件，不与 token stream 混协议。  
- 契约层用 **golden event fixtures** 做跨包 round-trip（学 silkd protocol/fixtures）。

### 3.2 中优先级（性能与密度）

#### L6. 阶段计时与 placement 指标

学 `sandbox.trace` boot phase µs：

- loop：`setup_ms`、`first_model_ms`、`tool_batch_ms`、`transition_ms`  
- executor：`claim_wait_ms`、`queue_delay_ms`  
- 进入 diagnostics / run metrics，而不是只靠日志

#### L7. 内存压力闭环

节点已报 `resource:memory_pressure`：

1. readiness 增加 warning→blocker 阈值（可配置）。  
2. 调度权重下调或拒绝 `heavy_task_safe` 任务。  
3. 治理 sweep 汇总「压力下仍被 claim」为 drift。

#### L8. Golden 环境资产

不为 MicroVM，而为 **可复用 workspace 模板**：

- eval / compat probe 的固定 fixture 目录  
- `pnpm` store / build cache 节点级共享  
- worktree 从模板 clone（git worktree 或目录拷贝策略写清）

#### L9. Doctor 与 API 真相一致

学 cocoon doctor 与运行时同源检查：

- `pnpm run doctor` 应读取与 `/nodes` 相同的 registry 行  
- 区分 `configured nodes` vs `online candidates`

### 3.3 低优先级 / 明确不做

| 模式 | 为何暂不做 |
|------|------------|
| 引入 cocoon/sandbox 依赖 | 需 Linux+KVM；与 monorepo TS 边界冲突；非 P1 |
| 替换 los 状态机为 VM 生命周期 | 对象模型不同；AP1–AP3 不可替换 |
| 全局零 daemon | gateway/executor 必须长驻心跳与队列 |
| 默认 net=none 式全隔离 chat | 破坏本机 workspace 开发体验；仅高风险路径值得 |

---

## 4. 设计原则提炼（可写进团队口径）

从 cocoon/sandbox 抽出、与 los 价值观兼容的原则：

1. **热路径补贴，冷路径诚实计价**  
   常见操作必须最便宜；昂贵操作要可观测、可配额。

2. **默认最小能力，声明后升级**  
   安全与密度优先；网络/写盘/重型工具按需打开。

3. **共享不可变，隔离可变**  
   只读层极大共享；可变状态小、有生命周期、可 GC。

4. **一致性优先于激进清理**  
   锁不全则整轮跳过，胜过半删除。

5. **控制面小，数据面直**  
   意图、审批、lease 走控制面；大字节走专用通道。

6. **实现可换，契约不换**  
   CH/FC 对用户透明；los 侧 provider/node/sandbox 后端应对 RunContract 透明。

7. **证据与性能指标同级**  
   快而不自知 = 不可运维；阶段耗时应进账本或 diagnostics。

---

## 5. 与 los 路线图的挂接（不新开依赖）

| 学习项 | 挂接任务 | 类型 |
|--------|----------|------|
| L1 placement tier | 调度/lease（P1-L*）+ 节点 readiness | 实现增强 |
| L2 capability claim | ADR 0010 执行侧硬化 | 实现增强 |
| L3 交叉引用 GC | P1-O outbox 水位 + reaper | 决策 + 实现 |
| L4 缓存读写分层 | P1-CA1 CBM；spec loader | 实现 |
| L5 golden stream fixtures | P1-C1/C2 契约 | 测试基建 |
| L6 阶段计时 | diagnostics / session metrics | 可观测 |
| L7 memory_pressure 调度 | executor readiness | 小改 |
| L8 golden workspace | eval / firing-range | 运维 |
| L9 doctor 对齐 API | `tools/los.sh doctor` | 卫生 |

**明确不挂接**：cocoon 安装、sandboxd 部署、MicroVM 镜像构建——需未来独立 ADR，且仅 Linux executor 节点 opt-in。

---

## 6. 反模式：从 cocoon 学「不要怎么做」

1. **不要**把「隔离」做成用户可选的底层开关（用户选 FC/CH）；应做成 **策略推导**。  
2. **不要**在 list/inspect 类只读 API 上刷新 LRU（污染「最近使用」语义）。  
3. **不要**在 GC 部分成功时继续删（半一致比暂时泄漏更糟）。  
4. **不要**用全量拷贝冒充 clone（无 reflink/COW 时要诚实显示成本）。  
5. **不要**把控制 JSON 与大文件字节塞进同一通道还假装低延迟。

---

## 7. 证据与信息源

| 源 | 用途 |
|----|------|
| cocoon README / docs（vm, images, snapshots, networking, gc, firecracker） | 机制与公开性能主张 |
| `utils/reflink_linux.go`、`utils/hugepages.go`、`gc/orchestrator.go` | 实现级证据 |
| sandbox README + cocoonstack.github.io/sandbox | warm pool / silkd / 控制面 |
| los ADR 0010、0015、0016、0020；`tool-resolver.ts` sandboxMode | 映射锚点 |

性能数字均来自上游文档，**未在 los 环境复测**；落地任何调度阈值前需本地 baseline。

---

## 8. 总结

Cocoon 高性能的内核不是「用了 Firecracker」这一句，而是：

1. **把创建成本摊到池与快照上**；  
2. **用共享只读 + CoW 把复制变成元数据操作**；  
3. **用能力分档避免为所有负载付最高规格**；  
4. **用 fail-closed 的跨模块 GC 和清晰控制/数据面保持系统可长期运行**。

los 应吸收的是这套 **资源经济与调度哲学**，用在 executor claim、能力匹配、缓存分层、outbox/reaper、契约 golden tests 和可观测阶段计时上。  
**不引入 cocoon 二进制或包**；若未来 Linux 节点要做真 MicroVM sandbox，另开 ADR，且默认路径仍保持 tool_policy + workspace 语义。

---

## 附录 A. 速查：机制 → los 关键词

| Cocoon/Sandbox | los 关键词 |
|----------------|------------|
| Warm pool claim | candidate node + lease |
| Golden snapshot clone | worktree/template + plan resume |
| net=none → FC | sandboxMode/capabilities 推导 |
| FICLONE / COW | artifact cache / file-sync |
| Balloon / memory pressure | node warnings → scheduler |
| GC lock-all | outbox watermark / reaper |
| silkd vsock protocol | artifact stream + contracts fixtures |
| doctor --fix | `pnpm doctor` + registry 同源 |

## 附录 B. 非目标清单（本文承诺）

- [x] 不添加 cocoon/sandbox 依赖  
- [x] 不修改 packages 运行时以「接入」MicroVM  
- [x] 仅产出 research 文档，供 P1 与后续 ADR 引用  
- [ ] 本地复测 sandbox 延迟数字（未做）  
- [ ] 编写 ADR 引入可选后端（未授权）
