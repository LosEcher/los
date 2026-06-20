/**
 * SaaS Todo Dispatch — tenant/project scoped todo seed dispatch and reconciliation.
 *
 * Provides:
 *   POST /tenants/:tid/projects/:pid/todos/dispatch — dispatch seed todos to scope
 *   GET  /tenants/:tid/projects/:pid/todos/reconcile — dry-run reconciliation report
 *   POST /tenants/:tid/projects/:pid/todos/reconcile — reconciliation + auto-fix drift
 *
 * The bridge allows SaaS operators to propagate los planning todo seeds into
 * specific tenant/project scopes. It uses governance_reconciliation for diff
 * and the existing seedLosPlanningTodos path for write.
 */

import type { FastifyInstance } from 'fastify';
import {
  createTodo,
  updateTodo,
  archiveTodo,
  listTodos,
  seedLosPlanningTodos,
  reconcilePlanningTodosWithDefaultDb,
  createGovernanceJob,
  ensureGovernanceJobStore,
} from '@los/agent';
import type { TodoStatus, CreateTodoInput } from '@los/agent/todos';
import { LOS_PLANNING_TODO_SEED } from '@los/agent/todo-seeds';

// ── Normalizers ──────────────────────────────────────────

function normalizeOptionalString(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.trim().length === 0) return undefined;
  return v.trim();
}

function normalizeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/^-+/, '').replace(/-+$/, '') || 'default';
}

const VALID_TODO_STATUSES: Set<string> = new Set([
  'backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled',
]);

function normalizeTodoStatus(v: unknown): TodoStatus | undefined {
  if (typeof v === 'string' && VALID_TODO_STATUSES.has(v)) return v as TodoStatus;
  return undefined;
}

function normalizeStatusFilter(v: unknown): TodoStatus[] | undefined {
  if (typeof v === 'string') {
    const parts = v.split(',').map(s => s.trim()).filter(Boolean);
    const valid = parts.filter(s => VALID_TODO_STATUSES.has(s)) as TodoStatus[];
    if (valid.length > 0) return valid;
  }
  return undefined;
}

// ── Routes ───────────────────────────────────────────────

