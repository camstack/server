/**
 * D647 — the scheduler: sent once per window, restart-safe, and every branch
 * that sends nothing says so.
 */
import {
  type IScopedLogger,
  NcRuleSchema,
  scheduleForSendTimes,
  type NcRule,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { NcStateSummary } from '../state-summary.js'
import { NcStateSummaryScheduler } from '../state-summary-scheduler.js'
import type { NcStateSummaryStamp, NcStateSummaryStampPort } from '../state-summary-stamps.js'

const MIN = 60_000
const AT_0800 = Date.UTC(2026, 8, 26, 8, 0)

function logger(): IScopedLogger & {
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
} {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

function stampPort(
  answered = true,
): NcStateSummaryStampPort & { readonly rows: Map<string, NcStateSummaryStamp> } {
  const rows = new Map<string, NcStateSummaryStamp>()
  return {
    rows,
    get: (id) => rows.get(id),
    put: async (row) => {
      rows.set(row.ruleId, row)
    },
    answered: () => answered,
  }
}

function summaryRule(id: string, extra: Record<string, unknown> = {}): NcRule {
  return NcRuleSchema.parse({
    id,
    name: `rule ${id}`,
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: ['device-battery-low'] } },
    systemEventDelivery: {
      mode: 'summary',
      schedule: scheduleForSendTimes([{ days: [0, 1, 2, 3, 4, 5, 6], minute: 8 * 60 }], 'UTC'),
    },
    targets: [{ targetId: 't' }],
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  })
}

const ONE_ITEM: NcStateSummary = {
  sections: [{ id: 'battery', status: 'read', items: [] }],
  itemCount: 1,
  unavailableCount: 0,
  dropped: {},
  excludedGroups: [],
}
const NOTHING: NcStateSummary = { ...ONE_ITEM, itemCount: 0 }

function scheduler(input: {
  readonly rules: readonly NcRule[]
  readonly stamps: NcStateSummaryStampPort
  readonly clock: { now: number }
  readonly summary?: NcStateSummary
  readonly deliver?: () => Promise<number>
  readonly log?: IScopedLogger
}) {
  const deliver = vi.fn(input.deliver ?? (async () => 1))
  const s = new NcStateSummaryScheduler({
    rules: () => input.rules,
    stamps: input.stamps,
    collect: async () => input.summary ?? ONE_ITEM,
    deliver,
    now: () => input.clock.now,
    logger: input.log ?? logger(),
  })
  return { s, deliver }
}

