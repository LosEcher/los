# Runtime Evidence Graph

## Purpose

The runtime evidence graph is a read model for auditing one `run_specs` row
across the execution tables that `los` already owns. It is not a full knowledge
graph engine and it does not ingest raw external tool transcripts.

## Scope

The first projection starts from `runSpecId` and returns nodes for:

1. `run_specs`;
2. `task_runs`;
3. `session_events`;
4. `tool_call_states`;
5. `verification_records`;
6. `agent_tasks`;
7. `task_attempts`.

Edges express evidence relationships such as:

1. run spec has task runs, session events, tool states, verification records,
   and agent tasks;
2. task run emitted events and owns tool states or verification records;
3. agent tasks depend on each other;
4. task attempts ran as task runs, used tool states, or linked verifier
   records;
5. session events preserve parent-event links when both events are in the
   bounded result set.

## Boundaries

This projection deliberately keeps three boundaries:

1. static code reachability stays in `execution-static-graph.ts`;
2. runtime evidence stays in PostgreSQL-owned `los` tables;
3. Codex, Claude Code, Reasonix, OpenCode, OMX, and browser artifacts remain
   external-only unless an ingestion ADR defines redaction, provenance, and
   retention.

## Verification

The focused coverage is `packages/agent/src/runtime-evidence-graph.test.ts`.
It creates a run spec, task run, session events, tool state, verification
record, planner/verifier tasks, a dependency edge, and an attempt, then asserts
the graph nodes and cross-table edges.
