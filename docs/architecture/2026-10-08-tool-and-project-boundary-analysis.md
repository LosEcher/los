# DSH / los / Codex / Grok 及 rust 工具集的职责边界分析（2026-10-08）

- **状态**：分析（待评审）→ 配套阶段任务见 `2026-10-08-phased-development-plan.md`
- **取证方式**：只读。配置/进程/端口/DB/仓结构实测 + `~/.dsh/storages/session-index.db` 跨项目事实 + 各仓 manifest 与 AGENTS.md
- **口径**：**实测** = 本机命令输出；**文档声称** = 仓库/全局规则里的表述。两者冲突时以实测为准，并把冲突登记为缺口。
- **不涉及**：不改任何工具的配置；密钥一律不输出明文。

---

## 0. 摘要（先读这 7 条）

0. **⚠️ 有一件事故正在发生**：`dsfolder` 每日 rust 门禁今日 6 仓 11 check 全 FAIL 并被记成 **"real drift"**，真因是**网关 PATH 缺 `~/.cargo/bin`**（`tools/los-launchd-wrapper.sh:22`）⇒ `cargo: command not found`（exit 127）。已污染 6 个 Work Item + 18 条 run_spec，且 auto-revision 被 cap 静默抑制。**详见 §2.9，建议插队修（1 行 PATH + 127→exit2 分类 + 回滚）。**

1. **模型访问有 3 个各自成立的决策中心，而不是一条链**：`cc-switch`(GUI app, :15721，管桌面工具的 provider 切换) / `Codex`→`api-slb.packyapi.com` 与 `Grok`→`cf.api.fan`（各自 config.toml 直连，不经本地转发）/ `DSH` 自己的 `agent-default-model` + `dsh-llm-fallbacks` 插件（**默认 provider 显式配成 `deepseek-official`**）/ `los gateway`(:8080，作为**可选**统一入口)。**没有任何一个面**能回答"某个工具此刻实际用哪个模型、凭证怎么刷新"。
2. **三个控制面都有实现，但只有 los 有程序化接口**：`cc-switch` 提供 `/v1/*` 转发 + `/health`，**没有管理 API**（`/api/*` 全 404）；DSH 的模型路由由**插件 + profile 配置**控制（可程序化改配置，但无对外 API）；los gateway 有 `/v1/*` 与 operator 路由，**但流量几乎为 0**——因为 DSH 的默认模型被显式配成 `deepseek-official/deepseek-flash`（`~/.dsh/profiles/desktop/cordis.patch.yml:12-16` 的 `agent-default-model`），**这是设计选择，不是故障**。
3. **`dsfolder` 是"仓套仓"且未登记**：父目录是 git 仓，`unirun`/`rustopt`/`fmtguard`/`sandbox-run`/`verify-gate`/`routeguard` 是**内嵌独立 git 仓**，但**无 `.gitmodules`、无 gitlink** ⇒ 父子都无法版本化对方；**且 `dsfolder` 是最活跃的工作目录（近 60 天 182+106 sessions）却没有 `AGENTS.md`**。
4. **6 个 rust 工具的消费面是分裂的（口径已修正）**：`unirun` 被 **los 真接线**（唯一，且它是 los 自己的 ssh 传输层）；`fmtguard`/`verify-gate`/`session-index` **被 DSH 真接线**（插件已写进 profile bundles，`session-index` 还有 launchd 小时任务在跑）；`rustopt` 被 **dsfolder 的 rust 治理门禁**消费；**只有 `run-diff` 是真孤儿**（二进制与 `~/.cargo/bin/run-diff` 都不存在，los 0 引用）。**"6 个都零消费者"是错的口径**——正确口径是"los 侧零消费者 5 个、DSH 侧零消费者 1 个"。
5. **cantool / cankey / canpad 是三个独立应用**（operator 口径 2026-10-08）：**cantool 与 cankey 是有共性能力的不同应用**，使用场景与边界不同（启动器 vs OS 输入法/击键所有权）；**部分能力可抽象共用，但两者不需要强耦合、可各自独立使用**。实测支持这一点：cankey 全仓仅 1 处 cantool 提及（注释掉的示例 socket），cankey-sidecar 自述 "Not used in `Engine::step`"，cantool 侧对 cankey 引用为 0。缺口不是"耦合不够"，而是**cantool 侧没有声明"击键所有权在 cankey"这条边界**。
6. **根本问题不是"缺一个总管"，而是缺三样机械判据**：① 每个能力的**唯一归属层**；② 跨层引用时的**允许方向**；③ 冲突时**以谁为准**。本文 §5 给出这三样，§6 给逐项归属，§8 给可执行判据。

---

## 1. 分层职责模型

### 1.1 六层

| 层 | 职责 | **反面（什么不该放在这层）** |
| --- | --- | --- |
| **L0 全局规则层**（`~/.codex/rules/`、`~/.claude/rules/`、`~/.codex/AGENTS.md`） | 跨项目安全/证据/新鲜度边界；分层放置规则；路由角色分离 | 具体端口、项目命令、队列名、发布门禁、某个项目的路径矩阵 |
| **L1 工作区层**（`los-workspace/AGENTS.md`、`WORKSPACE.md`、`projects.json`） | 工作区里有哪些仓、各自角色、跨子仓共同规则、真实开发区登记 | 单仓的不变量；工具的实现细节 |
| **L2 项目规则层**（各仓 `AGENTS.md` / `SKILL.md` / `TODO.md` / `docs/`） | 本仓读序、契约、命令、门禁、验收基线 | 全局风格；别的仓的端口/路径；把"计划"写成"已实现" |
| **L3 工具二进制层**（`~/.cargo/bin/*`：unirun/rustopt/fmtguard/sandbox-run/verify-gate…） | **单一可执行能力**（做一件事、退出码有语义、可被任何宿主调用） | 组织级策略（谁在什么时候必须用它）；状态存储；跨工具编排 |
| **L4 执行与证据层**（**los**） | 受治理执行（run_spec→task_runs→verification）、多节点放置、治理节奏、账本与审计 | 交互式对话体验；浏览器自动化/采集；项目内业务逻辑；模型权重 |
| **L5 会话与交互层**（**DSH**，及 Codex/Claude/Grok 作为**入口**） | 人机交互、会话历史、技能编排、插件、按需渠道、headless 调度 | 项目真相（不能用自己的会话当证据）；长期账本；跨节点放置决策 |
| **（横切）Provider 访问层** | 模型/凭证/配额/健康/路由 | 业务语义；项目状态；把"配置的模型"当作"实际生效的模型" |

### 1.2 三条机械规则（本文件的判据内核）

