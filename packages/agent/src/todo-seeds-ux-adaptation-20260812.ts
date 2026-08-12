/**
 * @los/agent/todo-seeds-ux-adaptation-20260812
 *
 * Daily-feel UX adaptation queue after:
 * - Pi package catalog research (2026-08-12)
 * - Beautiful UI (beautifului.dev) AI-native primitives research (2026-08-12)
 *
 * Execution order (do not reorder casually):
 *   1. AI-native UI primitives (Beautiful UI spine on Chat/Work)
 *   2. Annotated plan + findings (Plannotator-class, uses Approval/Diff patterns)
 *   3. FeatureCard + rework-never-same-writer (graph hard rules)
 *   4. Structured clarify + live todo strip
 *   5. Channel session companion (Telegram/WeChat)
 *   6. Session memory FTS (policy-only default)
 *   7. Pi kernel steer/followUp parity
 *   8. Research pack polish
 *
 * Source docs:
 * - docs/research/2026-08-12-pi-package-catalog-and-los-ux-adaptation.md
 * - .impeccable.md (restrained industrial console; no decorative spectacle)
 */
import type { CreateTodoInput } from './todo-types.js';

const SOURCE = 'research-2026-08-12-pi-beautiful-ui';
const STAGE = 'ux-daily-feel-20260812';
const PARENT = 'todo-los-ux-daily-feel-20260812';

