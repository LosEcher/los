# Provider 健康面的协议盲区、执行器的双管理器、以及一轮机队收敛

Date: 2026-10-12

Subject: provider 健康评分（`provider-probe` / `provider-health` / `provider_call_telemetry`）、
执行器管理器归属（launchd vs `tools/los.sh`）、`scheduled_work_items` 里的明文 `agentKey`、
以及 8 节点机队从 `b4b3261f61751` 收敛到 `b4cd20e3f4189` 的过程与证据。

一句话：**探针只打 `GET {baseUrl}/models`，而那是 OpenAI 兼容协议的形状** ——
整个 `anthropic-messages` 协议族因此被结构性判为 `unhealthy`（0.40），
而 ADR 0031 会选择跳过 unhealthy。真实调用一直是 200。

## 1. 原始现象

`/providers/health`（operator token）在 **2026-10-12** 的读数：

| provider | 协议 | score | tier | 真实调用 |
| --- | --- | --- | --- | --- |
| `anthropic` | anthropic-messages | 0.40 | **unhealthy** | **200** |
| `deepseek-anthropic` | anthropic-messages | 0.33 | **unhealthy** | **200** |
| `zenmux-claude` | anthropic-messages | 0.20 | **unhealthy** | **200** |
| `minimax` | anthropic-messages | 0.07 | unhealthy | 402（真） |
| `nvidia-nim` | openai 兼容 | 0.86 | healthy | **410 Gone** |

同一张表里同时有**假红**（前三行可用却被判 unhealthy）与**假绿**（最后一行不可用却是 healthy）。

## 2. 根因（两个，独立）

### 2.1 探针协议盲区 → 见 §3

`computeHealthScore(provider, probe, outcomes)`：

```
score = 0.4·rttScore + 0.4·successRate + 0.2·availabilityScore
probe.healthy === false  ⇒  rttScore = 0 且 availabilityScore = 0
⇒ 即使真实成功率 = 1：score = 0.4·0 + 0.4·1 + 0.2·0 = 0.40 < 0.5 ⇒ unhealthy
tier 阈值：≥0.8 healthy / ≥0.5 degraded / <0.5 unhealthy
```

### 2.2 `outcomes` 从未被传入 → 见 §4

评分器**本来就设计**了 `outcomes` 入参，`provider-selection.ts` 也真的取了它（24h 窗口），
但**探针循环只传 probe**。⇒ 同一件事两套算法、输入不同；
`successRate` 在没有 outcomes 时恒为 **1.0**（"no outcome data → benefit of the doubt"），
所以 410/401 全被宽恕 —— 这就是假绿。

## 3. 修复一：探针按协议分派

判据由实测给出（不是猜的）：

| 路径 | zenmux | deepseek |
| --- | --- | --- |
| `{base}/models`（原探针） | **404** ⇒ 判 unhealthy | **401** ⇒ 判 healthy |
| `{base}/v1/messages`（协议正典） | 404 | 401 |
| `{base}/v1/models` | 200 | — |

⇒ `anthropic` 线改探 **`{base}/v1/messages`**，判据放宽为**任何 `< 500` 的 HTTP 应答 = 边缘可达**；
`openai` 线判据**不变**（那里 `/models` 真的存在，放宽会让填错的 baseUrl 看起来健康）。

**职责分开**：探针量**可用性**（权重 0.2），**正确性**由真实调用结果承担（权重 0.4）。
所以"401/404 也算可达"不会掩盖坏凭据 —— `minimax` 就是活例（探针 healthy、真实 402 ⇒ 0.64 degraded）。

⚠️ **不能用遥测的 `avgDurationMs` 替代探针 RTT**：那是**生成耗时**（实测 anthropic 10526ms、
openrouter 16404ms），而 `RTT_MAX_MS = 5000`，全都会算成 0。与探针的**连接 RTT** 不可互换。

### 3.1 走过的弯路（留档，避免重试）

第一版处置是「把 anthropic 系**排除出探针靶**」。它确实解除了误路由（`unhealthy` → `degraded`），
但实测这 4 家会从 `/providers/health` **整条消失**（健康条目由探针循环填缓存）
⇒ 那是拿"误判成 unhealthy"换"看不见"，而看不见会让真实在坏的 provider 也无从发现。
**正确做法是照样算分、只是不给 probe**，或（本提交）**按协议探对路径**。

## 4. 修复二：真实调用结果接进评分

