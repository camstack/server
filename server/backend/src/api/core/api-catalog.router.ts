/**
 * `apiCatalog.*` — the API explorer's data (planning#595), admin-only.
 *
 *   list         every method the hub serves: kind, tier, token scope, and
 *                whether the CALLER may call it: `yes`, `no`, or `per-device`
 *                when only a device grant reaches it — the list has no input,
 *                and the real call is decided on the device it names
 *   inputSchema  one method's input as JSON Schema, for the editor skeleton
 *
 * The router reads the app router it is mounted in through `getProcedures`,
 * which `buildAppRouter` resolves once the router exists.
 */
import type {
  ApiCallable,
  ApiCatalogEntry,
  ApiCatalogInputSchemaOutput,
  ApiCatalogListOutput,
  CredentialScope,
} from '@camstack/types'
import { capabilityScopesOf } from '@camstack/types'
import { METHOD_ACCESS_MAP } from '@camstack/server/system'
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

/**
 * A device-scoped cap method refused at path level, for a principal holding a
 * device grant at the method's access: the matcher refuses only because no
 * device is named (`checkScopeAccess`), so the real call is decided per device.
 */
function reachedPerDevice(scopes: readonly CredentialScope[], path: string): boolean {
  const meta = METHOD_ACCESS_MAP[path]
  if (meta === undefined || meta.capScope !== 'device') return false
  return capabilityScopesOf(scopes).some(
    (s) => s.type === 'device' && s.access.includes(meta.access),
  )
}

/** May `user` call the method — `per-device` when it depends on the device the input names. */
export function callableBy(user: AuthenticatedAgent, entry: ApiCatalogEntry): ApiCallable {
  if (entry.tier === 'public') return 'yes'
  const scopes = enforcedScopesOf(user)
  const pathLevel: ApiCallable = authorizeProcedure(scopes, entry.path, undefined).ok
    ? 'yes'
    : reachedPerDevice(scopes, entry.path)
      ? 'per-device'
      : 'no'
  if (pathLevel === 'no') return 'no'
  if (
    entry.tier === 'admin' &&
    !user.isAdmin &&
    !viewerPassesAdminTier(user.scopes ?? [], entry.path)
  ) {
    return 'no'
  }
  return pathLevel
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
      return {
        methods: catalog().map((entry) => ({ ...entry, callable: callableBy(user, entry) })),
      }
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
