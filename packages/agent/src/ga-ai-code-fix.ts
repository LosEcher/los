/**
 * AI code-fix orchestrator — the self-bootstrap closure.
 *
 * `applyAICodeFix` is dispatched by the GA loop for the `ai_code_fix` job. It:
 *   1. Claims a P1 governance todo (status backlog → in_progress, atomic guard).
 *   2. Runs an AI agent (DeepSeek/MiniMax/GPT) with project-write tools to edit code.
 *   3. Classifies the diff (small/review/abort) and verifies via `pnpm run _typecheck`.
 *   4. Commits on a branch + opens a PR; auto-merges if small.
 *
 * CRITICAL: the AI agent runs with `project-write` tools (no shell, no network).
 * The orchestrator itself runs `git`/`gh`/`pnpm` via `execSync` in the gateway
 * process — which has network + operator credentials, exactly like
 * `applyBranchCleanupFix` runs `git push` via direct `execSync`. The AI never
 * touches the network; only the orchestrator does.
 *
 * `runAgent`, `exec`, and `db` are injectable for hermetic testing.
 */
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { GovernanceJob } from './governance-jobs-types.js';
import type { TodoRecord } from './todo-types.js';
import type { TodoRow } from './todos/rows.js';
import { rowToTodo } from './todos/rows.js';
import type { AgentConfig, AgentResult } from './loop/types.js';
import type { BranchHygieneExecFn } from './governance-auditors.js';

const log = getLogger('ga-loop-runner');

/** DB interface the fix functions need — getDb() in production, a fake in tests. */
export type DbLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export type RunAgentFn = (prompt: string, config?: AgentConfig) => Promise<AgentResult>;

export interface AICodeFixJobConfig {
  provider?: string;        // default 'deepseek'
  model?: string;
  maxDiffLines?: number;    // default 200
  maxLoops?: number;        // default 8
}

/** Tools the AI fix agent may use: file edit + read + search. NO shell, NO network. */
export const AI_FIX_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'apply_patch', 'preview_patch',
  'list_directory', 'search_content', 'search_files', 'glob', 'get_symbols',
] as const;

export const AI_FIX_SYSTEM_PROMPT = `You are a focused code-fixing agent for the los monorepo (TypeScript/pnpm).
Before editing, read AGENTS.md and the relevant .los/spec/<package>/index.md for the files you are touching — los enforces a 400/600-line module gate and a contract-first structure.
Make the MINIMAL change that resolves the todo. Do not refactor unrelated code.
Do NOT add or modify dependencies (package.json, pnpm-lock.yaml). Do NOT touch contracts/, secrets, env files, or .los/accounts/.
Keep your total diff under 200 lines. You have file-edit tools ONLY — do NOT run shell, pnpm, git, or gh; the orchestrator handles verification and PR creation.
When finished, reply with one line listing the files you changed.`;

// ── Diff classification ────────────────────────────────

export type DiffClassification = 'small' | 'review' | 'abort';

const SECRET_PATH_PATTERNS = [
  /\.env(\.|$)/i,
  /\.pem$/i,
  /\/secrets\//i,
  /^\.los\/accounts\//i,
  /(^|\/)[^/]*\bkey\b[^/]*$/i,
];

/**
 * Classify a `git diff --numstat` output into small / review / abort.
 * - abort: touches secrets/env/keys → no PR, restore tree.
 * - review: contracts/, dependency manifests, non-packages/ paths, cross-package, or over size limit → PR without --auto.
 * - small: single package, under limit, no config/contracts/deps → eligible for --auto.
 */
export function classifyDiff(numstatLines: string[], maxDiffLines: number): DiffClassification {
  const entries = numstatLines
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => {
      const parts = l.split(/\s+/);
      return { added: parts[0] ?? '0', deleted: parts[1] ?? '0', path: parts.slice(2).join(' ') };
    });
  if (entries.length === 0) return 'review';

  for (const e of entries) {
    if (SECRET_PATH_PATTERNS.some(p => p.test(e.path))) return 'abort';
  }
  for (const e of entries) {
    if (e.path.startsWith('contracts/')) return 'review';
    if (e.path.endsWith('package.json') || e.path.endsWith('pnpm-lock.yaml')) return 'review';
  }
  const pkgs = new Set<string>();
  for (const e of entries) {
    const m = e.path.match(/^packages\/([^/]+)\//);
    if (!m) return 'review';
    pkgs.add(m[1]);
  }
  if (pkgs.size > 1) return 'review';

  const total = entries.reduce((sum, e) => {
    const a = e.added === '-' ? 0 : Number.parseInt(e.added, 10);
    const d = e.deleted === '-' ? 0 : Number.parseInt(e.deleted, 10);
    return sum + (Number.isFinite(a) ? a : 0) + (Number.isFinite(d) ? d : 0);
  }, 0);
  if (total > maxDiffLines) return 'review';
  return 'small';
}

