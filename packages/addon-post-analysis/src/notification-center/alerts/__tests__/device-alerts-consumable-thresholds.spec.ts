/**
 * Per-RULE consumable thresholds, in the episode ledger (D642).
 *
 * The operator (2026-09-26): the consumable-low threshold is "default 15 % ma
 * configurabile sulla rule". A rule at 25 must be told about an item at 20 %,
 * a rule at 10 must not — and when the item later falls to 8 %, the rule at 10
 * must be told THEN, which one cluster-wide episode can never do (it opened at
 * 25 and has nothing left to raise).
 *
 * So the ledger keeps one episode per (threshold, device, item) — its own
 * hysteresis, its own pending raise, its own reminder — for every threshold a
 * rule in the set asks for. The thresholds come from a MIRROR of the rule set;
 * a mirror that has not been read yet (`null`) judges nothing and changes
 * nothing (D49), and a threshold that disappears from it retires its episodes
 * only when a SECOND read agrees.
 */
import { describe, expect, it } from 'vitest'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { NC_CONSUMABLE_LOW_PERCENT_MAX } from '@camstack/types'
import { CONSUMABLE_LOW_HYSTERESIS_PCT } from '../consumable-band.js'
import type { NcConsumableItemReading, NcIncomingEvent } from '../../event-intake.js'
import type { NcAlertRow } from '../alert-episode.js'
import { type NcDeviceAlertSettings, NcDeviceAlerts } from '../device-alerts.js'

const SETTINGS: NcDeviceAlertSettings = {
  batteryLowPercent: 20,
  renotifyMinutes: 720,
  notifyRecovery: true,
}

const VACUUM = 4385

interface LogLine {
  readonly level: 'debug' | 'info' | 'warn'
  readonly message: string
  readonly tags: LogExtras['tags']
  readonly subject: unknown
}

interface Harness {
  readonly alerts: NcDeviceAlerts
  readonly sent: NcIncomingEvent[]
  readonly rows: Map<string, NcAlertRow>
  readonly lines: LogLine[]
  now: number
  heard: boolean
  rulesVersion: string
  /** The rule mirror's thresholds; `null` = the rules have not been read. */
  thresholds: readonly number[] | null
}

