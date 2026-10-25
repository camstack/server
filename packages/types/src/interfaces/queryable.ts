/**
 * IQueryable — standard capability for addons to expose custom query methods
 * discoverable by the hub and admin UI.
 *
 * Any addon implementing this capability can be queried from the hub via:
 *   broker.call("{addonId}.queryable.query", { name, params })
 *
 * The admin UI auto-generates forms from paramsSchema and renders results
 * from resultSchema.
 */

interface QueryCatalogEntry {
  readonly name: string
  readonly description: string
  /** Zod schema for query parameters — used for validation + auto-generated UI forms */
  readonly paramsSchema?: unknown
  /** Zod schema for query results — used for auto-rendered result display */
  readonly resultSchema?: unknown
}

interface IQueryable {
  /** List all queries this addon supports */
  getQueryCatalog(): QueryCatalogEntry[]
  /** Execute a named query with parameters */
  query(name: string, params: Record<string, unknown>): Promise<unknown>
}

export type { IQueryable, QueryCatalogEntry }
