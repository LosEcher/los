import type { FastifyInstance } from 'fastify';
import { buildSloReport, type BuildSloReportOptions, type SloReport } from '@los/agent/slo-report';
import { normalizeOptionalNonNegativeInteger } from '../server-helpers.js';

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
    const query = req.query as Record<string, unknown>;
    const days = normalizeOptionalNonNegativeInteger(query.days);
    const report = await deps.buildSloReport(days !== undefined ? { windowDays: days } : {});
    return reply.send(report);
  });
}
