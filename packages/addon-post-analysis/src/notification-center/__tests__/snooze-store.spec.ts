/**
 * NcSnoozeStore — the durable half of a snooze.
 *
 * What these pin down, beyond CRUD:
 *  - a window ENDS by the clock, and cancelling one only moves the clock — the
 *    row survives, because the digest of what it hid is still owed;
 *  - suppression is COUNTED per (window, target, rule, camera), not stored one
 *    row per hidden notification: a snooze exists because something is noisy;
 *  - a malformed row silences NOTHING, and a failed load keeps the windows
 *    already in memory rather than un-silencing the operator by accident.
 */
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, ncTable, seedRows, withNcFaults } from './support/nc-test-deps.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { defined } from '../../__tests__/support/vitest-mock.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcSnoozeStore } from '../snooze-store.js'

const HOUR = 3_600_000

describe('NcSnoozeStore', () => {
  let world: InMemoryRecords
  let store: NcSnoozeStore
  let now: number

  beforeEach(async () => {
    world = makeNcRecords()
    now = 1_000_000
    let seq = 0
    store = new NcSnoozeStore({
      records: world.records,
      logger: makeSilentLogger(),
      now: () => now,
      newId: () => `snooze-${(seq += 1)}`,
    })
  })

  const open = async (
    overrides: Partial<Parameters<NcSnoozeStore['create']>[0]> = {},
  ): ReturnType<NcSnoozeStore['create']> =>
    store.create({
      userId: 'alice',
      scope: 'rule',
      ruleId: 'r1',
      durationMinutes: 60,
      global: false,
      summary: true,
      ...overrides,
    })

  it('create stamps the window from a DURATION, so a skewed client clock cannot author it', async () => {
    const s = await open({ durationMinutes: 30 })
    expect(s.startedAt).toBe(now)
    expect(s.expiresAt).toBe(now + 30 * 60_000)
    expect(s.digestSentAt).toBeUndefined()
  })

  it('silences on the hot path, and stops silencing when the clock passes it', async () => {
    await open()
    const q = { nowMs: now, userId: 'alice', ruleId: 'r1', deviceId: 101 }
    expect(store.activeFor(q)?.id).toBe('snooze-1')
    // Nothing ran in between — only the clock moved.
    expect(store.activeFor({ ...q, nowMs: now + 2 * HOUR })).toBeNull()
  })

  it('load hydrates a fresh instance over the same store', async () => {
    await open()
    const other = new NcSnoozeStore({ records: world.records, logger: makeSilentLogger() })
    await other.load()
    expect(other.list()).toHaveLength(1)
    expect(other.get('snooze-1')?.userId).toBe('alice')
  })

  it('load SKIPS a malformed row — a broken window must silence nothing', async () => {
    await open()
    seedRows(world, 'snoozes', [
      { id: 'junk', data: { userId: 'x', expiresAt: 9e12, snooze: { id: 'junk', scope: 'nope' } } },
    ])
    const other = new NcSnoozeStore({ records: world.records, logger: makeSilentLogger() })
    await other.load()
    expect(other.list().map((s) => s.id)).toEqual(['snooze-1'])
  })

  it('a FAILED load keeps the windows already in memory', async () => {
    await open()
    const exploding = new NcSnoozeStore({
      records: withNcFaults(world, { read: () => 'store down' }).records,
      logger: makeSilentLogger(),
      now: () => now,
    })
    // Nothing loaded yet, so this is the interesting direction: a store that
    // dropped every window on a transient error would un-silence the operator.
    await exploding.load()
    expect(exploding.list()).toEqual([])
  })

  it('cancel ends the window NOW and keeps the row — the digest is still owed', async () => {
    await open()
    const ended = await store.cancel('snooze-1')
    expect(ended?.expiresAt).toBe(now)
    expect(store.get('snooze-1')).not.toBeNull()
    expect(store.activeFor({ nowMs: now, userId: 'alice', ruleId: 'r1', deviceId: 101 })).toBeNull()
  })

  it('cancel on an already-closed window leaves its real end alone', async () => {
    const s = await open({ durationMinutes: 1 })
    now += 10 * 60_000
    const ended = await store.cancel('snooze-1')
    expect(ended?.expiresAt).toBe(s.expiresAt)
  })

  it('cancel of an unknown id is null, not a throw', async () => {
    expect(await store.cancel('nope')).toBeNull()
  })

  it('counts suppression per (window, target, rule, camera) instead of one row each', async () => {
    await open()
    const hit = {
      snoozeId: 'snooze-1',
      targetId: 't1',
      ruleId: 'r1',
      ruleName: 'gate',
      deviceId: 101,
    }
    await store.recordSuppressed({ ...hit, at: now })
    await store.recordSuppressed({ ...hit, at: now + 60_000 })
    await store.recordSuppressed({ ...hit, at: now + 120_000 })
    expect(ncTable(world, 'snooze-suppressed').size).toBe(1)
    const row = defined((await store.suppressedFor('snooze-1'))[0], 'suppressed row')
    expect(row.count).toBe(3)
    expect(row.firstAt).toBe(now)
    expect(row.lastAt).toBe(now + 120_000)
  })

  it('keeps one row per camera, so a digest can say WHERE', async () => {
    await open()
    const base = { snoozeId: 'snooze-1', targetId: 't1', ruleId: 'r1', ruleName: 'gate', at: now }
    await store.recordSuppressed({ ...base, deviceId: 101 })
    await store.recordSuppressed({ ...base, deviceId: 102 })
    const rows = await store.suppressedFor('snooze-1')
    expect(rows.map((r) => r.deviceId).toSorted()).toEqual([101, 102])
  })

  it('dueDigests names a closed window that still owes a summary — and only once', async () => {
    await open({ durationMinutes: 1 })
    expect(store.dueDigests(now)).toEqual([])
    now += 5 * 60_000
    expect(store.dueDigests(now).map((s) => s.id)).toEqual(['snooze-1'])
    await store.markDigestSent('snooze-1')
    expect(store.dueDigests(now)).toEqual([])
  })

  it('never owes a digest for a window that asked not to leave one', async () => {
    await open({ durationMinutes: 1, summary: false })
    now += 5 * 60_000
    expect(store.dueDigests(now)).toEqual([])
  })

  it('prune drops a long-closed window and its counters, and spares an open one', async () => {
    await open({ durationMinutes: 1 })
    await store.recordSuppressed({
      snoozeId: 'snooze-1',
      targetId: 't1',
      ruleId: 'r1',
      ruleName: 'gate',
      deviceId: 101,
      at: now,
    })
    await open({ durationMinutes: 600 })
    now += 12 * HOUR
    expect(await store.prune(now)).toBe(1)
    expect(store.get('snooze-1')).toBeNull()
    expect(store.get('snooze-2')).not.toBeNull()
    expect(ncTable(world, 'snooze-suppressed').size).toBe(0)
  })

  it('shows a user their own windows and the global ones that silence them, never a stranger private one', async () => {
    await open({ userId: 'alice' })
    await open({ userId: 'bob' })
    await open({ userId: 'bob', global: true })
    expect(
      store
        .listVisibleTo('alice', false)
        .map((s) => s.id)
        .toSorted(),
    ).toEqual(['snooze-1', 'snooze-3'])
    expect(store.listVisibleTo('alice', true)).toHaveLength(3)
  })
})
