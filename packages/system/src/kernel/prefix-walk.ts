/**
 * The keyset walk over one id prefix of a key/value collection, shared by the
 * settings door view and the per-device settings store. Split out of
 * `settings-door-view.ts` so the device store module does not import the view
 * that imports it.
 */
import type { ISettingsStoreProvider } from '@camstack/types'
import { prefixRange } from '../builtins/sqlite-storage/prefix-range.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function unwrapStoredValue(parsed: unknown): unknown {
  if (!isRecord(parsed) || !('value' in parsed)) return parsed
  return parsed.value
}

/**
 * Rows one page of a prefix read asks for.
 *
 * Below `SETTINGS_QUERY_DEFAULT_ROW_CAP` (2 000, `query-bounds.ts`) on purpose:
 * this read now names its own bound, so the engine's defensive cap is never the
 * thing that decides how much of the answer the caller gets.
 */
const PREFIX_PAGE_ROWS = 1_000

/**
 * Pages one prefix read may take before it refuses.
 *
 * 512 pages is 512 000 rows — three orders of magnitude past the largest live
 * scope (`addon-device-settings` for one addon over a ~1 019-device fleet) and
 * still a bound, because a walk with no bound is the defect this file was
 * fixing, not one to reintroduce.
 */
const PREFIX_PAGE_BUDGET = 512

/**
 * Every row under `prefix`, or a throw — never the first 2 000 of them.
 *
 * **The defect.** This issued ONE `query` with no `limit`, and
 * `queryDeclared` resolves an absent limit to `SETTINGS_QUERY_DEFAULT_ROW_CAP`
 * and cuts the result there. On the live hub that fired 138 times in two hours
 * (`settings-store query truncated by a defensive row cap`, collection
 * `addon-device-settings`, `rowCap: 2000`, `requestedLimit: null`): a
 * ~1 019-device fleet with more than two stored keys per device puts one
 * addon's `<addonId>:` range past the cap. The engine warned; the door did not
 * notice, and handed its caller a short map that is **shape-identical to a
 * complete one**. Every device whose rows sort past the cap reads as "has no
 * stored settings", which is exactly what a device with none looks like.
 *
 * **The fix is a keyset walk, not a bigger limit.** The cursor is the last id
 * of the previous page, INCLUSIVE — so the page boundary re-reads exactly one
 * row (ids are unique, so a full page always advances) and no row can fall
 * between two pages the way an `OFFSET` walk drops rows under a concurrent
 * write (D295 rule 1). Re-reading is free here: the accumulator is keyed by
 * suffix, so the duplicate overwrites itself with its own value.
 *
 * `ORDER BY id` is not decoration — the cursor is only meaningful if the
 * engine returns the range in the order the cursor advances through. It is the
 * primary key, so the ordering is the range scan's own.
 *
 * @throws when the prefix cannot be expressed as a range and the collection is
 *   larger than one page, or when the walk exceeds {@link PREFIX_PAGE_BUDGET}.
 *   A throw is the point: a caller that cannot be answered completely must not
 *   be handed something that looks like a complete answer.
 */
export async function loadPrefixed(
  door: Pick<ISettingsStoreProvider, 'query'>,
  collection: string,
  prefix: string,
  decode: (data: unknown) => unknown = unwrapStoredValue,
): Promise<Record<string, unknown>> {
  const range = prefixRange(prefix)
  const result: Record<string, unknown> = {}
  let cursor = range?.lo ?? null
  for (let page = 0; ; page++) {
    if (page >= PREFIX_PAGE_BUDGET) {
      throw new Error(
        `settings door: reading "${prefix}" from "${collection}" exceeded ${PREFIX_PAGE_BUDGET} ` +
          `pages of ${PREFIX_PAGE_ROWS} rows. Refusing to return the part that was read — a ` +
          `partial scope read is indistinguishable from an empty one.`,
      )
    }
    const rows = await door.query({
      collection,
      filter: {
        ...(range !== null && cursor !== null ? { whereBetween: { id: [cursor, range.hi] } } : {}),
        orderBy: { field: 'id', direction: 'asc' },
        limit: PREFIX_PAGE_ROWS,
      },
    })
    for (const row of rows) {
      if (range !== null && (row.id < range.lo || row.id >= range.hi)) continue
      if (!row.id.startsWith(prefix)) continue
      result[row.id.slice(prefix.length)] = decode(row.data)
    }
    if (rows.length < PREFIX_PAGE_ROWS) return result
    const last = rows[rows.length - 1]
    if (last === undefined) return result
    if (range === null) {
      // No range means no cursor: `prefixRange` refused (an empty or non-ASCII
      // prefix), so this read is an unfiltered scan of the collection and there
      // is nothing to page ALONG. A full page therefore means "there is more,
      // and I cannot go and get it".
      throw new Error(
        `settings door: prefix "${prefix}" on "${collection}" cannot be expressed as an id range, ` +
          `and the unfiltered read filled a page — the answer would be partial. ` +
          `Use an ASCII, non-empty prefix.`,
      )
    }
    if (last.id === cursor) {
      throw new Error(
        `settings door: reading "${prefix}" from "${collection}" made no progress at id ` +
          `"${last.id}" — ids under a prefix must be unique.`,
      )
    }
    cursor = last.id
  }
}
