/**
 * `readDeviceStoreBatch` — asserted on the number of STORE ROUND TRIPS, which
 * is the only number that was ever wrong.
 *
 * The per-device form returns correct values; it always did. What it could not
 * do is amortise, and `device-queries.ts#listAll` called it once per fleet row
 * on hub-main's event loop. The sqlite profiler measured the result at 9 229
 * `query addon-device-settings` a minute on 2026-08-25 — four times the next
 * busiest read in the cluster. So these tests count `door.query` calls.
 */

import type { ISettingsStoreProvider } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createDoorSettingsView } from '../../../kernel/settings-door-view.js'
import { resolveRowBound, SETTINGS_QUERY_DEFAULT_ROW_CAP } from '../query-bounds.js'

interface StoredRow {
  readonly id: string
  readonly data: unknown
}

/**
 * A door that counts its reads, honours the half-open id range the prefix
 * helper builds — the same predicate the real engine indexes on — AND applies
 * the engine's defensive row cap.
 *
 * The cap is the part this fake was missing until 2026-08-31, and its absence
 * is why these tests passed while production was serving a partial answer:
 * `queryDeclared` appends `LIMIT ?` to EVERY statement and resolves an absent
 * `limit` to {@link SETTINGS_QUERY_DEFAULT_ROW_CAP} (`query-bounds.ts`). A fake
 * that returns every matching row cannot see a truncation, so it agreed with a
 * production read that had been silently cut at 2 000 rows 138 times in two
 * hours (`settings-store query truncated by a defensive row cap`,
 * `addon-device-settings`, `requestedLimit: null`).
 */
function countingDoor(rows: readonly StoredRow[]) {
  let queries = 0
  const requestedLimits: (number | undefined)[] = []
  const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const door = {
    async query(input: {
      collection: string
      filter?: {
        whereBetween?: Record<string, readonly [string, string]>
        limit?: number
        orderBy?: { field: string; direction: 'asc' | 'desc' }
      }
    }) {
      queries += 1
      requestedLimits.push(input.filter?.limit)
      const between = input.filter?.whereBetween?.['id']
      const selected =
        between === undefined
          ? ordered
          : ordered.filter((r) => r.id >= between[0] && r.id < between[1])
      // Without `ORDER BY` the engine promises NOTHING about row order — it
      // returns whatever the plan produced. Reversing an unordered read is how
      // this fake refuses to hand a cursor walk an ordering it did not ask for.
      const inOrder =
        input.filter?.orderBy?.field === 'id' && input.filter.orderBy.direction === 'asc'
          ? selected
          : [...selected].reverse()
      const bound = resolveRowBound(input.filter?.limit)
      return inOrder.slice(0, bound.limit)
    },
    async get() {
      return null
    },
    async set() {
      return undefined
    },
    async delete() {
      return undefined
    },
    async deleteWhere() {
      return undefined
    },
  }
  return { door, queries: () => queries, requestedLimits: () => [...requestedLimits] }
}

function viewOver(rows: readonly StoredRow[], addonId = 'device-manager') {
  const counting = countingDoor(rows)
  const view = createDoorSettingsView(addonId, counting.door as unknown as ISettingsStoreProvider, {
    getSection: async () => ({}),
    setSection: () => undefined,
  })
  return { view, queries: counting.queries, requestedLimits: counting.requestedLimits }
}

/** The live shape: 967 devices, ~5.8 stored keys on the few that have any. */
function fleetRows(withOverrides: readonly number[]): readonly StoredRow[] {
  return withOverrides.flatMap((id) => [
    { id: `device-manager:${id}.retentionDays`, data: { value: 30 } },
    { id: `device-manager:${id}.mode`, data: { value: 'follow-recordings' } },
  ])
}