| 规则 | 内容 | 为什么 |
| --- | --- | --- |
| **R1 单写者（Single writer）** | 每个**状态**只有一个层可以写；其他层只能读或提议 | 今天 `dsfolder` 父仓与子仓互不知情、`los` 与 `cc-switch` 都能"决定 provider"，都是违反 R1 |
| **R2 允许方向（Allowed direction）** | 引用只能**从上层到下层**：L2 可引用 L3 二进制；L1 可引用 L2；禁止 L3 引用 L2/L1（二进制不得知道项目） | `unirun` 被 los 调用是**正确方向**（L4→L3）；若某二进制里去 `if project === 'cantool'` 就是越界 |
| **R3 真相优先级（Truth precedence）** | 冲突时：**持久化证据 > 运行时可观测事实 > 文档声称 > 记忆/摘要**。且"谁写的状态谁负责收敛" | 对应 `AGENTS.md` 的 "Persisted evidence outranks UI state or agent summaries"；今天文档状态与代码状态系统性脱节（D1–D7）就是 R3 没落地 |

### 1.3 五个必须分开的东西（抄既有 `routing-role-matrix` 的正确部分并扩）

`~/.codex/rules/routing-role-matrix.md` 已经要求「chat/UI 路径、proxy 路径、provider 路径、MCP 路径、认证身份、配额、用量报告**保持分开**」，并明确「不要把某个项目的端口矩阵全局化」。本节把它扩展成今天我们实际需要分开的**七件事**：

1. **配置的模型/凭证** ≠ **实际生效的模型/凭证**
2. **客户端入口**（谁发起） ≠ **转发面**（谁转发） ≠ **上游 provider**（谁最终回答）
3. **会话历史**（DSH/Codex/Claude/Grok 各自的） ≠ **执行账本**（los 的 `task_runs`/`session_events`）
4. **技能/skill**（提示词式工作流） ≠ **工具二进制**（可执行能力） ≠ **MCP 工具**（协议式能力）
5. **计划**（ADR/backlog） ≠ **当前实现**（代码） ≠ **运行证据**（报告/台账）
6. **派生投影**（`session-index.db`、看板、读模型） ≠ **canonical 源**（会话日志、DB、源文件）
7. **容器/沙箱隔离** ≠ **权限声明**（canpad 的 AGENTS 已写"权限声明不能替代插件沙箱"）

---

## 2. 现状实测：谁在管什么

### 2.1 工具与它们的配置真源

| 工具 | 配置真源 | 自有会话历史 | 自有 memory | 自有 skills | 注入到别人的机制 |
| --- | --- | --- | --- | --- | --- |
| **DSH** | `~/.dsh/profiles/{desktop,web,headless,acp-server}/cordis.{yml,patch.yml}` + `package.json` | `~/.dsh/sessions/<cwd-slug>/`（JSONL/zstd）+ 派生 `~/.dsh/storages/session-index.db` | `~/.dsh/memories/{MEMORY.md,daily/,projects/}` | `~/.agents/skills/`（72 条） | 提供 3080 GUI / 插件 / scheduler；向 Codex/Claude/Grok 暴露 MCP |
| **Codex** | `~/.codex/config.toml` + `~/.codex/AGENTS.md` + `~/.codex/rules/*.md` | `~/.codex/`（sessions/archived_sessions） | `.codex_memory`（另有 `~/.codex_memory`） | `~/.codex/skills`、`~/.codex/prompts` | 直接连 `api-slb.packyapi.com`（不经本地网关） |
| **Claude Code** | `~/.claude/settings.json` + `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md` + `~/.claude.json` | `~/.claude/projects/`、`~/.claude/sessions/`、`history.jsonl` | `.claude_memory` | `~/.claude/commands`、`plugins` | `ANTHROPIC_BASE_URL=http://127.0.0.1:15721` → **cc-switch** |
| **Grok / grokbot** | `~/.grok/config.toml`；`~/.grokbot/settings.json` | `~/.grok/sessions` | `~/.grok/memory`、`memory-v2`、`memtrace` | `~/.grok/skills` | `models_base_url=https://cf.api.fan/v1`（不经本地网关）；grokbot 有 `local-exec-daemon` |
| **CC Switch** | `~/.cc-switch/cc-switch.db`（SQLite）+ GUI | — | — | — | `:15721` HTTP 转发（`/v1/models` 200 但返回 `{"models":[]}`、`/v1/messages` 405、`/health` 200）；**无管理 API**（`/api/*` 全 404） |
| **其他** | `~/.omx`、`~/.reasonix`、`~/.opencode`、`~/.gemini`、`~/.cursor` | 各有 | — | — | — |

**⚠️ 归属修正（2026-10-08 复核）**：`~/.dsh/memories` **不是 DSH 核心的**，由第三方插件 **`dsh-memory-evolve` v0.1.0**（`github:csyangwen/dsh-memory-evolve#main`，在 `~/.dsh/profiles/web/package.json` 的 bundles 里）拥有：`~/.dsh/profiles/web/node_modules/dsh-memory-evolve/lib/index.js:402-404` 把 `memoryDir` 默认设为 `$DSH_HOME/memories`、`suggestionsFile` 设为 `<memoryDir>/SUGGESTIONS.jsonl`、**且 `skillDir` 默认设为 `~/.agents/skills`**。⇒ ① "DSH 的记忆"实际是**插件供给**的，插件被禁用/替换即记忆面消失（与 G17 的"建好就停摆"同类风险，但这次是**别人家的插件**）；② **同一个 `~/.agents/skills` 同时被"记忆插件写技能"与"DSH 技能 provider 读技能"** 占用，是并发写面。

