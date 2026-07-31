# Static Analysis Reliability & Governance

> 建立于 2026-07-31 全仓分析评估。来源:`los scan`(packages/agent/src/static-analysis)
> + codebase-memory (CBM) 知识图谱。评估方法:规则定义审查 + 按规则抽样对照源码
> + 双通道交叉验证。

## 可信度分级

### A. `los scan` 静态规则

| 规则 | findings (2026-07-31 修复后) | 抽样真阳性率 | 分级 | 依据 |
|---|---|---|---|---|
| `lang.typescript.no-any` | 171 | ~100% | ✅ verified | 全部为 `: any` 类型注解(样本 5/5) |
| `lang.typescript.no-non-null-assertion` | 243 | ~100% | ✅ verified | 全部为 `!` 断言;已豁免 `*.test.ts`(原 58% 在测试) |
| `lang.typescript.no-console-log` + `js` | 73 | ~100% | ✅ verified | 已豁免 packages/cli(CLI 输出即 console)与 xai-oauth-login/firing-range-scan(交互式工具) |
| `lang.typescript.no-as-assertion` | 1508 | ~90%+ | ✅ verified(排除 `as const` 后) | 已排除 `as const` 惯用法(原 198/1726 为误报) |
| `los.state-machine-bypass` (AP1) | 0 | — | ✅ verified | 与 `tools/check-state-machine-bypass.sh` 双通道一致(grep 版与 AST 版均 clean) |
| `los.direct-infra-import` | 0 | — | ✅ verified | infra/db.ts 自身豁免,rationale 声明与实现一致 |
| `los.file-size-gate` | 827 | N/A | ✅ (文档标记) | 非检测,策略由 `tools/check-structure.sh` 执行 |
| `los.duplicate-functions` | 827 | N/A | ✅ (文档标记) | 2026-07-31 从单点噪音规则降级;真重复检测交由 CBM similarity + 人工 |
| `los.no-gateway-root-routes` / `no-package-local-agents` / `no-skipped-hooks` / `todo-fixme-tracking` | 0-低 | — | ✅ verified(结构类) | 与 check-structure.sh/ADR 一致,无命中 |

**结论**:gate 中 error 门槛(仅 `state-machine-bypass`)可靠;warning/info 计数在规则豁免后全部为 verified 真阳性,可用于趋势指标。

### B. CBM 知识图谱信号

| 信号 | 分级 | 依据 |
|---|---|---|
| complexity 热点(register\*Routes 27-51、runAgent 28/539 行) | ✅ verified | 数值两次查询可复现;与源码规模对照一致 |
| alloc_in_loop = 0 | ✅ verified | 无性能分配风险 |
| recursion/loop 风险信号 | ✅ 结论可靠(无生产风险) | 生产代码信号均为正常递归(walkDir/hasCycle/互递归 close/listen);`listProviderAccounts` 证实为 CBM 误报(对象方法委托同名外部函数) |
| similarity 重复代码对 | ⚠️ partial | cli 命令骨架(artifacts/dead-letter/external-summaries/memory 多对互连)结构重复成立;但 `abortErrorFromSignal` 等单定义被误报 → **每对必须人工确认后才能列入 dedupe 队列** |

## 验证协议(新增/修改规则时)

1. **规则定义审查**:确认 pattern/kind 有界(禁止裸函数名/单点 pattern 冒充通用规则)。
2. **fixture 正反例**:每条规则至少一个 positive + 一个 negative fixture(现有
   `static-analysis.test.ts` 模式)。
3. **抽样对照**:变更后从全仓结果抽 ≥5 条/规则对照源码,真阳性率 <90% 的规则
   不得进入 warning 门槛。
4. **交叉验证**:AP 类规则与对应 bash 检查(`tools/check-*.sh`)双跑,必须一致。
5. **豁免须声明理由**:`exclude` 只用于设计性豁免(测试文件、包内入口、CLI 输出),
   并在规则 YAML 注释写明 rationale。

## 趋势指标(与 periodic-analysis 挂钩)

- 每次 `pnpm gate` 输出 warning/info 计数(`check-static-analysis.sh` 已实现);
- 周期报告(月度)记录 warning 总数与分规则计数,只允许下降或持平,
  新增计数须带归因;
- error 数必须恒为 0(硬门槛);duplicate-functions/file-size-gate 文档标记
  规则计数(= 扫描文件数)不计入趋势。

## CBM 治理用法

- similarity 对:人工确认后转入 `todo-seeds` dedupe 队列,确认前禁止直接提取;
- complexity 热点:gateway `register*Routes` 拆 handler 是最高杠杆项,按文件分批;
- CBM 查询结果只作线索,不直接写死到 gate(图索引可能过期,以 `los scan` 为 gate 真源)。

## 复杂度热点处置决策(2026-07-31 记录)

**已完成**:gateway 路由注册函数热点全部清零(5 文件拆解,
51/44/33/31/28 → 全部 <25):execution-experiment-routes、server-maintenance、
run-routes、provider-evidence-routes、runtime-adapter-routes。
模式:内联 handler 提取为命名函数 / 定时任务提取 timer helper,
逻辑逐字搬运 + DB 集成测试 + 全量 gate 验证。CBM 重扫确认闭环。

**剩余 >25 函数分类处置**(不再无差别批量拆解):

| 分类 | 函数 | 处置 |
|---|---|---|
| 领域复杂性(不拆) | `runAgent`(28, loop.ts)、`compactSession`(31, memory)、`runGaLoop`/`runGovernanceSweep`(33/28, agent, **GA 自愈禁用中**)、`readRuntimeEvidenceGraph`(28) | 复杂度即业务逻辑;拆分需先有测试设计与独立批次,禁止在无测试覆盖下重构核心路径 |
| 装配类(按需) | `setupLiveEventPush`(27, sse-routes)、`createWxPusherIngress`(33, wechat) | 接近已拆模式,若触及这些文件时顺带处理 |
| 前端低收益(不拆) | `eventPayloadSummary`(36)、`ChatPage`(32, web) | 展示逻辑,拆分收益低 |

**防增量原则**:
- 新 `register*Routes` 保持薄(仅路由接线,handler 独立命名函数)——作为代码评审惯例,
  并靠 `.large-file-baseline.txt` 防文件膨胀;
- 新核心函数复杂度 >25 时,先写测试再考虑拆分,不追求所有函数低复杂度。
