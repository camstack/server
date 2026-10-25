/**
 * D692 Task 9b — the window RECORD (spec §5: written at open, sealed at close) and the
 * bounded shutdown close (spec §3.5). Spec §11 center tests 10 and 11, plus the pieces
 * that make them hold: the SEAL chained behind the OPEN (fresh review L-7), the record
 * shape the `nc.listTrackGroups` action serves, and the 2 s bound with its D391 WARN
 * (review T8 L-4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NC_GROUPED_SHUTDOWN_CLOSE_MS } from '../grouped/grouped-delivery.js'
import type { NcGroupedWindow } from '../grouped/grouped-window-buffer.js'
import {
  NC_GROUP_MAX_ROWS_PER_DEVICE,
  type NcGroupRecord,
  NcGroupStore,
} from '../grouped/nc-group-store.js'
import { NcTrackGroupSchema } from '../nc-actions.js'
import {
  makeNcRecords,
  type NcRecordsQuery,
  ncTable,
  withNcFaults,
} from './support/nc-test-deps.js'
import {
  boot,
  CALLER,
  DEVICE,
  event,
  type Harness,
  makeHarness,
  makeLogRecorder,
  outboxIds,
  payloads,
  rule,
  T0,
} from './grouped-harness.js'

/** One column of a store write's `value` (typed `unknown` by the store contract). */
function field(value: unknown, name: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return Object.fromEntries(Object.entries(value))[name]
}

function seen(h: Harness, trackId: string, at = T0): void {
  h.setNow(at)
  h.center.onObjectEventPersisted(event({ trackId, timestamp: at }))
}

