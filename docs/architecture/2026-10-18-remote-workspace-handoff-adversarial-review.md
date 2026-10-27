---
subject: 多设备 agent 执行、Workspace Lease 与 losvault 存储边界的对抗性审查
auditedRev: 8461a263be68 (los git HEAD，2026-10-18)
readOnly: true
method:
  - 本会话真库 SQL（task_runs / run_specs / scheduler_decisions / executor_nodes）
  - 源码阅读（placement / managed-workspaces / file-sync / artifact / project-store）
  - Codex CLI 只读评审（失败，见 §2）
  - ChatGPT Web 对抗性评审（egolite，2026-10-18，免费版）
---

# 多设备 agent 执行：对抗性审查与分批计划（2026-10-18）

## 1. 结论

1. **不要在第一天就实现完整 Workspace Lease 平台。** 先用一个真实任务证明“M1 → 远端节点 → 结果回收到 M1”的闭环可重复、可验收，再把已验证的协议抽象成 Lease。
2. **losvault 不做热工作区。** 边界保持：git 管已提交源代码；lease 管运行中 worktree；CAS/artifact 管 patch、日志、构建产物；losvault 管加密快照、灾难恢复与异地副本。
3. **控制面保持单写者。** 现阶段不做多控制器、分布式数据库、自动故障转移；先保证单写者可恢复、可备份。
4. **Cell 只是拓扑分类，不是安全边界。** 若没有按 task_run 授予的执行身份、数据级别、凭据和网络出口规则，Home/Cloud/Vendor 标签不会阻止数据外流。
5. **移动端先做 triage，不做执行。** DSH access-gate + dsh-mobile 已能提供 Tailscale HTTPS、访问码、Web Push；缺的是 los 任务的统一 inbox 和审批/阻塞推送。

## 2. 参与与证据

### 2.1 Codex CLI（失败，留档）

尝试：

```bash
codex exec --sandbox read-only -C <los> -o /tmp/codex-adversarial-review-20261018.md - < prompt
```

失败原因（两层，均非评审结论）：

- 默认 `model_provider = custom`（PackyCode）需要外部认证助手 `packycode-token-keychain`；本次进程报 `No such file or directory`，随后 401。
- 改用 `-c model_provider=openai` 后，`gpt-5.5` 被 ChatGPT 账号拒绝：`The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.`

后续又试了 `gpt-5.1-codex` / `gpt-5.1` / `gpt-5` 三个模型，均被 ChatGPT 账号拒绝（同样的 `model is not supported`）。

⇒ **本轮没有 Codex 评审输出。** 不把失败当成“Codex 同意/反对”。修复认证或多模型路由后可重跑；prompt 已保留在 `/tmp/codex-adversarial-review-prompt-20261018.md`。

### 2.2 ChatGPT Web（egolite，已登录）

会话：`https://chatgpt.com/c/6ad454b7-acc0-83ea-927a-17b355dae2a0`（标题“红队架构评审”，免费版）。
输入是本会话上一轮的事实基线与候选方案；输出是外部、不可信数据，仅作对抗性意见，不当作事实来源。

它给出的核心反对意见（摘要）：

| 反对点 | 内容 | 对本方案的处置 |
|---|---|---|
| **最大风险是闭环未证明** | “控制面已经具备分布式调度的外形，却没有建立可验证的执行闭环；现在加 Lease/CAS/Cell 可能只是复杂化一个尚未证明有用的远程执行系统。” | **接受**。P0 改为单任务端到端 spike，不先做平台 |
| **不要把 git/CAS/losvault 叠成三个工作区层** | 三套内容机制都参与热路径会产生多份身份、失效规则和恢复语义 | **接受**。四条边界写死（见 §3） |
| **Cell 不是安全边界** | 拓扑标签不能自动限制文件访问、凭据、出口、结果回传 | **接受**。补“按 task_run 的执行身份 + 数据分级” |
| **losvault 不应做统一工作区** | 快照恢复语义不适合并发工作区协议；4.1 GB/1228 s 只是试点，不证明长期吞吐 | **接受**。只做加密冷备/制品 |
| **Lease 的五个失败场景** | baseRevision 不一致、dirty/untracked 漏项、双写、缓存键不全、崩溃/分区/重复提交 | **接受**。写成 §4 的机械验收 |
| **只做一件事** | 先做“交付—执行—封存—回收到独立目录验证”的闭环，连续 20 次 + 故障注入 | **接受**。作为 Batch 1 |
| **现在不该做** | losvault 双向同步、多控制器/分布式 DB、跨 Cell 自动迁移、通用 DAG 调度器、全量预同步、把 DSH 与 los 强行合成一个状态机 | **接受**。列入拒绝清单 |

