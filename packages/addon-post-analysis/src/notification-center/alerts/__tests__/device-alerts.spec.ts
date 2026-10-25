/**
 * `NcDeviceAlerts` end to end — the five gates the operator named, exercised
 * through the service rather than through the reducer alone.
 *
 * A reducer test proves the arithmetic. This one proves the WIRING: that the
 * band is derived from the operator's threshold, that the ledger row is the
 * thing the recovery reads, that a reminder reaches `emit` with a different
 * record id, and that nothing at all is emitted for a device that has never
 * reported.
 */
import { describe, expect, it } from 'vitest'
import type { NcIncomingEvent } from '../../event-intake.js'
import type { NcAlertRow } from '../alert-episode.js'
import { type NcDeviceAlertSettings, NcDeviceAlerts } from '../device-alerts.js'

const MIN = 60_000

const SETTINGS: NcDeviceAlertSettings = {
  batteryLowPercent: 20,
  renotifyMinutes: 60,
  notifyRecovery: true,
}

interface Harness {
  readonly alerts: NcDeviceAlerts
  readonly sent: NcIncomingEvent[]
  readonly rows: Map<string, NcAlertRow>
  now: number
}

function harness(settings: Partial<NcDeviceAlertSettings> = {}): Harness {
  const sent: NcIncomingEvent[] = []
  const rows = new Map<string, NcAlertRow>()
  const h: Harness = {
    now: 1_000,
    sent,
    rows,
    alerts: new NcDeviceAlerts({
      emit: async (event) => {
        sent.push(event)
        return true
      },
      rulesVersion: () => 'v1',
      consumableThresholds: () => [15],
      settings: () => ({ ...SETTINGS, ...settings }),
      lookup: () => undefined,
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
    }),
  }
  return h
}

function kindsOf(sent: readonly NcIncomingEvent[]): readonly string[] {
  return sent.map((e) => e.subject.systemEvent?.kind ?? '?')
}

describe('gate 2 — a battery that has never reported produces nothing, ever', () => {
  it('emits nothing for the empty slice (lastUpdated 0, percentage 0)', () => {
    // 3255, 3279, 3609 on the live hub carry exactly this.
    const h = harness()
    h.alerts.observeBattery(3255, { percentage: 0, lastUpdated: 0 })
    expect(h.sent).toHaveLength(0)
    // And it writes NO row: a subject we know nothing about must not be seeded
    // as healthy either, or a later first real reading of 4% would look like a
    // transition from a state we invented.
    expect(h.rows.size).toBe(0)
  })

  it('starts speaking the moment the device actually reports', () => {
    const h = harness()
    h.alerts.observeBattery(3255, { percentage: 0, lastUpdated: 0 })
    h.alerts.observeBattery(3255, { percentage: 4, lastUpdated: 5_000 })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low'])
  })
})

describe('gate 3 — an oscillation around the threshold says nothing twice', () => {
  it('announces once and then holds through 20 → 21 → 20 → 22', () => {
    const h = harness()
    h.alerts.observeBattery(3602, { percentage: 20, lastUpdated: 1_000 })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low'])
    for (const percentage of [21, 20, 22, 24]) {
      h.now += 1_000
      h.alerts.observeBattery(3602, { percentage, lastUpdated: h.now })
    }
    expect(kindsOf(h.sent)).toEqual(['device-battery-low'])
  })

  it('discards a repeat of the SAME reading — 526 writes in 25 minutes', () => {
    const h = harness()
    h.alerts.observeBattery(3602, { percentage: 90, lastUpdated: 1_000 })
    for (let i = 0; i < 526; i += 1) {
      h.now += 1_000
      // Only the clock moves, which is what the census measured.
      h.alerts.observeBattery(3602, { percentage: 90, lastUpdated: h.now })
    }
    expect(h.sent).toHaveLength(0)
  })

  it('only recovers once the reading clears threshold + hysteresis', () => {
    const h = harness()
    h.alerts.observeBattery(3602, { percentage: 12, lastUpdated: 1_000 })
    h.now += 1_000
    h.alerts.observeBattery(3602, { percentage: 24, lastUpdated: h.now })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low'])
    h.now += 1_000
    h.alerts.observeBattery(3602, { percentage: 25, lastUpdated: h.now })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low', 'device-battery-normal'])
  })
})

