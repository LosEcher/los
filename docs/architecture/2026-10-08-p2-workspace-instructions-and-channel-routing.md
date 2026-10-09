# P2 设计：工作区指令链 + 跨项目仓拓扑 + IM 渠道路由（按需可插拔）

- **状态**：设计（待评审）
- **归属**：DSH 与 los 双侧；L2-3/2-4 主要在 **DSH 侧**（profile/插件/渠道），L2-1/2-2 主要动**工作区文档**（不是代码）
- **批次**：P2
- **依据**：2026-10-08 盘点 + `~/syncfolder/project` 与 `los-workspace` 实测目录 + 用户 2026-10-08 口径：**"IM 按需配置，可以在 DSH 也可以在 los，都是插件化可拔插的方案"**
- **前置**：无（文档与配置为主）

---

## 1. 问题陈述（有数字）

### 1.1 工作区指令链在活跃仓库上不生效，最活跃的仓没有 AGENTS.md

实测各仓顶层指令文件：

| 仓 | AGENTS.md | CLAUDE.md | jj | 近 14 天 DSH sessions |
| --- | --- | --- | --- | --- |
| **dsfolder** | **缺失** | — | — | **82（最活跃）** |
| lot2extension | ✅ 6,719B | ✅ | ✅ | 42 |
| cantool | ✅ 7,471B | ✅ | ✅ | 29 |
| lzlyx | ✅ 1,095B | ✅ | — | 23 |
| deepseek-harness* | — | — | — | 19 |
| **los** | ✅ 5,996B | ✅ 661B | ✅ | 12 |
| wechatdp | ✅ 4,342B | ✅ | ✅ | 9 |
| cankey | ✅ 17,833B | — | ✅ | 8 |
| los-memory | ✅ 3,390B | — | — | 4 |
| canpad | ✅ 1,071B | — | — | 0 |

**三个具体缺口**：

1. **`dsfolder` 无 `AGENTS.md`**，而它是**最活跃的仓（82 sessions / 14d）**，且内部有 20+ 子目录（`unirun` / `rustopt` / `fmtguard` / `sandbox-run` / `verify-gate` / `run-diff` / `session-index` / `golden-tasks` / `routeguard` / `browser-fastloop` / `win-exec` / `grok-cloud-node` / `los-openai-proxy` / `memory-eval` / `nmem-diag` / `startup-opt-preflight` / `zoetrope-fold` / `anthropic-threat-2026-09` / `fx-poc` / `scripts` / `tmp` / `~`）。
   - 其中 `unirun` / `rustopt` / `fmtguard` / `sandbox-run` **各自是独立仓**且**有自己的 AGENTS.md**（实测：`dsfolder/fmtguard/AGENTS.md`、`dsfolder/unirun/AGENTS.md` 在会话里以 "Additional instructions from: unirun/AGENTS.md" 形式出现过）——所以**子仓有规则、父目录没有**，跨子仓的工作（如"把某个模式推广到四个 Rust 工具仓"）没有共同的规则落点。
2. **`los-memory/AGENTS.md` 写的是失效路径**：`~/projects/los-workspace/AGENTS.md` / `~/projects/los-workspace/WORKSPACE.md`——实测 **`~/projects` 不存在**（正确路径是 `~/syncfolder/project/los-workspace`）。
3. **`los-workspace/WORKSPACE.md` 的目录结构表与实际磁盘不符**：

   | WORKSPACE.md 声称 `projects/` 下有 | 实际磁盘 |
   | --- | --- |
   | `los` ★ / `lsclaw` / `vpsagentweb` / `los-ast` / `los-memory` / `pi` / `aigluetoolset` | **只有 `los` 与 `weclaw`** |

   同时，**真实活跃的 9 个开发仓全部在 `los-workspace/` 之外**（`~/syncfolder/project/{dsfolder,cantool,cankey,canpad,wechatdp,lot2extension,lzlyx,los-memory,deepseek-harness}`）。
   注：`los/AGENTS.md` 引的 `../../AGENTS.md`、`../../WORKSPACE.md` 是**能解析到的**（= `los-workspace/` 下，实测 exit 0），所以不是断链——**问题是它们描述的工作区与真实开发区不是同一个**。