**会话历史的跨工具可查性（实测，重要边界）**：`session-index.db` 的 **1123 条 `ingest_files.path` 100% 落在 `~/.dsh/sessions/` 之下**（扩展名只有 `session.jsonl.zstd` / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`）⇒ **该索引只覆盖 DSH 会话**。Codex（`~/.codex/sessions/**/*.jsonl` 1,727 个 + `thread_history_1.sqlite` ≈ 985 MB）、Claude Code（`~/.claude/projects/*.jsonl` + `history.jsonl` 1.3 MB）、Grok（`~/.grok/sessions/**` 11,661 文件 + `session_search.sqlite` 8.2 MB）**各自独立、互不可查**，且三家的索引都**没有 CLI**（Grok 的两个 sqlite 实测 `mode=ro` 打不开，结构未验证）。

### 2.2 模型访问路径（**核心缺口**）

| 路径 | 入口 | 转发面 | 上游 | 实测证据 |
| --- | --- | --- | --- | --- |
| A | Claude Code | **cc-switch :15721** | `PackyCode - cc`（cc-switch `claude` app_type 的 active 行） | `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL`；`cc-switch.db` `providers` 表 |
| B | Codex | **无**（直连） | `https://api-slb.packyapi.com/v1`（`wire_api=responses`） | `~/.codex/config.toml:9-18`；凭证由 `~/.local/bin/packycode-token-keychain` 每 **300000ms** 刷新（`:17`） |
| C | Grok | **无**（直连） | `https://cf.api.fan/v1` | `~/.grok/config.toml:6,14` |
| D | DSH | **无**（由插件与 profile 配置决定） | `deepseek-official/deepseek-flash`（**显式默认**） | `~/.dsh/profiles/desktop/cordis.patch.yml:12-16` 的 `agent-default-model`；`dsh-llm-fallbacks` 插件（`cordis.patch.yml:207+`）的 `roles.rules: []`（无额外规则）；session-index `request/header` 590+6 印证 |
| D' | DSH（可选） | **los-gateway :8080** | los 的 12 个 provider | `~/.dsh/profiles/desktop/cordis.patch.yml:117-137`（`baseURL: http://127.0.0.1:8080/v1`）——**已配置但未被默认使用**，是模型选择器里的一个选项 |

**关键定性（修正早先"流量漏失"的说法）**：DSH 默认走 `deepseek-official` 是因为 `agent-default-model` **就是这么配的**；`dsh-llm-fallbacks` 插件的 root chain 尾部还要求"必须恰好是一个官方模型（`deepseek-official/deepseek-flash` 或 `deepseek-v4-pro`）"。因此：
- **DSH 自己就是它模型路由的 owner**（plugin + profile），los gateway 对 DSH 是**可选入口**而非必经代理；
- 由此 Q1 的正确问法不是"谁统一管 provider"，而是"**谁有权改 DSH 的默认模型/fallback**"以及"**跨工具的 active provider 谁来对齐**"。

**cc-switch 声明的 active provider（实测 `providers` 表）**：

| app_type | active（`is_current=1`） | 候选数 |
| --- | --- | --- |
| `claude` | **PackyCode - cc** | 6（DeepSeek / zenmuxcc-payg / zenmux-sub / zenmuxcc-cc / Claude Official / MiniMax） |
| `codex` | **PackyCode** | 2（+zenmux） |
| `gemini` | **Google Official** | 1 |
| `grokbuild` | **PackyCode** | 2（+Grok Official） |
| `opencode` | `default`（+`Imported 2026-02-28`） | 2 |

**三条实测结论**：
1. **只有一个 GUI app 在管"桌面工具的 provider 切换"，而它没有程序化接口** ⇒ agent 无法切换、无法审计、无法自动验证"切换后是否真的生效"（违反 R3）。注意 DSH 的模型路由**不**归它管（见路径 D/D'）。
2. **los 只读 cc-switch、不能控制它**：`packages/infra/src/discovery/scanners.ts:177-194` 读 `~/.cc-switch/cc-switch.db`；`provider-parsers.ts` 把 `is_current` 映射成 `prefer`（`config-sources.ts:148` "active cc-switch accounts overwrite"）。**全仓无任何写回路径**。
3. **三个 provider 决策中心并行**：`cc-switch`（桌面工具）/ DSH 的 `agent-default-model` + `dsh-llm-fallbacks`（会话宿主）/ `los gateway`（agent、headless、治理）。三者各自维护 provider 清单/凭证/健康，互不知道；los 侧 `provider_accounts` 只有 1 行（xai）。**`los-gateway` 在 DSH 里是"已配置但未默认启用"的选项**。

### 2.3 项目实况

| 项目 | 语言/构建 | 独立仓 | 指令文件 | 规模（源文件） | 近 30 天 tool/LLM 比 |
| --- | --- | --- | --- | --- | --- |
| `cantool` | Tauri 2（Rust + React/TS） | ✅ git+jj | AGENTS + CLAUDE | 1242 | 59.7 |
| `cankey` | Rust（IME core，零平台 API） | ✅ git+jj | AGENTS | 87 | **123.0** |
| `canpad` | Tauri（Rust core + 生成契约） | ✅ git | AGENTS | 75 | — |
| `lot2extension` | 扩展 + Go 后端 + Playwright | ✅ git+jj | AGENTS + CLAUDE | 2817 | 46.4 |
| `wechatdp` | Python（冷层/ETL） | ✅ git+jj | AGENTS + CLAUDE | 492 | 74.6 |
| `lzlyx` | 多语言 | ✅ git | AGENTS + CLAUDE | 6403 | **137.8** |
| `los` | TS/pnpm monorepo | ✅ git+jj | AGENTS + CLAUDE | 1007 | 108.3 |
| `dsfolder`（父） | — | ✅ git | **缺 AGENTS.md** | — | 99.7 |
| ↳ `unirun` | Rust 库+bin | ✅ **内嵌 git** | AGENTS | — | 130.8 |
| ↳ `rustopt` | Rust | ✅ 内嵌 git | AGENTS | — | 138.6 |
| ↳ `fmtguard` | Rust | ✅ 内嵌 git | AGENTS | — | **163.8** |
| ↳ `sandbox-run` | Rust | ✅ 内嵌 git | AGENTS | — | — |
| ↳ `verify-gate` | Rust | ✅ 内嵌 git | AGENTS | — | — |
| ↳ `run-diff` | Rust | ❌ **无 VCS** | — | — | — |
| ↳ `session-index` | Rust | ❌ **无 VCS** | README | — | — |
| ↳ `routeguard` | Rust | ✅ git | — | — | — |

**内嵌仓的登记状态（实测）**：`dsfolder/.gitmodules` **不存在**；`git ls-files -s` **无 gitlink 行** ⇒ 这些内嵌仓既不是 submodule 也没被父仓跟踪。子仓 remote：`unirun`/`fmtguard`/`rustopt`/`sandbox-run`/`verify-gate` → `github.com/LosEcher/<name>.git`；`routeguard` **无 remote**。

### 2.4 路径分裂（历史遗留）

| 路径 | 会话时间范围 | 会话数 |
| --- | --- | --- |
| `~/syncthing/project/*` | 2026-08-14 → **2026-08-27** | **214** |
| `~/syncfolder/project/*` | **2026-08-30** → 2026-10-08 | 328 |

`~/syncthing/project/` **现在只剩一个文件**（`ai-runtime-config.json`），但 `~/.dsh/sessions/--Users-echerlos-syncthing-project-*--` 的 slug 目录仍在、214 条历史会话的 `cwd` 仍指向旧路径 ⇒ **跨路径的历史无法与今天的仓关联**（`session-index` 按 `cwd` 归项目）。这是 §2.2 之外第二个"同一逻辑对象有两个家"的实例。

---

## 2.9 ⚠️ 正在发生的事故（2026-10-08 独立复核，建议插队修）

**症状**：`dsfolder` 的每日 rust 门禁（launchd `07:40`）今日 **6 仓 11 个 check 全 FAIL**，并被台账记为 **"real drift"**。

**实测证据链（本轮亲自复现）**：
1. `dsfolder/.rust-los-gov/gate-launchd.err.log` 末行：`gate failures (real drift): fmtguard:documented, fmtguard:size:dist, run-diff:documented, run-diff:size:dist, session-index:documented, session-index:size:dist, verify-gate:documented, verify-gate:size:dist, rustopt:documented, sandbox-run:documented, sandbox-run:size:dist`
2. `gate-runs.jsonl` 末条：每条 result 的 `recordError = "verification command exited with 127"`、`outputTail = "/bin/sh: cargo: command not found"`。
3. **根因**：`tools/los-launchd-wrapper.sh:22` 的 PATH 是
   `$HOME/Library/pnpm:$HOME/Library/Application Support/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
   —— **不含 `~/.cargo/bin`**（`grep -c cargo` = **0**）。复制该串做 `env -i PATH=... /bin/sh -c 'command -v cargo'` → **CARGO NOT FOUND**，而 `command -v cargo` = `/Users/echerlos/.cargo/bin/cargo`。
   对照：同一 wrapper 的 `:21` 注释正是"为 launchd 补 PATH"而写；`packages/gateway/src/unirun-capabilities.ts` 也**显式**补了 `~/.cargo/bin` —— 只有这一处漏了。
4. **触发者 PATH 是对的，错在网关**：`dsfolder/scripts/rust-repo-gate-daily.sh` 自己加了 `$HOME/.cargo/bin`，但 `requiredChecks` 是由**网关进程** spawn 的。
5. **账本已污染（只读 SQL 实测）**：`run_specs` 里 `id LIKE 'run-session-179141%'` → **blocked 11 / created 5 / failed 2**；6 个 Work Item（`Keep <repo>'s gates green`）**全部 `blocked`**（`todo-b56b543e`=verify-gate、`todo-a5153acb`=rustopt、`todo-2461f1bb`=fmtguard、`todo-b3f21740`=run-diff、`todo-b2a59482`=session-index、`todo-b1b7c109`=sandbox-run）。
6. **自愈被静默抑制**：`gate-launchd.err.log` 首行 `fmtguard: auto-revision suppressed (cap: 3 consecutive recovery round(s) >= --max-recovery-attempts 1)`；而门禁每天只跑一次、每轮**新建** run spec，los 侧的 `exhausted` 只在"同一个 run spec 反复失败"时推进 ⇒ 实测每仓都建了 `recoveryRunSpecId: …:revision:2` 且 `recoveryExhausted: false`，**6 次无效 planning（单次 `loopCount 8`、prompt 123k–168k tokens）已被烧掉**。

**为什么这是边界问题而不是单纯 bug**：它**正好命中本文档的三条判据**——
- **违反 J8（配置≠生效）**：脚本声明的执行环境（自己加了 cargo PATH）与网关实际执行环境不一致，而**没有人对账**；
- **违反 J1/R1（单写者）**：`requiredChecks` 有**两个求值器**（网关 `spawn(shell:true)` 可跑 `cargo test`；`scheduled_work_items` 路径按**工具调用**求值，`run_shell` 在 L1 被拒）⇒ 同一字段两种语义；
- **违反 J6（计划/实现/证据三态）**：错误被写成"外部漂移"（`real drift`）而不是"判不了"（应 exit 2），**把环境故障伪装成产品缺陷**，并使真正的新漂移（如 `verify-gate` 二进制 0.1.0 vs 源码 0.2.0）淹没在同一条红里。

**修法 3 步（最小、可验证）**：
1. `tools/los-launchd-wrapper.sh:22` 的 PATH 补 `$HOME/.cargo/bin`（1 行）；
2. **门禁三态收紧**：`recordError` 含 `exited with 127` / `command not found` / `timed out` 的**不得**进 `FAIL`，必须走 exit 2（"判不了"）——`rust-repo-gate-run.mjs` 已有 TIMEOUT 三态，只是没覆盖 127；
3. **回滚被污染的 6 个 Work Item 与 18 条 run_spec**（按本文档的 R3：写状态者负责收敛）。

---

## 3. 边界违规清单

### 3.1 同一能力多份实现（违反 R1）

| # | 能力 | 有几份 | 证据 | 风险 |
| --- | --- | --- | --- | --- |
| V1 | **provider 路由/切换** | **3**（`cc-switch` 的 `providers` 表〔桌面工具〕 + DSH 的 `agent-default-model`/`dsh-llm-fallbacks`〔会话宿主〕 + `los` 的 `config.providers`/`provider-defaults`/discovery〔agent/headless〕） | `cc-switch.db`；`~/.dsh/profiles/desktop/cordis.patch.yml:12-16,207+`；`packages/infra/src/provider-defaults.ts` + `~/.los/config.yaml` | 改一处另两处静默失效；"配置的"≠"生效的"；**三者各自成立（不是重复实现），缺的是"冲突时谁说了算"** |
| V2 | **凭证刷新** | 4（`packycode-token-keychain` 5min / cc-switch 自己 / `kimi-code.ts` per-request / `xai-oauth.ts` async+锁） | `~/.codex/config.toml:16-18`；`auth/kimi-code.ts:105-175`；`auth/xai-oauth.ts:318` | 仅 2/20+ provider 自动刷新，其余手工；告警面无人聚合 |
| V3 | **格式化门禁** | 至少 2（`fmtguard` 二进制 + 各仓自己的 `cargo fmt --check` 脚本） | `cankey/scripts/cleanup.py`、`cantool/scripts/test.sh` 都提到 `cargo fmt` | fmtguard 的卖点正是"绝不让 formatter 决定范围"，但各仓仍可能用裸 `cargo fmt` ⇒ 纪律靠人记 |
| V4 | **验证门禁** | 3（`verify-gate` 二进制 + 各仓 `scripts/check-*.sh` + los 的 `verification_records` 层） | `cantool/scripts/check-*.sh` 计数；los `docs/architecture/2026-10-06-architecture-boundaries-and-gaps.md:32` 的"可执行门禁"清单 | 同一断言在三处各有实现，改一处另两处不知情 |
| V5 | **会话/事件投影** | 2（DSH `session-index.db` + los `sessions`/`session_events`） | 1097 vs 307 sessions；两种 schema | "跨项目历史"与"执行账本"不可 join |
| V6 | **skills 三处** | 3（DSH `~/.agents/skills` 72 条 + los `skills` 表 35 条 + `~/.codex/skills`） | 盘点实证：los `skills` 全 `usage_count=0`、`.los/skills/` 只有 1 个文件 | 登记≠消费；同名技能可能语义不同 |
| V7 | **MCP 工具面** | `los mcp serve` 4 工具**零消费者**；而 Codex/Claude/DSH 各接的是 `context7/exa/cbm/nowledge/pencil/webbridge/lot` | `docs/architecture/2026-10-06-architecture-boundaries-and-gaps.md:175`（I-3）+ 本轮实测三家 MCP 配置 | 能力建好没人用；ADR 0031 声称"MCP 是唯一程序化接口"却无消费者 |

### 3.2 职责越界（违反 R2 / L0 与 L2 的层界）

| # | 越界 | 证据 |
| --- | --- | --- |
| V8 | **父目录与子仓互不知情**：`dsfolder` 是仓、子目录也是仓、**无 `.gitmodules`** ⇒ 父仓无法记录子仓版本，子仓无法表达"我属于谁" | §2.3 实测 |
| V9 | **`dsfolder` 无 `AGENTS.md` 却是最活跃工作目录** ⇒ agent 在父目录工作时读不到任何跨子仓规则 | 近 60 天 `syncthing/project/dsfolder` 182 + `dsfolder` 106 sessions |
| V10 | **项目文档写全局规则**：`los-memory/AGENTS.md` 引 `~/projects/los-workspace/*`（**该路径不存在**）；`WORKSPACE.md` 声称的 7 个项目与磁盘不符 | 盘点 G8/G9 |
| V11 | **全局规则写项目端口**——**当前未发现**，`routing-role-matrix.md` 明确禁止且执行到位 | 正面证据，说明 L0 纪律是好的 |
| V12 | **los 侧 provider 面与 cc-switch 面重复定义"谁是 active"** | V1；`config-sources.ts:148` 用 cc-switch 的 `is_current` 覆盖 los 的 discovery 结果 ⇒ **los 的 provider 真相依赖一个它不能写的 GUI app** |
| **X6** | **两份互相矛盾的"权威"**：`los/docs/governance/toolchain-matrix.md` 判「外部 transcript 只当**比较输入**」，而 `dsfolder/RUST-REPO-LOS-GOVERNANCE-DESIGN-2026-10-07.md` 判「工具 `runs.jsonl` 作为**外部证据可引用**」——同一批工具两处不同归属规则，**且没有任何门禁会红** | 两份文档各自自称权威；实测 `toolchain-matrix.md` 里**一个 Rust 工具都没列**，而 dsfolder 侧自行定义了「采集面/门禁判读面/决策面」三层与台账归属规则。**建议最先收口这一处**：若 dsfolder 的做法被推广，los 的「外部产物不得冒充运行时证据」边界会被逐步侵蚀 |
| **X7** | **边界未声明（不是"耦合不够"）**：`cankey` 与 `cantool` 是**两个独立应用**（operator 口径 2026-10-08：有共性能力可抽象共用，但使用场景与边界不同、**不需要强耦合、可各自独立使用**）。实测耦合为 0：cankey 全仓仅 1 处 cantool 提及（`config.example.toml:54` 注释掉的 socket），`cankey-sidecar` 自述 "Not used in `Engine::step`"，cantool 侧对 cankey 引用为 0 | **缺口不是缺耦合，而是 cantool 侧没声明"击键所有权在 cankey"** ⇒ 在 cantool 改 `text_expansion/`/`input_runtime/injection/` 的 agent 不知道存在一个已覆盖该场景的独立应用，典型事故是"造第二条注入路径"。**最小修法（2 行，不建立耦合）**：`cantool/AGENTS.md` 的 Read Order 加一行指向 `cankey/docs/design/architecture.md`（作为**相关应用**而非依赖），Hard Invariants 加一条"输入注入类改动必须先判定击键所有权；不得复制或绕过 cankey 的投递协议" |

### 3.3 孤儿层（有实现、无消费者）

| # | 孤儿 | 证据 |
| --- | --- | --- |
| V13 | `los mcp serve` 4 工具 | 三家 MCP 配置里都没有 los |
| V14 | 5/6 rust 工具在 los 侧零引用 | 只有 `unirun` 被接线（`unirun-capabilities.ts` / `install-unirun.sh` / `tools/deploy-to-remote.sh`）；`fmtguard`/`rustopt`/`sandbox-run`/`verify-gate`/`run-diff` 在 `packages/*/src` 与 `tools/` 中 0 命中 |
| V15 | `run-diff` / `session-index` **无 VCS** | 实测 `vcs=none`，但 `session-index` 有 launchd 小时任务在跑 |
| V16 | `routeguard` **无 remote** | 实测 |
| V17 | los 的 `provider_accounts` 只有 1 行（xai），而 cc-switch 管着 5 个 app_type 的 active provider | 盘点实证 |

### 3.4 真相层错位（违反 R3）

| # | 错位 | 证据 |
| --- | --- | --- |
| V18 | **文档状态与代码状态系统性脱节** | 盘点 D1–D7（P0 行未回填、行号漂移 13–25 行、编号冲突残留、"22 个零引用契约"独立复核只得 6/40…） |
| V19 | **"计划"被当"实现"读** | cankey AGENTS 明确警告"协议冻结不等于 Host 已实现"；los 的 ADR 0042/0044/0045/0046 长期 Proposed 却出现在路线图里 |
| V20 | **派生投影被当 canonical** | `session-index.db` 是**可丢弃投影**（README 明说 "the projection is disposable, the session log stays canonical"），但它是唯一能跨会话查询的面 ⇒ 一旦停更（launchd 挂了）就会被当成"没有这段历史" |
| V21 | **配置里"有"某 provider 被当成"在用"它** | DSH 配置里**同时有** los-gateway（`:117-137`）与 `agent-default-model`（`:12-16`），默认生效的是后者（deepseek-official）。看到 los-gateway 就断言"DSH 经 los 调用"是误读（§2.2 路径 D vs D'） |

---

## 4. 逐项归属结论

### 4.1 六个 rust 工具（**口径修正：不是"全部零消费者"**）

实测归属（"被 PATH 调用" ≠ "被显式引用" ≠ "被真实执行"）：

| 工具 | 版本 | 正确归属 | 今天真实状态 |
| --- | --- | --- | --- |
| **`unirun`** | 0.5.0 | **los 消费（已接）** | 它是 los **自己的 ssh 传输层**（不是外部工具）：`unirun-capabilities.ts:1-14` 记录了 0.3.0 时代「版本→特性表静默过期」的真实事故，改为问 `unirun capabilities --json` + 保守空集 fail-closed；`install-unirun.sh` 有 pin + sha256 + 能力断言；`deploy-to-remote.sh` 有 `LOS_REQUIRE_UNIRUN=1`。**唯一补强**：网关 launchd PATH 缺 `~/.cargo/bin`（见 §2.9） |
| **`rustopt`** | 0.1.0 | **los 消费（事实上已接，经 `requiredChecks`）** | `gates.json` 的 `size:dist` 就是 `rustopt check --build-profile dist --budget N --emit json`；6 仓预算已测（dist +5%）；`--manifest DIR` 天然跨仓且不污染目标 `target/`。**问题在 D8**：预算值同时硬编码在 `gates.json` 与 cantool 侧（已发生 1.44 MB 口径差） |
| **`fmtguard`** | 0.4.2 | **DSH 消费（已接）；不进 los** | 输入是「agent 刚编辑了哪些 hunk」= **交互面信息**，los 的 E3 作业拿不到也不该拿；`dsh-fmtguard` 已提供 `rust_fmt_changes` + `fmtguard_doctor`（默认 dry-run、越界即拒）；cantool `AGENTS.md` 已把"脏树不跑全仓 `cargo fmt`"写成硬规则。**补强**：把 `fmtguard_doctor --requireVersion` 用到 CI |
| **`verify-gate`** | **已装二进制 0.1.0 / 源码 0.2.0** | **DSH 消费（已接）；与 los verification 面显式分层，不接线** | manifest 类型（file/cmd/http/git/json）比 los 的 `kind: command\|assertion\|operator_review` 更宽；**退出码语义不同**（verify-gate 0/1/2 三态 vs los 把超时与非 0 都记 `failed`）。**仲裁规则只有一条**：「这个 check 失败后需不需要自动 revision/派 todo」→ 需要走 los，不需要走 verify-gate。⚠️ 版本漂移本身是一条未被发现的缺陷（正好被 §2.9 的假红淹没） |
| **`sandbox-run`** | 0.1.3 | **项目本地工具；与 los `managed-workspaces` 真重叠，需一次显式仲裁** | 提供「git worktree / jj workspace 里跑验证，主树不被污染」；los 有 `managed-workspaces`（jj-only）+ 服务端 `verification-runner` 的 `spawn`。**`dsfolder/RUST-REPO-LOS-GOVERNANCE-DESIGN §5` 自己写了「不动…谁当隔离 owner 另行决策」——该决策至今未做** |
| **`run-diff`** | 0.1.0 | **退役 或 转 DSH 评测面（今天既无二进制也无消费者）** | `~/.cargo/bin/run-diff` 与 `target/release/run-diff` **都不存在**；los 的 2 处命中是 `packages/web/e2e/work-diff-review.spec.ts:90,113` 的 **fixture 字符串**；README 自称"golden-task 回归套件的反馈环"，而 DSH 侧对应工作是 dashboards/eval |
| （附）`session-index` | 0.5.0 | **DSH 消费（已在跑，全清单最健康）** | 二进制在 `dsfolder/session-index/target/release/`（2.0 MB）；launchd `com.echerlos.dsh-session-index` 实测 **31 次 finish / 31 次 exit 0 / 0 失败**（最近 2026-10-08 12:44，耗时 <1s，DB 275 MB）；DSH 插件已装进 **web** profile（`package.json:25,64`）。**对 los 只开只读投射**（P1 L1-2 已设计） |

**归属汇总**：los 消费 **2**（unirun、rustopt）/ DSH 消费 **3**（fmtguard、verify-gate、session-index）/ 待仲裁 **1**（sandbox-run）/ 退役或转评测 **1**（run-diff）。

⇒ **"6 个工具零消费者"是错的口径**。正确口径是：**los 侧零消费者 5 个，DSH 侧零消费者只有 1 个（`run-diff`）**。真正的问题是「**los 不知道其余 5 个的存在，而其中 3 个已经被 DSH 用起来了**」——这是**可观测性缺口，不是能力缺口**（也正是 P1 要解决的）。

**孤儿 `los mcp serve` 的机制解释**：它与 `dsh-los-ops` 覆盖的能力**不重叠**——前者是 run 生命周期（`los_run`/`los_run_state`/`los_run_replay`/`los_operator_control`），后者是治理/死信/todos（直连 gateway HTTP，实测在用：`los_dlq_ack` 88 / `los_todos` 31 / `los_todo_update` 25 / `los_gov_jobs` 20 / `los_dlq_summary` 19 / `los_gov_job_run` 7 / `los_chat` 4）。⇒ **孤儿不是"没接好"，是"为一个不存在的消费者先建了入口"**（ADR 0031 假设的消费者是"编辑器与 agent host"，而实际消费 los 治理面的是 DSH 的 HTTP 插件）。

### 4.2 `dsfolder` 与 rust 工具集的结构结论

**结论：`dsfolder` 当前的形态是"母仓 + 未登记的内嵌仓"，这是 V8 的根因，必须先定性再谈开发分工。**

三条可选路，**推荐 B**：

| 方案 | 内容 | 代价 |
| --- | --- | --- |
| A. 转 submodule | 加 `.gitmodules`，父仓记录子仓 gitlink | 需要每个子仓有稳定 remote（`routeguard` 没有）+ 日常操作变复杂（agent 最怕 submodule） |
| **B. 明确"母仓只管非仓内容，子仓各自独立"** | ① 父仓 `.gitignore` 显式排除子仓目录（避免误提交/误 status）；② **补 `dsfolder/AGENTS.md`** 声明"本目录不是单一仓 + 子仓清单 + 各自 AGENTS 入口 + 跨子仓修改规则"；③ 用工作区级 `projects.json`（P2 L2-1）登记 `umbrella`/`children` 关系 | 最低；不动子仓 VCS；**唯一要求是补文档与忽略规则** |
| C. 拆散 | 把 6 个工具仓移出 `dsfolder` | 破坏现有相对路径引用（`dsfolder/scripts` 大量引用），成本最高 |

**附带必须做的**：给 `run-diff`、`session-index` 纳入版本控制（V15）；给 `routeguard` 补 remote 或明确"本地专用"（V16）。

### 4.3 cantool / cankey / canpad：三个应用，不是一族

**operator 口径（2026-10-08，权威）**：

> **cantool 与 cankey 是「有共性能力的不同应用」**。部分能力可以**抽象**出来共同使用，但**基于输入法与应用启动器的使用场景和边界是不一样的**；**两者也不需要强耦合，可以各自独立使用**。

**实测身份与边界**：

| 应用 | 使用场景 | 边界 | 指令文件 |
| --- | --- | --- | --- |
| `cantool` | 应用启动器 / 生产力面板（Raycast·Alfred·Espanso 类） | 以**用户主动唤起**为中心；**不拥有 OS 击键** | AGENTS + CLAUDE，Tauri 2 + Rust + React |
| `cankey` | **OS 输入法**（独占击键，产出文本/动作候选） | 以**击键所有权**为中心；core 零平台 API；热路径禁网络/AI/CanTool RPC/磁盘 fsync | AGENTS，独立 git+jj，独立门禁 B5/B44–B49 |
| `canpad` | 本地优先 Markdown / 文本工作台 | 把 cantool 当**运行时能力提供方**（`/v1/capabilities`）；客户端 ↔ 服务 | AGENTS + README + TODO |

**实测耦合程度（证据支持"不需要强耦合"）**：
- `cankey` 全仓**仅 1 处**提到 cantool，且是**注释掉的示例路径**：`crates/cankey-config/bundles/config.example.toml:54` → `# socket = "/tmp/cantool-ime.sock"`。
- `cankey-sidecar` crate 自述 = **"Optional CanTool IME sidecar client. Not used in `Engine::step`."** ⇒ **可选扩展点**，不是运行必需（在 `default-members` 里会被构建，但核心面不依赖任何 cantool 组件）。
- `cantool` 侧对 cankey 的引用为 **0**（`grep -rn "cankey\|CanKey" cantool/src-tauri/ cantool/AGENTS.md cantool/README.md cantool/TODO.md` 全 0 命中）。
- `canpad` 全文 **0 次**提到 cankey。

