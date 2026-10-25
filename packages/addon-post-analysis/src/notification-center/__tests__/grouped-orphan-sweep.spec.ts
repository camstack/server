/**
 * D692 T17 FR2 (review L-5) — the boot sweep of orphaned group rows.
 *
 * Every `sealed:false` row found at boot is an orphan: a clean shutdown seals the live
 * windows, and a replay re-opens a window by key (its `recordOpen` overwrites the row). A
 * D143 burst row that was open at deploy, and a D692 window row whose process crashed, would
 * otherwise read "in progress" in the timeline forever. The sweep seals them
 * (`closeReason: 'orphaned-at-start'`) BEFORE the evaluation and the replay start.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { InMemoryRecords } from '@camstack/types'
import { ncTable, withNcFaults } from './support/nc-test-deps.js'
import {
  boot,
  DEVICE,
  event,
  type Harness,
  type HarnessOptions,
  makeHarness,
  restart,
  T0,
} from './grouped-harness.js'

/** A D143 burst row exactly as the pre-D692 `record()` wrote it: every real column, no window fields. */
const D143_ROW = {
  ruleId: 'legacy',
  deviceId: 104,
  openedAt: T0 - 600_000,
  lastGrowthAt: T0 - 104_000,
  memberTrackIds: ['trk-a', 'trk-b'],
  memberCount: 2,
  revision: 2,
  sealed: false,
} as const

function rowOf(world: InMemoryRecords, id: string): Record<string, unknown> | undefined {
  return ncTable(world, 'track-groups').get(id)
}

/** The stored `sealed` column, whichever way the store holds a boolean (JS boolean or 0/1). */
function isSealed(row: Record<string, unknown> | undefined): boolean {
  return row?.['sealed'] === true || row?.['sealed'] === 1
}

describe('boot sweep of orphaned group rows (D692 T17 FR2, review L-5)', () => {
  const centres: Harness[] = []
  function harness(options: HarnessOptions = {}): Harness {
    const h = makeHarness(options)
    centres.push(h)
    return h
  }
  afterEach(async () => {
    for (const h of centres.splice(0)) await h.center.stop()
  })

  it('1. a D143 row left sealed:false is sealed at start with closeReason orphaned-at-start, nothing else changed', async () => {
    const h = harness()
    h.world.seed('track-groups', {
      id: 'grp:legacy:104:trk-a@1',
      deviceId: 104,
      data: { ...D143_ROW },
    })
    await boot(h)

    const rows = await h.center.listTrackGroups({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'grp:legacy:104:trk-a@1',
      sealed: true,
      closeReason: 'orphaned-at-start',
      memberTrackIds: ['trk-a', 'trk-b'],
      memberCount: 2,
      revision: 2,
      openedAt: D143_ROW.openedAt,
    })
    expect(rows[0]?.outcome).toBeUndefined()
    expect(rows[0]?.members).toBeUndefined()
    const info = h.linesOf('group rows sealed at start')
    expect(info).toHaveLength(1)
    expect(info[0]?.level).toBe('info')
    expect(info[0]?.meta).toMatchObject({ sealed: 1, byDevice: { '104': 1 } })
  })

  it('2. a crash-orphan D692 window row is sealed the same way by the next start', async () => {
    const a = harness()
    await boot(a)
    a.setNow(T0)
    a.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 }))
    await a.settle()
    await new Promise((r) => setTimeout(r, 0))
    const key = a.center.groupedOpenWindows()[0]?.key
    expect(key).toBeDefined()
    expect(isSealed(rowOf(a.world, key ?? ''))).toBe(false) // the open row is on disk (CRASH: no stop)

    const b = harness({ world: a.world, startAt: T0 + 30_000 })
    await restart(b)

    const rows = await b.center.listTrackGroups({})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: key,
      deviceId: DEVICE,
      sealed: true,
      closeReason: 'orphaned-at-start',
      memberTrackIds: ['trk-1'],
    })
    expect(rows[0]?.outcome).toBeUndefined()
    expect(rows[0]?.members).toBeUndefined()
  })

  it('3. a window the replay re-opens reads sealed:false AFTER the sweep (recordOpen overwrites the sealed orphan)', async () => {
    const events = [
      event({ trackId: 'trk-1', timestamp: T0 }),
      event({ trackId: 'trk-2', timestamp: T0 + 1_000 }),
    ]
    const list: NonNullable<HarnessOptions['listObjectEventsSince']> = async (since) =>
      events.filter((e) => e.timestamp >= since)
    const a = harness({ listObjectEventsSince: list })
    await boot(a)
    for (const e of events) a.center.onObjectEventPersisted(e)
    await a.settle()
    for (let i = 1; i <= 15; i += 1) await a.tick(T0 + 1_000 + i * 500)
    const key = a.center.groupedOpenWindows()[0]?.key
    expect(key).toBeDefined()

    // CRASH; B boots 2 s after the window opened, so the replayed window is still inside its 20 s.
    const b = harness({ world: a.world, startAt: T0 + 2_000, listObjectEventsSince: list })
    await restart(b)
    await b.settle()
    await new Promise((r) => setTimeout(r, 0))

    expect(b.center.groupedOpenWindows().map((w) => w.key)).toEqual([key])
    const rows = await b.center.listTrackGroups({})
    const row = rows.find((r) => r.id === key)
    expect(row).toBeDefined()
    expect(row?.sealed).toBe(false)
    expect(row?.closeReason).toBeUndefined()
    expect(row?.memberTrackIds).toContain('trk-1')
  })

  it('4. a sweep that cannot read WARNs and the boot continues (never blocks start)', async () => {
    const base = makeHarness()
    const h = harness({
      world: withNcFaults(base.world, {
        read: (kind) => (kind === 'track-groups' ? 'disk gone' : null),
      }),
    })
    base.world.seed('track-groups', {
      id: 'grp:legacy:104:trk-a@1',
      deviceId: 104,
      data: { ...D143_ROW },
    })
    await boot(h)

    const warns = h.lines.filter((l) => l.level === 'warn' && l.msg === 'group row sweep failed')
    expect(warns).toHaveLength(1)
    expect(String(warns[0]?.meta['error'])).toContain('disk gone')
    expect(h.linesOf('notification center started')).toHaveLength(1)
    // The boot reached the end of start() and created its rule.
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    expect(isSealed(rowOf(base.world, 'grp:legacy:104:trk-a@1'))).toBe(false)
  })

  it('5. a row that cannot be rewritten WARNs with its count and the others are still sealed', async () => {
    const base = makeHarness()
    const world = withNcFaults(base.world, {
      write: (kind, id) =>
        kind === 'track-groups' && id === 'grp:legacy:104:bad@1' ? 'locked' : null,
    })
    const h = harness({ world })
    base.world.seed('track-groups', {
      id: 'grp:legacy:104:bad@1',
      deviceId: 104,
      data: { ...D143_ROW },
    })
    base.world.seed('track-groups', {
      id: 'grp:legacy:104:good@1',
      deviceId: 104,
      data: { ...D143_ROW, openedAt: T0 - 500_000 },
    })
    await boot(h)

    expect(isSealed(rowOf(base.world, 'grp:legacy:104:good@1'))).toBe(true)
    expect(isSealed(rowOf(base.world, 'grp:legacy:104:bad@1'))).toBe(false)
    const warn = h.lines.find((l) => l.level === 'warn' && l.msg === 'group row sweep failed')
    expect(warn?.meta).toMatchObject({ failed: 1, byDevice: { '104': 1 } })
    expect(h.linesOf('group rows sealed at start')[0]?.meta).toMatchObject({ sealed: 1 })
  })
})