### 1.2 跨项目仓拓扑无权威登记

近 14 天活跃的 9 个仓，在 los 的账本里只有 `los`（6231 todos）与 `lot2extension`（204）有登记，`dsfolder` 只有 3 条、`dsfolder-rustopt` 2 条、`dsfolder-fmtguard` 2 条、`dsfolder-run-diff` / `dsfolder-sandbox-run` 各 1 条（`todos` 表按 `project_id` 实测）。⇒ **仓登记是零散的、按需创建的，没有"这个工作区里有哪些仓、各自角色是什么"的单一真源**。后果：

- 无法机械回答"某个失败模式影响几个仓"（P1 的 `pattern_key` 聚合需要这个映射才能从 `cwd` 归到 `project_key`）。
- `dsfolder` 这种"父目录非仓、子目录各自是仓"的形态无法表达。

### 1.3 IM 渠道：插件化已实现，但缺"按需配置"的统一面

用户口径：**IM 按需配置，DSH 或 los 都可以，插件化可拔插**。现状盘点：

| 渠道 | 形态 | 现状 |
| --- | --- | --- |
| DSH `dsh-channel-wechat` | DSH 插件 | **已彻底卸载**（2026-10-06，源码归档 `~/.dsh/backups/wechat-uninstall-20261006-134701/`），因 iLink ret=-2 长期故障 |
| DSH `dsh-channel-telegram` | DSH 插件 | 仓在 `dsplugins/dsh-channel-telegram`，web profile 有依赖但**挂载行被注释掉** |
| DSH `dsh-feishu-outbound` / `dsh-lark-channel` | DSH 插件 | 存在（10-06 / 08-26 有改动） |
| los `packages/wechat-bot` | los 内置包 | **disabled / stopped**；依赖外部 `weclaw` 二进制；`WECLAW_API_ADDR=127.0.0.1:18011` 仍在 `.env` 但**无监听** |
| los `packages/telegram-bot` | los 内置包 | **disabled / stopped** |
| los feishu | 仅 `status:'planned'` | 未实现 |

**缺口不是"归属"，而是三件事**：

1. **没有统一的"渠道开关/健康"面**：DSH 侧散在 4-5 个插件的 profile 挂载行，los 侧散在 `.env` 的 `LOS_WECHAT_BOT_MODE` + 两个 package 的启停；两侧无法互相看见，也没有一个地方能回答"现在有几条 IM 出站路径是活的"。
2. **残留配置无人清**：`WECLAW_API_ADDR` 指着一个不监听的端口，而 `.env.example` 仍在宣传它——排障时会被误导（2026-10-08 盘点 B23 实证）。
3. **"按需"目前是手工三步**：改 profile 挂载行（或 `.env`）→ `pnpm install` / 重启宿主 → 验证。缺一个**幂等的开关 + 自证**（DSH 侧 2026-10-06 曾交付过 `dsfolder/scripts/wechat-channel-toggle.sh`（on\|off\|status），随插件卸载一起删了；这个形态是对的，只是绑死在单一渠道上）。

### 1.4 渠道依赖任务与渠道实际可用性不联动

实测：`daily execution digest (feishu)` 定时任务是 **enabled**，同期 los 侧 IM 能力为零、DSH 飞书插件虽在但**没有"任务执行前检查渠道可用"的门禁**。10-07 closeout 唯一的遗留功能项（DSH `job-440be80b` 每周验证 job 失败，真因 `feishu-push` 的 `.sent` 记账缺失 + 沙箱拒写）正是同一类问题的另一面：**投递链的成功/失败没有被独立记账**。

---

## 2. 设计目标与非目标