describe('grouped window record and shutdown (D692 Task 9b)', () => {
  let h: Harness
  afterEach(async () => {
    vi.useRealTimers()
    await h.center.stop()
  })

  it('10. stop() with an open window enqueues it with closeReason shutdown', async () => {
    h = makeHarness()
    await boot(h)
    seen(h, 'trk-1')
    await h.settle()
    expect(outboxIds(h.world)).toHaveLength(0)

    await h.center.stop()

    const rows = payloads(h.world)
    expect(rows).toHaveLength(1)
    const group = rows[0]?.group
    expect(group !== undefined && 'version' in group ? group.closeReason : undefined).toBe(
      'shutdown',
    )
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
  })

  it('10b. a stop with nothing stuck leaves no timer behind (the bound is cleared)', async () => {
    h = makeHarness()
    await boot(h)
    seen(h, 'trk-1')
    await h.settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await h.center.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(outboxIds(h.world)).toHaveLength(1)
  })

  it('10c. a close that cannot finish does not stall the stop, and the WARN names the windows', async () => {
    const never = new Promise<void>(() => {})
    let stuck = false
    h = makeHarness({
      world: withNcFaults(makeNcRecords(), {
        aroundWrite: async (kind) => {
          if (stuck && kind === 'outbox') await never
        },
      }),
    })
    await boot(h)
    seen(h, 'trk-1')
    seen(h, 'trk-2', T0 + 1_000)
    await h.settle()
    const openKeys = h.center.groupedOpenWindows().map((w) => w.key)
    expect(openKeys).toHaveLength(1)

    stuck = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const stopping = h.center.stop()
    await vi.advanceTimersByTimeAsync(NC_GROUPED_SHUTDOWN_CLOSE_MS)
    await stopping

    const warns = h.linesOf(
      'grouped windows not closed within the shutdown bound — the restart replay recovers them',
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]?.level).toBe('warn')
    expect(warns[0]?.meta['windows']).toEqual([{ windowKey: openKeys[0], deviceId: DEVICE }])
    expect(warns[0]?.meta['boundMs']).toBe(NC_GROUPED_SHUTDOWN_CLOSE_MS)
    expect(outboxIds(h.world)).toHaveLength(0)
  })

  it('11. the record: written at open (sealed:false, no outcome), sealed at close with fates', async () => {
    h = makeHarness()
    const ruleId = await boot(h, rule({ groupingSec: 30 }))
    seen(h, 'trk-1')
    h.outlooks.set('trk-2', { final: false, awaiting: 'face' })
    seen(h, 'trk-2', T0 + 2_000)
    await h.settle()

    const open = await h.center.listTrackGroups({ ruleId })
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ deviceId: DEVICE, openedAt: T0, revision: 1, sealed: false })
    expect(open[0]?.outcome).toBeUndefined()
    expect(open[0]?.closeReason).toBeUndefined()
    expect(open[0]?.members).toBeUndefined()
    // The RAW stored row, not the read-back: the reader defaults `revision` to 1, so only the
    // stored value proves the NOT NULL column is really written (L-3). The open row is written
    // at the window's first member; the seal rewrites it whole.
    const rawOpen = [...ncTable(h.world, 'track-groups').values()]
    expect(rawOpen).toHaveLength(1)
    expect(rawOpen[0]).toMatchObject({ revision: 1, lastGrowthAt: T0, memberCount: 1 })

    h.outlooks.set('trk-1', { final: true })
    h.outlooks.set('trk-2', { final: true })
    await h.tick(T0 + 5_000)
    await h.tick(T0 + 5_500)

    const sealed = await h.center.listTrackGroups({ ruleId })
    expect(sealed).toHaveLength(1)
    expect(sealed[0]).toMatchObject({
      sealed: true,
      outcome: 'sent',
      closeReason: 'all-final',
      closedAt: T0 + 5_000,
      waitedMs: 5_000,
      memberTrackIds: ['trk-1', 'trk-2'],
      memberCount: 2,
    })
    expect(sealed[0]?.members).toEqual([
      { trackId: 'trk-1', className: 'person', fate: 'sent' },
      { trackId: 'trk-2', className: 'person', fate: 'sent' },
    ])
    expect(ncTable(h.world, 'track-groups').size).toBe(1)
    const rawSealed = [...ncTable(h.world, 'track-groups').values()]
    expect(rawSealed[0]).toMatchObject({ revision: 1, memberCount: 2, sealed: true })
    expect(typeof rawSealed[0]?.['lastGrowthAt']).toBe('number')
  })

  it('11b. a window that said nothing is sealed dropped, with the reason per member', async () => {
    h = makeHarness()
    const ruleId = await boot(
      h,
      rule({ conditions: { classes: ['person'], identities: ['id-a'] } }),
    )
    seen(h, 'trk-1')
    await h.settle()
    await h.tick(T0 + 20_000)
    await h.tick(T0 + 20_500)

    expect(outboxIds(h.world)).toHaveLength(0)
    const [row] = await h.center.listTrackGroups({ ruleId })
    expect(row).toMatchObject({
      sealed: true,
      outcome: 'dropped',
      closeReason: 'deadline',
      waitedMs: 20_000,
    })
    expect(row?.members).toEqual([
      { trackId: 'trk-1', className: 'person', fate: 'recognition-not-final' },
    ])
  })

  it('11c. a window dropped by the mute is sealed dropped with the members marked muted', async () => {
    h = makeHarness()
    const ruleId = await boot(h)
    h.outlooks.set('trk-1', { final: true })
    seen(h, 'trk-1')
    await h.settle()
    await h.center.buildProvider().setDeviceMuted({ deviceId: DEVICE, muted: true })
    await h.tick(T0 + 5_000)
    await h.tick(T0 + 5_500)

    expect(outboxIds(h.world)).toHaveLength(0)
    const [row] = await h.center.listTrackGroups({ ruleId })
    expect(row).toMatchObject({ sealed: true, outcome: 'dropped' })
    expect(row?.members).toEqual([{ trackId: 'trk-1', className: 'person', fate: 'muted' }])
  })
})

