import type { FastifyInstance } from 'fastify';
import { buildSloReport, type BuildSloReportOptions, type SloReport } from '@los/agent/slo-report';
import { normalizeOptionalNonNegativeInteger } from '../server-helpers.js';
import { requireOperator } from '../../request-context.js';

type SloRouteDependencies = {
  buildSloReport: (options: BuildSloReportOptions) => Promise<SloReport>;
};

const defaultDependencies: SloRouteDependencies = {
  buildSloReport,
};

export function registerSloRoutes(
  app: FastifyInstance,
  deps: SloRouteDependencies = defaultDependencies,
): void {
  app.get('/slo/report', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const query = req.query as Record<string, unknown>;
    const days = normalizeOptionalNonNegativeInteger(query.days);
    const report = await deps.buildSloReport(days !== undefined ? { windowDays: days } : {});
    return reply.send(report);
  });
}
