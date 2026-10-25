/**
 * Wrap a Zod schema parse with an actionable error message. The
 * settings-store regression that broke local-auth in May 2026 surfaced
 * as an opaque Zod error listing every required field as `undefined`
 * — confusing because the data IS in the DB, just exposed through the
 * wrong shape by `queryDeclared`. This helper makes the failure mode
 * obvious: it explicitly mentions the kind, the offending value's top-
 * level keys, and a hint about the most common cause.
 *
 * `schema` is typed loosely (any with a `parse` method) to avoid the
 * generic ZodTypeAny variance error across Zod major versions when this
 * helper is reused by callers that import schemas from `@camstack/types`.
 */
interface ZodLikeSchema<T> {
  parse(data: unknown): T
}

export function parseRecord<T>(kind: string, schema: ZodLikeSchema<T>, data: unknown): T {
  try {
    return schema.parse(data)
  } catch (err: unknown) {
    const topKeys =
      data && typeof data === 'object' && !Array.isArray(data)
        ? Object.keys(data as Record<string, unknown>).join(', ') || '(empty)'
        : `(non-object: ${typeof data})`
    const detail = err instanceof Error ? err.message : String(err)
    const looksDoubleWrapped =
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      Object.keys(data as Record<string, unknown>).length === 1 &&
      'data' in (data as Record<string, unknown>)
    const hint = looksDoubleWrapped
      ? ' This shape is the legacy double-wrap from a stale settings-store query path. Restart the server with the latest @camstack/system build.'
      : ''
    throw new Error(
      `Failed to parse ${kind} from settings store. Top-level keys=[${topKeys}].${hint} Underlying: ${detail}`,
      { cause: err },
    )
  }
}