describe('readDeviceStoreBatch', () => {
  it('reads 967 devices in ONE query, where the per-device form took 967', async () => {
    const ids = Array.from({ length: 967 }, (_, i) => i + 1)
    const batched = viewOver(fleetRows([12, 101, 102]))
    await batched.view.readDeviceStoreBatch?.(ids)
    expect(batched.queries()).toBe(1)

    const oneAtATime = viewOver(fleetRows([12, 101, 102]))
    for (const id of ids) await oneAtATime.view.readDeviceStore(id)
    expect(oneAtATime.queries()).toBe(967)
  })

  it('answers for EVERY id asked for, so absent is never confused with unread', async () => {
    const { view } = viewOver(fleetRows([102]))
    const out = await view.readDeviceStoreBatch?.([101, 102])
    expect(out?.size).toBe(2)
    expect(out?.get(101)).toEqual({})
    expect(out?.get(102)).toEqual({ retentionDays: 30, mode: 'follow-recordings' })
  })

  it('agrees value-for-value with the per-device read it replaces', async () => {
    const rows = fleetRows([12, 102])
    const { view } = viewOver(rows)
    const batch = await view.readDeviceStoreBatch?.([12, 102, 999])
    for (const id of [12, 102, 999]) {
      expect(batch?.get(id)).toEqual(await view.readDeviceStore(id))
    }
  })

  it('never leaks another ADDON’s rows, nor another device’s', async () => {
    const rows: readonly StoredRow[] = [
      { id: 'device-manager:102.mine', data: { value: 1 } },
      { id: 'device-manager-extra:102.notMine', data: { value: 2 } },
      { id: 'recorder:102.notMine', data: { value: 3 } },
      { id: 'device-manager:6170.notMine', data: { value: 4 } },
    ]
    const { view } = viewOver(rows)
    const out = await view.readDeviceStoreBatch?.([102])
    expect(out?.get(102)).toEqual({ mine: 1 })
  })

  /**
   * The live shape on 2026-08-31: ~1 019 devices, an addon holding more than
   * two keys on enough of them to put the `<addonId>:` range past 2 000 rows.
   * One query answers 2 000 of them and the door has no way to tell that from
   * "that was all there was" — every device whose rows sort after the cap is
   * reported as having NO stored settings, which is indistinguishable from a
   * device that genuinely has none.
   */
  it('answers for every device even when the addon holds more rows than one query returns', async () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => i + 1)
    const { view } = viewOver(fleetRows(ids))
    expect(fleetRows(ids).length).toBeGreaterThan(SETTINGS_QUERY_DEFAULT_ROW_CAP)

    const out = await view.readDeviceStoreBatch?.(ids)

    const empty = ids.filter((id) => Object.keys(out?.get(id) ?? {}).length === 0)
    expect(empty).toEqual([])
    expect(out?.get(ids[ids.length - 1] ?? 0)).toEqual({
      retentionDays: 30,
      mode: 'follow-recordings',
    })
  })

  /** …and it pages to do it: the round trips scale with ROWS/page, never with
   *  devices. The per-device form is what this batch exists to replace. */
  it('pages the prefix range instead of taking one round trip per device', async () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => i + 1)
    const { view, queries } = viewOver(fleetRows(ids))
    await view.readDeviceStoreBatch?.(ids)
    expect(queries()).toBeGreaterThan(1)
    expect(queries()).toBeLessThanOrEqual(5)
  })

  /**
   * The defect's own log signature: `requestedLimit: null`.
   *
   * A read that names no `limit` inherits whatever the engine's defensive cap
   * happens to be — so "the page was short, therefore that was everything" is
   * a conclusion about a number the caller never chose. Asking explicitly is
   * what makes the stop condition mean anything.
   */
  it('never issues a query without saying how many rows it wants', async () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => i + 1)
    const { view, requestedLimits } = viewOver(fleetRows(ids))
    await view.readDeviceStoreBatch?.(ids)
    await view.readDeviceStore(102)
    await view.readAddonStore()
    expect(requestedLimits().length).toBeGreaterThan(0)
    expect(requestedLimits().filter((limit) => typeof limit !== 'number')).toEqual([])
  })

  /** The same cap, on the same code path, for the single-device and whole-addon
   *  reads that share `loadPrefixed`. */
  it('reads a whole addon store past the cap, not the first page of it', async () => {
    const rows: readonly StoredRow[] = Array.from(
      { length: SETTINGS_QUERY_DEFAULT_ROW_CAP + 137 },
      (_, i) => ({ id: `device-manager.key${String(i).padStart(6, '0')}`, data: { value: i } }),
    )
    const { view } = viewOver(rows)
    const store = await view.readAddonStore()
    expect(Object.keys(store).length).toBe(rows.length)
  })

  it('an empty request costs no query at all', async () => {
    const { view, queries } = viewOver(fleetRows([102]))
    const out = await view.readDeviceStoreBatch?.([])
    expect(out?.size).toBe(0)
    expect(queries()).toBe(0)
  })
})