export function registerSaaSTodoRoutes(app: FastifyInstance): void {
  /**
   * POST /tenants/:tenantId/projects/:projectId/todos/dispatch
   *
   * Dispatch los planning seeds into a specific tenant/project scope.
   *
   * Body:
   *   source? — filter seeds by source (default: all)
   *   dryRun? — if true, return what would be created without writing
   *
   * Returns:
   *   { dispatched, skipped, todoIds, jobId }
   */
  app.post('/tenants/:tenantId/projects/:projectId/todos/dispatch', async (req, reply) => {
    const tenantId = normalizeId((req.params as any).tenantId);
    const projectId = normalizeId((req.params as any).projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = normalizeOptionalString(body.source);
    const dryRun = body.dryRun === true || body.dryRun === 'true';

    await ensureGovernanceJobStore();

    // Get current seeds vs DB state
    const reconciled = await reconcilePlanningTodosWithDefaultDb({
      tenantId,
      projectId,
      includeArchived: false,
    });

    // Determine which seeds need to be created (seedOnly — in seeds but not DB)
    const toCreate = source
      ? reconciled.seedOnly.filter(s => {
          // Match by source prefix
          const seedSource = (s as any).source as string | undefined;
          return seedSource && seedSource.includes(source);
        })
      : reconciled.seedOnly;

    const todoIds: string[] = [];
    let skipped = 0;

    if (!dryRun) {
      // Resolve full seed data from LOS_PLANNING_TODO_SEED
      const { LOS_PLANNING_TODO_SEED } = await import('@los/agent/todo-seeds');
      const seedMap = new Map(LOS_PLANNING_TODO_SEED.map(s => [s.id, s]));

      for (const item of toCreate) {
        const seed = seedMap.get(item.id);
        if (!seed) { skipped++; continue; }

        try {
          const created = await createTodo({
            ...seed,
            // Override tenant/project scope
            metadata: {
              ...(seed.metadata ?? {}),
              tenantId,
              projectId,
              dispatchedAt: new Date().toISOString(),
              dispatchSource: 'saa_bridge',
            },
          });
          todoIds.push(created.id);
        } catch (err: any) {
          // If todo already exists (dedup), skip
          if (err?.message?.includes('unique') || err?.message?.includes('duplicate')) {
            skipped++;
          } else {
            throw err;
          }
        }
      }
    } else {
      todoIds.push(...toCreate.map(s => s.id));
    }

    // Record dispatch as a governance job for audit trail
    const job = await createGovernanceJob({
      jobType: 'consistency_audit',
      tenantId,
      projectId,
      config: {
        action: 'saa_todo_dispatch',
        source: source ?? null,
        dryRun,
        dispatchedCount: todoIds.length,
        skippedCount: skipped,
        seedOnlyBaseline: reconciled.seedOnly.length,
        dbOnlyBaseline: reconciled.dbOnly.length,
      },
    });

    return {
      dispatched: todoIds.length,
      skipped,
      todoIds,
      jobId: job.id,
      dryRun,
      scope: { tenantId, projectId },
    };
  });

  /**
   * GET /tenants/:tenantId/projects/:projectId/todos/reconcile
   *
   * Dry-run reconciliation report: show seed vs DB differences
   * without making changes.
   */
  app.get('/tenants/:tenantId/projects/:projectId/todos/reconcile', async (req, reply) => {
    const tenantId = normalizeId((req.params as any).tenantId);
    const projectId = normalizeId((req.params as any).projectId);

    const reconciled = await reconcilePlanningTodosWithDefaultDb({
      tenantId,
      projectId,
      includeArchived: false,
    });

    return {
      scope: { tenantId, projectId },
      seedCount: reconciled.seedCount,
      dbCount: reconciled.dbCount,
      activeCounts: reconciled.activeCounts,
      seedOnly: reconciled.seedOnly.map(item => ({ id: item.id, title: item.title })),
      dbOnly: reconciled.dbOnly.map(item => ({
        id: item.id,
        title: item.title,
        status: item.status,
      })),
      statusDrift: reconciled.statusDrift.map(drift => ({
        id: drift.id,
        title: drift.title,
        expectedStatus: drift.expectedStatus,
        actualStatus: drift.actualStatus,
        archivedAt: drift.archivedAt ?? null,
      })),
      hasDrift: reconciled.statusDrift.length > 0,
      hasOrphans: reconciled.seedOnly.length > 0 || reconciled.dbOnly.length > 0,
    };
  });

  /**
   * POST /tenants/:tenantId/projects/:projectId/todos/reconcile
   *
   * Execute reconciliation with optional auto-fix:
   *   - seedOnly → dispatch missing seeds
   *   - dbOnly → archive orphaned todos
   *   - statusDrift → update to expected status
   *
   * Body:
   *   fixMode: 'seed_only' | 'db_only' | 'status_drift' | 'all' (default: 'all')
   *   dryRun: boolean (default: false)
   */
  app.post('/tenants/:tenantId/projects/:projectId/todos/reconcile', async (req, reply) => {
    const tenantId = normalizeId((req.params as any).tenantId);
    const projectId = normalizeId((req.params as any).projectId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fixMode = (body.fixMode as string) ?? 'all';
    const dryRun = body.dryRun === true || body.dryRun === 'true';

    const reconciled = await reconcilePlanningTodosWithDefaultDb({
      tenantId,
      projectId,
      includeArchived: false,
    });

    const result: Record<string, unknown> = {
      scope: { tenantId, projectId },
      dryRun,
      seedOnlyFixed: 0,
      dbOnlyFixed: 0,
      statusDriftFixed: 0,
      errors: [] as string[],
    };

    if (!dryRun) {
      const { LOS_PLANNING_TODO_SEED } = await import('@los/agent/todo-seeds');
      const seedMap = new Map(LOS_PLANNING_TODO_SEED.map(s => [s.id, s]));

      // Fix seedOnly (missing seeds in DB)
      if (fixMode === 'all' || fixMode === 'seed_only') {
        for (const item of reconciled.seedOnly) {
          const seed = seedMap.get(item.id);
          if (!seed) continue;
          try {
            await createTodo({
              ...seed,
              metadata: {
                ...(seed.metadata ?? {}),
                tenantId,
                projectId,
                dispatchedAt: new Date().toISOString(),
                dispatchSource: 'reconciliation',
              },
            });
            (result.seedOnlyFixed as number)++;
          } catch (err: any) {
            (result.errors as string[]).push(`seed ${item.id}: ${err.message}`);
          }
        }
      }

      // Fix statusDrift (correct status mismatches)
      if (fixMode === 'all' || fixMode === 'status_drift') {
        const { updateTodo } = await import('@los/agent/todos');
        for (const drift of reconciled.statusDrift) {
          try {
            await updateTodo(drift.id, {
              status: drift.expectedStatus,
              metadata: {
                driftFixedAt: new Date().toISOString(),
                previousStatus: drift.actualStatus,
              },
            });
            (result.statusDriftFixed as number)++;
          } catch (err: any) {
            (result.errors as string[]).push(`drift ${drift.id}: ${err.message}`);
          }
        }
      }

      // Fix dbOnly (orphaned todos not in seeds)
      if (fixMode === 'all' || fixMode === 'db_only') {
        for (const item of reconciled.dbOnly) {
          try {
            await archiveTodo(item.id, 'seed_no_longer_defines_this_todo');
            (result.dbOnlyFixed as number)++;
          } catch (err: any) {
            (result.errors as string[]).push(`dbOnly ${item.id}: ${err.message}`);
          }
        }
      }
    }

    await ensureGovernanceJobStore();
    await createGovernanceJob({
      jobType: 'consistency_audit',
      tenantId,
      projectId,
      config: {
        action: 'reconciliation_fix',
        fixMode,
        dryRun,
        ...result,
      },
    });

    return result;
  });

  /**
   * GET /tenants/:tenantId/projects/:projectId/todos
   *
   * List todos for a specific tenant/project scope with optional status filter.
   */
  app.get('/tenants/:tenantId/projects/:projectId/todos', async (req, reply) => {
    const tenantId = normalizeId((req.params as any).tenantId);
    const projectId = normalizeId((req.params as any).projectId);
    const query = req.query as { status?: string; limit?: string; includeArchived?: string };

    const todos = await listTodos({
      tenantId,
      projectId,
      status: normalizeTodoStatus(query.status),
      limit: query.limit ? Math.min(1000, Number(query.limit)) : 200,
      includeArchived: query.includeArchived === 'true',
    });

    return { scope: { tenantId, projectId }, count: todos.length, todos };
  });
}
