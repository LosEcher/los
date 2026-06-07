# Agent Toolchain Matrix

## Purpose

This matrix records how external agent tools should be used around `los`. It
does not make their raw logs part of `los` evidence. A tool can inform a
decision, but `los`-owned execution evidence still comes from `run_specs`,
`task_runs`, `session_events`, tests, operation smokes, and explicit
compatibility or verifier records.

## Current Matrix

| Tool | Best role | Evidence produced | Permission surface | Memory/transcript surface | Use when | Avoid when | Ingestion status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | Long local engineering execution, repo review, scoped edits, test and `jj` closeout | Conversation summary, command results, diffs, tests, commits | Sandbox/approval profile plus local tools | Codex thread history and local memory summaries | A task needs source inspection, implementation, verification, and commit hygiene | Raw chat history would be treated as durable run replay | External-only; bounded summaries may inform docs/todos |
| Claude Code | Project coding, `CLAUDE.md`-style read order, interactive implementation | Tool transcript, project context, provider/auth status signals | Claude Code tool permissions and local shell/file access | Claude project jsonl/history | A project already has Claude-specific context or operator wants a second implementation pass | Provider login/readiness is being mistaken for compatibility proof | External-only until redacted summary schema exists |
| Reasonix | Planning experiments, session/receipt concepts, agent platform comparison | Session/meta/plan files, receipts, sometimes truncated captures | Reasonix runtime/tool permissions | `.reasonix/` captures and truncated results | Comparing planner state, receipt semantics, or external framework behavior | Long command/web output must be replayed exactly | External-only; useful design reference |
| OpenCode | Alternate coding workflow reference, build/plan split, UI/team-plan experiments | Prompt history and tool transcript when available | OpenCode local tool permissions | OpenCode prompt history/config | Comparing execution UX or task-plan ergonomics | It would become an implementation target for current `los` runtime | External-only |
| OMX | Codex hook bridge, tool-level local log helper, future summarized event source | Hook/log summary, local tool ledger candidates | Local hook/plugin permissions | `.omx/logs/` | Inspecting local Codex tool events or evaluating hook coverage | Raw logs include secrets, oversized output, or unredacted transcripts | External-only; ADR 0016 controls any promotion |
| Gemini | Lightweight comparison and configuration reference | Usually small prompt/config traces | Tool/provider dependent | Local project/config records | A lightweight second opinion is useful | Current-state claims need code/runtime evidence | External-only |
| Browser tools | Live UI/browser verification, logged-in website interaction, screenshots | Screenshots, DOM/browser observations, interaction traces | Browser automation permissions and session cookies | Browser history/session state | UI smoke, local web target verification, auth-dependent inspection | Website state should be treated as persisted `los` evidence without capture policy | External-only unless an operation smoke records bounded observations |

## Comparison Rules

1. Treat external transcripts as comparison input, not replay evidence.
2. Store only redacted summaries unless an ADR defines schema, redaction,
   provenance, and retention rules.
3. Keep configured provider, effective runtime provider, login health,
   compatibility, quota, and cost as separate truth surfaces.
4. When a tool produces a useful behavior pattern, route it to the smallest
   owner layer:
   - project todo for planned `los` work;
   - project doc for current design and operator rules;
   - ADR for durable architecture or ingestion contracts;
   - test/harness for executable regression checks;
   - global skill only for repeated cross-project workflow.

## Current Gap Comparison

| Capability | los current state | Codex | Claude Code | Reasonix | OpenCode | Next los action |
| --- | --- | --- | --- | --- | --- | --- |
| Source-grounded coding execution | Has local agent loop, scheduler, executor nodes, `task_runs`, tool-state evidence, executable verifier runner, and DAG verifier task execution | Strong at repo edits, tests, and `jj` closeout | Strong at project-context coding | Useful for planning experiments | Useful workflow reference | Keep verifier surfaces covered by tests and operation smokes |
| Static execution understanding | `execution-static-graph` covers CLI commands, gateway routes, agent exports, and core call chain | Usually implicit through code reading | Usually implicit through code reading | Can model plans, not source truth | Can inspect project flow | Keep static graph as drift detector; add expected-route warnings if needed |
| Runtime replay and audit | `/runs/:id/events?since=`, `tool_call_states`, `verification_records`, and runtime evidence graph exist | Transcript/command summary is external | Transcript/project jsonl is external | Receipts may be truncated | Prompt history is external | Use runtime evidence graph as the los-owned audit surface |
| Verification gate | DAG gate, direct `/chat` blocking, API/CLI verifier entrypoints, DAG verifier tasks, and `verification-runner` required-check execution exist | Human/agent runs commands and reports | Human/agent runs commands and reports | May record plan/receipt | May record task status | Keep verifier evidence linked to runtime evidence graph |
| Recovery and resume | `tool-call-recovery` classifies retry/resume/cancel/operator-action decisions from durable tool rows; scheduler queues retry/resume follow-up attempts; API/CLI can apply cancel/operator-attention transitions | Good human-directed recovery, not los ledger | Good interactive recovery, not los ledger | Good planning state ideas | Useful task UX reference | Keep transition events auditable and expose recovery state through bounded read models |
| External tool ingestion | ADR 0019 allows `external_tool_summaries` imports for redacted `external_summary` records only | Source of bounded summaries only | Source of bounded summaries only | Source of comparison ideas only | Source of comparison ideas only | Keep imports isolated from runtime replay and provider compatibility evidence |
| Provider compatibility | Compatibility evidence exists, `los provider promote` remains setup-only, and required-gate decisions have separate proposed/enforced states | Can run checks externally | Login/readiness can be misleading | Not provider authority | Not provider authority | Keep enforced policy changes tied to ADR, harness, target-list behavior, and operation evidence |

## Promotion Gates

Before any external tool summary can be imported into `los`:

1. a fake-secret fixture must prove redaction;
2. the schema must record tool, version, cwd, source file, capture policy,
   redaction policy, and import time;
3. raw prompt/stdout/stderr/auth snapshots must remain outside repo history;
4. imported facts must be labeled as external summary, not `los` runtime
   evidence;
5. an operation smoke or test must prove that ingestion cannot overwrite
   `task_runs`, `session_events`, or provider compatibility evidence.

## Immediate Follow-Up

Use this matrix to order the execution-gap todos:

1. continue DAG runtime promotion with UI dashboards and failover-specific
   metrics now that graph-task provider/model selection, minimal `run_evals`
   records, eval summary views, and baseline/candidate comparison exist;
2. keep provider policy enforcement evidence current when required-target
   decisions move from proposed to enforced;
3. keep ADR 0019 external summary imports bounded, redacted, and separate from
   runtime replay evidence.
