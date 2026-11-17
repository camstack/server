/**
 * The API explorer's catalogue (planning#595): every tRPC method the hub
 * serves, read off the LIVE router's procedure record — capability routers and
 * the hand-written core routers alike. Nothing here lists a method by hand:
 *
 *   - path, router, method and kind come from the procedure record;
 *   - the tier is the gate the procedure was built behind (`procedureTierOf`);
 *   - the token scope of a capability route is its `METHOD_ACCESS_MAP` row
 *     (the same row `protectedProcedure` authorizes against); a core route has
 *     none — it needs authentication only, plus `adminProcedure` where it says so;
 *   - the input schema is the procedure's own Zod parser, as JSON Schema.
 */
import { METHOD_ACCESS_MAP } from '@camstack/server/system'
import type {
  ApiCatalogEntry,
  ApiCatalogScope,
  ApiProcedureKind,
  JsonSchemaDocument,
} from '@camstack/types'
import { z } from 'zod'
import type { ProcedureTier } from '../trpc/trpc.middleware.js'

/** What the catalogue reads off one built procedure. */
export interface ProcedureShape {
  readonly kind: ApiProcedureKind
  readonly inputs: readonly unknown[]
  readonly middlewares: readonly unknown[]
}

function isKind(value: unknown): value is ApiProcedureKind {
  return value === 'query' || value === 'mutation' || value === 'subscription'
}

/** The `_def` of a built tRPC procedure, or `null` for anything else. */
export function procedureShapeOf(procedure: unknown): ProcedureShape | null {
  if (typeof procedure !== 'function' && (typeof procedure !== 'object' || procedure === null)) {
    return null
  }
  const def: unknown = Reflect.get(procedure, '_def')
  if (typeof def !== 'object' || def === null) return null
  const kind: unknown = Reflect.get(def, 'type')
  const inputs: unknown = Reflect.get(def, 'inputs')
  const middlewares: unknown = Reflect.get(def, 'middlewares')
  if (!isKind(kind)) return null
  return {
    kind,
    inputs: Array.isArray(inputs) ? inputs : [],
    middlewares: Array.isArray(middlewares) ? middlewares : [],
  }
}

function scopeOf(path: string): ApiCatalogScope | null {
  const row = METHOD_ACCESS_MAP[path]
  if (row === undefined) return null
  return { capName: row.capName, capScope: row.capScope, access: row.access, role: row.role }
}

/** Every procedure of `procedures` as a catalogue entry, sorted by path. */
export function buildApiCatalog(
  procedures: Readonly<Record<string, unknown>>,
  tierOf: (middlewares: readonly unknown[]) => ProcedureTier,
): readonly ApiCatalogEntry[] {
  const entries: ApiCatalogEntry[] = []
  for (const [path, procedure] of Object.entries(procedures)) {
    const shape = procedureShapeOf(procedure)
    if (shape === null) continue
    const dot = path.lastIndexOf('.')
    const scope = scopeOf(path)
    entries.push({
      path,
      router: dot < 0 ? '' : path.slice(0, dot),
      method: dot < 0 ? path : path.slice(dot + 1),
      kind: shape.kind,
      tier: tierOf(shape.middlewares),
      source: scope === null ? 'core' : 'capability',
      scope,
      hasInput: shape.inputs.length > 0,
    })
  }
  return entries.toSorted((a, b) => a.path.localeCompare(b.path))
}

export interface InputSchemaAnswer {
  readonly schema: JsonSchemaDocument | null
  /** Why a schema could not be produced (a non-Zod parser, an unrepresentable type). */
  readonly error: string | null
}

function jsonSchemaOf(parser: unknown): JsonSchemaDocument {
  if (!(parser instanceof z.ZodType)) {
    throw new Error('the input parser is not a Zod schema')
  }
  // `io: 'input'`: what the CALLER sends — a defaulted field is optional.
  const schema: Readonly<Record<string, unknown>> = z.toJSONSchema(parser, {
    io: 'input',
    unrepresentable: 'any',
  })
  return schema
}

/** The input JSON schema of a procedure; several chained inputs become `allOf`. */
export function inputSchemaOf(shape: ProcedureShape): InputSchemaAnswer {
  if (shape.inputs.length === 0) return { schema: null, error: null }
  try {
    const parts = shape.inputs.map(jsonSchemaOf)
    const schema = parts.length === 1 ? parts[0] : { allOf: parts }
    return { schema: schema ?? null, error: null }
  } catch (err) {
    return { schema: null, error: err instanceof Error ? err.message : String(err) }
  }
}