`provider_call_telemetry` 聚合（`telemetry.ts` 的 `getRecentProviderOutcomes`，24h 窗口，
窗口与 `provider-selection.ts` 一致），**按 provider 全量聚合**而不是"取最热的那个 model"：

- 早期实现 `GROUP BY model … ORDER BY total DESC LIMIT 1` 有两个真缺陷（独立 review 指出）：
  其余 model 的失败被整条丢掉；调用量接近时**两次探测之间会抖动**。
- 现在 `model` 只作展示，用 `model ASC` 做确定性 tiebreak。

**查询失败 ≠ 窗口内无数据**：前者必须记日志（否则静默退回宽恕，刚修的假绿原样复现）。

### 4.1 修复后的分层（实测）

| provider | 修复前 | 修复后 |
| --- | --- | --- |
| `deepseek-anthropic` | 0.33 unhealthy | **0.90 healthy**（rtt=390ms） |
| `anthropic` | 0.40 unhealthy | 0.74 degraded（rtt=3087ms） |
| `minimax` | 0.07 unhealthy | 0.64 degraded（真实 402 仍拉低）✅ |
| `nvidia-nim` | 0.86 **healthy**（假绿） | 0.13 unhealthy ✅（真实 410） |
| `opencode-zen` | 0.80 **healthy**（假绿） | 0.70 degraded ✅（真实 401） |

## 5. 执行器的**双管理器**陷阱（运维价值最高的一条）

| | 谁在管 | 跑哪棵树 | 端口 |
| --- | --- | --- | --- |
| gateway | 本仓 `./tools/los.sh`（`.los-runtime/gateway.pid`） | **工作树** | 8080 |
| executor（本地节点） | **launchd `com.echerlos.los-executor`** | **钉树 `~/.local/share/los`** | 8090 |

`./tools/los.sh start` **也会去起 executor**。一旦起了，它占住 8090，
launchd 那个用 **`EADDRINUSE`** 崩在 `~/.local/share/los/.los-runtime/executor-launchd.err.log`。

**症状**：`tools/los-fleet-rollout.sh --node mbp-executor-1` 的 verify 报
`/health never reported <目标> (got <旧摘要>)`，而**真实持有端口的进程版本是对的**——
因为 verify 看到的是 `los.sh` 起的那个（跑**工作树**）。

**判据：pid 文件不可信，看真正持有端口的人。**

```sh
lsof -nP -iTCP:8090 -sTCP:LISTEN          # 真实持有者
lsof -a -p <pid> -d cwd                   # 钉树还是工作树
curl -s http://127.0.0.1:8090/health      # version / lifecycle / acceptingTasks
launchctl list | grep los-executor        # 存在即由 launchd 管
```

**修法**：杀掉 `los.sh` 那套（进程 + 其包装父进程），让 launchd 的 KeepAlive 接管。
实测：`8090` 的持有者由 `15359`（cwd=工作树）变为 `8482`（cwd=钉树），
`/health` 立刻报出目标摘要。

**推论**：executor 是**长驻进程，配置只在启动时装载**。
「改了 `.env`/`config.yaml` 但 executor 没重启」与「配置写错了」在现象上**一模一样**。
2026-10-12 实测：给网关加了 `ANTHROPIC_*`，gateway 立刻能用，
executor 一直报 `Provider 'anthropic' not configured` —— 因为 `EADDRINUSE` 让它永远起不来新的。

## 6. 明文 `agentKey`（安全）

`scheduled_work_items.run_template_json.executor.agentKey` 有 **9 行**存着**明文活密钥**
（`md5(去重聚合) = a19d861daa0498c35ba87577efd15201`），与当时机队 key **逐字相同**。

**前置检查推翻了一个假设**：`runner.ts` 是 `executor: schedule.runTemplate.executor` ——
runner **真的会读它**（`run-resume-dispatch` 的 config 兜底只在 `options.executor` 为空时生效）。
所以"纯冗余、可无风险抹掉"是错的，**必须先改 runner**。

三处改动：① 写入侧 `normalizeExecutorConfig` 收到 `executor.agentKey` **fail-loud 拒绝**；
② runner 以 `config.executor.agentKey` 为准（新增 `withExecutorKeyFromConfig`）；
③ 抹存量 `UPDATE 9` → 复核 **0 行**，`executor` 其余字段完好。

**不轮换密钥**：暴露面是**库内静态 + 备份/dump**（scheduled-work 路由里 `runTemplate`
只出现在写入/补丁路径，**没有 GET 把它吐给调用方**），而轮换要同步改 8 台 `.env` + 网关 + 9 行
（心跳与模型路径用同一把 key，漏一台就 401）。**确认泄露再轮换。**