## 3. 修订后的边界（写死）

| 层 | 唯一权威 | 不做什么 |
|---|---|---|
| 已提交源代码与历史 | git remote（Forgejo） | 不把 losvault 当 git 替代 |
| 运行中修改 / 未提交文件 | Lease 对应的节点本地 worktree | 不做多写者共享目录 |
| patch / 日志 / 测试报告 / 构建输出 | 不可变 artifact/CAS（先算摘要，再异步归档） | 不让归档失败改写已封存制品身份 |
| 加密快照 / 灾难恢复 / 异地副本 | losvault | 不参与 prepare/hydrate/seal/release 热路径 |
| 任务状态 / 证据索引 | los Postgres | 不把大对象塞进 Postgres，不把状态机塞进 losvault |

## 4. Workspace Lease 的最小失败模型与防线

| 失败场景 | 机械验收防线 |
|---|---|
| baseRevision 与检出版本不一致 | `prepare` 校验精确 commit OID；不匹配拒绝执行 |
| dirty patch 漏掉 untracked / ignored / submodule | `seal` 后在独立空目录重建，比较完整 manifest + 文件摘要；任一不一致失败 |
| 两个 executor 同时写同一 lease | 每次 lease 唯一 `fencingToken`；提交时 CAS 校验 token/状态，旧 token 一律拒绝 |
| 缓存命中但依赖/工具链/子模块/LFS 不同 | cacheKey 含 commit、依赖锁、工具链摘要、submodule、外部输入摘要；缺项禁止复用 |
| executor 崩溃 / 网络分区 / 重试 | 状态机限定 `PREPARED → SEALED → RELEASED`；seal 幂等；租约过期禁止旧执行者提交；制品持久化确认后才算成功 |

**补充**：`inputDigest` 不能只覆盖 git commit；环境变量、生成文件、外部下载物、密钥引用、运行时工具版本都可能影响结果。当前未验证 executor/artifact/DB 是否完整支持这些约束。

## 5. 修订后的分批计划

### Batch 0（本轮）：记录与共识

- 本文件 + docs 索引登记。
- 不改代码、不改调度、不动节点注册表。

### Batch 1（下一步，先证明闭环）

**目标**：M1 上一个真实、可重复的多文件任务 → 远端 node34（或 M3）隔离 worktree 执行 → 封存 patch + untracked manifest + 测试结果 → 在 M1 独立目录重建并验证。

最小步骤：

1. 选一个真实 repo（优先 `dsfolder/session-index` 或 los 的一个小包），固定 commit + 依赖锁。
2. 用现有 artifact 通道把 git bundle（或 tar）送到目标节点；目标节点 `git clone`/`worktree` 到隔离目录。
3. 执行一个确定性检查（不是“agent 随便改”，先跑固定命令）。
4. `seal`：`git diff --binary` + untracked tar + manifest + sha256。
5. 回传 artifact；M1 在空目录重建，比较 manifest，跑同一检查。
6. 故障注入：断网、executor 重启、重复提交、旧 token 提交、磁盘不足。
7. 连续 20 次成功；任何一次静默丢失/越权/旧结果覆盖新结果即失败。

**验收**：`task_runs.node_id` 落目标节点；输入可追溯；输出可重建；原工作区未变化；故障注入不产生静默错误。

### Batch 2（闭环通过后）：把已验证协议抽象成 Lease

- `WorkspaceRef` / `WorkspaceLease` / `prepare|seal|release` 端点。
- 缓存键、GC、租约保护、fencing。
- 只对通过 Batch 1 的节点开放 `hydrate`。

### Batch 3（并行，低风险）：真值面与移动端

- 只清理“假在线/重复身份”，不做 36 节点全量清洗大工程。
- los console 走 `tailscale serve` + access-gate；blocked/approval 接 Web Push。
- 统一 inbox：DSH session ↔ los run ↔ node ↔ artifact 的关联 ID。

> Track B（task token / 无状态 executor）与 Track C（scope / `los tools --check`）
> 的详细设计见同目录 `2026-10-18-task-token-heartbeat-and-stateless-executor.md`。
> 它们与 Track A 并行，但远端 agent run 默认化必须同时通过两条线的共同门禁。

### Batch 4（安全，独立批准）

- 共享 `EXECUTOR_AGENT_KEY` → per-task 短期凭据。
- executor 不直连 PG。
- 明文 provider key 迁 Keychain/DPAPI（本机 `~/.grok/config.toml` 已发现明文，不复述值）。
- Tailscale ACL 按 Cell/角色收敛；免费 provider 数据边界与配额。

## 6. 拒绝清单