**目标**
1. 每个活跃仓**至少有一个**可被 agent 读到的规则落点，且**父目录/工作区层能表达"跨子仓的共同规则"**。
2. 有**单一真源**登记"这个工作区有哪些仓、各自角色、各自指令文件在哪"。
3. IM 渠道：**按需开、可插拔、开关幂等、状态可自证、残留可清**，且 DSH 与 los 两侧**互相可见**。
4. 渠道依赖任务在**渠道不可用时 fail-loud**，而不是静默 no_op 或假成功。

**非目标**
- **不决定** IM 归属（用户已定：两边都可，插件化）。本批次只做**配置面**。
- 不重写任何仓的 `AGENTS.md` 内容（只补缺失的落点 + 修失效路径）。
- 不引入新的 IM 协议/网关；只做开关与健康面。
- 不把 DSH 插件搬进 los 或反之。

---

## 3. 交付物

### L2-1 跨项目仓拓扑单一真源（DSH 侧，`project-registry.json` + 生成视图）

**新增** `~/syncfolder/project/los-workspace/.workspace/projects.json`（工作区级，人工维护 + 机械校验）：

```jsonc
{
  "version": 1,
  "projects": [
    {
      "key": "dsfolder",                      // P1 pattern_key 聚合用的 project_key
      "path": "/Users/echerlos/syncfolder/project/dsfolder",
      "kind": "umbrella",                     // umbrella | repo
      "role": "跨项目规则/设计/脚本母仓；Rust 工具仓的父目录",
      "agents_md": null,                      // ← L2-2 补齐
      "vcs": "git",
      "children": [
        { "key": "unirun",   "path": "…/dsfolder/unirun",   "kind": "repo", "agents_md": "AGENTS.md" },
        { "key": "rustopt",  "path": "…/dsfolder/rustopt",  "kind": "repo", "agents_md": "AGENTS.md" },
        { "key": "fmtguard", "path": "…/dsfolder/fmtguard", "kind": "repo", "agents_md": "AGENTS.md" },
        { "key": "sandbox-run", "path": "…/dsfolder/sandbox-run", "kind": "repo", "agents_md": "AGENTS.md" }
      ]
    },
    { "key": "los", "path": "…/los-workspace/projects/los", "kind": "repo", "agents_md": "AGENTS.md" }
    // cantool / cankey / canpad / wechatdp / lot2extension / lzlyx / los-memory / deepseek-harness
  ]
}
```

**校验器** `tools/check-project-registry.mjs`（fail-closed）：
- 每个 `path` 必须存在；
- `kind=repo` 必须有 VCS 目录；
- `agents_md` 声明为路径的必须存在；
- **反向完备性**：扫 `~/.dsh/sessions/*` 的 cwd slug，凡近 30 天有会话但**未登记**的 cwd → 报告为 `unregistered`（不直接红，但出 TODO）；
- 版本化：变更必须 bump `version`。

**为什么放 DSH/工作区而不是 los**：los 是主项目，但它不是工作区的唯一居民；`project_key` 是跨项目概念，落 los 会让 los 依赖别的仓的存在。

**验收**：校验器 exit 0；人为把 `dsfolder` 的 `agents_md` 指向不存在的文件 → exit 1；人为删一个 `path` → exit 1；`unregistered` 列表为空或每条都有 todo。

### L2-2 工作区指令链补齐与去陈旧（文档，非代码）

