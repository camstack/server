/**
 * The version of the migration API contract (planning#447), alone in a schema-free module.
 * The kernel's `ctx.migrationApi` facade runs inside every addon runner and needs this VALUE;
 * it lives here so the `@camstack/types/addon` entry can export it without constructing the
 * Zod schema graph of `migration-api.v1.schema.ts` (D28).
 */
export const MIGRATION_API_VERSION = 1 as const
