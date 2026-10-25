/**
 * tRPC error formatter that serializes CapRouteError diagnostic fields
 * across the server→client boundary.
 *
 * tRPC only carries `error.message` by default. This formatter augments
 * the default shape's `data` block with typed CapRouteError fields so the
 * admin-UI can read `capRouteReason` instead of substring-matching message text.
 *
 * Fields added (all optional — absent when the error is not a CapRouteError):
 *   - `capRouteReason` — 'no-provider' | 'node-offline' | 'cap-unknown' | 'transport-failed'
 *   - `capRouteRejected` — array of `{ kind: string; why: string }` route-rejection descriptors
 *   - `capRouteNodeId` — the target node id, when known
 *
 * The formatter is EXPORTED for unit testing (no side-effects, pure function).
 */
import { CapRouteError, getCatalogRegistry, SERVER_NAMESPACE } from '@camstack/system'
import {
  DEFAULT_CATALOG_LANG,
  interpolate,
  readErrorI18n,
  type CatalogLang,
  type ErrorI18nPayload,
} from '@camstack/types'
import type { RejectedRoute } from '@camstack/system'
import type { TRPCError } from '@trpc/server'
import type { DefaultErrorShape } from '@trpc/server/unstable-core-do-not-import'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The augmented data block we attach when a CapRouteError is present. */
export interface CapRouteErrorData {
  readonly capRouteReason: string
  readonly capRouteRejected: readonly RejectedRoute[]
  readonly capRouteNodeId?: string
}

export interface AugmentedErrorShape extends DefaultErrorShape {
  readonly data: DefaultErrorShape['data'] &
    Partial<CapRouteErrorData> & {
      /** The stable error code + params (D863), present when the thrown error carried one. */
      readonly i18n?: ErrorI18nPayload
    }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Known CapRouteError reason values — used as a runtime safety rail. */
const KNOWN_REASONS = new Set<string>([
  'no-provider',
  'node-offline',
  'cap-unknown',
  'transport-failed',
])

/** Narrows a plain string to the `CapRouteError['reason']` union. */
function isCapRouteReason(r: string): r is CapRouteError['reason'] {
  return KNOWN_REASONS.has(r)
}

/** Narrows an `unknown` value to `RejectedRoute` by checking structural shape. */
function isRejectedRoute(r: unknown): r is RejectedRoute {
  if (typeof r !== 'object' || r === null) return false
  const kind: unknown = Reflect.get(r, 'kind')
  const why: unknown = Reflect.get(r, 'why')
  return typeof kind === 'string' && typeof why === 'string'
}

// ---------------------------------------------------------------------------
// CapRouteError extraction helpers
// ---------------------------------------------------------------------------

/**
 * Walks the `.cause` chain of an error to find a CapRouteError.
 * Returns the first one found, or null.
 *
 * Detection is dual-mode:
 *   1. `instanceof CapRouteError` — works when the same module is loaded.
 *   2. Duck-type: `name === 'CapRouteError'` + `typeof reason === 'string'`
 *      — robust against module-boundary issues (self-contained addons).
 */
function extractCapRouteError(err: unknown): CapRouteError | null {
  let current: unknown = err
  for (let depth = 0; depth < 8; depth++) {
    if (current === null || current === undefined) return null

    if (current instanceof CapRouteError) {
      return current
    }

    // Duck-type fallback: err.name + err.reason field present
    if (typeof current === 'object' && Reflect.get(current, 'name') === 'CapRouteError') {
      const rawReason: unknown = Reflect.get(current, 'reason')
      if (typeof rawReason === 'string') {
        // Runtime safety: reject unrecognised reason strings so the formatter
        // only promotes values it knows are valid CapRouteError reasons.
        if (!isCapRouteReason(rawReason)) {
          // Unrecognised reason — treat as a non-CapRouteError and keep walking
          const cause: unknown = Reflect.get(current, 'cause')
          if (cause === current) return null
          current = cause
          continue
        }
        const reason: CapRouteError['reason'] = rawReason

        const rawRejected: unknown = Reflect.get(current, 'rejected')
        const rejected: readonly RejectedRoute[] = Array.isArray(rawRejected)
          ? rawRejected.filter(isRejectedRoute)
          : []

        const nodeId: unknown = Reflect.get(current, 'nodeId')
        const message: unknown = Reflect.get(current, 'message')
        const rawCapName: unknown = Reflect.get(current, 'capName')
        const capName: string = typeof rawCapName === 'string' ? rawCapName : '(unknown)'

        // Build a minimal object with the same shape — enough for the formatter.
        const synthetic = Object.assign(
          new CapRouteError(capName, undefined, {
            reason,
            rejected,
            ...(typeof nodeId === 'string' ? { nodeId } : {}),
          }),
          {
            // Override message from the original if available
            message: typeof message === 'string' ? message : '(duck-typed CapRouteError)',
          },
        )
        return synthetic
      }
    }

    // Walk the cause chain
    if (typeof current !== 'object') return null
    const cause: unknown = Reflect.get(current, 'cause')
    if (cause === current) return null // Guard against circular refs
    current = cause
  }
  return null
}

// ---------------------------------------------------------------------------
// Formatter — exported for unit tests
// ---------------------------------------------------------------------------

export interface FormatTrpcErrorOpts {
  readonly error: TRPCError
  readonly shape: DefaultErrorShape
  /** The request context; only `lang` is read (D863). Absent on the mesh. */
  readonly ctx?: { readonly lang?: CatalogLang } | undefined
}

/**
 * Augments the default tRPC error shape with CapRouteError diagnostic fields
 * when the thrown error (or any error in its `.cause` chain) is a CapRouteError.
 * Returns the shape unchanged for all other errors.
 */
export function formatTrpcError(opts: FormatTrpcErrorOpts): AugmentedErrorShape {
  return withErrorI18n(opts, withCapRouteData(opts))
}

/**
 * A coded error (`userError(...)`, D863) gets its response `message` in the
 * request language when the `server` catalog has the code; the code and params
 * stay in `data.i18n` whatever the language. A legacy error (no code), an
 * unknown code and English all pass through with the original message.
 */
function withErrorI18n(opts: FormatTrpcErrorOpts, shape: AugmentedErrorShape): AugmentedErrorShape {
  const coded = readErrorI18n(opts.error)
  if (coded === null) return shape
  const lang = opts.ctx?.lang ?? DEFAULT_CATALOG_LANG
  const text =
    lang === DEFAULT_CATALOG_LANG
      ? undefined
      : getCatalogRegistry().lookup(lang, SERVER_NAMESPACE, coded.code)
  return {
    ...shape,
    ...(text !== undefined ? { message: interpolate(text, coded.params) } : {}),
    data: { ...shape.data, i18n: coded },
  }
}

function withCapRouteData(opts: FormatTrpcErrorOpts): AugmentedErrorShape {
  const { error, shape } = opts

  // extractCapRouteError already walks the full .cause chain, so a single call
  // starting from `error` covers both `error instanceof CapRouteError` and
  // `error.cause` (and deeper nesting). No second call needed.
  const capRouteError = extractCapRouteError(error)
  if (capRouteError === null) {
    return { ...shape, data: { ...shape.data } }
  }

  const extraData: CapRouteErrorData = {
    capRouteReason: capRouteError.reason,
    capRouteRejected: capRouteError.rejected,
    ...(capRouteError.nodeId !== undefined ? { capRouteNodeId: capRouteError.nodeId } : {}),
  }

  return {
    ...shape,
    data: {
      ...shape.data,
      ...extraData,
    },
  }
}
