# los Web 设计方案分析与优化建议

- 日期：2026-08-16
- 分析来源：los 侧 Kimi 深度评审（结合代码实证）+ 人工复核 + [beautifului.dev](https://www.beautifului.dev/)（AI-native UI 原语库）设计参考对照
- 范围：`packages/web`（React 19 + Vite + TypeScript 运营控制台）
- 状态：设计评审与优化路线图，供后续迭代对齐

## 0. 一句话总结

los console 的**信息架构与设计令牌层已经超过多数同类自研控制台**，并已自发地在做"Beautiful UI 式 AI-native 原语"映射（`chat-ai-primitives.tsx` + `styles.css` 的 `AI-native primitives (Beautiful UI → LOS tokens)` 段）；主要短板集中在 **8.4k 行单文件全局 CSS 的可维护性、通用组件缺口（Toast/Skeleton/Modal/EmptyState）、数据密集页面的信息密度打磨、以及聊天体验的"refined 感"细节**。优化应沿着"基建清理 → 原语补齐 → 体验打磨"的顺序推进，而不是推倒重来。

## 1. 背景与目标

- 目标：对 los 整体 Web 设计方案做一次系统性分析，对照 2026 年现代 Web 设计标准（以 beautifului.dev 代表的 AI-native 界面原语为参照系），给出可执行的优化更新建议，沉淀为设计文档。
- beautifului.dev 定位：**Crafted primitives for AI-native interfaces**——即面向"agent 型产品"的界面原语库（思考轨迹、流式文本、工具芯片、任务行、审批卡、提示词栏、上下文卡、推荐卡、代码块等 19 种）。这与 los console（agent 执行与记忆管理控制台）的界面需求高度同构，是最贴切的参考系，而非泛泛的"漂亮网站"。

## 2. 现状概览

### 2.1 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 19 + Vite 5 + TypeScript（strict） |
| 数据 | @tanstack/react-query（轮询为主）+ 原生 WebSocket（`ws-client.ts`） |
| 列表 | @tanstack/react-virtual（聊天虚拟滚动） |
| 渲染 | react-markdown + rehype-highlight（highlight.js） |
| 图标 | lucide-react |
| 样式 | 全自定义：`tokens.css`（设计令牌）+ `styles.css`（全局 class，8,452 行）+ `markdown.css`；无 Tailwind / CSS Modules / 组件库 |
| 国际化 | 自研 i18n（zh/en 双语言，`src/i18n/`） |
| 主题 | dark 默认 + light + system（`useTheme.tsx`，`data-theme` 切换） |
| 路由 | 自研 hash 路由（`nav-config.ts` 的 parse/build 契约，支持 `#work/<id>`、`#chat?session=` 深链） |
| 移动端 | TabBar + MoreSheet（`mobile-nav.tsx`），PWA 壳（生产环境注册 SW） |

### 2.2 关键数据

- 页面：29 个 PageId，5 个分区（daily / library / advanced / communication / configure+operations），OPS 区 12 项默认折叠
- 令牌：~60 个 CSS 变量（surface×4、text×3、语义色×5、间距×10、圆角×6、字号×8、z-index×8、动效×3）
- 自制组件：`ui.tsx` 13 个导出（StatusPill/Field/Fact/Definition/DataTable/Panel/Badge/Button/Toolbar 等）+ `chat-ai-primitives.tsx` 8 个 AI 原语
- 代码规模：`styles.css` 8,452 行（168KB）、`App.tsx` 528 行、页面平均 15-27KB

### 2.3 结构（文字示意）

```
tokens.css（令牌）→ styles.css（全局样式）+ markdown.css
main.tsx（QueryClient/I18n/Theme Provider）
App.tsx（外壳：Sidebar + Topbar + 页面分发 + MobileTabBar/MoreSheet）
  ├─ chat 体验：chat-composer / chat-virtual-scroller / markdown-renderer / chat-ai-primitives
  ├─ 29 个业务页：inbox / work / schedules / sessions / todos / memory / usage / governance …
  └─ 自制通用件：ui.tsx / mobile-nav.tsx / i18n / hooks
```

## 3. 八维度评估

> 依据：Kimi 深度评审 + 本人工复核（已逐条验证证据，未验证项已标注 [U]）。

| # | 维度 | 评级 | 一句话结论 |
|---|---|---|---|
| 1 | 设计系统一致性 | ★★★★☆ | 令牌层优秀；单文件 CSS 是最大维护风险 |
| 2 | 信息架构与导航 | ★★★★☆ | 全项目最成熟的一块；路由状态管理散 |
| 3 | 组件层质量 | ★★★☆☆ | 命名清晰但覆盖不足 |
| 4 | 聊天体验 | ★★★☆☆ | 功能骨架完整，refined 感打磨空间最大 |
| 5 | 数据密集页面 | ★★★☆☆ | 有 sparkline/甘特/拓扑等定制视图；表格与空态待打磨 |
| 6 | 移动端与响应式 | ★★★★☆ | 架构正确；Tab 叙事与 MoreSheet 焦点管理有小缺口 |
| 7 | 可访问性 | ★★★☆☆ | 基础项做了；无焦点圈定/skip-link，对比度未实测 |
| 8 | 视觉质感与动效 | ★★★☆☆ | 工程气质足，精致度不足 |

### 3.1 设计系统一致性（★4/5）

**优点**：`tokens.css` 是声明明确的 single source of visual truth，头部注释直接禁止页面内 ad-hoc 色值；dark 默认 + light 全量镜像（shadow、*-bg 半透明色均各自适配）；`color-scheme` 正确设置避免表单闪白；body 用 32px 网格线 + radial-gradient 做出有辨识度的"图纸感"背景，且 light 主题有对应版本。

**问题**：
1. **168KB 单文件 `styles.css`**（8,452 行）无分层：无 `@layer`、无按页面拆分，新增样式靠"追加注释段"，搜索定位与冲突排查成本高，存在大量 legacy 类（如 `.chat-reasoning` 与新 `.ai-thinking` 并存，注释自述 "legacy class kept for any residual markup"）。
2. 令牌冗余别名未清理：`--border/--line`、`--muted-border/--line`、`--err/--danger`、`--text-dim/--muted` 并存，新代码容易用错入口。
3. `--warn` 与 `--accent` 同色值（dark 下均为 `#d7a842`），警告与品牌强调无法区分。

**建议**：按 `@layer`（reset/tokens/components/pages）重构 styles.css；令牌别名标废弃注释并限期删除；warn 色与 accent 解耦（如 `--warn: #d7a842` → 独立橙色系）。

### 3.2 信息架构与导航（★4/5）

**优点**：`nav-config.ts` 用 `audience` 三分 + `sectionKey` 细分；daily 决策路径（Inbox→Work→Schedules→Chat）显式 `showStatus:false` 降噪；OPS 区默认折叠且 localStorage 持久化、深链进 OPS 自动展开；NavItem 携带 `status: live|partial|reserved` 页面成熟度元数据——这是大多数产品做不到的诚实设计；hash 路由有规范 parse/build 契约，`#inbox?id=` 深链别名会归一化为 `#work/<id>`。

**问题**：
1. 29 个页面平铺一份数组，OPS 区 12 项展开后侧边栏极长，无二级分组。
2. `App.tsx` 路由状态用 6+ 个独立 useState（sessionId/todoId/workItemId/scheduleId/day/runSpecId），`navigate()` 手写大量条件清理逻辑，新增深链参数时易漏（已有 `#inbox?id=` 别名特殊分支，是补丁式增长信号）。

**建议**：路由状态收敛为单一 reducer 或将深链参数完全交给 hash 作 single source；OPS 区按"执行/治理/诊断"二级分组（可折叠树）。

### 3.3 组件层质量（★3/5）

**优点**：`ui.tsx` 组件小而正，语义直白；DataTable 内置 loading/empty 双态；formatDate/formatDuration 走 i18n locale（中文"小时/分"）。

**问题**：
1. **通用组件缺口**：无 Modal/Dialog（Abort Confirmation Modal 是页面内一次性实现，MoreSheet 亦然）、无 Toast（z-index 已预留 `--z-toast:100` 但无对应组件）、无 Tooltip、无 Select、无通用 Skeleton（仅有 `.daily-skeleton` 页面级实现）、无规范 EmptyState（仅一行灰字 `EmptyText`）。
2. `Button` 的 className 拼接逻辑怪异：无 variant 时默认落到 `tiny-btn`，`size="tiny"` 与 variant 组合会叠加出双 class（`tiny-btn tiny-btn`）。

**建议**：抽象 Sheet/Modal（基于 MoreSheet 已有实现）、Toast（复用 `--z-toast` + `--overlay`）、Skeleton、EmptyState 四件套即可覆盖 80% 缺口；修正 Button 默认 variant 语义（默认=secondary，tiny 仅由 size 决定）。

### 3.4 聊天体验（★3/5）

**优点**：虚拟滚动处理了两个难点——流式期间自动贴底（用户上滚超 120px 即暂停）+ 完成时复位；`measureElement` 动态测高。composer 有 slash 命令补全（9 条，键盘 ↑↓/Tab/Esc 全支持）、`/skill` 自动 pin 技能、route-dot 显示 provider 健康、runtime/provider/model/toolMode 工具栏分组。markdown-renderer 对代码块加语言标签头、外链强制 `target=_blank rel=noopener`、表格套滚动容器。

**问题**：
1. 缺少流式打字光标态与代码块"一键复制"按钮（Beautiful UI Code Block 原语的标配）。
2. 部分 UI 文案硬编码英文（如 scroll-to-bottom 按钮），不走 i18n。
3. `estimateSize` 固定 120px，长短消息混排时滚动跳动概率高。
4. composer props 20+ 个，已是"上帝组件"，难以测试与复用。

**建议**：代码块加 copy 按钮；流式中加 typing indicator 与 elapsed 态（已有 `StreamingElapsed` 可扩展）；scroll 按钮文案进 i18n；composer 按 concerns 拆 context（prompt assembly / tool mode / route status）。

### 3.5 数据密集页面（★3/5）

**现状**：已有 sparkline（`sparkline.tsx`）、甘特（`timeline-gantt.tsx`）、拓扑（`topology-panel.tsx`）、subagent 树（`subagent-tree.tsx`）、activity 并发时间线（`activity-panel.tsx`）等专用可视化；Inbox/Usage/Governance 页有 filter bar + 状态徽章体系。usage 页的 L1 runtime cube（byDay/byProviderModel/callTelemetry）结构完整。

**问题**：表格普遍是自制 record-list（无排序/筛选/列配置）；部分高密度列表（如 provider 兼容矩阵、任务表）缺少空态插画、加载骨架与批量操作；数字呈现（tokens/cost/毫秒）缺少格式化组件（千分位/单位换算/趋势箭头），各页各写一份。

**建议**：抽出 `DataTable` 的增强版（排序/筛选/空态/骨架）；新增 `MetricValue`/`TokenCount`/`Duration` 等格式化组件统一数字呈现；对照 Beautiful UI 的 Records/Filter Table 原语补"状态芯片筛选 + 关系列"模式。

### 3.6 移动端与响应式（★4/5）

**优点**：MobileTabBar 语义规范（`aria-current="page"`、badge 进 aria-label、99+ 截断）；MoreSheet 是合格 dialog（`role="dialog" aria-modal`、Esc/backdrop 关闭、打开时锁 body scroll 且恢复前值）；`--touch-target:44px` 令牌存在；MoreSheet 与桌面端共享 OPS 折叠 localStorage 状态，跨端一致。

**问题**：
1. TabBar 仅 3 个主 tab（inbox/work/chat），schedules 被降级到 More——与 nav-config 注释中"Daily: Inbox→Work→Schedules→Chat"四项叙事矛盾，daily 主路径被切断一环。
2. MoreSheet 无 focus trap（Tab 可逃出 dialog）；`viewport-fit=cover` 已配置但 safe-area 细节未验证。

**建议**：schedules 升为第 4 个 tab 或让"今日" tab 内嵌 schedule 入口；MoreSheet 补焦点圈定（或用原生 `<dialog>`）。

### 3.7 可访问性（★3/5）

**优点**：全局 `:focus-visible` 用 accent 色 2px outline，并对非 focus-visible 显式清除（避免鼠标点击出框）；触控目标 44px 令牌化；部分 group 控件有 `role="group" aria-label`；**`prefers-reduced-motion` 媒体查询已存在**（styles.css:4763）[已人工验证]。

**问题**：无 skip-link、无 focus trap（对话框场景）；对比度未用工具实测——dark 主题 `--faint:#757b68` on `--bg:#10110f` 估算约 4.2:1，仅适合辅助文本（估算，待工具验证）[U]；图标按钮普遍缺 `aria-label`（多处仅 `title`）。

**建议**：补 skip-link 与 `<dialog>` 焦点管理；跑一次 axe 审计 + 对比度工具（Lighthouse/axe-core），把结果落成 checklist；为纯图标按钮补 aria-label。

### 3.8 视觉质感与动效（★3/5）

**优点**：动效令牌克制（120/200/320ms + 一条 ease-out 曲线），无炫技动画；背景网格纹理是有记忆点的品牌资产；三级阴影 + `--overlay` 遮罩齐全；轻主题下阴影/遮罩均做了镜像。

**问题**：
1. **状态反馈单调**：加载态只有纯文本"Loading…"，无骨架屏/微光（除 daily 页）；无 Toast 通知体系；按钮点击反馈弱。
2. **空状态弱**：EmptyText 一行灰字，无引导（Beautiful UI Search/Empty State 有配图+CTA 引导模式）。
3. **层级扁平**：卡片/pane 之间边界只靠 1px 边框，缺少"面板抬升"的层次感（阴影与 surface 阶梯利用不足）。
4. 流式输出、任务行状态切换（running→completed）无过渡动画，agent 感弱。

**建议**：建立统一空状态组件（图标+文案+CTA 模板）；为面板加轻微 hover 抬升；流式文字加光标态、任务行状态变化加 200ms 过渡；考虑像素网格 loader（Beautiful UI Loading State 与现有图纸纹理呼应）。

## 4. Beautiful UI 原语覆盖矩阵

beautifului.dev 定义了 19 种 AI-native 界面原语。los 的覆盖情况：

| # | Beautiful UI 原语 | los 现状 | 证据 |
|---|---|---|---|
| 01 | Loading State（像素网格+微光+耗时） | ◐ 部分 | `.daily-skeleton` 微光；无通用 loader |
| 02 | Thinking（可展开轨迹） | ✓ 已有 | `ThinkingBlock` + `.ai-thinking` |
| 03 | Streaming Text（内联来源/动作/追问） | ◐ 部分 | 流式渲染 + `StreamingElapsed`；无来源/追问内联 |
| 04 | Approval Card（HITL 提问） | ✓ 已有 | `HitlQuestionCard`（含 typed options）+ `chat-plan-approval.tsx` |
| 05 | Tool Chips（工具调用紧凑芯片） | ✓ 已有 | `ToolChip`/`ToolChipList` + `.tool-chip` |
| 06 | Task Rows（运行/失败/完成） | ✓ 已有 | `TaskRow`/`TaskRowList`（pending/running/completed/failed/blocked） |
| 07 | Chat（多 tab 聊天面板+推理回复） | ✓ 已有 | `ChatPage` + 虚拟滚动 |
| 08 | Prompt Bar（@来源//命令/模型选择/听写） | ◐ 部分 | slash 命令 + 模型选择齐全；无 @ 引用来源、无听写 |
| 09 | Recommendation Card（置信度+动作） | ✗ 缺失 | 无对应原语（Inbox 决策卡近似但不完整） |
| 10 | Context Cards（检索知识块+来源） | ◐ 部分 | context 通知存在；无带来源的知识块卡片 |
| 11 | Diff Table（AI 提议表格编辑） | ◐ 部分 | work diff review 存在；表格 sweep 模式无 |
| 12 | Records Table（CRM 网格：标签/排序/关系） | ◐ 部分 | record-list 无排序/关系列 |
| 13 | Filter Table（状态芯片筛选） | ◐ 部分 | Inbox filter bar 已有；状态芯片→重组数据无 |
| 15 | Search（命令搜索+空态） | ✗ 缺失 | 无全局命令面板（Cmd+K） |
| 16 | Insight Cards（分页洞察+可 scrub 图表） | ◐ 部分 | usage 趋势图存在；无分页洞察卡 |
| 17 | Code Block（逐行流式代码） | ◐ 部分 | 代码高亮+语言标签；无逐行流式、无复制 |
| 18 | Fine-tune Card（agent 调设计属性） | ✗ 缺失 | 与 los 场景弱相关，可暂缓 |
| 19 | Selection Actions（选中段落交给 agent） | ✗ 缺失 | 无文本选区动作 |

**关键结论**：
1. los **已自发建立"Beautiful UI → LOS tokens"映射**（`styles.css:657` 注释段 + `chat-ai-primitives.tsx`），核心聊天原语（02/04/05/06/07）完成度高——这证明方向正确，值得把映射显式化为设计文档的一部分，而非偶然为之。
2. **最高性价比补位**：Toast（横切全局）、Cmd+K 全局命令面板（15，运营控制台刚需）、通用空状态/骨架（01/15 配套）、代码块复制+流式（17）、@ 引用来源（08/10）。
3. 与 Beautiful UI 的差距不在"抄样式"，而在**把原语抽象成可复用组件并统一状态语言**（loading/empty/error/streaming 四态 × 每个原语）。

## 5. 痛点与建议清单（按优先级）

### P0 — 结构性风险（先做）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P0-1 | `styles.css` 8,452 行单文件，无分层 | 文件结构：各页样式按注释段追加 | 引入 `@layer`（tokens/atoms/components/pages/utilities），按层迁移，删除 legacy 类（`.chat-reasoning` 等），设 dead-CSS 检查 |
| P0-2 | 路由状态 6+ useState 手写清理 | `App.tsx` navigate() 条件分支 | 收敛为单一 `useReducer` 或 hash 即状态（`useHashRoute`），消除 `#inbox?id=` 特殊分支 |
| P0-3 | 令牌别名冗余、warn=accent | `tokens.css` `--border/--line/--err/--warn` | 别名标 `@deprecated` 注释 + grep 清理；warn 独立色值 |
| P0-4 | Button 默认 variant 语义错乱 | `ui.tsx` 默认落到 tiny-btn、双 class 叠加 | 默认=secondary；`size` 与 `variant` 正交 |

### P1 — 体验缺口（次做）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P1-1 | 无 Toast 通知体系 | tokens 有 `--z-toast` 无组件 | 建 `ToastProvider`（成功/错误/信息，i18n，auto-dismiss） |
| P1-2 | 无通用 Skeleton / EmptyState | 仅 `.daily-skeleton` + `EmptyText` 一行字 | 建 `Skeleton`（token 化微光）+ `EmptyState`（图标/文案/CTA 模板） |
| P1-3 | 无 Modal/Dialog 抽象 | 每次页面内手写（Abort Modal、MoreSheet） | 抽 `Modal`（focus trap + Esc + scroll lock），MoreSheet 基于它重构 |
| P1-4 | 代码块无复制、流式无光标态 | markdown-renderer 无相关实现 | 代码块 header 加 copy 按钮；流式末字符加 caret 动画 |
| P1-5 | 部分文案硬编码英文 | scroll-to-bottom 按钮 | i18n 覆盖扫尾（grep 引号内英文文案） |
| P1-6 | 移动端 daily 主路径断环 | TabBar 3 tab，schedules 在 More | schedules 升第 4 tab 或今日 tab 内嵌入口 |

### P2 — 打磨增强（有资源再做）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P2-1 | 数据表格无排序/筛选/空态增强 | 自制 record-list | 增强 DataTable：排序、列配置、骨架、空态 |
| P2-2 | 数字呈现各页自写 | usage/tasks/metrics | 抽 MetricValue/TokenCount/Duration 格式化组件 |
| P2-3 | 无全局命令面板 | 无 Cmd+K | 建 CommandPalette（页面跳转/深链/新建会话/搜索），对标 Beautiful UI Search |
| P2-4 | 状态切换无过渡动画 | 任务行、流式 | 200ms 过渡 + reduced-motion 下禁用（已存在媒体查询） |
| P2-5 | 对比度与焦点管理未实测 | `--faint` 估算 4.2:1 | axe + Lighthouse 审计，纯图标按钮补 aria-label |
| P2-6 | 空状态无引导 | EmptyText | 各页空态接入 EmptyState 模板（Inbox 无待办、Memory 为空等） |

## 6. 优化路线图

建议按 4 个迭代波推进，每波独立可交付、可回归（web 有 e2e + 快照测试体系可兜底）：

- **Wave 1（基建清理，1-2 迭代）**：P0-1~P0-4 —— `@layer` 重构、路由状态收敛、令牌清理、Button 修正。不动视觉，风险最低。
- **Wave 2（原语补齐，2-3 迭代）**：P1-1~P1-3 —— Toast/Skeleton/EmptyState/Modal 四件套 + 落地到 3-5 个高频页面（Inbox/Usage/Settings/Chat）。
- **Wave 3（聊天体验，2 迭代）**：P1-4~P1-5 + composer 拆解——代码块复制、流式光标、i18n 扫尾、composer context 拆分。
- **Wave 4（数据与动效，持续）**：P2 系列 —— 表格增强、数字格式化、Cmd+K、过渡动画、空状态模板推广。

## 7. 值得保留的闪光点（不要动）

1. **设计令牌层**：tokens.css 的完整性（双主题全镜像 + color-scheme + 语义命名）——是后续一切样式工作的地基。
2. **诚实的信息架构**：NavItem 携带页面成熟度（live/partial/reserved）并暴露给 UI，29 页分区与 OPS 折叠——业界少见的克制设计。
3. **hash 路由契约**：parse/build 双向规范 + 深链归一化。
4. **AI-native 原语方向**：`chat-ai-primitives.tsx` 的 Thinking/ToolChip/TaskRow/HITL 完成度高且纯函数可单测——这是与 beautifului.dev 对齐的最有价值的资产。
5. **移动端语义细节**：TabBar 的 aria-current/badge 处理、MoreSheet 的 dialog 语义与 scroll lock。
6. **背景网格纹理**：图纸感品牌资产，light/dark 双版本。
7. **reduced-motion 支持**、focus-visible 规范。

## 8. 设计原则（决策与拒绝清单精神）

推进优化时应遵守（与项目治理原则一致的落地版）：

1. **令牌优先，禁 ad-hoc 色值**——新样式只准用 tokens.css 变量（沿袭文件头禁令）。
2. **原语化而非页面化**——新交互先抽象组件再进页面；同一原语（如空状态）只允许一个实现。
3. **拒绝"整包组件库"**——不引入 Tailwind/shadcn 等重依赖；Beautiful UI 只作为**原语清单与状态语言参考**，落地仍走现有 tokens + 自制组件（与 ADR 0004 的"不 copy 外部控制台"判断一致）。
4. **视觉升级与功能浪潮交替**——Wave 1 基建清理先行，避免在 8.4k 行单文件上继续叠加。
5. **动效克制**——120/200/320ms 三档 + reduced-motion 兜底；不为动而动。
6. **每个新组件必带四态**——loading / empty / error / streaming-ready，杜绝"一行灰字"式占位。

## 9. 证据附录

- 分析对象：`packages/web/`（package.json / main.tsx / App.tsx / ui.tsx / chat-ai-primitives.tsx / chat-composer.tsx / chat-virtual-scroller.tsx / mobile-nav.tsx / nav-config.ts / styles/tokens.css / styles.css / markdown-renderer.tsx / pages/*）
- 参考源：[beautifului.dev — Crafted primitives for AI-native interfaces](https://www.beautifului.dev/)（19 种原语清单，经 r.jina.ai 抽取）
- 历史决策：`docs/adr/0004-web-observability-console-plan.md`（React+Vite 选型、不 copy 外部控制台、前端为独立表现层）
- 评审方法：los 侧 Kimi 深度评审（8 维度）→ 人工复核关键断言（styles.css 行数、reduced-motion、Toast/Skeleton/focus-trap 缺失、Button 逻辑、AI-native 段与组件文件）→ beautifului.dev 原语对照
- 已知局限：对比度 4.2:1 为估算值（未跑工具）；styles.css 内重复定义/dead CSS 未逐行扫描（Wave 1 落地时用工具审计）
