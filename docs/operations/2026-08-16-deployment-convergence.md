# Deployment Convergence — launchd 主承诺路径（Roadmap R5）

> 日期：2026-08-16
> 追踪：`docs/governance/2026-08-16-product-roadmap.md` R5；todo `todo-los-rm-deploy-converge`
> 输入：ADR 0041（晋升门槛 preregistered）、2026-08-09-rollout-runbook.md（drain/restart/ready/smoke）

## 1. 主承诺路径声明（2026-08-16 起）

**macOS launchd 常驻（`com.los.daemon` + `tools/los.sh`）是唯一受支持的部署路径。**
Docker compose 保留为文档化备选，**不承诺**同等支持；任何 docker 使用必须先记录到
`docs/operations/`（避免双承诺——ADR 0041 同款纪律：未记录即未发生）。

选择依据（本机事实，2026-08-16）：

- `com.los.daemon.plist` 常驻，KeepAlive=true，wrapper 30s 健康检查自愈；
- `pnpm run status` 显示 `managed=true`（gateway pid 被 daemon 管理）；
- 生产库 `provider_call_telemetry` 3020 行、`session_events` 75533 行全部来自 launchd
  路径的网关（2026-06-20 起连续运行证据）；
- docker-compose.yml 无真实使用记录（`docker compose ps` 无 los 容器）。

## 2. 备份与恢复（2026-08-16 起有脚本与演练）

```bash
tools/db-backup.sh <label>          # pg_dump 快照 → .los-runtime/db-backups/，保留 14 份
PG_DUMP=/path/to/pg_dump tools/db-backup.sh daily   # 非默认路径时
```

恢复流程（演练版，2026-08-16 实测通过）：

```bash
LIBPQ=/opt/homebrew/opt/libpq/bin
DBNAME=los_restore_$(date +%s)
$LIBPQ/createdb "$DBNAME"                                        # 同 host/port 建临时库
$LIBPQ/pg_restore --no-owner --no-privileges -d "$DBNAME" \
  .los-runtime/db-backups/los-*-<label>.dump
# 校验关键表行数与生产一致，然后 dropdb 清理
```

**2026-08-16 演练证据**（生产 22MB dump → 临时库恢复 → 行数校验全等 → 清理）：

```
session_events: 75533   task_runs: 471   provider_call_telemetry: 3020
verification_records: 79  run_specs: 301  todos: 2832
```

## 3. 升级与回滚（沿用 rollout-runbook，2026-08-09）

主路径日流程不变：`tools/los.sh restart` → `/health` → `/ready` → ops/runtime-health
smoke。升级回滚 = 保留上一版本 change/bookmark + 重跑 restart + 版本确认
（`los.sh` 输出 revision hash）；无自动二进制推送（G11）。

## 4. 30 分钟首跑（新机器流程，2026-08-16 文档化）

1. `pnpm install`（或 Docker 备选路径见 README）；
2. `pnpm run setup`（幂等：环境/依赖/配置/PG → 启动 gateway/executor → 就绪报告）；
3. `bin/los setup` 复查就绪摘要（只报凭证存在性，不打印值）；
4. 首次受控任务：`pnpm run cli -- chat --provider deepseek "inspect the current workspace"`。

## 5. R4 决策窗口检查点（2026-09-16，与 ADR 0041 联动）

数据积累对照（`psql "$DATABASE_URL"` 或 los 查询）：

```sql
-- pairwise 配对量（ADR 0041 §2.1：≥50 组/类，≥30 天）
SELECT evaluation_kind, count(*) FILTER (WHERE created_at > now() - interval '30 days') n30
FROM run_evals GROUP BY 1;
-- effort 采集覆盖（ADR 0041 §2.3：≥30 天）
SELECT count(*) FILTER (WHERE request_meta_json ? 'reasoningEffort') effort_calls,
       count(*) total FROM provider_call_telemetry
WHERE created_at > now() - interval '30 days';
-- 候选 kernel 样本（ADR 0041 §2.2：基线/候选各 ≥30）
SELECT COALESCE(metadata_json->'executionKernel'->>'kind','los') kernel, count(*) n
FROM task_runs WHERE created_at > now() - interval '30 days' GROUP BY 1;
```

"未达标"是合法检查结果（ADR 0041 §5）——报告就绪度，不做晋升。

## 6. 待办（残留缺口，非本迭代范围）

- 备份自动化调度（cron/launchd 定时 `db-backup.sh daily`）——人工演练已通过，自动化未做；
- 恢复的完整 failover 演练（跨机器恢复）——本迭代仅同机临时库验证；
- `los doctor` 扩展备份就绪检查——沿用现有 doctor 输出。
