# 重启前状态与重启后验证清单（2.4.2）

## ⚠️ 一处前提纠正（实测得到）

设计文档把 2.4.2 描述为"`session-index` 插件**装进** desktop profile"。
**实测否掉了这个前提**：`dsh-session-index` **本来就在 desktop 的插件树里**：

```
pluginInventory/list →
  {"entryId":"include:session-index","moduleName":"dsh-session-index",
   "enabled":true,"fiberPhase":"active","meta":{... "session_search / session_events / session_stats" ...}}
```

`fiberPhase: "active"` ⇒ fiber 已加载 ⇒ 它的 `inject: [tools]` 已执行。
且 DB mtime 在推进（launchd `com.echerlos.dsh-session-index` 已加载并运行）。

**真正缺的是**：`dsh-obs plugin-status` 探测到
```
· dsh-session-index      N/A (HTTP 404)     ← 它没实现 /plugins/<id>/status
  已实现 /plugins/<id>/status: 0/1
```
对照 `dsh-dashboards` 有：`✓ v0.1.0 widgets=14 backendsOk=0`。

⇒ 这是**可观测性缺口**（不变量 **O1**：有状态组件必须有状态面），
**不是安装缺口**。补齐它需要**改插件代码**（加一个只读 status 端点），
那才是一次真正需要重启的改动。

## 本轮已做的配置变更（无害且使状态更明确）

| 变更 | 位置 | 说明 |
| --- | --- | --- |
| `dependencies += dsh-session-index` | `~/.dsh/profiles/desktop/package.json` | 与 web profile 同形（`link:` 指向 dsplugins 源） |
| `dsh.profile.bundles += dsh-session-index` | 同上 | **必须同时加**，否则只在 dependencies 里不生效 |
| `pnpm install` | desktop profile | 创建 `node_modules/dsh-session-index` 符号链接（此前缺失） |

**备份**：`/tmp/desktop-pkg-backup.json`、`/tmp/desktop-lock-backup.yaml`。
**注意**：`dsh plugin --profile desktop` **不可用** ——
`error: profile "desktop" is managed exclusively by the Electron application`
⇒ 手工改配置是唯一途径。

## 重启后要验证什么（按判据，不是"看起来对了"）

### V1 插件仍在树里且 enabled（回归）
```bash
cd ~/syncfolder/project/dsfolder
node scripts/dsh-obs.mjs rpc pluginInventory/list --args '{}' \
  | python3 -c "import sys,json;raw=sys.stdin.read();d=json.loads(raw[raw.find('{'):]);\
[print(json.dumps(e,ensure_ascii=False)[:200]) for e in d['entries'] if 'session-index' in json.dumps(e)]"
```
期望：`enabled: true` + `fiberPhase: "active"`。

### V2 工具真的可调用 —— ✅ **重启前已提前验证通过**

```bash
BIN=~/syncfolder/project/dsfolder/session-index/target/release/session-index
"$BIN" stats --db ~/.dsh/storages/session-index.db --emit json
```
**实测返回真实数据**（session_id / events / tool_calls / llm_requests / tokens）
⇒ 工具的**底层二进制可用**。

**二进制解析的实际情况**（取证）：
| 候选 | 状态 |
| --- | --- |
| `config.binary` / `$SESSION_INDEX_BIN` | 未设置 |
| PATH `session-index` | ❌ 不在 PATH |
| `~/.cargo/bin/session-index` | ❌ **未安装** |
| `dsfolder/session-index/target/release/session-index`（插件内置 fallback） | ✅ **存在**（`session-index 0.5.0`，`2026-10-07 12:12` 构建） |

⇒ **工具能工作，靠的是插件内置的仓内 fallback**，而不是已安装的二进制。
**建议**（非阻塞）：`cargo install --path dsfolder/session-index --locked` 把它装到
`~/.cargo/bin`，否则该 fallback 一旦被清理（如 `cargo clean`）工具就会失效。
这与 B2.1(b) 的工具链新鲜度检具是同一条判据面。

### V2 原计划的重启后复核（仍可做，用于确认重启未破坏它）
在任一 DSH 会话里调用 `session_stats`（或 `session_search`）。
- 能返回 ⇒ **闭环**
- 报"二进制缺失/找不到库" ⇒ 按插件 README 的解析顺序排查
  （`config.binary` → `$SESSION_INDEX_BIN` → PATH → `~/.cargo/bin` → dsfolder `target/release`）