| 动作 | 内容 |
| --- | --- |
| **A. 补 `dsfolder/AGENTS.md`** | 只写**跨子仓的共同规则**（不重复子仓规则）：① 子仓清单 + 各自规则入口（指向 `unirun/AGENTS.md` 等）；② 「改一个工具仓的模式要不要推广到其余三个」的判据（参考 `docs/research/2026-10-07-shaders-patterns-cross-project-optimization.md` 的四级可迁移性）；③ 共同的验证纪律（沙箱内/外、`cargo fmt --check`、门禁跑法）；④ 明示"本目录不是单一仓，勿在父目录 commit 子仓内容" |
| **B. 修 `los-memory/AGENTS.md` 的失效路径** | `~/projects/los-workspace/*` → `~/syncfolder/project/los-workspace/*`（或改为相对引用的说明） |
| **C. 修 `los-workspace/WORKSPACE.md`** | 目录结构表改为真实内容（`projects/` 只有 `los` + `weclaw`）；**新增一节"真实开发区"**，指向 L2-1 的 `projects.json` 作为权威；保留 `lsclaw/vpsagentweb/los-ast/pi/aigluetoolset` 为"已归档的历史参考源（不在磁盘）" |
| **D. 一致性门禁** | `tools/check-workspace-docs.sh`：① `WORKSPACE.md` 声称存在的 `projects/*` 必须存在，否则红；② 各仓 `AGENTS.md` 里的路径式引用（`~/projects/...`、`../../...`）必须可解析，否则红；③ `los-memory/AGENTS.md` 与 `los/AGENTS.md` 的 Workspace 段必须与 `projects.json` 一致 |

**验收**：D 的门禁在修好的树上 exit 0；把任一条路径改坏 → exit 1（负向控制）。补 A 之后，在 `dsfolder` 起一个会话，确认 system-reminder 里出现该 `AGENTS.md`。

### L2-3 IM 渠道路由的按需配置面（DSH 主，los 侧对齐）

**统一开关（幂等 + 自证）**，两档实现、同一份状态语义：

| 档 | 命令 | 动作 |
| --- | --- | --- |
| DSH | `dsfolder/scripts/channel-toggle.sh <profile> <channel> on\|off\|status` | 改 profile 的 bundle 挂载行（与 `cordis.patch.yml` 覆盖行）→ 等热重放（或按需重启宿主）→ **断言**：`settings.describe` 命名空间 / 插件树 `failed=0` / `channel-<x>` 命中与期望一致 |
| los | `tools/los.sh channels:mode <channel> on\|off\|status` | 改 `.env` 的 `LOS_<CH>_BOT_MODE` + 启停 `com.los.<ch>-bot` → 断言：`pnpm run channels:status` 与端口监听一致 |

**关键约束（来自已踩的坑，必须写进脚本注释）**：
- DSH 侧 `ctx.settings.register` **会**在 config-only 热重放中执行（2026-10-06 实证），所以"必须重启"这类断言要先机械验证再写；
- **headless 不可加载 `dsh-channel-wechat`**（缺 `webServer` 服务，2026-08-16 实证：整树激活失败 → boot 崩）；
- profile 变更需同轮 `pnpm install`，且用**profile 自身那版 pnpm**。

**统一健康面**（两侧都写同一份 JSON，供 P1 看板/日报读）：

```jsonc
// ~/.dsh/storages/channel-registry.json
{
  "asOf": "2026-10-08T12:00:00Z",
  "channels": [
    { "id": "wechat",   "side": "dsh", "state": "uninstalled", "evidence": "profile dep absent" },
    { "id": "telegram", "side": "dsh", "state": "declared-disabled", "evidence": "cordis.patch.yml 挂载行注释" },
    { "id": "feishu",   "side": "dsh", "state": "loaded", "evidence": "settings.describe=feishu-push" },
    { "id": "wechat",   "side": "los", "state": "disabled", "evidence": "LOS_WECHAT_BOT_MODE=disabled" },
    { "id": "telegram", "side": "los", "state": "disabled", "evidence": "channels:status" },
    { "id": "weclaw",   "side": "los", "state": "dead-endpoint", "evidence": "127.0.0.1:18011 无监听" }
  ]
}
```

**残留清理**（本批次一并做）：
- `.env`：`WECLAW_API_ADDR` / `WECLAW_DEFAULT_TO` → 若决定不用 los 侧 wechat，则移入 `.env.bak` 并在 `.env.example` 标注"仅当 los wechat-bot 启用时需要"；
- `.env.example`：为 `LOS_WECHAT_BOT_MODE` / `LOS_TELEGRAM_BOT_MODE` / feishu 相关键补"何时需要 + 开启后如何自证"；
- 判据：`lsof -nP -iTCP:18011 -sTCP:LISTEN` 为空时，注册表必须把 `weclaw` 标 `dead-endpoint`，日报不得把它当活路径。

