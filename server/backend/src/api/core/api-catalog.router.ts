/**
 * `apiCatalog.*` — the API explorer's data (planning#595), admin-only.
 *
 *   list         every method the hub serves: kind, tier, token scope, and
 *                whether the CALLER may call it (decided at path level, without
 *                an input — a device-scoped grant still checks the device on the
 *                real call)
 *   inputSchema  one method's input as JSON Schema, for the editor skeleton
 *
 * The router reads the app router it is mounted in through `getProcedures`,
 * which `buildAppRouter` resolves once the router exists.
 */
import type {
  ApiCatalogEntry,
  ApiCatalogInputSchemaOutput,
  ApiCatalogListOutput,
} from '@camstack/types'
import { z } from 'zod'
import type { AuthenticatedAgent } from '../trpc/trpc.context.js'
import { enforcedScopesOf } from '../trpc/device-access.js'
import { authorizeProcedure, viewerPassesAdminTier } from '../trpc/principal-authorization.js'
import { adminProcedure, procedureTierOf, trpcRouter } from '../trpc/trpc.middleware.js'
import { trpcUserError } from '../trpc/user-error.js'
import { buildApiCatalog, inputSchemaOf, procedureShapeOf } from './api-catalog.js'

/** The flat `<router>.<method>` → procedure record of the served router. */
export type ServedProcedures = Readonly<Record<string, unknown>>

export type ProcedureSource = () => ServedProcedures

const InputSchemaInput = z.object({ path: z.string().min(1) })

function callableBy(user: AuthenticatedAgent, entry: ApiCatalogEntry): boolean {
  if (entry.tier === 'public') return true
  const scopes = enforcedScopesOf(user)
  if (!authorizeProcedure(scopes, entry.path, undefined).ok) return false
  if (entry.tier === 'admin') {
    return user.isAdmin || viewerPassesAdminTier(user.scopes ?? [], entry.path)
  }
  return true
}

export function createApiCatalogRouter(getProcedures: ProcedureSource) {
  // The procedure record is fixed once the app router is built: compute once.
  let cached: readonly ApiCatalogEntry[] | null = null
  const catalog = (): readonly ApiCatalogEntry[] => {
    cached ??= buildApiCatalog(getProcedures(), procedureTierOf)
    return cached
  }

  return trpcRouter({
    list: adminProcedure.query(({ ctx }): ApiCatalogListOutput => {
      const user = ctx.user
      return { methods: catalog().map((entry) => ({ ...entry, callable: callableBy(user, entry) })) }
    }),

    inputSchema: adminProcedure
      .input(InputSchemaInput)
      .query(({ input }): ApiCatalogInputSchemaOutput => {
        const shape = procedureShapeOf(getProcedures()[input.path])
        if (shape === null) {
          throw trpcUserError(
            'NOT_FOUND',
            'apiCatalog.unknown-method',
            { path: input.path },
            `No method ${input.path} on this hub`,
          )
        }
        const answer = inputSchemaOf(shape)
        return {
          path: input.path,
          hasInput: shape.inputs.length > 0,
          schema: answer.schema,
          error: answer.error,
        }
      }),
  })
}
