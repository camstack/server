/**
 * The prefix range that replaced `WHERE id LIKE ? || '%'` on the two canonical
 * KV tables.
 *
 * Two things are asserted, and only one of them is the speed fix:
 *  1. the range is the SAME set of rows the LIKE matched, for real key shapes;
 *  2. it is NOT the same set where LIKE was wrong — an addon id containing `_`
 *     or differing only in case. Those rows were being deleted by mistake, and
 *     a test that only checked "same as before" would have preserved the bug.
 *
 * The query PLAN is asserted too. Without it the whole change is invisible: a
 * range that happens to scan is exactly as slow as the LIKE it replaced, and
 * nothing else in the suite would notice.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDeviceSettingsStore,
  readDeviceOrThrow,
  type DeviceSettingsStore,
} from '../../../kernel/device-settings-store.js'
import { createDataStoreDispatch } from '../../storage-orchestrator/data-store-dispatch.js'
import { prefixRange } from '../prefix-range.js'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'

describe('prefixRange', () => {
  it('bounds an ASCII prefix with its successor', () => {
    expect(prefixRange('neighbours:101.')).toEqual({
      lo: 'neighbours:101.',
      hi: 'neighbours:101/', // '.' (0x2E) → '/' (0x2F)
    })
  })

  it('refuses an empty prefix (that is the whole table, not a range)', () => {
    expect(prefixRange('')).toBeNull()
  })

  it('refuses a non-ASCII prefix rather than guessing the byte order', () => {
    expect(prefixRange('café:1.')).toBeNull()
  })

  it('refuses a prefix with no ASCII successor', () => {
    expect(prefixRange(`a${String.fromCharCode(0x7f)}`)).toBeNull()
  })
})

function storeOf(backend: SqliteSettingsBackend, addonId: string): DeviceSettingsStore {
  return createDeviceSettingsStore(
    createDataStoreDispatch(() => [backend]),
    addonId,
  )
}
const readOf = (store: DeviceSettingsStore, id: number) => readDeviceOrThrow(store, id)

const tmpDirs: string[] = []
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function openBackend(): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prefix-range-'))
  tmpDirs.push(dir)
  const b = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await b.initialize()
  return b
}

describe('scoped KV prefix access', () => {
  it('uses the INDEX rather than scanning the table', async () => {
    const backend = await openBackend()
    const db = backend.getDatabase()
    if (db === null) throw new Error('backend not open')
    const r = prefixRange('neighbours:101.')
    if (r === null) throw new Error('expected a range for an ASCII prefix')
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id, data FROM "addon-device-settings" WHERE id >= ? AND id < ?`,
      )
      .all(r.lo, r.hi)
    const detail = plan.map((p) => String((p as { detail: string }).detail)).join(' | ')
    expect(detail, `plan was: ${detail}`).toMatch(/SEARCH/)
    expect(detail).not.toMatch(/SCAN/)
  })

  it('round-trips a device blob and leaves neighbours alone', async () => {
    const backend = await openBackend()
    const store = storeOf(backend, 'neighbours')
    await store.merge(101, { motion: { phase: 'idle' }, battery: { pct: 90 } })
    await store.merge(6150, { motion: { phase: 'motion' } })
    await store.merge(61, { motion: { phase: 'stale' } })

    expect(await readOf(store, 101)).toEqual({ motion: { phase: 'idle' }, battery: { pct: 90 } })
    // '101' must not swallow '6150' - the separator is what keeps them apart,
    // and it is the range's job to respect it.
    expect(await readOf(store, 6150)).toEqual({ motion: { phase: 'motion' } })
    expect(await readOf(store, 61)).toEqual({ motion: { phase: 'stale' } })
  })

  it('merges on rewrite, and clears only its own scope', async () => {
    const backend = await openBackend()
    const store = storeOf(backend, 'scoped')
    await store.merge(101, { a: 1, b: 2 })
    await store.merge(102, { a: 9 })
    await store.merge(101, { a: 3 })
    expect(await readOf(store, 101)).toEqual({ a: 3, b: 2 })

    await store.clear(101)
    expect(await readOf(store, 101)).toEqual({})
    expect(await readOf(store, 102)).toEqual({ a: 9 })
  })

  /**
   * The bug the range fixes rather than preserves. `LIKE 'a_b:1.%'` treats `_`
   * as "any single character", so writing `a_b` clobbered `axb`. With the
   * range, `axb` survives.
   */
  it('does not treat `_` in an addon id as a LIKE wildcard', async () => {
    const backend = await openBackend()
    const axb = storeOf(backend, 'axb')
    const aUb = storeOf(backend, 'a_b')
    await axb.merge(101, { kept: true })
    await aUb.merge(101, { own: true })

    await aUb.clear(101)
    expect(await readOf(aUb, 101)).toEqual({})
    expect(await readOf(axb, 101), 'LIKE deleted this row').toEqual({ kept: true })
  })

  /** SQLite's `LIKE` is ASCII-case-insensitive; a byte range is not. */
  it('does not fold case across two different addon ids', async () => {
    const backend = await openBackend()
    const lower = storeOf(backend, 'recorder')
    const upper = storeOf(backend, 'Recorder')
    await lower.merge(101, { lower: true })
    await upper.merge(101, { upper: true })
    expect(await readOf(lower, 101)).toEqual({ lower: true })
    expect(await readOf(upper, 101)).toEqual({ upper: true })
  })

  it('keeps addon-scope settings separate the same way', async () => {
    const backend = await openBackend()
    backend.setAllAddon('recorder', { fps: 10 })
    backend.setAllAddon('recorder-x', { fps: 30 })
    expect(backend.getAllAddon('recorder')).toEqual({ fps: 10 })
    expect(backend.getAllAddon('recorder-x')).toEqual({ fps: 30 })
    backend.setAllAddon('recorder', { fps: 20 })
    expect(backend.getAllAddon('recorder')).toEqual({ fps: 20 })
    expect(backend.getAllAddon('recorder-x')).toEqual({ fps: 30 })
  })
})