⇒ **两仓之间没有编译期依赖、没有运行期必需依赖**；只有**一个可选扩展点**与**一段历史渊源**（cankey 的 README/AGENTS 把它写作 "CanTool 的输入法投递面"）。**历史渊源不是运行时边界。**

**判据结论**：

| 关系 | 定性 | 规则 |
| --- | --- | --- |
| cantool ↔ cankey | **两个独立应用**（不同使用场景与边界）；**不强耦合、各自独立可用**；**有共性能力可抽象共用** | 见下方 A1–A4 + R1–R3 |
| cantool ↔ canpad | **对接方 / 客户端 ↔ 服务** | canpad→cantool 只允许「探针 + 消费已发布端点」（只许 `GET /v1/capabilities`），**禁止 canpad 定义新端点**；canpad 配置类型写权在 `canpad-core`，生成物不手改 |
| cankey ↔ canpad | 无关系 | — |
| 三者 ↔ dsfolder rust 工具 | **工具消费关系**（L3←L2 允许方向） | 可消费 `fmtguard`/`sandbox-run`/`verify-gate`/`rustopt`；**不得**把工具逻辑复制进仓内 |

**共性能力的抽象原则（A1–A4）**

| # | 原则 |
| --- | --- |
| **A1** | **抽象到独立面，不落到任一应用内部**：共性能力（词典/词库处理、候选排序、配置模型生成、文本变换、契约生成）应作为**独立可发布单元**，由两个应用**各自选用**。禁止让 A 应用从 B 应用**内部 crate** 引用共性能力 —— 那等于建立了不需要的耦合 |
| **A2** | **抽象是"共同使用"不是"共同拥有"**：独立单元有自己的写权与发布节奏；**不因为一个应用需要就改另一个应用的 core** |
| **A3** | **抽象必须由第二个真实消费者证明**：只有两个应用**都已在用**同一能力时才抽出为共享单元（与 `~/.codex/AGENTS.md` 的"不为假设的复用加抽象"一致） |
| **A4** | **不强耦合 = 任一方可单独构建、安装、使用、发布**：判定方式 = `cankey` 在**没有 cantool 安装**的机器上必须完整可用；`cantool` 同理。任一方不得把另一方列为构建或运行前提 |