1. 不做 losvault 双向同步/统一热工作区。
2. 不做多控制器、分布式 DB、自动故障转移（先单写者可恢复）。
3. 不做跨 Home/Cloud/Vendor 自动迁移（先显式放置 + 人工重试）。
4. 不做通用 DAG 调度器、复杂优先级、自动扩缩容。
5. 不做 36 节点全量“可执行节点”清洗（先验证真实在线节点）。
6. 不做全量预同步/全仓复制。
7. 不把 DSH 会话与 los run 强行合成一个状态机（先做关联 ID + 审计事件）。
8. 不把免费推理路由当可信执行环境，不默认向厂商云发工作区。

## 7. Batch 1.0 / 1.1 执行记录（本轮）

### 7.1 本地 dry-run（M1 only）

在 `dsfolder/fmtguard` 的 `git worktree` 上做确定性改动（README 注释 + `spike-dir/note.txt` + `untracked.txt`），生成 patch + untracked tar + manifest，再从 `git archive HEAD` 重建并比较：

```text
MANIFEST_MATCH=yes
FILES_WT=31 FILES_REBUILD=31
PATCH_BYTES=197 UNTRACKED_BYTES=180
CORRUPT_PATCH_REJECTED=yes
```

### 7.2 跨设备 dry-run（M1 → node34 → M1）

复用同一脚本，改为通过 `ssh localnode34` 在远端建立 baseline + 改动 + seal，再把 patch/tar/manifest 拉回 M1 重建：

```text
CROSS_DEVICE_MANIFEST_MATCH=yes
REMOTE_FILES=31 LOCAL_FILES=31 PATCH_BYTES=204
CORRUPT_PATCH_REJECTED=yes
```

随后把步骤固化为可重复脚本：[`tools/spikes/workspace-handoff.sh`](../../tools/spikes/workspace-handoff.sh)。再次运行：

```text
[5/7] compare full manifest (excluding .git)
PASS: manifest match (31 files)
[6/7] negative control: corrupt patch must be rejected
PASS: corrupt patch rejected
repo=985e964f93c4c9d2b6bc4af78e41895746479555
remote=localnode34
```

### 7.3 artifact API 探针（网关与远端各一次）

- 网关 `POST /artifacts` + `GET /artifacts/:id/content`：`ARTIFACT_ROUNDTRIP=yes`，sha256 `bb76827a7d…`，存储落 `.los-runtime/artifacts/`。
- node34 `POST /v1/artifacts` + `GET /v1/artifacts/:id/content`：`REMOTE_ARTIFACT_ROUNDTRIP=yes`，sha256 `3bd37c7208…`，存储落 `/opt/los/.los-runtime/executor-artifacts/node34-executor-1/`。
- 认证差异：网关 `/artifacts` 用 `x-los-operator-token`；executor 用 `Authorization: Bearer $EXECUTOR_AGENT_KEY`。
- **缺口**：网关只有 `readArtifactContentFromOwner` / `deleteArtifactFromOwner`，没有 `putArtifactToOwner`；因此网关不能把 bundle 推到远端，远端也不能主动从网关拉。Batch 1.2 必须补“谁推/谁拉”的契约，不能默认 `ssh + tar` 是最终方案。

### 7.4 这证明了什么 / 没证明什么

**已证明**：

- 一个固定 commit 的真实 repo 可以在远端隔离目录里生成可回放的 patch；
- untracked 文件可以单独封存并恢复；
- 全量文件 manifest（31 个文件）在远端工作树与 M1 重建目录之间一致；
- 损坏的 patch 会被 `git apply --check` 拒绝（负向控制）。

**未证明（下一批必须补）**：

- 没有走 los artifact API / executor 端点，仍是 `ssh + tar`；
- 没有 lease、fencing、并发写保护；
- 没有断网、executor 崩溃、重复提交、旧 token 提交等故障注入；
- 没有覆盖 submodule、LFS、二进制大文件、文件权限/符号链接、Windows 路径；
- 只跑了 1 次，不是连续 20 次；
- 没有验证 agent 在远端执行（Batch 1 先用固定命令，避免把“交付正确”与“agent 行为正确”混在一起）。

## 8. 未决问题

1. Batch 1 的目标 repo 选哪个？建议 `dsfolder/session-index`（小、可重复、非关键）或 los 的一个小包。
2. node34 与 M3 哪个先做？node34 常驻、Linux、已有 `/opt/los/los-workspace`；M3 更贴近真实构建，但可能睡眠。
3. 是否接受“Batch 1 只跑固定命令，不跑 agent”？建议接受：先证明交付/回收，再引入 agent 的不确定性。
4. 控制面是否迁出 M1？在 Batch 1 通过后立即做，还是并行做？
