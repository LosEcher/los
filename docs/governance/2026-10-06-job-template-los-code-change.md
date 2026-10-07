# 作业模板：让 los 产出代码改动（E3），由外部 runner 验收

Date: 2026-10-06（首例：P0-3 promote 版本校验）
适用：需要真实改动仓库代码、且改动本身要留证据的任务。
不适用：需要浏览器/交互式 REPL 的任务；需要 los 自己跑测试的任务（见 §4）。

## 1. 原理（一句话）

**los 是生产端，外部 runner 是验收端。** los 沙箱给的写权限是 L1（只能改文件），既没有
shell 也没有网络；因此"改代码"必须拆成两段，而不是让 los 全流程跑完：

```text
[los]          写改动 + 写变更说明（project-write / L1，只用文件工具）
   ↓ 工作区里的改动
[外部 runner]  tsc + 单测 + 全套测试，通过才提交；不通过则退回
   ↓
[los/看板]     结果与变更说明留档（run 台账 + change note）
```

## 2. 作业配置（run_template_json）

```jsonc
{
  "templateId": "scheduled_execution",
  "mode": "execution",
  "toolMode": "project-write",          // L1：文件写入；**没有 shell**
  "editableSurfaces": [                 // 收敛到具体文件，越窄越好
    "<repo>/packages/<pkg>/src/<target>.ts",
    "<repo>/packages/<pkg>/src/<target>.test.ts",
    "<repo>/packages/<pkg>/test-runner.mjs"   // 新增测试文件必须在此登记
  ],
  "requiredChecks": [                   // 只放**读**检查：los 无法执行命令
    "read_file packages/<pkg>/src/<target>.ts",
    "read_file packages/<pkg>/src/<target>.test.ts"
  ],
  "reportDir": "<repo>/.los-runtime/change-notes",
  "goalTemplate": "<见 §3>"
}
```

外层记录建议：`status='paused'` + `trigger: {kind:'once', expression:'2099-01-01T00:00:00.000Z'}`，
即"只手动触发的模板"，避免它自己循环跑；`approval_policy='preapproved_scope'`、
`max_attempts=1`（改动类任务重试容易产出互相冲突的第二次改动）。

触发：`bash tools/los-schedule-ctl.sh trigger <schedule-id>`

## 3. goal 模板（要点，按此顺序写）

1. **明确角色与边界**：一句话说清"你是两段式流水线的生产端：你写改动，测试由外部 runner
   跑，你在沙箱里没有 shell，不要尝试跑测试/构建/git"。
2. **改动规格**：写清要改哪个文件的哪个分支、判据是什么、哪些行为必须保持向后兼容。
   规格越具体，产出越可用（首例给了"版本不符 → denied 且不写 online；相符 → 写进
   rolloutMessage；未提供期望版本 → 行为不变"）。
3. **测试要求**：要求新增测试，并**允许在无法驱动完整路径时改用纯函数/依赖注入**——
   首例中就因为 `executeNodeCommand` 需要 Postgres，agent 主动把判定抽成纯函数
   `evaluatePromoteVersionCheck` 并说明原因，这正是我们要的结果。
4. **登记测试文件**：新增 `*.test.ts` 必须在 `<pkg>/test-runner.mjs` 里分类，否则全套测试
   会因"未分类的测试文件"失败。
5. **MANDATORY 变更说明**：写到 `.los-runtime/change-notes/<id>.md` 并回读确认，内容含
   改了什么、实现了什么规则、为什么保持兼容、**外部 runner 该跑什么**、以及沙箱内无法
   验证的部分。（首例的 run 就是**因为漏写这个文件被 self-check 判 failed** —— 机制有效，
   但它同时说明"run 失败 ≠ 产物无用"，见 §5。）
6. **结果 JSON**：给一个确切的形状，例如
   `{"filesChanged":[...],"testFile":"...","rule":"...","externalRunnerMustRun":[...],"unverified":[...],"stopCondition":"not_applicable_completed_by_design"}`。

## 4. 外部 runner 清单（按序，全过才提交）

```bash
cd packages/<pkg> && ./node_modules/.bin/tsc --noEmit -p tsconfig.json   # 1 类型
./node_modules/.bin/tsx --test src/<new>.test.ts                          # 2 新测试
node ./test-runner.mjs                                                    # 3 全套（含分类校验与门禁）
```

第 3 步不能省。首例中正是全套测试抓出了 `event-types-completeness` 门禁的回归
（`upstream_error` 未登记）——那是**我自己上一轮合并时漏跑全套**留下的，只跑模块自身测试
发现不了。

## 5. 已验证的经验与坑

- **self-check 会抓漏交付物**：漏写变更说明 → run 记 `failed`；但**改动本身完整可用**。
  因此"run 失败 ⇒ 丢弃产物"是错判据，外部 runner 应能接手产物。
- **产物质量**：首例产出把判定抽成纯函数、测试 10 例、并在文件头写明为何不能驱动完整命令，
  质量高于预期；说明"外部 runner 验收"这个约束本身就提升了产出形态。
- **别用未加引号的 heredoc 往 DB 塞长文本**：反引号会被 bash 当命令替换，破坏 goal
  （本轮踩了三次，包括提交信息）。一律用带引号 heredoc、`--stdin` 或文件。
- **`requiredChecks` 只能放读操作**：放 `run_shell ...` 会让 self-check 判失败（L2 > L1）。
- **新增测试文件必须登记** `test-runner.mjs`，否则全套失败。

## 6. 边界（为什么测试在外部）

| 配置 | 结果 |
| --- | --- |
| `toolMode=project-write` / `sandboxMode=workspace-write` | L1：可改文件，**run_shell 被拒** |
| `toolMode=all` + `sandboxMode=sandbox` | L2 且 shell 可用，但 OS 沙箱**阻断 TCP 与 `/dev/null`** → 依赖安装/测试跑不动 |
| `toolMode=all`（不设 sandboxMode） | 设计上应退回 L2 无沙箱，定时执行路径实测到不了 |

结论：**los 负责受治理的改动产出与账本，测试执行属于外部 runner（DSH/CI）。** 这与
"DSH 主管理、los 按需执行"的分工一致。