**边界规则（R1–R6）**

| # | 规则 | 机械检查 |
| --- | --- | --- |
| **R1** | **击键所有权只在 cankey**：`cankey-core`/`-protocol`/`-config`/`-lexicon` 写权只属 cankey；cantool 不得把平台依赖反向塞入 | `cargo tree -p cankey-core` 不得出现 `objc2*`/`tauri`/`tokio`/`reqwest`；`grep -rn cankey cantool/src-tauri` 必须为空 |
| **R2** | **输入注入类改动必须声明"谁拥有击键"**；**不得复制或绕过 cankey 的投递协议**（若 cankey 已覆盖，正确做法是**调用**它，而不是造第二条注入路径） | PR 模板一项 + `rg 'NSWorkspace\|TIS\|SecureInput' cantool/src-tauri` 需与 cankey 能力表对齐 |
| **R3** | **协议写权只在 cankey**；`cankey-sidecar` 是**可选**扩展点，**禁止变成必需**（一旦必需即违反 A4） | cankey 的 `default-members`/`apps/*` 不得出现"缺 sidecar 即失败"；`Engine::step` 不得出现 sidecar 调用 |
| **R4** | canpad→cantool 只允许「探针 + 消费已发布端点」 | canpad 侧出现 `POST /v1/<新路径>` 到 cantool 即红 |
| **R5** | canpad 配置类型写权在 `canpad-core`，生成物不手改 | `npm run contracts:generate && git diff --exit-code` 型门禁 |
| **R6** | 三仓各自独立 VCS 与发布；跨仓改动必须在**各自仓**里分别是完整变更，**禁止一个 PR 跨两仓**；共享能力的抽出**另立变更** | 跨仓需求开 N 个变更（N = 被改仓数） |

