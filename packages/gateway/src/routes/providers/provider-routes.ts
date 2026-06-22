/**
 * Provider routes — onboarding, compat evidence, promotion, external summaries,
 * run evals, eval backlog, and provider CRUD.
 *
 * Delegate to extracted handler modules to keep each file under 400 lines.
 */
import type { FastifyInstance } from 'fastify';
import { registerProviderEvidenceRoutes } from './provider-evidence-routes.js';
import { registerProviderCrudRoutes } from './provider-crud-routes.js';

export function registerProviderRoutes(app: FastifyInstance): void {
  registerProviderEvidenceRoutes(app);
  registerProviderCrudRoutes(app);
}
