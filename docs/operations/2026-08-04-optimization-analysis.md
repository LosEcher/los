# Optimization Analysis — Advisory (2026-08-04)

> 资格:`optimizationAnalysisEligible=true`(sample gate
> `sample-gate-k4-20260803` passed,1 pair)。**Advisory 输出,不改变生产
> 行为**;正式采纳需 operator 决策 + focused harness(AGENTS.md 变更规则)。
> 数据全部 [E](DB/事件/实验记录)。

## 1. 样本与 gate 现状

| 项 | 值 |
| --- | --- |
| pairwise 记录 | 1(K4 canary:baseline LOS kernel vs candidate Pi K4,planning disposition) |
| verdict | tie(20:20;baseline 221 completion/267 文本 vs candidate 287/364) |
| gate | `sample-gate-k4-20260803` passed,`optimizationAnalysisEligible=true` |
| 结论 | 管道已通;**样本量不足以下统计结论**(n=1),分析仅具方向性 |

## 2. 观察与优化候选(按预估收益排序)

### A. session 事件风暴(高收益,低风险)— ✅ 已收敛 (2026-08-05)
- 08-03 chat 流观测:单次 run 产生 **200+ 对 `compaction.pre_compact` /
  `compaction.post_compact` 事件**(~300 事件/run);K4 run 同(221 对)。
- 影响:SSE 推送膨胀、每次 compactSession 的 DB 成本(3×count 查询 +
  symbol 汇总 + metrics + INSERT memory_compactions)、memory_compactions
  表增长(200+ 行/run)。
- **根因**:`chat-service-hooks.ts` 中每个 tool transition(succeeded/failed)、
  每 20 个 session 事件都触发一次 `compactSession(checkpoint: true)`;checkpoint
  模式无 dedup,每次全量执行并各发一对 pre/post 事件。
- **收敛方案**(PR #164):checkpoint 节流——两次 checkpoint 最小间隔
  `CHECKPOINT_MIN_INTERVAL_MS = 60s`,事件计数节流窗口内继续累计,10 分钟
  max-interval 兜底保留;`session.completed`/`session.error` 的 final
  compaction 不变。
- **量化证据**(focused harness `chat-service-hooks-storm.test.ts`):
  250 事件 / 200 tool transitions / 5 分钟 run → compactSession 调用从
  **legacy≈212 收敛到 4(reduction 98.1%)**,pre/post 事件 4 对,
  memory_compactions 4 行(1 行/次),recovery checkpoint 与 10 分钟兜底
  行为不变。
- **附带修复**:storm harness 暴露 `ensureMemoryCompactionStore()` 并发竞态
  (两个并发 compactSession 同时执行 SCHEMA → `pg_type_typname_nsp_index`
  重复键);已用 in-flight promise 去重修复(compaction.ts)。
- 消费面确认:pre/post 事件仅走 operator SSE(append-only 审计面),不进
  session_events,replay/recovery 均不消费;恢复数据源 memory_compactions +
  stream_checkpoints(event log)未变。

### B. CI 镜像分裂(中收益,已部分缓解) [E]
- gate-fast/test/drift 用 node24 镜像(pnpm 11.6.0 prepare),web-e2e 用
  legacy node22 镜像(pnpm 9 + corepack 每次下载 11.6.0)。
- 缓解:corepack 重试循环(PR #161)已让 CI 稳定;根治=playwright 镜像重建
  (node24 基础),当前在 node34 构建中,完成后经 docker save/load 传输到
  Windows podman runner。
- 附带:pnpm store 持久缓存(Windows/node34 runner 侧)进一步降低网络依赖。

### C. oracle 资源约束(记录,不改) [E]
- 954MB RAM、`heavy_task_safe=false`、无 file_sync_folders 配置
  (与 node34/mbp 不一致)。任务调度已按能力过滤,无实际风险。

### D. 样本生产自动化(低收益-中期) [I]
- 当前半自动脚本(tools/pairwise-sample-ingest.mts);全自动收集器需
  scheduler 变更,样本量不足前不值得。

### E. K4 内核对比(观察,不行动) [E]
- 单样本 tie;planning 输出长度 candidate 更优(+97 文本)但 token 更多
  (+66 completion);方向性:Pi 在 planning 上输出更充实。样本 ≥5 后再评。

## 3. 结论

1. **建议采纳 A**(事件风暴收敛)——有量化证据,低风险,收益明确。
2. **B 继续执行**(playwright 镜像重建已在途)。
3. C/D/E 维持观察;正式优化决策(如 A)需 operator 批准后以 bounded change
   落地(harness + 回归)。