**即时缺口**：cantool 侧对 cankey 的引用为 0 —— 在**不需要耦合**的前提下这**不是**缺陷本身；真正的缺口是 **cantool 侧没有声明"击键所有权在 cankey"这条边界**，因此在那里改输入/注入的 agent 不知道存在一个已覆盖该场景的独立应用。**最小修法（2 行，不建立耦合）**：`cantool/AGENTS.md` 的 Read Order 加一行指向 `cankey/docs/design/architecture.md`（作为**相关应用**而非依赖），Hard Invariants 加一条"输入注入类改动必须先判定击键所有权；不得复制或绕过 cankey 的投递协议"。

**为什么这三个仓的跨仓开发最容易出事故**：它们的 tool/LLM 比很高（cankey **123.0** vs lot2extension 46.4），意味着**单轮 agent 会走很长的工具链**；而 cankey 的 `AGENTS.md` 已经因为"防止把计划当实现"而写了大量反例（B5 门禁、`docs/plan/backlog.md` 状态横幅），说明**这个仓历史上被"文档说已实现"坑过**。

### 4.4 其他常用项目

| 项目 | 归属定性 | 跨项目规则要点 |
| --- | --- | --- |
| `lot2extension` | **独立产品**（扩展 + Go 后端 + e2e）；与 los 有**真实双向集成**（feed-analysis：lot2extension → los → callback），但**回调死信 18/87 无告警** | los 侧的 feed-analysis 是**契约集成**；lot2extension 侧不得依赖 los 内部表；`docs/CAPABILITY_BOUNDARY_MODEL.md` 是 lot2extension 自己的边界真源 |
| `wechatdp` | **独立数据面**（Python 冷层/ETL）；被 `wechatdp-cold-layer-ops` 技能驱动 | 数据搬运**不进 los**（los 非目标：不做冷层数据搬运） |
| `lzlyx` | **独立项目**，规模最大（6403 源文件），比 137.8 | 高长循环风险；应复用 L3 工具（fmtguard/sandbox-run/verify-gate）降低单轮步数 |
| `los-memory` | **独立项目**（本地 SQLite memory ledger + Nowledge/shadow 双轨） | ⚠️ **与 los 的 `packages/memory` 语义重叠但不共享实现**；需明确"谁是记忆的 canonical"（见 §7 风险 R2） |