describe('NcStateSummaryScheduler', () => {
  it('sends at the window end, once — later ticks and a RESTART do not send it again', async () => {
    const stamps = stampPort()
    const clock = { now: AT_0800 - 3 * 60 * MIN }
    const rules = [summaryRule('r1')]
    const first = scheduler({ rules, stamps, clock })
    await first.s.tick() // arms the rule at 05:00
    expect(first.deliver).not.toHaveBeenCalled()
    clock.now = AT_0800 + 20_000
    expect((await first.s.tick()).sent).toBe(1)
    await first.s.tick()
    expect(first.deliver).toHaveBeenCalledTimes(1)
    expect(stamps.rows.get('r1')?.lastWindowEnd).toBe(AT_0800)
    // A new process over the same durable stamps.
    const restarted = scheduler({ rules, stamps, clock })
    clock.now = AT_0800 + 10 * MIN
    await restarted.s.tick()
    expect(restarted.deliver).not.toHaveBeenCalled()
  })

  it('a restart that crossed a close sends that window LATE, and logs it', async () => {
    const stamps = stampPort()
    const armed = await armedStamp()
    stamps.rows.set('r1', {
      ...armed,
      ruleId: 'r1',
      armedAt: AT_0800 - 24 * 60 * MIN,
      lastWindowEnd: AT_0800 - 24 * 60 * MIN,
    })
    const log = logger()
    const clock = { now: AT_0800 + 60 * MIN }
    const { s, deliver } = scheduler({ rules: [summaryRule('r1')], stamps, clock, log })
    await s.tick()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      'state summary enqueued',
      expect.objectContaining({
        meta: expect.objectContaining({ late: true, windowEnd: AT_0800 }),
      }),
    )
  })

  it('a window closed too long ago is MISSED: not sent, stamped, and a WARN says so', async () => {
    const stamps = stampPort()
    const armed = await armedStamp()
    stamps.rows.set('r1', { ...armed, ruleId: 'r1', armedAt: 0, lastWindowEnd: 0 })
    const log = logger()
    const clock = { now: AT_0800 + 5 * 60 * MIN }
    const { s, deliver } = scheduler({ rules: [summaryRule('r1')], stamps, clock, log })
    expect((await s.tick()).missed).toBe(1)
    expect(deliver).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      'state summary window MISSED — closed too long ago to send now',
      expect.anything(),
    )
    expect(stamps.rows.get('r1')?.lastWindowEnd).toBe(AT_0800)
  })

  it('nothing to report: NOT sent, logged, and the window is stamped', async () => {
    const stamps = stampPort()
    const log = logger()
    const clock = { now: AT_0800 - MIN }
    const { s, deliver } = scheduler({
      rules: [summaryRule('r1')],
      stamps,
      clock,
      log,
      summary: NOTHING,
    })
    await s.tick()
    clock.now = AT_0800 + MIN
    expect((await s.tick()).empty).toBe(1)
    expect(deliver).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      'state summary has nothing to report — not sent',
      expect.objectContaining({ meta: expect.objectContaining({ windowEnd: AT_0800 }) }),
    )
    expect(stamps.rows.get('r1')?.lastWindowEnd).toBe(AT_0800)
  })

  it('a failed enqueue is NOT stamped — the next tick retries it', async () => {
    const stamps = stampPort()
    const clock = { now: AT_0800 - MIN }
    let fail = true
    const { s, deliver } = scheduler({
      rules: [summaryRule('r1')],
      stamps,
      clock,
      deliver: async () => {
        if (fail) throw new Error('store down')
        return 1
      },
    })
    await s.tick()
    clock.now = AT_0800 + MIN
    expect((await s.tick()).failed).toBe(1)
    expect(stamps.rows.get('r1')?.lastWindowEnd).toBe(0)
    fail = false
    expect((await s.tick()).sent).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('an unread send ledger holds EVERY summary, with one warning — never a guess', async () => {
    const log = logger()
    const clock = { now: AT_0800 + MIN }
    const { s, deliver } = scheduler({
      rules: [summaryRule('r1')],
      stamps: stampPort(false),
      clock,
      log,
    })
    expect((await s.tick()).held).toBe(true)
    await s.tick()
    expect(deliver).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('an INSTANT rule is not the scheduler’s business, and a new schedule re-arms (no late send of the old one)', async () => {
    const stamps = stampPort()
    const clock = { now: AT_0800 + MIN }
    const instant = summaryRule('r2', { systemEventDelivery: { mode: 'instant' } })
    const { s, deliver } = scheduler({ rules: [instant], stamps, clock })
    await s.tick()
    expect(stamps.rows.size).toBe(0)
    expect(deliver).not.toHaveBeenCalled()
    // A rule switched to summary AFTER its 08:00 close is armed now: 08:00 is not owed.
    const late = scheduler({ rules: [summaryRule('r3')], stamps, clock })
    await late.s.tick()
    expect(late.deliver).not.toHaveBeenCalled()
    expect(stamps.rows.get('r3')?.armedAt).toBe(AT_0800 + MIN)
  })
})

async function armedStamp(): Promise<NcStateSummaryStamp> {
  const stamps = stampPort()
  const { s } = scheduler({ rules: [summaryRule('probe')], stamps, clock: { now: 0 } })
  await s.tick()
  const row = stamps.rows.get('probe')
  if (row === undefined) throw new Error('not armed')
  return row
}

describe('the next close is cached per arm or stamp (review I4)', () => {
  it('ticks before the close compute nothing; the tick after it computes once', async () => {
    const stamps = stampPort()
    const clock = { now: AT_0800 - 60 * MIN }
    const { s, deliver } = scheduler({ rules: [summaryRule('r1')], stamps, clock })
    expect((await s.tick()).decisions).toBe(1)
    for (let i = 0; i < 5; i += 1) {
      clock.now += 30_000
      expect((await s.tick()).decisions).toBe(0)
    }
    clock.now = AT_0800 + 30_000
    const report = await s.tick()
    expect(report.decisions).toBe(1)
    expect(report.sent).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('a rule armed in the MIDDLE of a window is sent at its close — not skipped (review M1)', async () => {
    const stamps = stampPort()
    const clock = { now: AT_0800 - 30 * MIN }
    const morning = summaryRule('r1', {
      systemEventDelivery: {
        mode: 'summary',
        schedule: {
          windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 420, endMinute: 480 }],
          timezone: 'UTC',
        },
      },
    })
    const { s, deliver } = scheduler({ rules: [morning], stamps, clock })
    await s.tick()
    clock.now = AT_0800 + MIN
    expect((await s.tick()).sent).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
