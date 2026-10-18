# 沙箱 profile 漏了 `/dev/null` ⇒ `sandboxMode: sandbox` 下 git 完全不可用（DuckDB 落点派发实测暴露）

> Status: **已定位到源码并实测复现**（2026-10-16）。**未修**：修法是一行，但属安全面改动，需显式决定。
> 锚：`file:packages/agent/src/tools/external/shell-sandbox.ts:237-254`、`file:packages/agent/src/loop.test.ts:148-165`、`file:packages/agent/src/tools/core/registry-policy.ts:181-186`
> 发现路径：dsfolder 侧第一次**真实 los 派发**（`dsfolder-session-index`，节点 `mbp-executor-1`）连续两次失败后的根因定位。
> dsfolder 侧的证据留档：`dsfolder/CROSS-PROJECT-PROPOSAL-LIFECYCLE-DESIGN-2026-10-16.md` §5.7 C-3′。

---

## 1. 现象（两次派发，两种失败）

| 次 | `toolMode` / `sandboxMode` | 结果 |
|---|---|---|
| 1 | `all` / `sandbox` | run 自检驳回：agent 只做了**静态读代码**（读 `test/gates.sh:533-563`）而未执行，自检原文 *"which is not execution evidence"*。**且 `git` 每条命令 rc=128**（agent 明确写"判不了"，未折成"工作树干净"） |
| 2 | `project-write` / `workspace-write` | **`tool denials: run_shell×1 (Tool risk L2 exceeds max L1: run_shell)`** ⇒ 连 `cargo build` 都跑不了，三项 requiredChecks 全"判不了" |

**两次都不能执行任何命令** —— 而"实现"与"验收"这两件事都需要执行命令。

## 2. 根因（读源码，非推断）

`packages/agent/src/tools/external/shell-sandbox.ts` 的 `_buildMacSandboxProfile()` 生成：

```scheme
(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow file-read*)
(allow file-write* (subpath "<workspace cwd>"))   ; ← 只允许写工作区内
(deny network*)
```

`(deny default)` + 仅 `subpath(cwd)` 可写 ⇒ **`/dev/null` 在工作区之外 ⇒ 不可写**。
而 `git` 会在若干路径上打开 `/dev/null` ⇒ **沙箱内每条 git 命令 rc=128**。

## 3. 为什么这是个死结（两边都堵）

风险级别映射读自 `packages/agent/src/loop.test.ts:148-165`（canonical resolver），判定点在 `packages/agent/src/tools/core/registry-policy.ts:181-186`：

| 模式 | `maxRiskLevel` | `allowWrites` | 后果 |
|---|---|---|---|
| `readonly`（或 legacy `read-only`） | **L0** | false | 没有任何 shell |
| `workspace-write` **或** `project-write` | **L1** | true | **`run_shell`（L2）被拒** |
| `sandbox` | **L2** | true | shell 允许，**但 profile 只允许写 cwd ⇒ git/`/dev/null` 挂** |
| 缺省 | L2 | true | 同上 |

且 `sandbox` 与 `workspace-write` **用的是同一个 write clause**（源码 docstring 原话 *"same enforced profile as workspace-write"*）⇒ **两者唯一的差别就是那个 L2/L1**。

⇒ **要 shell 就得用 `sandbox`（唯一 L2），而那个模式的 profile 恰好让 `/dev/null` 不可写；换 `workspace-write` 文件系统正常但 shell 被 L1 拒。** 无解。

## 4. 一行修法

`shell-sandbox.ts` 的 profile 数组里加：

```scheme
(allow file-write-data (literal "/dev/null"))
(allow file-write-data (literal "/dev/tty"))   ; 视需要
```

**为什么这不是"放宽安全边界"**：写 `/dev/null` 是**丢弃数据**，不是数据落点；沙箱的意图是"写只落在工作区内"，而 `/dev/null` 从来不是数据。当前行为是**误伤**，不是有意的约束。

## 5. 实测证明（负向控制，2026-10-16，本机 `sandbox-exec`）

逐字复刻上述 profile（cwd = session-index），只改 `/dev/null` 那一行：

| profile | `echo x > /dev/null` | `git rev-parse --short HEAD` |
|---|---|---|
| **现状**（逐字复刻 los 的输出） | ❌ 被拒 | ❌ rc≠0 |
| **加一行后** | ✅ OK | ✅ `63aa1e1` |

## 6. 影响面

- **任何需要 shell 的 los 任务**都受影响：`executor` 上的 `run_agent`、gates、构建、测试。
- **任何需要 git 证据的验收**都受影响 —— 且本工作区的判据大量依赖 git（`commit:` 锚、`git status`、`git log`）。
- 也就是：**"用 los 做实现与验收"这件事目前整体不可用**，而表面症状（"agent 没跑就说跑了"、"判不了"）看起来像是 agent 的毛病，**根因在沙箱**。

## 7. 建议（未执行）

1. **改 profile 加 `/dev/null`**（一行），并**加一条测试**：在沙箱里断言 `echo > /dev/null` 与 `git rev-parse` 均成功 —— 否则这个坑会再次出现。
2. **顺带检查 `/dev/fd`、`/dev/stdout`、`/dev/stderr`、`/dev/tty`** 是否也需要（`file-read*` 已放开读，但写未覆盖）。
3. **给 `run_shell` 的 L2/L1 分层一个说明**：现在"能 shell"与"文件系统正常"被绑在两个互斥的模式上，使用者无法从名字推断出这个约束。
4. **本文件不代为改代码**：属安全面，需显式决定。
