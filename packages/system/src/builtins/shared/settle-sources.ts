/**
 * settleSourcesWithTimeout — parallel, per-source-timeout fan-out shared by
 * the addon-pages / addon-widgets aggregators.
 *
 * Each source is called concurrently and raced against `timeoutMs`. A source
 * that rejects OR exceeds the timeout yields a `{ ok: false, error }` result
 * instead of blocking or failing the whole batch. This is the defense that
 * keeps ONE slow/unreachable source — e.g. an agent-hosted source whose cap
 * call sits in a 30s Moleculer `waitForServices` — from stalling the
 * aggregator's `listPages()/listWidgets()` (which otherwise hangs long enough
 * to trip the admin-ui WS keepalive → "server unreachable") or blanking the
 * sidebar. Entry order is preserved in the returned array.
 */

/** Per-source outcome: the source's items, or the error that prevented them. */
export type SourceResult<T> =
  | { readonly ok: true; readonly value: readonly T[] }
  | { readonly ok: false; readonly error: Error }

/** Reject with a timeout error if `p` hasn't settled within `ms`. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`source '${label}' timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

export async function settleSourcesWithTimeout<T>(
  entries: ReadonlyArray<readonly [string, () => Promise<readonly T[]>]>,
  timeoutMs: number,
): Promise<ReadonlyArray<readonly [string, SourceResult<T>]>> {
  return Promise.all(
    entries.map(async ([id, call]): Promise<readonly [string, SourceResult<T>]> => {
      try {
        const value = await withTimeout(Promise.resolve().then(call), timeoutMs, id)
        return [id, { ok: true, value }]
      } catch (err: unknown) {
        return [id, { ok: false, error: toError(err) }]
      }
    }),
  )
}