describe('grouped window record and shutdown — review T9b round 1', () => {
  let h: Harness
  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await h.center.stop()
  })

  async function sealedRow(ruleId: string): Promise<NcGroupRecord | undefined> {
    const [row] = await h.center.listTrackGroups({ ruleId })
    return row
  }

  it('M-1: a close pass that THROWS still seals the record — dropped, every member close-failed', async () => {
    // The user fan-out read fails at close: the pass throws before anything is enqueued.
    h = makeHarness({
      listUsers: async () => {
        throw new Error('users unavailable')
      },
      getDeviceRoute: async () => ({ stableId: 'cam', addonId: 'provider' }),
    })
    const ruleId = await boot(h, rule({ targetUsers: ['someone'] }))
    seen(h, 'trk-1')
    seen(h, 'trk-2', T0 + 1_000)
    await h.settle()
    await h.tick(T0 + 20_000)
    await h.tick(T0 + 20_500)

    expect(outboxIds(h.world)).toHaveLength(0)
    expect(h.linesOf('grouped window close failed — window lost')).toHaveLength(1)
    const row = await sealedRow(ruleId)
    expect(row).toMatchObject({ sealed: true, outcome: 'dropped', closeReason: 'deadline' })
    expect(row?.members).toEqual([
      { trackId: 'trk-1', className: 'person', fate: 'close-failed' },
      { trackId: 'trk-2', className: 'person', fate: 'close-failed' },
    ])
  })

  const silencedCases: readonly {
    readonly name: string
    readonly fate: string
    readonly input?: Parameters<typeof rule>[0]
    readonly act?: (ruleId: string) => Promise<void>
  }[] = [
    {
      name: 'the rule was deleted mid-window',
      fate: 'rule-removed',
      act: async (ruleId) => {
        await h.center.buildProvider().deleteRule({ ruleId })
      },
    },
    {
      name: 'the rule was disabled mid-window',
      fate: 'rule-disabled',
      act: async (ruleId) => {
        await h.center.buildProvider().setRuleEnabled({ ruleId, enabled: false })
      },
    },
    {
      name: 'every target is snoozed at close',
      fate: 'snoozed',
      act: async () => {
        await h.center.createSnooze(
          { scope: 'all', durationMinutes: 60, global: true, summary: false },
          CALLER,
        )
      },
    },
    {
      name: 'no target resolves',
      fate: 'no-target',
      input: { targets: [], targetUsers: ['someone'] },
    },
  ]
  for (const c of silencedCases) {
    it(`M-1: ${c.name} → sealed dropped, every member '${c.fate}'`, async () => {
      h = makeHarness()
      const ruleId = await boot(h, rule(c.input ?? {}))
      h.outlooks.set('trk-1', { final: true })
      seen(h, 'trk-1')
      await h.settle()
      await c.act?.(ruleId)
      await h.tick(T0 + 20_000)
      await h.tick(T0 + 20_500)

      expect(outboxIds(h.world)).toHaveLength(0)
      const row = await sealedRow(ruleId)
      expect(row).toMatchObject({ sealed: true, outcome: 'dropped' })
      expect(row?.members).toEqual([{ trackId: 'trk-1', className: 'person', fate: c.fate }])
    })
  }

  it('M-2: stop() returns only once the shutdown SEAL has landed (inside the same bound)', async () => {
    let slowSeal = false
    h = makeHarness({
      world: withNcFaults(makeNcRecords(), {
        aroundWrite: async (kind, _id, data) => {
          // The seal is a slow write: it lands well after the close pass returned.
          if (slowSeal && kind === 'track-groups' && field(data, 'sealed') === true) {
            await new Promise<void>((resolve) => setTimeout(resolve, 50))
          }
        },
      }),
    })
    await boot(h)
    seen(h, 'trk-1')
    await h.settle()
    const key = h.center.groupedOpenWindows()[0]?.key ?? ''
    slowSeal = true

    await h.center.stop()

    // Read at once, with no further await: the stop itself waited for the seal.
    const row = ncTable(h.world, 'track-groups').get(key)
    expect(row?.['sealed']).toBe(true)
    expect(row?.['closeReason']).toBe('shutdown')
    expect(row?.['outcome']).toBe('sent')
  })

  it('M-2: a seal that cannot land within the bound does not stall the stop, and says so', async () => {
    const never = new Promise<void>(() => {})
    let stuck = false
    h = makeHarness({
      world: withNcFaults(makeNcRecords(), {
        aroundWrite: async (kind, _id, data) => {
          if (stuck && kind === 'track-groups' && field(data, 'sealed') === true) await never
        },
      }),
    })
    await boot(h)
    seen(h, 'trk-1')
    await h.settle()
    stuck = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const stopping = h.center.stop()
    await vi.advanceTimersByTimeAsync(NC_GROUPED_SHUTDOWN_CLOSE_MS)
    await stopping

    expect(outboxIds(h.world)).toHaveLength(1)
    expect(
      h.linesOf('grouped window records not sealed within the shutdown bound — they read as open'),
    ).toHaveLength(1)
    expect(
      h.linesOf(
        'grouped windows not closed within the shutdown bound — the restart replay recovers them',
      ),
    ).toHaveLength(0)
  })

  it('L-1: an event still queued on the chain when stop() begins is closed as shutdown too', async () => {
    h = makeHarness()
    await boot(h)
    // No settle: the admission is queued on the chain, no window is open yet.
    seen(h, 'trk-1')
    expect(h.center.groupedOpenWindows()).toHaveLength(0)

    await h.center.stop()

    const rows = payloads(h.world)
    expect(rows).toHaveLength(1)
    const group = rows[0]?.group
    expect(group !== undefined && 'version' in group ? group.closeReason : undefined).toBe(
      'shutdown',
    )
  })

  it('L-1: the timeout WARN names only the windows still open or closing — never one that closed', async () => {
    const never = new Promise<void>(() => {})
    let stuck = false
    h = makeHarness({
      world: withNcFaults(makeNcRecords(), {
        aroundWrite: async (kind, _id, data) => {
          if (stuck && kind === 'outbox' && field(data, 'deviceId') === 591) await never
        },
      }),
    })
    await boot(h)
    seen(h, 'trk-1')
    h.setNow(T0 + 500)
    h.center.onObjectEventPersisted(event({ trackId: 'trk-2', deviceId: 591, timestamp: T0 + 500 }))
    await h.settle()
    const windows = h.center.groupedOpenWindows()
    expect(windows.map((w) => w.deviceId)).toEqual([DEVICE, 591])
    const stuckKey = windows[1]?.key

    stuck = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const stopping = h.center.stop()
    await vi.advanceTimersByTimeAsync(NC_GROUPED_SHUTDOWN_CLOSE_MS)
    await stopping

    const warns = h.linesOf(
      'grouped windows not closed within the shutdown bound — the restart replay recovers them',
    )
    expect(warns).toHaveLength(1)
    expect(warns[0]?.meta['windows']).toEqual([{ windowKey: stuckKey, deviceId: 591 }])
    // The camera whose window closed in time got its message.
    expect(payloads(h.world).map((p) => p.subject.deviceId)).toEqual([DEVICE])
  })
})