export const _UX_ADAPTATION_20260812_TODO_SEED: CreateTodoInput[] = [
  {
    id: PARENT,
    title: 'Daily-feel UX: Beautiful UI spine + Pi/Hermes interaction patterns',
    description:
      'Close the “implemented but not smooth” gap by shipping one operator spine:\n' +
      'goal → annotated plan → FeatureCard worker → fresh reviewer → wake coordinator → verify.\n' +
      'UI reference: https://www.beautifului.dev (AI-native primitives).\n' +
      'Product references: Plannotator, pi-subagents, pi-hermes-memory, pi-telegram.\n' +
      'Do not install Pi packages into the production path; re-implement patterns under LOS contracts.',
    kind: 'phase',
    status: 'in_progress',
    priority: 'P0',
    source: SOURCE,
    stageId: STAGE,
    parentId: 'todo-los-daily-agent-product',
    dependsOnIds: ['todo-los-daily-agent-web-work-first-intake'],
    dedupeKey: 'los:todo:ux-daily-feel-20260812',
    metadata: {
      problem:
        'LOS governance is strong but daily interaction density is high; Pi/Hermes feel smoother because interaction is the product.',
      solution:
        'Prioritize AI-native UI primitives and annotated human gates before more control-plane features.',
      researchDocs: [
        'docs/research/2026-08-12-pi-package-catalog-and-los-ux-adaptation.md',
        'https://www.beautifului.dev',
      ],
      executionOrder: [
        'todo-los-ux-ai-primitives-beautiful',
        'todo-los-ux-annotated-plan-findings',
        'todo-los-ux-feature-card-rework',
        'todo-los-ux-structured-clarify-todo',
        'todo-los-ux-channel-companion',
        'todo-los-ux-memory-fts-policy',
        'todo-los-ux-kernel-steer-parity',
        'todo-los-ux-research-pack',
      ],
      nonGoals: [
        'No third-party pi-package control plane',
        'No plugin-owned succeeded transitions',
        'No decorative marketing UI that violates .impeccable.md',
      ],
    },
  },

  // ── 1. P0: Beautiful UI AI-native primitives ──────────────────────────
  {
    id: 'todo-los-ux-ai-primitives-beautiful',
    title: 'Chat/Work AI-native UI primitives (Beautiful UI reference)',
    description:
      'Adopt patterns from https://www.beautifului.dev as LOS token-based components (not a copy-paste skin):\n' +
      '1. Thinking — expandable step/reasoning/search/coding traces inside turns\n' +
      '2. Tool Chips — compact tool-call chips (read/edit/bash) with expand-to-detail\n' +
      '3. Streaming Text — streamed answer with inline actions/follow-ups\n' +
      '4. Approval Card — HITL question with typed options before acting\n' +
      '5. Task Rows — live child/graph task status (running/failed/completed)\n' +
      '6. Prompt Bar — @sources, /commands, model picker affordances (map to LOS providers)\n' +
      'Respect .impeccable.md: precise/calm/accountable; progressive disclosure; no glow/hero spectacle.\n' +
      'Ship on Chat timeline first, then Work detail strip.',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: SOURCE,
    stageId: STAGE,
    parentId: PARENT,
    dependsOnIds: [PARENT],
    dedupeKey: 'los:todo:ux-ai-primitives-beautiful',
    metadata: {
      order: 1,
      problem: 'Chat/Work feel like admin consoles of events, not an AI-native operator surface.',
      beautifulUiMap: [
        'Loading State',
        'Thinking',
        'Streaming Text',
        'Approval Card',
        'Tool Chips',
        'Task Rows',
        'Chat',
        'Prompt Bar',
      ],
      acceptance: [
        'Thinking/tool traces are expandable inside the turn, not a top-of-page dump',
        'Tool calls render as compact chips with stable layout during stream',
        'At least one Approval Card path uses typed options (not free-form only)',
        'Child/graph tasks show as Task Rows with live status',
        'Tokens from packages/web/src/styles/tokens.css only; no raw hex in new UI',
        'Playwright covers desktop + mobile for Chat primitives smoke',
      ],
      candidateFiles: [
        'packages/web/src/chat-messages.tsx',
        'packages/web/src/chat-composer.tsx',
        'packages/web/src/chat-ui.tsx',
        'packages/web/src/styles.css',
        'packages/web/docs/design-tokens.md',
      ],
      reference: 'https://www.beautifului.dev',
    },
  },

  // ── 2. P0: Annotated plan + findings ──────────────────────────────────
  {
    id: 'todo-los-ux-annotated-plan-findings',
    title: 'Annotated plan approve + structured review findings (Plannotator-class)',
    description:
      'Upgrade binary plan approve into visual annotate → structured feedback:\n' +
      '- Plan artifact open for pin/replace/notes (Beautiful UI Selection Actions + Approval Card)\n' +
      '- Persist annotations into reviseRunSpecPlan / run_contract\n' +
      '- Diff review pins become ReviewFindings list\n' +
      '- Accept/reject with notes can dispatch rework graph edge\n' +
      'Reference: @plannotator/pi-extension + beautifului Diff Table / Selection Actions.\n' +
      'Default Work path uses this; advanced graph stays secondary.',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: SOURCE,
    stageId: STAGE,
    parentId: PARENT,
    dependsOnIds: ['todo-los-ux-ai-primitives-beautiful'],
    dedupeKey: 'los:todo:ux-annotated-plan-findings',
    metadata: {
      order: 2,
      problem: 'Plan gate is mostly binary; humans cannot mark up plans/diffs the way Plannotator allows.',
      beautifulUiMap: ['Approval Card', 'Diff Table', 'Selection Actions', 'Recommendation Card'],
      acceptance: [
        'Operator can annotate plan lines and submit approve-with-notes or deny-with-notes',
        'Annotations persist into plan revision / run contract fields',
        'Diff pins produce structured ReviewFindings (path, line, severity, note)',
        'Work page primary path is annotate-then-approve, not raw approve only',
        'E2E covers annotate → revise → re-approve',
      ],
      candidateFiles: [
        'packages/web/src/chat-plan-approval.tsx',
        'packages/web/src/work-review-panel.tsx',
        'packages/gateway/src/routes',
        'contracts/',
      ],
      references: [
        'https://www.beautifului.dev',
        'https://plannotator.ai',
        'npm:@plannotator/pi-extension',
      ],
    },
  },

  // ── 3. P1: FeatureCard + rework hard rules ────────────────────────────
  {
    id: 'todo-los-ux-feature-card-rework',
    title: 'FeatureCard handoff + rework never same writer',
    description:
      'Implement deterministic multi-agent handoff inspired by pi-subagents / official Pi subagent example:\n' +
      'FeatureCard { goal, acceptance, editableSurfaces, files[], keySymbols[], constraints[], outOfScope[], verificationHints[] }\n' +
      'Rules:\n' +
      '- Worker receives only card + workspace (minimal context)\n' +
      '- Reviewer is a fresh session/attempt with read-only tools\n' +
      '- Reject → new worker identity; never resume the writer session for rework\n' +
      '- Accept or reject always wakes coordinator / operator\n' +
      'Communication edges are scheduler-owned, not model-owned.',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: SOURCE,
    stageId: STAGE,
    parentId: PARENT,
    dependsOnIds: ['todo-los-ux-annotated-plan-findings'],
    dedupeKey: 'los:todo:ux-feature-card-rework',
    metadata: {
      order: 3,
      problem: 'Graph primitives exist but product path lacks compressed handoff and rework identity isolation.',
      acceptance: [
        'contracts define FeatureCard + ReviewFindings schemas',
        'Graph preset: worker → fresh reviewer → accept|rework(new worker)',
        'Rework attempt cannot reuse writer task-run/session identity',
        'Coordinator/operator wake event always emitted',
        'Focused tests for identity isolation and wake edges',
      ],
      candidateFiles: [
        'contracts/',
        'packages/agent/src/',
        'packages/web/src/agent-graph-control.tsx',
      ],
      references: [
        'pi-subagents',
        'packages/coding-agent/examples/extensions/subagent (Pi monorepo)',
      ],
    },
  },

  // ── 4. P1: Structured clarify + live todo ─────────────────────────────
  {
    id: 'todo-los-ux-structured-clarify-todo',
    title: 'Structured ask_user + live todo strip (Beautiful UI Task Rows)',
    description:
      'When the agent would otherwise guess, emit a structured questionnaire (typed options).\n' +
      'Render as Approval Card on Web and as selectable options on Telegram/WeChat when bound.\n' +
      'Show a live todo/task strip that survives stream/compaction and follows AP12 (todo status tracks task-run outcome).\n' +
      'References: beautifului Approval Card + Task Rows; rpiv-ask-user-question; rpiv-todo.',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: SOURCE,
    stageId: STAGE,
    parentId: PARENT,
    dependsOnIds: ['todo-los-ux-ai-primitives-beautiful'],
    dedupeKey: 'los:todo:ux-structured-clarify-todo',
    metadata: {
      order: 4,
      problem: 'Free-form clarification and hidden todos make mid-run control noisy.',
      beautifulUiMap: ['Approval Card', 'Task Rows', 'Recommendation Card'],
      acceptance: [
        'Tool or event path for structured questions with options[]',
        'Web renders options as primary actions; free-text secondary',
        'Live todo strip on Work/Chat bound to run/todo outcomes (AP12)',
        'Tests for option selection → operator event / follow-up injection',
      ],
      candidateFiles: [
        'packages/agent/src/tools',
        'packages/web/src/chat-approval.tsx',
        'packages/web/src/',
      ],
    },
  },

  // ── 5. P1: Channel companion ──────────────────────────────────────────
  {
    id: 'todo-los-ux-channel-companion',
    title: 'Telegram/WeChat as live session companion (pi-telegram pattern)',
    description:
      'Bind channel to an already-running operator session (not a second agent):\n' +
      '- One-time link/bind flow\n' +
      '- Default push: needs_approval, verification_failed, run_succeeded, structured questions\n' +
      '- Mobile actions map to operator steering / followup / approve\n' +
      'Reference: @llblab/pi-telegram. Packages already exist; enablement + session binding is the product gap.',
    kind: 'task',
    status: 'ready',
    priority: 'P1',
    source: SOURCE,
    stageId: STAGE,
    parentId: PARENT,
    dependsOnIds: ['todo-los-ux-structured-clarify-todo'],
    dedupeKey: 'los:todo:ux-channel-companion',
    metadata: {
      order: 5,
      problem: 'Channels exist but are cold/disabled and not session companions.',
      acceptance: [
        'Documented bind flow for Telegram and WeChat to active session',
        'Approval and structured questions deliver on channel',
        'Steer/followup from channel consume existing operator-event path',
        'Smoke checklist for enable → bind → approve → complete',
      ],
      candidateFiles: [
        'packages/telegram-bot',
        'packages/wechat-bot',
        'packages/gateway/src/routes',
      ],
    },
  },

  // ── 6. P2: Memory FTS ─────────────────────────────────────────────────
  {
    id: 'todo-los-ux-memory-fts-policy',
    title: 'Session FTS search + policy-only memory default (Hermes-inspired)',
    description:
      'Add session/event full-text search in Web + CLI.\n' +
      'Default memory injection is policy-only / on-demand retrieval; pin only operator-approved rules.\n' +
      'Secret scan on memory write. Keep procedural candidate promotion gated (LOS strength).\n' +
      'Reference: pi-hermes-memory (search when needed, not always inject).',
    kind: 'task',
    status: 'backlog',
    priority: 'P2',
    source: SOURCE,
    stageId: STAGE,
    parentId: PARENT,
    dependsOnIds: ['todo-los-ux-ai-primitives-beautiful'],
    dedupeKey: 'los:todo:ux-memory-fts-policy',
    metadata: {
      order: 6,
      problem: 'Memory stores exist but recall/search UX is weak; risk of over-injection.',
      acceptance: [
        'Search past sessions/events from Web and CLI',
        'Default prompt path does not dump full memory archive',
        'Write path redacts secrets',
        'Promotion remains consent-gated',
      ],
    },
  },

  // ── 7. P2: Kernel steer parity ────────────────────────────────────────
  {
    id: 'todo-los-ux-kernel-steer-parity',
    title: 'Pi kernel steer/followUp parity with LOS operator events',
    description:
      'ExecutionKernel protocol already declares steering/followUp; LOS loop supports operator events;\n' +
      'PiKernelAdapter still reports steering:false / followUp:false.\n' +
      'Enable safe-point consumption on the K-line without giving Pi success ownership.\n' +
      'kernel.finished still does not mean succeeded (AP3).',
    kind: 'task',
    status: 'backlog',
    priority: 'P2',
    source: SOURCE,
    stageId: STAGE,
    parentId: PARENT,
    dependsOnIds: [PARENT],
    dedupeKey: 'los:todo:ux-kernel-steer-parity',
    metadata: {
      order: 7,
      problem: 'Mid-run programmatic control is incomplete on Pi kernel path.',
      acceptance: [
        'Pi adapter capabilities.steering/followUp true when safe points implemented',
        'Operator events drain at documented safe points',
        'No success transition from kernel alone',
        'Focused tests for steer vs followUp ordering',
      ],
      candidateFiles: [
        'packages/agent/src/pi-execution-kernel.ts',
        'packages/agent/src/operator-control-consumer.ts',
        'contracts/execution-kernel.yaml',
      ],
      gate: 'Follow ADR 0039 K-line; no canary without consent',
    },
  },

  // ── 8. P2: Research pack ──────────────────────────────────────────────
  {
    id: 'todo-los-ux-research-pack',
    title: 'Unified research tool pack (pi-web-access patterns)',
    description:
      'Promote a single research pack: web_search, fetch, optional GitHub clone-to-search under ToolBroker limits,\n' +
      'provider fallback policy, source_check for citations.\n' +
      'Heavy media/PDF may stay MCP. Do not re-own ffmpeg in agent core.\n' +
      'Reference: pi-web-access.',
    kind: 'task',
    status: 'backlog',
    priority: 'P2',
    source: SOURCE,
    stageId: STAGE,
    parentId: PARENT,
    dependsOnIds: [PARENT],
    dedupeKey: 'los:todo:ux-research-pack',
    metadata: {
      order: 8,
      problem: 'Outside-repo research is fragmented across tools/MCP with uneven quality.',
      acceptance: [
        'Documented research pack with stable tool names',
        'Fallback policy without forcing keys on day one where possible',
        'GitHub clone path is size/lease limited if implemented',
        'No production dependency on pi-web-access package',
      ],
    },
  },
];