describe('gate 4 — the recovery honours the cluster flag', () => {
  it('sends it when the flag is on', () => {
    const h = harness({ notifyRecovery: true })
    h.alerts.observeBattery(3602, { percentage: 5, lastUpdated: 1_000 })
    h.now += 1_000
    h.alerts.observeBattery(3602, { percentage: 90, lastUpdated: h.now })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low', 'device-battery-normal'])
  })

  it('suppresses it when the flag is off — and still moves the ledger', () => {
    const h = harness({ notifyRecovery: false })
    h.alerts.observeBattery(3602, { percentage: 5, lastUpdated: 1_000 })
    h.now += 1_000
    h.alerts.observeBattery(3602, { percentage: 90, lastUpdated: h.now })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low'])
    expect(h.rows.get('battery:3602')?.alerting).toBe(false)
    // The proof the row mattered: falling again is a NEW low, not a repeat.
    h.now += 1_000
    h.alerts.observeBattery(3602, { percentage: 5, lastUpdated: h.now })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low', 'device-battery-low'])
  })
})

describe('gate 5 — two consecutive reminders are two outbox rows', () => {
  it('reminds on the interval, with a different record id each time', () => {
    const h = harness({ renotifyMinutes: 60 })
    h.alerts.observeBattery(3602, { percentage: 5, lastUpdated: 1_000 })
    h.now += 60 * MIN
    h.alerts.tick()
    h.now += 60 * MIN
    h.alerts.tick()
    expect(kindsOf(h.sent)).toEqual([
      'device-battery-low',
      'device-battery-low',
      'device-battery-low',
    ])
    const ids = h.sent.map((e) => e.subject.recordId)
    expect(new Set(ids).size).toBe(3)
    expect(ids[1]).not.toBe(ids[2])
  })

  it('does not remind before the interval has elapsed', () => {
    const h = harness({ renotifyMinutes: 60 })
    h.alerts.observeBattery(3602, { percentage: 5, lastUpdated: 1_000 })
    h.now += 59 * MIN
    h.alerts.tick()
    expect(h.sent).toHaveLength(1)
  })

  it('never reminds when the operator set the interval to 0', () => {
    const h = harness({ renotifyMinutes: 0 })
    h.alerts.observeBattery(3602, { percentage: 5, lastUpdated: 1_000 })
    h.now += 400 * MIN
    h.alerts.tick()
    expect(h.sent).toHaveLength(1)
  })

  it('stops reminding once the episode is over', () => {
    const h = harness({ renotifyMinutes: 60 })
    h.alerts.observeBattery(3602, { percentage: 5, lastUpdated: 1_000 })
    h.now += 1_000
    h.alerts.observeBattery(3602, { percentage: 95, lastUpdated: h.now })
    const after = h.sent.length
    h.now += 400 * MIN
    h.alerts.tick()
    expect(h.sent).toHaveLength(after)
  })
})

describe('the threshold is the operator’s, not a hardcoded 20', () => {
  it('does not fire at 23% when the operator asked for 10%', () => {
    const h = harness({ batteryLowPercent: 10 })
    h.alerts.observeBattery(3602, { percentage: 23, lastUpdated: 1_000 })
    expect(h.sent).toHaveLength(0)
  })

  it('still fires for a BINARY low at 15 under a 10% threshold', () => {
    // The stand-in is not a measurement — the provider already decided.
    const h = harness({ batteryLowPercent: 10 })
    h.alerts.observeBattery(3560, { percentage: 15, lastUpdated: 1_000, binary: true })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low'])
  })
})

describe('the first observation', () => {
  it('seeds a HEALTHY battery silently — a boot must not announce the fleet', () => {
    const h = harness()
    h.alerts.observeBattery(3602, { percentage: 100, lastUpdated: 1_000 })
    expect(h.sent).toHaveLength(0)
    expect(h.rows.get('battery:3602')?.alerting).toBe(false)
  })

  it('announces a battery whose FIRST observation is already low', () => {
    const h = harness()
    h.alerts.observeBattery(3560, { percentage: 15, lastUpdated: 1_000, binary: true })
    expect(kindsOf(h.sent)).toEqual(['device-battery-low'])
  })
})
