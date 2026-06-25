/**
 * AI code-fix orchestrator tests — hermetic (no network, no DB, no provider).
 *
 * `applyAICodeFix` is driven with injected `runAgent` + `exec` + `db` so it never
 * imports loop.js (provider/db chain) or touches git/gh. `classifyDiff` and
 * `buildUserPrompt` are pure functions tested directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDiff,
  buildUserPrompt,
  AI_FIX_SYSTEM_PROMPT,
  AI_FIX_TOOLS,
  claimAICodeFixTodo,
  applyAICodeFix,
  type DbLike,
} from './ga-ai-code-fix.js';
import { checkHasFindings } from './ga-loop-runner.js';
import type { BranchHygieneExecFn } from './governance-auditors.js';
import { SEED_JOBS } from './governance-jobs-schema.js';
import type { TodoRow } from './todos/rows.js';
import type { GovernanceJob } from './governance-jobs-types.js';
import type { AgentResult } from './loop/types.js';

// ── Fakes ──────────────────────────────────────────────

type FakeCmd = { match: string; out?: string; error?: string };

function fakeExec(cmds: FakeCmd[], recorded: string[] = []): BranchHygieneExecFn {
  return (cmd: string) => {
    recorded.push(cmd);
    for (const c of cmds) {
      if (cmd.includes(c.match)) {
        if (c.error !== undefined) throw new Error(c.error);
        return c.out ?? '';
      }
    }
    return '';
  };
}

function fakeDb(rowSets: unknown[][] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db: DbLike = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ sql: text, params: params ?? [] });
      return { rows: rowSets.shift() ?? [] };
    },
  };
  return { db, calls };
}

function fakeTodoRow(over: Partial<TodoRow> = {}): TodoRow {
  return {
    id: 'todo-1', tenant_id: 'local', project_id: 'los', user_id: null,
    node_id: null, stage_id: null, parent_id: null,
    title: 'Fix: add return type to foo()',
    description: 'packages/agent/src/foo.ts foo() lacks a return type annotation.',
    kind: 'task', status: 'backlog', priority: 'P1', source: 'governance_sweep',
    trace_id: null, request_id: null, dedupe_key: null, task_run_id: null,
    session_id: null, batch_key: null, archived_at: null, archive_reason: null,
    metadata_json: { sweepJobId: 'smoke', sweepJobType: 'file_size', auditType: 'missingType' },
    created_at: '2026-06-25T00:00:00Z', updated_at: '2026-06-25T00:00:00Z',
    started_at: null, completed_at: null, cancelled_at: null, reopened_at: null,
    ...over,
  };
}

const fakeAgentResult: AgentResult = {
  text: 'edited packages/agent/src/foo.ts', turns: [], loopCount: 3,
  totalTokens: { prompt: 100, completion: 50 }, messages: [],
};

function makeJob(config: Record<string, unknown> = {}): GovernanceJob {
  return {
    id: 'govjob-ai', jobType: 'ai_code_fix', cadence: 'manual', status: 'active',
    config, consecutiveNoOps: 0, consecutiveFailures: 0, circuitState: 'closed',
    createdAt: '2026-06-25T00:00:00Z', updatedAt: '2026-06-25T00:00:00Z',
  };
}

// ── classifyDiff ───────────────────────────────────────

describe('classifyDiff', () => {
  it('small: single package, under limit, no config/contracts/deps', () => {
    assert.equal(classifyDiff(['10\t2\tpackages/agent/src/foo.ts'], 200), 'small');
  });

  it('review: over size limit', () => {
    assert.equal(classifyDiff(['250\t0\tpackages/agent/src/foo.ts'], 200), 'review');
  });

  it('review: cross-package', () => {
    assert.equal(classifyDiff(['1\t1\tpackages/agent/src/a.ts', '1\t1\tpackages/cli/src/b.ts'], 200), 'review');
  });

  it('review: touches contracts/', () => {
    assert.equal(classifyDiff(['1\t1\tpackages/agent/src/foo.ts', '1\t1\tcontracts/run-spec.yaml'], 200), 'review');
  });

  it('review: touches package.json', () => {
    assert.equal(classifyDiff(['1\t1\tpackages/agent/package.json'], 200), 'review');
  });

  it('review: non-packages/ path (e.g. tools/)', () => {
    assert.equal(classifyDiff(['1\t1\ttools/foo.sh'], 200), 'review');
  });

  it('abort: .env path', () => {
    assert.equal(classifyDiff(['1\t1\tpackages/agent/.env'], 200), 'abort');
  });

  it('abort: secrets path', () => {
    assert.equal(classifyDiff(['1\t1\tconfig/secrets/key.pem'], 200), 'abort');
  });

  it('abort takes precedence over review', () => {
    assert.equal(classifyDiff(['1\t1\t.env', '1\t1\tpackages/agent/src/foo.ts'], 200), 'abort');
  });
});

// ── Prompt ─────────────────────────────────────────────

describe('prompt', () => {
  it('systemPrompt enforces conventions and tool boundary', () => {
    assert.match(AI_FIX_SYSTEM_PROMPT, /AGENTS\.md/);
    assert.match(AI_FIX_SYSTEM_PROMPT, /200 lines/);
    assert.match(AI_FIX_SYSTEM_PROMPT, /do NOT run shell, pnpm, git, or gh/i);
    assert.match(AI_FIX_SYSTEM_PROMPT, /package\.json/);
  });

  it('buildUserPrompt injects todo fields', () => {
    const row = fakeTodoRow();
    const prompt = buildUserPrompt({ ...row, id: 'todo-x', title: 'T', description: 'D', source: 'ga_loop', metadata: { foo: 1 } } as never, '/ws');
    assert.match(prompt, /TODO: T/);
    assert.match(prompt, /DESCRIPTION: D/);
    assert.match(prompt, /SOURCE: ga_loop/);
    assert.match(prompt, /METADATA: \{"foo":1\}/);
    assert.match(prompt, /\/ws/);
  });

  it('AI_FIX_TOOLS has no shell/network tools', () => {
    assert.equal((AI_FIX_TOOLS as readonly string[]).includes('run_shell'), false);
    assert.equal((AI_FIX_TOOLS as readonly string[]).includes('spawn_agent'), false);
    assert.ok(AI_FIX_TOOLS.includes('edit_file'));
    assert.ok(AI_FIX_TOOLS.includes('apply_patch'));
  });
});

// ── checkHasFindings ───────────────────────────────────

describe('checkHasFindings — ai_code_fix', () => {
  it('candidateCount 0 → false', () => {
    assert.equal(checkHasFindings('ai_code_fix', { candidateCount: 0 }), false);
  });
  it('candidateCount 3 → true', () => {
    assert.equal(checkHasFindings('ai_code_fix', { candidateCount: 3 }), true);
  });
  it('missing candidateCount → false', () => {
    assert.equal(checkHasFindings('ai_code_fix', {}), false);
  });
});

// ── claimAICodeFixTodo ─────────────────────────────────

describe('claimAICodeFixTodo', () => {
  it('claims a backlog todo and returns the record', async () => {
    const { db, calls } = fakeDb([[fakeTodoRow()]]);
    const todo = await claimAICodeFixTodo('todo-1', undefined, db);
    assert.ok(todo);
    assert.equal(todo!.id, 'todo-1');
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /WHERE id = \$1/);
    assert.match(calls[0].sql, /AND status = 'backlog'/); // the race-safety guard
  });

  it('returns null when the row is already claimed (0 rows)', async () => {
    const { db } = fakeDb([[]]); // claim returns 0 rows
    const todo = await claimAICodeFixTodo('todo-1', undefined, db);
    assert.equal(todo, null);
  });
});

// ── applyAICodeFix orchestration ───────────────────────

describe('applyAICodeFix orchestration', () => {
  it('happy small path: opens PR + requests auto-merge', async () => {
    const { db, calls } = fakeDb([[fakeTodoRow()]]);
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'git status --porcelain', out: '' },
      { match: 'diff --numstat', out: '10\t2\tpackages/agent/src/foo.ts\n' },
      { match: 'pnpm run _typecheck', out: '' },
      { match: 'git checkout -b', out: '' },
      { match: 'git add -A', out: '' },
      { match: 'git commit -m', out: '' },
      { match: 'gh pr create', out: 'https://github.com/LosEcher/los/pull/84\n' },
      { match: 'gh pr merge', out: '' },
      { match: 'git checkout main', out: '' },
    ], recorded);
    const runAgent = async (): Promise<AgentResult> => fakeAgentResult;

    const res = await applyAICodeFix(makeJob(), { nextTodoId: 'todo-1' }, { runAgent, exec, db });

    assert.equal(res.applied, true);
    assert.equal(recorded.some(c => c.includes('gh pr create')), true);
    assert.equal(recorded.some(c => c.includes('gh pr merge --auto --merge --delete-branch')), true);
    // markTodoOutcome called with auto_merged (last db write)
    assert.match(calls[calls.length - 1].sql, /UPDATE todos/);
    assert.equal(calls[calls.length - 1].params[1], 'done');
    assert.equal(calls[calls.length - 1].params[2], 'auto_merged');
  });

  it('large diff: opens PR WITHOUT --auto (human review)', async () => {
    const { db } = fakeDb([[fakeTodoRow()]]);
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'git status --porcelain', out: '' },
      { match: 'diff --numstat', out: '250\t0\tpackages/agent/src/foo.ts\n' },
      { match: 'pnpm run _typecheck', out: '' },
      { match: 'git checkout -b', out: '' },
      { match: 'git add -A', out: '' },
      { match: 'git commit -m', out: '' },
      { match: 'gh pr create', out: 'https://github.com/LosEcher/los/pull/85\n' },
      { match: 'git checkout main', out: '' },
    ], recorded);
    const runAgent = async (): Promise<AgentResult> => fakeAgentResult;

    const res = await applyAICodeFix(makeJob(), { nextTodoId: 'todo-1' }, { runAgent, exec, db });

    assert.equal(res.applied, true);
    assert.equal(recorded.some(c => c.includes('gh pr create')), true);
    assert.equal(recorded.some(c => c.includes('gh pr merge')), false); // no auto-merge
  });

  it('typecheck fails: restores tree, no PR', async () => {
    const { db, calls } = fakeDb([[fakeTodoRow()]]);
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'git status --porcelain', out: '' },
      { match: 'diff --numstat', out: '5\t1\tpackages/agent/src/foo.ts\n' },
      { match: 'pnpm run _typecheck', error: 'TS2345: argument mismatch' },
      { match: 'git checkout --', out: '' }, // restore
    ], recorded);
    const runAgent = async (): Promise<AgentResult> => fakeAgentResult;

    const res = await applyAICodeFix(makeJob(), { nextTodoId: 'todo-1' }, { runAgent, exec, db });

    assert.equal(recorded.some(c => c.includes('git checkout --')), true); // restore ran
    assert.equal(recorded.some(c => c.includes('gh pr create')), false); // no PR
    assert.equal(calls[calls.length - 1].params[2], 'typecheck_failed');
    assert.match(res.detail, /typecheck FAILED/);
  });

  it('secrets in diff: aborts, no PR', async () => {
    const { db, calls } = fakeDb([[fakeTodoRow()]]);
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'git status --porcelain', out: '' },
      { match: 'diff --numstat', out: '1\t1\tpackages/agent/.env\n' },
      { match: 'git checkout --', out: '' }, // restore on abort
    ], recorded);
    const runAgent = async (): Promise<AgentResult> => fakeAgentResult;

    const res = await applyAICodeFix(makeJob(), { nextTodoId: 'todo-1' }, { runAgent, exec, db });

    assert.equal(res.applied, false);
    assert.equal(recorded.some(c => c.includes('gh pr create')), false);
    assert.equal(calls[calls.length - 1].params[2], 'aborted_secrets');
    assert.match(res.detail, /secrets/);
  });

  it('runAgent throws: graceful failure, no throw escaping', async () => {
    const { db, calls } = fakeDb([[fakeTodoRow()]]);
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'git status --porcelain', out: '' },
    ], recorded);
    const runAgent = async (): Promise<AgentResult> => { throw new Error('provider 500'); };

    const res = await applyAICodeFix(makeJob(), { nextTodoId: 'todo-1' }, { runAgent, exec, db });

    assert.equal(res.applied, false);
    assert.match(res.detail, /agent error: provider 500/);
    assert.equal(calls[calls.length - 1].params[2], 'agent_error');
  });

  it('dirty working tree: refuses to claim (no db write)', async () => {
    const { db, calls } = fakeDb([[fakeTodoRow()]]);
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'git status --porcelain', out: ' M src/foo.ts\n' },
    ], recorded);

    const res = await applyAICodeFix(makeJob(), { nextTodoId: 'todo-1' }, { exec, db });

    assert.equal(res.applied, false);
    assert.match(res.detail, /dirty/);
    assert.equal(calls.length, 0); // claim never attempted
  });

  it('claim lost (race): no agent run', async () => {
    const { db } = fakeDb([[]]); // claim returns 0 rows
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'git status --porcelain', out: '' },
    ], recorded);
    let agentCalled = false;
    const runAgent = async (): Promise<AgentResult> => { agentCalled = true; return fakeAgentResult; };

    const res = await applyAICodeFix(makeJob(), { nextTodoId: 'todo-1' }, { runAgent, exec, db });

    assert.equal(res.applied, false);
    assert.match(res.detail, /claim lost/);
    assert.equal(agentCalled, false);
  });

  it('no candidate in summary: no-op', async () => {
    const res = await applyAICodeFix(makeJob(), { nextTodoId: null }, {});
    assert.equal(res.applied, false);
    assert.match(res.detail, /no candidate/);
  });
});

// ── seed config ────────────────────────────────────────

describe('ai_code_fix seed config', () => {
  it('cadence is manual with autoFix enabled and strict config', () => {
    const seed = SEED_JOBS.find(s => s.jobType === 'ai_code_fix');
    assert.ok(seed);
    assert.equal(seed!.cadence, 'manual');
    assert.ok(seed!.autoFix);
    assert.equal(seed!.autoFix!.autoFixEnabled, true);
    assert.equal(seed!.autoFix!.maxAutoFixAttempts, 1);
    assert.equal(seed!.autoFix!.escalationCadence, 'after_retry');
    const cfg = seed!.config as { provider: string; maxDiffLines: number; maxLoops: number };
    assert.equal(cfg.provider, 'deepseek');
    assert.equal(cfg.maxDiffLines, 200);
    assert.equal(cfg.maxLoops, 8);
  });
});