---

## 5. 可执行判据（10 条）

供评审与后续门禁使用。每条都写成**可机械检查**的形式。

| # | 判据 | 检查方式 |
| --- | --- | --- |
| J1 | 每个**状态**只有一个写者 | 列状态清单（provider active / node designation / session 账本 / memory / 配置）→ 每项标唯一写者；出现第二个写者即红 |
| J2 | 引用方向只能上层→下层 | grep 二进制仓是否出现项目名/项目路径；出现即红 |
| J3 | L0 不含端口/路径/项目命令 | grep `~/.codex/rules`、`~/.claude/rules` 是否含具体端口号或 `~/syncfolder/...`；含即红（当前合规） |
| J4 | L2 不写别的仓的端口/路径 | 各仓 `AGENTS.md` 里的路径式引用必须可解析（P2 L2-2D 的门禁） |
| J5 | 同一能力不得有两份实现 | 维护"能力 → 唯一归属层"表；新增实现必须在表里登记并给出"为什么不能复用" |
| J6 | 计划/实现/证据三态分离 | 文档状态行必须带锚（`commit:` / `file:line`）——即 P4 L4-3 |
| J7 | 派生投影必须标明 canonical 源与新鲜度 | 每个投影面（session-index / 看板 / 读模型）必须暴露 `asOf` + 源头路径；落后阈值即 stale |
| J8 | 配置的模型 ≠ 生效的模型；**且必须指明是哪个决策中心** | 每次"路由/模型"结论必须给三件：① 配置路径与值；② **该工具的路由 owner**（cc-switch / DSH 插件+profile / los gateway）；③ 实际生效证据（session 记录/日志）。三者不一致即**冲突**，须显式报冲突而非择一 |
| J9 | 内嵌仓必须被登记 | `umbrella` 目录下的每个仓必须在工作区 `projects.json` 里出现（P2 L2-1 的反向完备性） |
| J10 | 无 VCS 的代码目录不得进入交付链 | 扫描 `dsfolder/*`，凡有 manifest 但无 `.git`/`.jj` 者标红（当前：`run-diff`、`session-index`） |