function recordingLogger(lines: LogLine[]): IScopedLogger {
  const at =
    (level: LogLine['level']) =>
    (message: string, context?: LogExtras): void => {
      lines.push({ level, message, tags: context?.tags, subject: context?.meta?.['subject'] })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('warn'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function harness(): Harness {
  const sent: NcIncomingEvent[] = []
  const rows = new Map<string, NcAlertRow>()
  const lines: LogLine[] = []
  const h: Harness = {
    now: 1_000,
    sent,
    rows,
    lines,
    heard: true,
    rulesVersion: 'v1',
    thresholds: [15],
    alerts: new NcDeviceAlerts({
      emit: async (event) => {
        sent.push(event)
        return h.heard
      },
      settings: () => SETTINGS,
      consumableThresholds: () => h.thresholds,
      lookup: () => undefined,
      rulesVersion: () => h.rulesVersion,
      rows: {
        get: (subject) => rows.get(subject),
        put: (row) => {
          rows.set(row.subject, row)
        },
        all: () => [...rows.values()],
        remove: async (subject) => {
          rows.delete(subject)
        },
      },
      now: () => h.now,
      logger: recordingLogger(lines),
    }),
  }
  return h
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function filterAt(level: number | null, status: 'ok' | 'replace' | null = null) {
  const item: NcConsumableItemReading = { key: 'filter', label: 'Filtro', level, status }
  return item
}

/** The (kind, judged threshold) of every emission, in order. */
function said(h: Harness): readonly string[] {
  return h.sent.map(
    (e) =>
      `${String(e.subject.systemEvent?.kind)}@${String(e.subject.systemEvent?.consumableLowPercent)}`,
  )
}

describe('each rule judges an item against ITS threshold', () => {
  it('rule 25 is told at 20 %, rule 10 is not', async () => {
    const h = harness()
    h.thresholds = [10, 25]
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    await settle()
    expect(said(h)).toEqual(['device-consumable-low@25'])
    expect(h.sent[0]?.subject.systemEvent?.subject).toBe(`consumable@25:${VACUUM}:filter`)
    expect(h.rows.get(`consumable@25:${VACUUM}:filter`)?.alerting).toBe(true)
    // The 10 episode exists and is healthy — seeded, not silent-by-absence.
    expect(h.rows.get(`consumable@10:${VACUUM}:filter`)?.alerting).toBe(false)
  })

  it('the rule at 10 is told when the item reaches ITS threshold, later', async () => {
    const h = harness()
    h.thresholds = [10, 25]
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    h.alerts.observeConsumable(VACUUM, filterAt(8))
    await settle()
    expect(said(h)).toEqual(['device-consumable-low@25', 'device-consumable-low@10'])
  })

  it('a provider "replace" is low at EVERY threshold', async () => {
    const h = harness()
    h.thresholds = [10, 25]
    h.alerts.observeConsumable(VACUUM, filterAt(60, 'replace'))
    await settle()
    expect([...said(h)].toSorted()).toEqual([
      'device-consumable-low@10',
      'device-consumable-low@25',
    ])
  })
})

describe('hysteresis is per (threshold, device, item)', () => {
  it('a level wobbling above the 25 threshold says nothing until it clears 30', async () => {
    const h = harness()
    h.thresholds = [25]
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    for (const level of [26, 24, 27, 29]) h.alerts.observeConsumable(VACUUM, filterAt(level))
    await settle()
    expect(said(h)).toEqual(['device-consumable-low@25'])
    h.alerts.observeConsumable(VACUUM, filterAt(30))
    await settle()
    expect(said(h)).toEqual(['device-consumable-low@25', 'device-consumable-normal@25'])
  })

  it('the 10 episode keeps its own band while the 25 one recovers', async () => {
    const h = harness()
    h.thresholds = [10, 25]
    h.alerts.observeConsumable(VACUUM, filterAt(8))
    h.alerts.observeConsumable(VACUUM, filterAt(12))
    await settle()
    // 12 clears neither: 25 needs 30, 10 needs 15.
    expect([...said(h)].toSorted()).toEqual([
      'device-consumable-low@10',
      'device-consumable-low@25',
    ])
    h.alerts.observeConsumable(VACUUM, filterAt(16))
    await settle()
    expect(said(h).at(-1)).toBe('device-consumable-normal@10')
    expect(h.rows.get(`consumable@25:${VACUUM}:filter`)?.alerting).toBe(true)
  })
})

describe('every allowed threshold can recover (review M1)', () => {
  it('the highest threshold the schema allows plus the hysteresis still fits in 100 %', () => {
    expect(NC_CONSUMABLE_LOW_PERCENT_MAX + CONSUMABLE_LOW_HYSTERESIS_PCT).toBeLessThanOrEqual(100)
  })

  it('a rule at the maximum is told, and hears the recovery of a replaced part', async () => {
    const h = harness()
    h.thresholds = [NC_CONSUMABLE_LOW_PERCENT_MAX]
    h.alerts.observeConsumable(VACUUM, filterAt(90))
    h.alerts.observeConsumable(VACUUM, filterAt(100))
    await settle()
    expect(said(h)).toEqual([
      `device-consumable-low@${NC_CONSUMABLE_LOW_PERCENT_MAX}`,
      `device-consumable-normal@${NC_CONSUMABLE_LOW_PERCENT_MAX}`,
    ])
  })
})

describe('the thresholds come from a mirror; a read that fails changes nothing (D49)', () => {
  it('rules not read yet: no row, no emission — the reading is kept for later', async () => {
    const h = harness()
    h.thresholds = null
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(0)
    expect(h.rows.size).toBe(0)
    // The rules arrive: the kept reading is judged on the next tick.
    h.thresholds = [25]
    h.alerts.tick()
    await settle()
    expect(said(h)).toEqual(['device-consumable-low@25'])
  })

  it('an UNKNOWN census on the tick retires nothing, however many ticks (review I1)', async () => {
    const h = harness()
    h.thresholds = [25]
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    await settle()
    const before = h.sent.length
    // The store went away: the mirror cannot say which thresholds exist.
    h.thresholds = null
    for (let tick = 0; tick < 5; tick += 1) h.alerts.tick()
    await settle()
    expect(h.rows.get(`consumable@25:${VACUUM}:filter`)?.alerting).toBe(true)
    expect(h.rows.has(`consumable@15:${VACUUM}:filter`)).toBe(false)
    expect(h.sent.length).toBe(before)
    // …and when it answers again with the same rules, nothing is re-raised.
    h.thresholds = [25]
    h.alerts.tick()
    h.alerts.tick()
    await settle()
    expect(h.sent.length).toBe(before)
  })

  it('a threshold a rule GAINS is judged on the next tick, from the last reading', async () => {
    const h = harness()
    h.thresholds = [15]
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    await settle()
    expect(h.sent).toHaveLength(0)
    h.thresholds = [15, 25]
    h.alerts.tick()
    await settle()
    expect(said(h)).toEqual(['device-consumable-low@25'])
    // …and only once: the next tick finds the row.
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(1)
  })

  it('a threshold that vanishes from ONE read keeps its episode', async () => {
    const h = harness()
    h.thresholds = [25]
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    await settle()
    h.thresholds = [15]
    h.alerts.tick()
    h.thresholds = [25]
    h.alerts.tick()
    h.thresholds = [15]
    h.alerts.tick()
    await settle()
    expect(h.rows.get(`consumable@25:${VACUUM}:filter`)?.alerting).toBe(true)
  })

  it('a threshold absent from TWO consecutive reads retires its episodes, silently', async () => {
    const h = harness()
    h.thresholds = [25]
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    await settle()
    const before = h.sent.length
    h.thresholds = [15]
    h.alerts.tick()
    h.alerts.tick()
    await settle()
    expect(h.rows.has(`consumable@25:${VACUUM}:filter`)).toBe(false)
    // Retiring is not a recovery: nobody is told the filter got better.
    expect(h.sent.slice(before).map((e) => e.subject.systemEvent?.kind)).not.toContain(
      'device-consumable-normal',
    )
    const retired = h.lines.find((l) => l.message.includes('retired'))
    expect(retired?.tags).toEqual({ deviceId: VACUUM })
  })
})

describe('a pre-D642 row is carried over, not re-announced', () => {
  it('an open cluster-wide episode becomes the default-threshold episode', async () => {
    const h = harness()
    h.rows.set(`consumable:${VACUUM}:sensor`, {
      subject: `consumable:${VACUUM}:sensor`,
      alerting: true,
      since: 500,
      lastNotifiedAt: 600,
      reminders: 2,
    })
    h.thresholds = [15]
    h.alerts.observeConsumable(VACUUM, { key: 'sensor', label: 'Sensor', level: 4, status: null })
    await settle()
    expect(h.sent).toHaveLength(0)
    expect(h.rows.has(`consumable:${VACUUM}:sensor`)).toBe(false)
    expect(h.rows.get(`consumable@15:${VACUUM}:sensor`)).toMatchObject({
      alerting: true,
      since: 500,
      lastNotifiedAt: 600,
      reminders: 2,
    })
  })
})

describe('every consumable log line carries the device id', () => {
  it('the repeat, the pending raise and the retirement are all tagged', async () => {
    const h = harness()
    h.heard = false
    h.thresholds = [25]
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    h.alerts.observeConsumable(VACUUM, filterAt(20))
    await settle()
    const consumableLines = h.lines.filter(
      (l) => typeof l.subject === 'string' && l.subject.startsWith('consumable'),
    )
    expect(consumableLines.length).toBeGreaterThanOrEqual(2)
    for (const line of consumableLines)
      expect(line.tags, line.message).toEqual({ deviceId: VACUUM })
  })
})