// ── Prompt ─────────────────────────────────────────────

export function buildUserPrompt(todo: TodoRecord, workspaceRoot: string): string {
  const meta = todo.metadata ? JSON.stringify(todo.metadata) : '{}';
  return [
    `TODO: ${todo.title}`,
    `DESCRIPTION: ${todo.description ?? '(none)'}`,
    `SOURCE: ${todo.source}`,
    `METADATA: ${meta}`,
    '',
    `Resolve this todo with the smallest possible change in the workspace at ${workspaceRoot}.`,
    'Edit files directly using your tools. Do NOT run pnpm/git/gh.',
    'When done, respond with a one-line summary of files changed.',
  ].join('\n');
}

// ── Claim ──────────────────────────────────────────────

/**
 * Atomically claim a todo for AI fix: status backlog → in_progress, guarded by
 * `WHERE status='backlog'` so concurrent claimants on the same todo serialize
 * (loser gets 0 rows → null). Lease metadata lets the reaper return stale claims.
 */
export async function claimAICodeFixTodo(
  todoId: string,
  leaseMs = 30 * 60 * 1000,
  db: DbLike = getDb(),
): Promise<TodoRecord | null> {
  const leaseIso = new Date(Date.now() + leaseMs).toISOString();
  const res = await db.query(
    `UPDATE todos
       SET status = 'in_progress',
           started_at = COALESCE(started_at, now()),
           updated_at = now(),
           metadata_json = metadata_json
             || jsonb_build_object('aiFixClaim',
                  jsonb_build_object('claimedAt', now()::text,
                                     'leaseExpiresAt', $2::text,
                                     'processId', $3::bigint))
     WHERE id = $1
       AND status = 'backlog'
       AND archived_at IS NULL
     RETURNING *`,
    [todoId, leaseIso, process.pid],
  );
  return res.rows[0] ? rowToTodo(res.rows[0] as TodoRow) : null;
}

