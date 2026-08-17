/**
 * Zod re-export — single zod dependency point for packages that consume
 * @los/infra (agent/gateway/web). Avoids duplicating the zod dep in every
 * package that needs configuration schemas.
 */
export { z, type ZodType } from 'zod';
