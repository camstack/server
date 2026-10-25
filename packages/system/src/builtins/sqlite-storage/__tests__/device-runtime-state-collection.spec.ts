/**
 * The runtime-state blob must land in the collection it is NAMED for.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * `device-runtime-state` is one of the nine CANONICAL_KV_COLLECTIONS, declared
 * at every boot, and until 2026-08-13 it had never held a single row on any
 * installation. The writer (`ConfigManager.createSettingsView
 * .writeDeviceRuntimeState`) routed the blob into `addon-device-settings`
 * instead, under a synthetic addonId `__device-state`, one row per
 * (device, cap) — `__device-state:101.device-status`.
 *
 * Two things followed, and both cost a session:
 *
 *   1. Every measurement of "does runtime state survive a restart" that probed
 *      the named table read ZERO and concluded the write path was broken. It
 *      never was: 1,268 rows across 374 devices were sitting in the other
 *      collection the whole time (live hub, 2026-08-13). A decoy table is worse
 *      than a missing one — it answers.
 *   2. `setAddonDevice` is a DELETE-by-prefix plus one INSERT PER CAP SLICE in
 *      one transaction. A camera with eight slices therefore paid nine
 *      statements per flush, once a second, to persist a 1.3 KB blob that the
 *      design believed cost a single upsert.
 *
 * One row per device, one statement per flush, in the named collection. The
 * legacy prefix read fallback was deleted with D870.
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

describe('device-runtime-state collection', () => {
  let backend: SqliteSettingsBackend

  beforeEach(async () => {
    backend = new SqliteSettingsBackend(':memory:')
    await backend.initialize()
  })

  afterEach(async () => {
    await backend.shutdown()
  })

  const db = (): Database.Database => {
    const handle = backend.getDatabase()
    if (handle === null) throw new Error('backend not initialized')
    return handle
  }

  const countRuntimeRows = (): number => {
    const row = db().prepare('SELECT COUNT(*) AS c FROM "device-runtime-state"').get()
    if (typeof row !== 'object' || row === null || !('c' in row)) throw new Error('bad count')
    const c = (row as { c: unknown }).c
    return typeof c === 'number' ? c : 0
  }

  it('writes the whole blob as ONE row in the collection it is named for', () => {
    backend.setDeviceRuntimeState('101', {
      'device-status': { online: true, lastChangedAt: 1_786_613_647_644 },
      zones: { zones: [{ id: 'a', name: 'Drive' }] },
    })

    expect(countRuntimeRows()).toBe(1)
    // Not one row per cap — the whole cap map is one blob.
    expect(backend.getDeviceRuntimeState('101')).toEqual({
      'device-status': { online: true, lastChangedAt: 1_786_613_647_644 },
      zones: { zones: [{ id: 'a', name: 'Drive' }] },
    })
  })

  it('replaces rather than merges — a dropped cap slice does not resurrect', () => {
    backend.setDeviceRuntimeState('101', {
      battery: { percentage: 80 },
      motion: { detected: true },
    })
    backend.setDeviceRuntimeState('101', { battery: { percentage: 79 } })

    expect(countRuntimeRows()).toBe(1)
    expect(backend.getDeviceRuntimeState('101')).toEqual({ battery: { percentage: 79 } })
  })

  it('an unknown device reads as an empty blob, never null', () => {
    expect(backend.getDeviceRuntimeState('999')).toEqual({})
  })

  it('costs ONE statement per flush, not one per cap slice', () => {
    const slices: Record<string, unknown> = {}
    for (let i = 0; i < 8; i += 1) slices[`cap-${i}`] = { v: i }

    let statements = 0
    const handle = db()
    const original = handle.prepare.bind(handle)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = (sql: string): unknown => {
      if (/INSERT|DELETE|UPDATE/i.test(sql)) statements += 1
      return original(sql)
    }
    Object.defineProperty(handle, 'prepare', { value: spy, configurable: true })
    try {
      backend.setDeviceRuntimeState('621', slices)
    } finally {
      Object.defineProperty(handle, 'prepare', { value: original, configurable: true })
    }

    // One upsert. The legacy retirement DELETE is allowed on top; what is not
    // allowed is a statement per cap slice (8 caps ⇒ the old path prepared 2
    // and RAN 9).
    expect(statements).toBeLessThanOrEqual(2)
  })
})