- **不得**因"树里有"就认为工具可用 —— 这正是 V-19「配置被当生效」的形态

### V3 DB 新鲜度（O3）
```bash
stat -f '%Sm %z' -t '%Y-%m-%d %H:%M:%S' ~/.dsh/storages/session-index.db
```
**基线**（重启前）：`2026-10-08 17:44:29` / `278568960` bytes
期望：mtime 在推进（launchd 每小时；阈值内不算故障 —— 见 watchdog 的"漏跑 ≥2 次才拉响"）。
若**不推进** ⇒ 显式报"已配置但未生效"，不得报成功。

### V4 status 端点（本项真正的缺口，需改代码）
```bash
node scripts/dsh-obs.mjs plugin-status session-index
```
当前：`N/A (HTTP 404)`。
**重启不会改变它** —— 需给插件加 `/plugins/dsh-session-index/status`，
返回 `lastRunAt`/`lastDurationMs`/`lastError`/`consecutiveFails`/`dataAgeMs`/`dbBytes`
（照 `dsh-dashboards` 的 `lib/poller.mjs` 形态，且**成功不清空 `lastError`**，不变量 O2）。

## 重启状态取证（2026-10-08 19:02 实测）

判据不是"用户说重启了"，而是**宿主进程启动时刻 vs 代码改动时刻**：

```
宿主进程 32564:  STARTED Thu Oct 8 10:41:42   ELAPSED 08:21:02
当前时间:        2026-10-08 19:02:38
status 端点:     dsh-session-index  N/A (HTTP 404)
```

宿主启动在 **10:41:42**，而 status 端点的代码改动在 **~18:50–19:00** ⇒
**重启尚未发生**，404 是预期的。（`ps -o lstart` 是比"用户叙述"更可靠的判据 ——
本项已实际用到。）

## ★ 第一次重启的结果与我的 bug（2026-10-08 20:15 实测）

**重启确实成功了**，但 V4 仍 404 —— **原因在我的代码**，且时间线可以证明：

```
desktop 宿主（19387）启动   20:14:02   ← 重启成功
我编辑 index.mjs           20:14:46   ← 编辑在启动之后 38 秒
```

**根因**：`dsh-dashboards` 声明了 `export const inject = ['webServer']`，
而**我的插件只声明了 `['tools']`**。Cordis 只注入被声明的服务 ⇒ `ctx.webServer`
是 `undefined`，而我写的守卫是 `if (ctx.webServer?.register)` ⇒ **静默跳过注册**，
日志无痕，外部表现与"代码没改"完全一样。

**这与本项目一直在登记的反模式同族**："守卫/降级把失败抹掉"（对照 verify-gate 的
"全 na 算 pass"）。写成 `if (dep?.method)` 时，`?.` 会让**装配错误**伪装成
**可选功能缺失**。对"我声明了就该有"的依赖，守卫必须 **fail-loud**。

**已修**（`dsh-session-index ad0c6b7`）：`inject = ['tools','webServer']`，
且守卫改为 `if (!ctx.webServer?.register) ctx.logger?.error?.(...)`。

**⇒ 需要再重启一次**（DSH 规则：host 插件代码改动必须重启；Node ESM 按 URL 缓存，
HMR 只对 `cordis.patch.yml` 之类的 config 生效）。

## ⚠️ 注意：有两个宿主，别测错对象

| 端口 | 进程 | profile | 说明 |
| --- | --- | --- | --- |
| **19387** | Electron `DeepSeek Harness` | **desktop** | **本项的目标**；`dsh-obs` 需 `DSH_OBS_BASE=http://127.0.0.1:19387` |
| 3080 | `node … web --no-open`（launchd daemon 拉起） | web | `dsh-obs` 的**默认**目标 |

**我先前用默认的 3080 测，测错了对象** —— 3080 是 web daemon，与 desktop 无关。
另：desktop 是 Electron 托管的，**`dsh-obs` 对它的 RPC 认证会因重启而失效**
（launch token 过期），故验证优先用**直接探测路由**：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19387/plugins/dsh-session-index/status
```
期望 `200`（此前为 `404`）。

## 建议

1. **重启本身可选**：插件已在树里，重启对 V2/V3 不产生变化（只是让新加的 bundle 显式生效）。
2. **若你已准备重启**：重启后跑 V1–V3 即可（V4 不会变）。
3. **真正该做的是 V4**（给插件加 status 端点）—— 这是一次需要重启的**代码**改动，
   建议与重启合并进行，避免两次中断。