## 7. 凭据单一真源

`anthropic` 的 key 曾同时存在于 **3 处**（`los/.env`、`~/.los/config.yaml`、
cc-switch db），而**钉树还有自己的 `.env`**（机队约定"每节点一份配置"）
⇒ 轮换只改一处就是静默陷阱。

**收敛到 1 处**：`~/.los/accounts/anthropic.json`（mode **600**，字段
`{provider, api_key, base_url, model}`；名字 `anthropic` 靠 `model-profiles.ts` 定线，
**不需要 apiShape**）。顺手把历史遗留的 `deepseek.json` 从 644 修成 600。

验证：`/providers/models?provider=anthropic` 的 `source` = `los/accounts/anthropic.json`，
且 `POST /v1/chat/completions {"model":"anthropic"}` → 200。

## 8. 一条 model id 的防御性修复

cc-switch 的 claude 账户把 Claude Code 的方括号后缀写进 model 值
（`ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-5.5[1M]`）。
用它当 API model id 打 zenmux 的 `/api/anthropic/v1/messages` → **404 `invalid_model`**；
`anthropic/claude-opus-5.5` → **200**。已在 discovery 解析边界剥掉结尾 `[...]`
（`-free` 这类是真后缀，不剥）。

⚠️ **可达性窄**：`ccSwitchProviderFromRow` 只把 **deepseek/minimax** 形状的 claude 行映射成
provider，**其余返回 `null`**（`zenmuxcc-*` 就是这类）⇒ 那条 `[1M]` 值**今天进不了 los**。
所以这是**防御性**修复。**我的第一版测试写错了前提**（用 zenmux 行），是**跑测试**而不是读代码
把它抓出来的。

## 9. 机队收敛（两轮）

| 轮 | 目标 | 结果 |
| --- | --- | --- |
| 1 | `b3f84c0591642` | 8/8 收敛；本地节点先经 §5 的端口交接才通过 |
| 2 | `b4cd20e3f4189`（含 §3/§4/§7/§8） | 8/8 收敛 |

**判据命令**：

```sh
node tools/deployable-content.mjs --digest
psql "$DATABASE_URL" -At -c "select distinct version from executor_nodes where status='online' and node_kind='executor'"
bash tools/los-fleet-rollout.sh --plan
```

**两个教训**：
- `--canary` 取节点表**第一台（vultr，海外）**；它 SSH 偶发不通会把 fail-fast 变成
  "其余 7 台也不动" ⇒ 全量滚用 `--continue-on-error`。
- `executor_nodes.rollout_state` 可能是**陈旧**的 `draining`：以节点自报
  `/health.acceptingTasks` 为准（实测 vultr：DB 说 draining、节点说 accepting=true，3/3 采样）。

## 10. 本轮被推翻的自家前提（每条都留了对照）

| # | 原来的说法 | 被什么推翻 |
| --- | --- | --- |
| 1 | 「`openai` 通道坏了（500 fetch failed）」 | 连打 + 遥测分布：**单次瞬时** |
| 2 | 「agentKey 是纯冗余」 | 前置检查：`runner.ts` 真会读它 |
| 3 | 「`[1M]` 会被 los 采用」 | **测试直接失败**：非 deepseek/minimax 行返回 null |
| 4 | 「packycode 残余假红」 | 抖动窗口内的**单次读数**；稳定后 0.79、成功率 1 |
| 5 | 「裸 curl 400 ⇒ packycode 不支持 chat」 | 那是**我打错了协议**（它走 Responses） |

⇒ 提炼为 `~/.codex/rules/agent-execution-discipline.md` 的
**Claims And Falsification** 一节：任何"某东西坏了"的结论都必须带一条**能证伪它的对照**。

## 11. 本轮未验证 / 未做

- **vultr 的直探/SSH 偶发超时**：量化到**直探 10 次成 6 次**；节点健康、registry 正常
  ⇒ 属**网络面**，未做修复（缺丢包率/路径数据）。
- **按协议分派的探针只覆盖两条线**（openai / anthropic）：将来加协议（如 Gemini）
  需要同时补路径与判据。
- **`xai`（OAuth `invalid_grant`）/ `nvidia-nim`（410）/ `minimax`（402）的 unhealthy 是真实的**，
  本轮**没有**去"修好"它们。
- **9 行历史 `agentKey` 已抹，但数据库备份/转储里可能仍有** —— 未做备份侧清理，
  也未轮换密钥（判据见 §6）。