function ringRow(openedAt: number): Record<string, unknown> {
  return {
    ruleId: 'r1',
    openedAt,
    lastGrowthAt: openedAt,
    memberTrackIds: [],
    memberCount: 0,
    revision: 1,
    sealed: true,
  }
}

describe('NcGroupStore window record (D692 Task 9b)', () => {
  function window(key: string): NcGroupedWindow {
    return {
      key,
      ruleId: 'r1',
      deviceId: DEVICE,
      groupingSec: 20,
      openedAt: T0,
      floorAt: T0 + 5_000,
      deadlineAt: T0 + 20_000,
      replaying: false,
      origin: 'pipeline',
      flags: { bypassCooldown: false, bypassMute: false, closeImmediately: false },
      lastAdmittedAt: T0 + 3_000,
      members: [],
    }
  }

  it('L-4: the ring prune reads the ring plus ONE row (records have no offset), and keeps exactly the newest 500', async () => {
    const world = makeNcRecords()
    const queries: NcRecordsQuery[] = []
    const seen = withNcFaults(world, {
      read: (kind, query) => {
        if (kind === 'track-groups' && query !== undefined) queries.push(query)
        return null
      },
    })
    const store = new NcGroupStore({ records: seen.records, logger: makeLogRecorder().logger })
    for (let i = 0; i < 550; i += 1) {
      world.seed('track-groups', {
        id: `old-${String(i)}`,
        deviceId: DEVICE,
        data: { ...ringRow(i + 1), deviceId: DEVICE },
      })
    }
    for (let i = 0; i < 50; i += 1) {
      const w = window(`grp:r1:104:trk-${String(i)}@${String(1_000 + i)}`)
      await store.recordSealed(
        { ...w, openedAt: 1_000 + i },
        { closedAt: 2_000, outcome: 'sent', closeReason: 'deadline', members: [] },
      )
    }

    expect(ncTable(world, 'track-groups').size).toBe(NC_GROUP_MAX_ROWS_PER_DEVICE)
    const prune = queries.find((q) => q.where?.['deviceId'] === DEVICE && q.desc === true)
    // The ring and the one row past it.
    expect(prune?.limit).toBe(NC_GROUP_MAX_ROWS_PER_DEVICE + 1)
  })

  it('the SEAL waits for a slow OPEN of its own key — a close at once cannot be overwritten (L-7)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let first = true
    const slow = withNcFaults(makeNcRecords(), {
      aroundWrite: async () => {
        if (first) {
          first = false
          await gate
        }
      },
    })
    const store = new NcGroupStore({ records: slow.records, logger: makeLogRecorder().logger })

    const w = window('grp:r1:104:trk-1@100000')
    const opening = store.recordOpen(w)
    const sealing = store.recordSealed(w, {
      closedAt: T0 + 20_000,
      outcome: 'dropped',
      closeReason: 'test',
      members: [],
    })
    release()
    await Promise.all([opening, sealing])

    const [row] = await store.list({ ruleId: 'r1' })
    expect(row).toMatchObject({ sealed: true, outcome: 'dropped', closeReason: 'test' })
  })

  it('a window with no open row (the tester) is recorded by its seal alone', async () => {
    const store = new NcGroupStore({
      records: makeNcRecords().records,
      logger: makeLogRecorder().logger,
    })
    await store.recordSealed(window('grp:r1:104:trk-9@100000'), {
      closedAt: T0,
      outcome: 'sent',
      closeReason: 'test',
      members: [{ trackId: 'trk-9', className: 'person', fate: 'sent' }],
    })
    const rows = await store.list({})
    expect(rows).toHaveLength(1)
    expect(rows[0]?.closeReason).toBe('test')
  })

  it('L-6: a member fate is one of the record’s fates — a failed condition names its id, anything else is refused', () => {
    const row = (fate: string): unknown => ({
      id: 'grp:r1:104:trk-9@100000',
      ruleId: 'r1',
      deviceId: DEVICE,
      openedAt: T0,
      lastGrowthAt: T0,
      memberTrackIds: ['trk-9'],
      memberCount: 1,
      revision: 1,
      sealed: true,
      members: [{ trackId: 'trk-9', className: 'person', fate }],
    })
    expect(NcTrackGroupSchema.safeParse(row('close-failed')).success).toBe(true)
    expect(NcTrackGroupSchema.safeParse(row('failed-condition:schedule')).success).toBe(true)
    expect(NcTrackGroupSchema.safeParse(row('lost-somewhere')).success).toBe(false)
  })

  it('NcTrackGroupSchema serves the sealed shape, including closeReason test (C8)', () => {
    const parsed = NcTrackGroupSchema.parse({
      id: 'grp:r1:104:trk-9@100000',
      ruleId: 'r1',
      deviceId: DEVICE,
      openedAt: T0,
      lastGrowthAt: T0,
      memberTrackIds: ['trk-9'],
      memberCount: 1,
      revision: 1,
      sealed: true,
      closedAt: T0,
      outcome: 'sent',
      closeReason: 'test',
      members: [{ trackId: 'trk-9', className: 'person', fate: 'sent' }],
      waitedMs: 0,
    })
    expect(parsed.closeReason).toBe('test')
  })
})