### L2-4 渠道依赖任务的 fail-loud 门禁（los + DSH 双侧）

**问题**：`daily execution digest (feishu)` 任务是 enabled，但渠道可用性没有前置检查；DSH 侧 `job-440be80b` 的 `failed` 与 `exit=0` 并存（`.sent` 记账缺失）。

**设计**
1. **任务声明渠道依赖**：`scheduled_work_items` 的 config 增 `requiresChannels: ["feishu"]`（los 侧）/ DSH 侧 job 增同义字段。
2. **执行前门禁**：读 L2-3 的 `channel-registry.json`，若依赖渠道 `state ∉ {loaded, healthy}` → run 记 **`skipped: channel_unavailable`**（**不是** `failed`，也**不是** `no_op`），并出一次 `channel_unavailable` 事件。
3. **投递必须独立记账**：发送成功 → 写 `.sent`（含 message id / 时间 / 目标）；发送失败 → 写 `.failed` + 原因；**缺记账视为失败**（这才是 10-07 `job-440be80b` 的真因：产物没落盘却 `exit 0`）。
4. **沙箱拒写不得被误判**：记账路径在工作区外时，**必须区分 `EACCES/denied` 与 "已存在 → 幂等命中"**——10-08 会话实证的原始缺陷是 `mkdir` claim 失败被读成 `inFlight → dedup:true exit 0`，即**故障通知根本没发出去却报成功**。判据：`mkdir` 失败时必须读 errno；`denied/permission` → 硬失败；`EEXIST` → 才可判幂等。

**验收**（负向控制是重点）
- 渠道 off + 任务 enabled → run 记 `skipped: channel_unavailable`（**不是** failed/no_op/exit 0）
- 渠道 on + 发送失败 → `.failed` 存在且 run 记 failed
- **沙箱拒写记账路径 → run 记 failed（不得 exit 0）**；把 `mkdir` 改成 `EEXIST` 场景 → 幂等命中且 run 记 succeeded
- DSH `job-440be80b` 跑完：`failed` 与 `exit 0` **不再并存**

---

## 4. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 补 `dsfolder/AGENTS.md` 后子仓会话看到两份规则（父 + 子）而冲突 | 父文件只写"跨子仓共同规则 + 子仓入口"，明确"子仓规则优先"；L2-2D 的门禁加一条"父文件不得重复子仓不变量"的人工评审项 |
| `projects.json` 又变成第二份会漂移的真相 | 校验器含**反向完备性**（从真实 session cwd 反查未登记项）+ version bump 强制 |
| 渠道开关脚本成为"第 N 个只在一个渠道上能用的脚本" | 两档实现同一份状态语义（`channel-registry.json`），并把这个 JSON 作为**唯一**健康判据（脚本只负责写它） |
| 门禁把渠道 off 判成 failed 造成告警噪音 | 三态分明：`skipped: channel_unavailable` / `failed` / `succeeded`，日报分别计数 |
| 改 profile 挂载行触发一次宿主重启，打断会话 | 沿用既有纪律：延迟重启（`dsh-web-restart.sh --delay N`）+ 排程前只读预检 + 结束时停在空闲态 |

---

## 5. 验收门（整批）

1. `check-project-registry.mjs` / `check-workspace-docs.sh` 双绿，且各自的负向控制能红。
2. `dsfolder` 会话能读到父 `AGENTS.md`；`los-memory/AGENTS.md` 与 `WORKSPACE.md` 的路径全部可解析。
3. `channel-toggle.sh status` 与 `los.sh channels:mode status` 对同一渠道给出一致状态，且与 `channel-registry.json` 一致。
4. `channel-registry.json` 在 weclaw 端口无监听时标 `dead-endpoint`；`.env.example` 已标注该键的启用条件。
5. fail-loud 门禁的四条负向控制全过（off→skipped、发送失败→failed、拒写→failed、EEXIST→succeeded）。