---

## 6. 三个最可能的未来事故（维持现状不改）

| # | 事故形态 | 触发条件 | 早期信号 |
| --- | --- | --- | --- |
| **A1** | **"切换了 provider 但没生效"** —— cc-switch GUI 切了 active，Codex 的 `config.toml` 仍指旧 base_url / Grok 指第三方域名，los 又读 cc-switch 的 `is_current` 当真相 ⇒ 三处不一致，而**没有任何面能判定谁对** | 任一次手工切 provider | Agent 报告"已切到 X"但实际请求打到 Y；`provider_call_telemetry` 里 provider 名与配置不符 |
| **A2** | **跨仓门禁静默失效** —— 同一断言在 `verify-gate` manifest、仓内 `check-*.sh`、los `verification_records` 三处各有一份；改一处另两处继续"绿" | 有人改门禁而不改另两处 | 门禁绿但真机复现失败；CI 与本地结论相反 |
| **A3** | **内嵌仓的改动丢失** —— 在 `dsfolder` 工作时误把子仓当普通目录；父仓 `git status` 不显示子仓内容，子仓又无 remote（`routeguard`）⇒ 改动既不进父仓历史也不可推 | 在 `dsfolder` 根目录做 `git add -A` 或清理 | 子仓工作副本变脏但没人知道；`routeguard` 改动永久本地 |

**次要风险**

| # | 风险 | 说明 |
| --- | --- | --- |
| A4 | **记忆 canonical 冲突** | `los-memory`（SQLite ledger + Nowledge/shadow 双轨）与 los `packages/memory`（Postgres + compaction + procedural candidates）都在做"记忆"，且 DSH 又有 `~/.dsh/memories`。三处 canonical 未定 ⇒ "某条记忆在哪"无法机械回答 |
| A5 | **投影停更被当"没有历史"** | `session-index` 的 launchd 任务若停（如 G17 的 CI 台账停摆），跨会话检索会静默返回旧结果 |
| A6 | **路径分裂导致历史断裂** | `~/syncthing/project/*`（214 sessions，至 08-27）与 `~/syncfolder/project/*`（328 sessions，08-30 起）无法 join |
| A7 | **高长循环仓的上下文耗尽** | cankey(123.0) / lzlyx(137.8) / fmtguard(163.8) 这类比值意味着单轮极长；`~/.codex` 的纪律要求"两次上下文压缩后必须收尾并交接"，但**没有机械门禁** |

---

## 7. 本文档的边界与未决问题

**已实测**：§2 全部（配置路径、端口、进程、cc-switch DB、MCP 配置、仓结构与 VCS、session 统计）、§3 的 V1–V3/V5–V21、§4.1 的 `unirun` 接线、§4.3 的三仓自述。
**文档声称未复核**：`cantool`/`cankey`/`canpad` 的门禁脚本细节（未逐份读 `scripts/`）；`lot2extension` 的能力矩阵文档；`wechatdp` 的契约细节。
**未做**：未跑任何 build/test/gate；未读任何密钥明文；未改任何配置。

**需要 operator 定调的 3 个问题**

1. **"provider 面的唯一写者"这个问法本身要改**——三个决策中心各自成立（§2.2）：桌面工具归 `cc-switch`、**DSH 会话归它自己的 `agent-default-model` + `dsh-llm-fallbacks`**、agent/headless/治理归 `los gateway`。真正要 operator 定的是两件事：
   - **(a) 冲突判定权**：三者指向不同上游时，**谁负责发现并报冲突**（建议 los，因为它是唯一有程序化接口与账本的一方，且它已经在读 cc-switch 的 DB）；
   - **(b) 谁能改 DSH 的默认模型**：`agent-default-model`（`cordis.patch.yml:12-16`）与 fallback root chain 属 DSH 的 owner 权限，los **不得**代改；若要 los 成为统一入口，须显式把 DSH 默认改成 `los-gateway` 并承担随之而来的可用性责任。
   这决定 A1 的修法。
2. **记忆的 canonical 是谁**：`los-memory`（SQLite）／los `packages/memory`（Postgres）／DSH `~/.dsh/memories`？还是分层（个人记忆 / 项目记忆 / 执行记忆）？
3. **`dsfolder` 的结构定性**：采用 §4.2 的方案 B（明确"母仓 + 独立子仓"并补文档）还是 A（转 submodule）？
