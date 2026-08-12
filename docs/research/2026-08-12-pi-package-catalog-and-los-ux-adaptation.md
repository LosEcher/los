# Pi Package Catalog Research And LOS UX Adaptation

- Date: 2026-08-12
- Status: research / seeded todos (no production package adoption)
- Sources: [pi.dev/packages](https://pi.dev/packages), npm download API
  (2026-07-11 → 2026-08-09 window), package READMEs, X/community consensus
  around nicopreme / Plannotator stacks, local Pi monorepo
  (`~/syncthing/project/pi`), [Beautiful UI](https://www.beautifului.dev)
  AI-native primitives, existing LOS docs:
  - `docs/adr/0039-pluggable-execution-kernel-and-pi-adoption.md`
  - `docs/governance/2026-07-18-los-pi-harness-capability-and-operability-audit.md`
  - `docs/governance/2026-08-06-daily-use-gap-analysis.md`
  - `docs/governance/2026-07-22-lsclaw-los-pi-kernel-migration-plan.md`
  - `packages/web/docs/design-tokens.md`, `.impeccable.md`
- Memory: nmem thread + memory `Pi package catalog vs los: what to borrow`
- Todos: `packages/agent/src/todo-seeds-ux-adaptation-20260812.ts`
  (`stageId=ux-daily-feel-20260812`)

## 1. Executive conclusion

Pi’s market winners are not “more features.” They compress the path from
intent → visible work → human correction → done. Hermes and Pi feel smooth
because **interaction is the product**; LOS is strong because **governance is
the product**. Daily-use friction after months of LOS work is mostly product
path density, not missing control-plane machinery.

**Do not install Pi packages into the LOS production path.** Re-implement the
useful interaction patterns behind LOS contracts, ToolBroker, RunContract, and
AP gates.

## 2. Market snapshot (npm last-month downloads)

| Package | Role | Downloads (approx.) | Author signal |
| --- | --- | ---: | --- |
| `pi-mcp-adapter` | MCP consumer for Pi | 354k | nicopreme stack glue |
| `pi-web-access` | Web / GitHub / PDF / YouTube | 222k | default research tools |
| `pi-subagents` | Multi-agent / parallel | 214k | default delegation |
| `@juicesharp/rpiv-ask-user-question` | Structured clarification | 52k | reduce free-form guessing |
| `@juicesharp/rpiv-todo` | Live todo overlay | 43k | visible progress |
| `pi-lens` | LSP / lint / type feedback | 41k | closed-loop code feedback |
| `@tintinweb/pi-subagents` | Claude Code–style subagents | 41k | alternate subagent family |
| `@plannotator/pi-extension` | Plan / Diff / Review UI | 38k | human-in-the-loop visual gate |
| `pi-hermes-memory` | Hermes-style long memory | 24k | session FTS + durable facts |
| `pi-intercom` | Parent/child coordination | 20k | pairs with subagents |
| `@llblab/pi-telegram` | Telegram control of live Pi | 14k | mobile operator surface |
| `pi-web-ui` | Deployable web chat over Pi SDK | 8k | remote web control family |
| `@jmfederico/pi-web` | Persistent workspace web UI | 7k | “PI WEB” remote-first |
| `pi-web` (ravshansbox) | Simpler web UI | 1k | alternate web shell |

Catalog home: <https://pi.dev/packages>. Community starter stack on X and blogs
consistently clusters: **web-access + subagents + Plannotator** (+ memory /
telegram when leaving the keyboard).

## 3. Package-by-package design extract

### 3.1 Official catalog mechanics (meta-lesson)

- Packages are npm/git/local bundles of extensions, skills, prompts, themes.
- Install is one command; project settings can pin packages for the team.
- Security model is honest: full system access; review source.
- **Lesson for LOS:** capability discovery should feel like “add a tool pack,”
  not “open five admin pages.” LOS already distributes Skills/MCP with
  inspect/apply/pin; the gap is **default happy-path packs** and fewer
  concepts between install and first useful action.

### 3.2 `pi-web-access`

**What it is:** One research surface: search, fetch page, clone GitHub for
local code search, PDF extract, YouTube/local video understanding. Zero-config
Exa path; optional multi-provider fallback.

**Design patterns:**

1. **One tool family for “outside the repo”** instead of many half-wired tools.
2. **GitHub URL → clone then search** beats HTML scrape for code questions.
3. **Provider fallback chain** hides key maze until needed.
4. **Source check** tool for citation hygiene.

**LOS map:**

| Pattern | LOS today | Adaptation |
| --- | --- | --- |
| Unified web research | web tools + MCP exist; quality uneven | Promote a single “research pack” with explicit tools and provider fallback policy |
| GitHub clone-to-search | not a first-class workflow | Optional managed workspace clone tool under ToolBroker, with size/lease limits |
| Media/PDF | partial via MCP | Keep MCP for heavy media; do not re-own ffmpeg inside agent core |

**Borrow priority:** medium. Improves research days; not the main “不顺手” root.

### 3.3 `pi-subagents`

**What it is:** Parent session delegates to isolated child Pi sessions. Builtins:
scout, researcher, worker, reviewer, oracle, delegate. Parallel runs, review
loops, fleet view, plain-language dispatch.

**Design patterns:**

1. **Role cards with tool/model defaults** (scout cheap/read-heavy; worker full;
   reviewer read-biased; oracle no-edit second opinion).
2. **Compressed handoff** — scout output written for an agent that has not seen
   the files.
3. **Fresh session per role** — context isolation by process, not by prompt
   begging.
4. **Deterministic workflows as presets** (`implement`, `implement-and-review`,
   review-until-clean with max rounds) rather than hoping the model remembers.
5. **Fleet visibility** — operator sees children without opening each transcript.

**LOS map:**

| Pattern | LOS today | Adaptation |
| --- | --- | --- |
| Role isolation | graph planner/executor/verifier + managed workspace | Encode FeatureCard + role tool modes on graph attempts |
| Reviewer ≠ writer | verifier task exists | Hard rule: rework spawns **new** worker attempt identity; never resume writer session for reject findings |
| Parallel reviewers | graph can fan out | Product preset: correctness / tests / simplicity parallel review |
| Fleet view | Nodes/Runs pages; graph control baseline | Single Work page strip: children status, cost, last event |
| Communication | scheduler + operator events | Keep deterministic edges: `worker.done → reviewer → accept\|reject → wake coordinator` |

**Borrow priority:** **highest for architecture**. Matches the coordinator /
worker / reviewer structure already desired. Implement in LOS graph, not by
embedding `pi-subagents`.

### 3.4 Plannotator (`@plannotator/pi-extension`)

**What it is:** Browser UI for plan review with inline annotations, deny-with-
notes, approve-with-notes; also code/PR review and annotate-last-message.

**Design patterns:**

1. **Plan is a first-class artifact** opened in a visual surface, not only a
   chat blob.
2. **Annotation returns structured feedback** to the agent (not binary approve).
3. **Same surface for plan and diff review** — one mental model for “I mark up
   what is wrong.”
4. **Local-first** — agent submits plan → browser opens → human marks → agent
   continues.

**LOS map:**

| Pattern | LOS today | Adaptation |
| --- | --- | --- |
| Plan approve | Work path goal→plan→approve→execute exists; largely binary | Add annotate / revise-with-notes on plan; feed notes into `reviseRunSpecPlan` |
| Diff review | line-level viewer closed 2026-08-07 | Add finding pins → structured findings list → optional rework dispatch |
| Visual gate | Web work page | Make **annotate plan** the default approve path, not a secondary dialog |

**Borrow priority:** **highest for UX**. This is the largest “feels smooth”
delta versus Pi for humans who already use LOS Web.

### 3.5 PI WEB family (`@jmfederico/pi-web`, `pi-web-ui`, `pi-web`)

**What it is:** Browser control of **already running** Pi sessions / workspaces.
Remote-first: machine stays on, UI follows you.

**Design patterns:**

1. Session continuity across devices without re-explaining the world.
2. Web is a **projection + control plane** over a live agent, not a second agent.
3. One-command deploy (Docker/systemd/launchd) for always-on host.

**LOS map:**

| Pattern | LOS today | Adaptation |
| --- | --- | --- |
| Remote web | full Web console already | LOS is ahead on multi-page ops; behind on “one live session ribbon” |
| Always-on host | gateway/executor managed | Keep; simplify default `pnpm start` / status as the only boot story |
| Session follow | CLI `sessions follow` closed 2026-08-07 | Surface follow as default Chat behavior (live, not poll-and-guess) |

**Borrow priority:** low for new product; medium for **simplifying** existing
Web into one session-centric spine.

### 3.6 `@llblab/pi-telegram`

**What it is:** Telegram as companion to a **live** Pi instance: queue prompts,
stream previews, deliver replies/files, model/thinking controls. Explicitly not
a remote shell.

**Design patterns:**

1. Channel binds to running session identity.
2. Mobile is steer/follow-up, not full re-onboarding.
3. Setup is slash-command driven (`/telegram-setup`, `/telegram-connect`).

**LOS map:**

| Pattern | LOS today | Adaptation |
| --- | --- | --- |
| Telegram bot | package exists; often disabled | Default bind bot ↔ active operator session; steer/followup already in operator events |
| Auth maze | operator token + auth | One-time link code; then channel inherits operator capability for that session |
| Delivery | preflight/health present | Make “message wakes me when run needs approval” the default value prop |

**Borrow priority:** high for daily willingness if WeChat/Telegram are how the
operator actually lives. LOS already owns the right architecture; enablement
and session binding are the product gap.

### 3.7 `pi-hermes-memory`

**What it is:** Port of Hermes memory ideas into Pi: SQLite FTS5 session search,
durable facts/preferences/failures, procedural skills, secret scanning,
auto-consolidation. **Default is policy-only** (search when needed) to save
tokens; optional pin/standing instructions.

**Design patterns:**

1. **Two-tier memory:** searchable archive vs small always-on policy.
2. **Session search as first tool** (“what did we decide last Tuesday?”).
3. **Failure/correction learning** without auto-promoting into system truth.
4. **Secret scanning** before persistence.

**LOS map:**

| Pattern | LOS today | Adaptation |
| --- | --- | --- |
| Persistent memory | memory package, compaction, procedural candidates | Keep promotion consent (LOS strength) |
| Session FTS | trace/replay exist; search UX weaker | Add session/event full-text search API + Chat “search past” |
| Policy-only default | risk of over-injection | Default retrieval-on-demand; pin only operator-approved rules |
| Secret scan | partial | Gate memory write path with redaction |

**Borrow priority:** high for quality-of-life; medium for architecture (LOS
already chose consentful promotion).

### 3.8 Adjacent high-signal packages

| Package | Pattern to steal | LOS note |
| --- | --- | --- |
| `pi-mcp-adapter` | MCP as default extension surface | LOS already consumes MCP and exposes `los-mcp`; finish credential/OAuth transports |
| `pi-lens` | Continuous lint/type feedback into the loop | Wire required checks as live mid-run signals, not only end verifier |
| `rpiv-todo` | Todo overlay survives compaction | AP12 already requires todo↔run outcome; show live todo on Work page |
| `rpiv-ask-user-question` | Typed options instead of free-form | Add structured clarification tool → operator UI (Web/Telegram) |
| `pi-intercom` | Parent/child message bus | Prefer DB events + leases over file mailboxes |
| `pi-supervisor` | External cheaper model steers toward goal | Optional supervisor run writing `operator.steering` |

## 4. Why LOS still feels 不顺手

Reliability work (2026-08-06 gap recheck) closed many Tier-1/2 items: recovery,
subagent persistence, i18n, masking, CLI follow, diff viewer, PWA. The remaining
pain is **interaction density**, not missing DB columns.

### 4.1 Product shape mismatch

```text
Pi / Hermes day-1 path
  install → type goal → see tools fire → annotate plan → children work → done

LOS day-1 path (conceptually)
  setup → providers → auth/operator token → project bind → chat/run mode
  → plan phase → approve → dispatch → kernel? graph? verify → many pages
```

LOS correctly refuses to lie about success (AP3). That honesty costs clicks
unless the UI hides machinery behind one spine.

### 4.2 Concrete friction inventory

| Friction | Symptom | Root |
| --- | --- | --- |
| Concept overload | Work item / run spec / graph / kernel / node / todo | All real; no single default story |
| Binary plan gate | Approve or revise, weak annotation loop | Missing Plannotator-style markup |
| Weak handoff | Workers get too much or too little context | No FeatureCard contract |
| Reviewer soft | Same agent often “reviews itself” in chat mode | Graph rules not default product path |
| Channel cold | Telegram/WeChat disabled or hard to bind | Not session-companion by default |
| Memory quiet | Compaction/candidates exist; search/recall weak | Archive without easy retrieve |
| Mid-run control | Operator steering works on LOS loop; Pi kernel `steering:false` | Kernel parity incomplete |
| Swarm UX | Graph baseline exists | No one-click create/watch/integrate |

### 4.3 What LOS already beats Pi/Hermes on

- Durable RunContract, leases, fencing, recovery.
- Verification-before-success.
- Managed jj workspaces and fleet/node evidence.
- Operator/auth split and audit surfaces.
- Multi-entry (Web/CLI/MCP) with one control plane.

Do not trade these for plugin-shaped convenience.

## 5. Beautiful UI research ([beautifului.dev](https://www.beautifului.dev))

Beautiful UI is a free set of **AI-native interface primitives** (Meng To /
Design+Code circle), not a full design system like Material/Carbon. It targets
agent products: thinking traces, streaming answers, tool chips, HITL approval,
task rows, prompt bars, context cards, diff tables, selection actions.

Stack note: demos are React + Tailwind copy-paste. LOS uses token CSS + existing
Web components (`.impeccable.md` restrained industrial console). **Borrow
interaction structure and density, not the ice-cream marketing skin.**

### 5.1 Primitive → LOS mapping

| # | Beautiful UI | LOS today | Borrow? | Notes |
| --- | --- | --- | --- | --- |
| 01 | Loading State (elapsed) | generic spinners | yes | show elapsed on long runs |
| 02 | Thinking (expandable traces) | events / raw tools | **yes P0** | inside-turn progressive disclosure |
| 03 | Streaming Text + actions | chat stream | yes | inline follow-ups, not only footer |
| 04 | Approval Card (typed options) | plan approve mostly free-form | **yes P0** | structured HITL |
| 05 | Tool Chips | tool cards can be dense | **yes P0** | compact default, expand detail |
| 06 | Task Rows | Runs/graph scattered | **yes P0** | child/graph status strip |
| 07 | Chat (tabs + reasoning) | Chat page | partial | keep timeline model from design-tokens |
| 08 | Prompt Bar (@ / model) | composer + settings | yes | @sources / model picker affordances |
| 09 | Recommendation Card | weak | later | confidence + alternatives for plan/rework |
| 10 | Context Cards | memory retrieval quiet | with memory WP | retrieved chunks + sources |
| 11 | Diff Table | line diff viewer done | yes | AI-proposed edit sweeps + pins |
| 12–13 | Records / Filter tables | Ops tables | low | ops already dense |
| 15 | Command Search | limited | medium | command palette for runs/sessions |
| 16 | Insight Cards | evals pages | low | later analytics |
| 17 | Code Block stream | present | polish | line-by-line stability |
| 18 | Fine-tune Card | n/a | no | design inspector not core |
| 19 | Selection Actions | missing | **yes with plan annotate** | highlight → rewrite/revise agent |

### 5.2 Design constraints when applying Beautiful UI to LOS

1. Lead with next operator action; evidence behind progressive disclosure
   (`.impeccable.md`).
2. Never merge configured / live / verification / callback into one label.
3. Token-first (`packages/web/src/styles/tokens.css`); no raw hex in new UI.
4. Chat is a timeline; tools live **inside** turns (design-tokens.md).
5. Single primary CTA per decision card.
6. Beautiful UI is reference demos — adapt patterns; do not import their
   Tailwind theme wholesale.

## 6. Adaptation strategy for LOS

### Principle

```text
Pi package     → interaction / orchestration pattern
Beautiful UI   → AI-native presentation primitives
LOS            → durable contract + UI spine + deterministic orchestration
```

### Target operator spine (one path)

```text
Goal
  → Research pack (optional)
  → Plan artifact
  → Annotated approve (Plannotator + Beautiful Approval/Selection)
  → FeatureCard dispatch to worker (isolated session/workspace)
  → Fresh reviewer (read-only tools)
  → accept | findings → new worker (never same writer)
  → always wake coordinator / operator channel
  → verify records → succeeded
```

Communication edges are **scheduler-owned**, not model-owned.

### Execution order (seeded 2026-08-12) — **adjusted**

Beautiful UI research **pulls visual primitives ahead** of backend graph work.
Feeling smooth starts in Chat/Work chrome; FeatureCard without a readable
surface still feels like an admin tool.

| Order | Todo id | Pri | Why this rank |
| ---: | --- | --- | --- |
| 0 | `todo-los-ux-daily-feel-20260812` | P0 phase | Container |
| 1 | `todo-los-ux-ai-primitives-beautiful` | **P0** | Beautiful UI spine: Thinking, Tool Chips, Approval, Task Rows, Prompt Bar |
| 2 | `todo-los-ux-annotated-plan-findings` | **P0** | Plannotator-class annotate; depends on Approval/Selection primitives |
| 3 | `todo-los-ux-feature-card-rework` | P1 | pi-subagents hard rules after human gate exists |
| 4 | `todo-los-ux-structured-clarify-todo` | P1 | Approval Card + Task Rows depth; // with #3 after #1 |
| 5 | `todo-los-ux-channel-companion` | P1 | pi-telegram bind; needs structured questions |
| 6 | `todo-los-ux-memory-fts-policy` | P2 | hermes-memory search UX |
| 7 | `todo-los-ux-kernel-steer-parity` | P2 | K-line; consent-gated |
| 8 | `todo-los-ux-research-pack` | P2 | pi-web-access patterns |

Previous draft order (annotated plan → FeatureCard first) is **superseded**: UI
primitives are now step 1 so plan annotate and clarify land on a consistent
surface.

#### Non-goals (keep)

- No LOS plugin marketplace that executes third-party code in-process.
- No Pi package as control plane or success owner.
- No auto-promotion of memory/skills without operator consent.
- No decorative Beautiful UI spectacle that fights the industrial console brand.

#### Work package detail

**#1 AI-native primitives** — Chat first, Work strip second. Expandable thinking,
tool chips, typed approval card, task rows, prompt affordances. Playwright
desktop+mobile smoke.

**#2 Annotated plan + findings** — pin/replace/notes on plan; findings on diff;
persist via `reviseRunSpecPlan`; default Work path.

**#3 FeatureCard + rework-never-same-writer**

```text
FeatureCard {
  goal, acceptance, editableSurfaces,
  files[], keySymbols[], constraints[],
  outOfScope[], verificationHints[]
}
```

**#4 Structured clarify + live todo** — options[] HITL; AP12-bound todo strip.

**#5 Channel companion** — bind TG/WeChat to live session; push approvals.

**#6 Memory FTS** — search + policy-only default; secret scan; consent promote.

**#7 Kernel steer** — Pi adapter safe-point steer/followUp; AP3 intact.

**#8 Research pack** — unified outside-repo tools; no pi-web-access dependency.

## 7. Gap matrix: LOS vs Pi vs Hermes (2026-08-12)

| Surface | Pi (+packages) | Hermes | LOS | Gap type |
| --- | --- | --- | --- | --- |
| Day-1 coding feel | Excellent | Excellent | Adequate if configured | Product path |
| Plan visual annotate | Plannotator | weaker / different | Binary-ish approve | **UX borrow** |
| Multi-agent roles | subagents ecosystem | built-in delegation | graph primitives | **Wire product presets** |
| Web research | pi-web-access | broad tools | tools/MCP | Pack polish |
| Long memory | hermes-memory / others | native strength | store + consent | Search UX |
| Mobile control | pi-telegram | 20+ platforms | TG/WeChat packages | Enable + bind |
| Remote web | PI WEB family | desktop/TUI | full ops Web | Simplify spine |
| Durable governance | weak | medium | **strong** | Keep |
| Success evidence | weak | medium | **strong** | Keep |
| Fleet / nodes | light | backends | **strong** | Keep |
| Extensibility market | huge | skill-ish | Skills/MCP governed | Do not copy raw market |

## 8. What not to copy

1. Shared-folder multi-agent mailboxes as source of truth.
2. Plugin-declared task success.
3. Auto skill promotion from session noise.
4. Unbounded nested subagents without lease/budget.
5. Second in-process agent framework beside ExecutionKernel.
6. “Install 30 packages” as the LOS onboarding story.

## 9. Suggested decision record (for later ADR if accepted)

If product work proceeds:

1. Accept **#1 AI primitives + #2 annotated plan** as the first delivery pair.
2. Accept **#3 FeatureCard rules** as the orchestration hard layer.
3. Keep Pi on the **K-line as L1 kernel only** (ADR 0039).
4. Treat Pi packages and Beautiful UI as **pattern references**, not dependencies.
5. Measure daily-use with a fixed scenario set (coordinator eval set + one
   human path timer: goal→green), not feature counts.

## 10. Closeout

| Item | Status |
| --- | --- |
| Market + npm stats collected | done |
| Named packages design extract | done |
| Beautiful UI primitive map | done |
| X/community starter stack noted | done (secondary to npm/catalog) |
| Execution order adjusted (UI first) | done |
| Todo seeds added | `todo-seeds-ux-adaptation-20260812.ts` |
| nmem thread + memory | done / update after seed |
| Production UI implementation | not started |
| ADR update | not yet; wait for operator accept of #1/#2 |

Residual risk: download counts proxy popularity, not quality or security.
Beautiful UI demos may change; pin patterns in LOS components, not their CDN.
Any future local Pi experimentation must stay outside LOS gateway/scheduler
process boundaries.
