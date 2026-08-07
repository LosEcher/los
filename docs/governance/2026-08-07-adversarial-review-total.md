# 对抗式盘点·总报告(2026-08-07)

第一次"总-分-总"对抗式盘点的"总"阶段。范围:los 全系统执行链路
(schedule → executor → agent → self-check → telemetry → 治理)。
方法:对抗式(基于易错点假设检验)+ 正面盘点(结构审查批次)结合。
后续:分模块深入(分)→ 汇总验证(总),频次从每日起步,数据积累后由
governance gate 自动降频。

## 一、本次盘点发现的问题(按执行链路顺序)

### 1. 调度层
| 问题 | 严重度 | 状态 |
| --- | --- | --- |
| 远程执行通道"已建成未接线"(5 个调用点全不传 executor) | 高 | ✅ 已修(PR #203 接线) |
| 节点选择随机分配(Math.random,无健康感知) | 中 | ✅ 已修(PR #203 健康排序) |
| approve 同步阻塞 HTTP(长连接跑完整任务) | 中 | ✅ 已修(PR #203 异步 approve,2s 返回) |
| cron 只支持日/周 preset,任意间隔只能用 interval | 低 | 保留(设计约束) |
| 静默降级:无效 templateId fallback 默认模板 | 中 | ✅ 已修(PR #203 fail-fast) |
| 重复 gateway scheduler(3 进程抢任务) | 高 | ✅ 已修(PR #208 bind 清理 + los.sh 单实例) |

### 2. 执行层(agent)
| 问题 | 严重度 | 状态 |
| --- | --- | --- |
| maxLoops=20 硬默认,复杂任务 turn 截断 | 中 | ✅ 已修(PR #203 maxLoops 可配) |
| workspaceRoot 为 gateway 路径,远程节点无效 | 高 | ✅ 已修(PR #205 workspaceRoot 覆盖) |
| run_shell 全链路被 L1 门禁拒(远程也同) | 设计约束 | B backlog(sandbox 升级) |
| self-check stop condition 概念错配(正常完成必 blocked) | 高 | ✅ 已修(PR #200) |
| self-check 延迟 30-80s(DeepSeek 隐藏 thinking tokens) | 高 | ✅ 已修(PR #208,1.9s) |
| codex runtime-adapter 参数过时(-p → exec,run codex 实坏) | 中 | ✅ 已修(PR #206) |

### 3. 观测层(telemetry/事件)
| 问题 | 严重度 | 状态 |
| --- | --- | --- |
| telemetry duration 只测到 headers,不含 body | 高 | ✅ 已修(PR #208 分段计时) |
| self-check telemetry 空 session/trace 无法归属 | 中 | ✅ 已修(PR #208 sessionId 透传) |
| session_events 43 万行 508MB 无 schema 演进 | 中 | event_retention job 已存在,持续观察 |
| task-events >500ms 无告警 | 低 | ✅ 已修(PR #206 warn 插桩) |

### 4. 治理/自举层
| 问题 | 严重度 | 状态 |
| --- | --- | --- |
| 快照→行为改进闭环缺失(quality 只记录不触发) | 高 | 待办(执行层自举) |
| 经验→技能自动提升缺失(全人工) | 中 | 待办 |
| 长期 in_progress todo 无周期性刷新 | 中 | 待办(治理缺口) |
| 静态探测 ready≠真实可用(kimi 假象) | 中 | ✅ 已修(adversarial_review 检查项) |
| 对抗式审查未制度化 | 中 | ✅ 已修(PR #209 daily job) |
| 文档漂移(ADR 0034 状态机) | 中 | ✅ 已修(PR #207) |

## 二、已建立的闭环(本次盘点新增)

1. **对抗式盘点 job**:每日运行,4 项确定性检查(metric_semantics /
   process_residue / stuck_approval / provider_ready_vs_usable),drift 规则
   findingCount+30%,gate 自动降频。首次运行已生效。
2. **self-check 性能闭环**:judge 限制(thinking/maxTokens)+ 超时 +
   分段 telemetry,延迟可观测、可告警、有上限。
3. **gateway 生命周期闭环**:bind 失败清理 + 单实例防护,不再残留
   timer-only 进程。

## 三、剩余待办(分模块处理的输入)

- **A. 自举执行层**:quality 快照 → 自动改进任务;todo 生命周期刷新
- **B. 观测深化**:事件表 schema/retention 强化;task-events 告警接入
- **C. 远程能力**:sandbox 升级(B backlog);NAS34 漂移校验 schedule
- **D. 治理**(2026-08-08 更新):
  - ✅ provider 盘点:7 providers / 1 account(`xai-grok-default` active);
    kimi provider 存在但凭据过期(`expires_at 2026-08-06T15:56Z`,文件
    `~/.kimi-code/credentials/kimi-code.json`)
  - ✅ runtime 工具实际使用验证:codex(`git --version`,输出
    `git version 2.50.1`)与 grok(echo 任务)真实任务经
    `POST /runtimes/:kind/run` 端到端成功,六事件流完整,
    `session_events` 持久化验证(`external-runtime:` source,8 行事件)
  - ⏳ kimi 恢复:凭据文件 mtime 2026-08-06T23:41(北京),access_token
    15 分钟短效已过期但 refresh_token 仍在(678 字符)—— 终端环境
    (有磁盘访问权限)运行 `kimi -p "hi"` 可自动刷新;仅刷新失效时
    才需 `kimi login`。自动化环境 mkdir `~/.kimi-code/sessions/`
    报 EPERM(TCC 限制,非认证问题)
- **E. 待用户确认**:todo-los-context-engineering-phase 已按证据关闭;
  ci-resource-baseline / ci-cd-observability 等 CI 恢复后继续

## 四、方法复盘

对抗式审查发现 3 类常规盘点发现不了的问题:① 指标语义错误(telemetry
只测 headers——我把错误指标当权威);② 失败路径残留(bind 失败留 timer
进程);③ 探测与真实不一致(ready 假象)。结论:对抗式(假设检验)与
正面盘点(系统枚举)互补,已固化为每日 job 持续执行。