async function markTodoOutcome(
  todoId: string,
  outcome: string,
  extra: Record<string, unknown> = {},
  db: DbLike = getDb(),
): Promise<void> {
  try {
    const status = outcome === 'auto_merged' ? 'done'
      : outcome === 'pr_opened_review' ? 'in_progress'
      : 'backlog';
    await db.query(
      `UPDATE todos
         SET status = $2,
             updated_at = now(),
             completed_at = CASE WHEN $2 = 'done' THEN now() ELSE completed_at END,
             metadata_json = metadata_json
               || jsonb_build_object('aiFixOutcome', $3::text, 'aiFixExtra', $4::jsonb)
       WHERE id = $1`,
      [todoId, status, outcome, JSON.stringify(extra)],
    );
  } catch (err) {
    log.warn(`markTodoOutcome failed for ${todoId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Shell helpers ──────────────────────────────────────

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'todo';
}
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function escapeTitle(s: string): string {
  return s.replace(/"/g, '\\"').slice(0, 80);
}

// ── Orchestrator ───────────────────────────────────────

export interface ApplyAICodeFixDeps {
  runAgent?: RunAgentFn;
  exec?: BranchHygieneExecFn;
  db?: DbLike;
}

export async function applyAICodeFix(
  job: GovernanceJob,
  summary: Record<string, unknown>,
  deps?: ApplyAICodeFixDeps,
): Promise<{ applied: boolean; detail: string }> {
  const cfg: Required<Omit<AICodeFixJobConfig, 'model'>> & { model?: string } = {
    provider: 'deepseek', maxDiffLines: 200, maxLoops: 8,
    ...(job.config as AICodeFixJobConfig),
  } as Required<Omit<AICodeFixJobConfig, 'model'>> & { model?: string };

  const nextTodoId = summary.nextTodoId as string | null | undefined;
  if (!nextTodoId) return { applied: false, detail: 'no candidate todo' };

  const { execSync: realExecSync } = await import('node:child_process');
  const exec: BranchHygieneExecFn = deps?.exec ?? ((cmd, opts) =>
    realExecSync(cmd, { encoding: 'utf8', ...opts }) as string);
  // Only import loop.js (which pulls provider/db deps) when no runAgent is injected —
  // keeps tests hermetic.
  const runAgentFn: RunAgentFn = deps?.runAgent
    ?? ((await import('./loop.js')).runAgent as RunAgentFn);
  const db: DbLike = deps?.db ?? getDb();
  const mark = (id: string, outcome: string, extra: Record<string, unknown> = {}) =>
    markTodoOutcome(id, outcome, extra, db);

  const detail: string[] = [];

  try {
    // 1. Precondition: clean working tree.
    try {
      if (exec('git status --porcelain', { timeout: 5000 }).trim().length > 0) {
        return { applied: false, detail: 'working tree dirty — refusing to claim (operator has uncommitted work)' };
      }
    } catch {
      return { applied: false, detail: 'git status failed — not a git worktree?' };
    }

    // 2. Claim.
    const todo = await claimAICodeFixTodo(nextTodoId, undefined, db);
    if (!todo) return { applied: false, detail: `claim lost (todo ${nextTodoId} no longer backlog)` };
    detail.push(`claimed ${todo.id}: ${todo.title}`);

    // 3. AI agent edits code.
    let agentResult: AgentResult;
    try {
      agentResult = await runAgentFn(buildUserPrompt(todo, process.cwd()), {
        provider: cfg.provider,
        model: cfg.model,
        systemPrompt: AI_FIX_SYSTEM_PROMPT,
        workspaceRoot: process.cwd(),
        toolMode: 'project-write',
        sandboxMode: 'workspace-write',
        allowedTools: [...AI_FIX_TOOLS],
        maxLoops: cfg.maxLoops,
      });
    } catch (err) {
      await mark(todo.id, 'agent_error');
      return { applied: false, detail: detail.join('\n') + `\nagent error: ${err instanceof Error ? err.message : String(err)}` };
    }
    detail.push(`agent ran ${agentResult.loopCount} loop(s)`);

    // 4. Diff + classify.
    const numstat = exec('git --no-pager diff --numstat', { timeout: 5000 });
    const diffLines = numstat.split('\n').filter(l => l.trim());
    if (diffLines.length === 0) {
      await mark(todo.id, 'no_changes');
      return { applied: false, detail: detail.join('\n') + '\nAI produced no changes' };
    }
    const classification = classifyDiff(diffLines, cfg.maxDiffLines);
    detail.push(`diff: ${classification} (${diffLines.length} file(s))`);

    // 5. Abort on secrets.
    if (classification === 'abort') {
      exec('git checkout -- . && git clean -fd', { timeout: 10000, stdio: 'pipe' });
      await mark(todo.id, 'aborted_secrets');
      return { applied: false, detail: detail.join('\n') + '\ndiff touches secrets/env — aborted, no PR' };
    }

    // 6. Verify typecheck.
    try {
      exec('pnpm run _typecheck', { timeout: 240000, stdio: 'pipe' });
      detail.push('typecheck passed');
    } catch (err) {
      exec('git checkout -- . && git clean -fd', { timeout: 10000, stdio: 'pipe' });
      await mark(todo.id, 'typecheck_failed');
      return { applied: true, detail: detail.join('\n') + `\ntypecheck FAILED — restored tree: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
    }

    // 7. Branch + commit.
    const branch = `ai-fix/${slugify(todo.id)}`;
    exec(`git checkout -b ${branch}`, { timeout: 10000, stdio: 'pipe' });
    exec('git add -A', { timeout: 10000, stdio: 'pipe' });
    exec(
      `git commit -m "fix(ai): ${escapeTitle(todo.title)}" -m "Closes todo ${todo.id}. Generated by ai_code_fix governance job (provider=${cfg.provider})."`,
      { timeout: 15000, stdio: 'pipe' },
    );
    detail.push(`branch ${branch}`);

    // 8. PR.
    const prTitle = `fix(ai): ${todo.title}`;
    const prBody = `Closes todo ${todo.id}.\n\nSource: ${todo.source}\nGenerated by ai_code_fix governance job (provider=${cfg.provider}, classification=${classification}).`;
    let prUrl = '';
    try {
      prUrl = exec(
        `gh pr create --base main --head ${branch} --title ${shellQuote(prTitle)} --body ${shellQuote(prBody)}`,
        { timeout: 30000, stdio: 'pipe' },
      ).trim();
      detail.push(`PR: ${prUrl}`);
    } catch (err) {
      await mark(todo.id, 'pr_create_failed', { branch });
      exec('git checkout main', { timeout: 10000, stdio: 'pipe' });
      return { applied: true, detail: detail.join('\n') + `\ngh pr create failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
    }

    // 9. Auto-merge if small; else human review.
    if (classification === 'small') {
      try {
        exec('gh pr merge --auto --merge --delete-branch', { timeout: 15000, stdio: 'pipe' });
        detail.push('auto-merge requested');
        await mark(todo.id, 'auto_merged', { prUrl });
      } catch (err) {
        detail.push(`auto-merge request failed (PR open for review): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
        await mark(todo.id, 'pr_opened_review', { prUrl });
      }
    } else {
      await mark(todo.id, 'pr_opened_review', { prUrl });
    }

    exec('git checkout main', { timeout: 10000, stdio: 'pipe' });
    return { applied: true, detail: detail.join('\n') };
  } catch (err) {
    return { applied: false, detail: `AI code fix failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
