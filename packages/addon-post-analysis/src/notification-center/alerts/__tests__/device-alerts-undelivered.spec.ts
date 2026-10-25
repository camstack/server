/**
 * An episode RAISE that no rule delivered is not "notified".
 *
 * Live, 2026-09-25: `battery:3615` opened on 2026-09-01 and reached reminder
 * r45 without one notification ever reaching a phone — the only rule that
 * could deliver it refused it by its own `deviceTypes: ['camera']`. `apply()`
 * wrote `lastNotifiedAt = now` whatever `consumeEvent` did, so once the rule
 * was fixed the open episode would have been heard only at its next reminder
 * (≤ 12 h), and with `renotifyMinutes = 0` never.
 *
 * So the raise asks the one door whether ANY rule matched. When none did, the
 * row stays PENDING (`lastNotifiedAt: 0`) and the raise is retried on the
 * reload tick — but only when the rule set CHANGED since the last attempt, so
 * an episode nobody wants to hear about is not re-evaluated every tick forever.
 */
import { describe, expect, it } from 'vitest'
import type { NcIncomingEvent } from '../../event-intake.js'
import type { NcAlertRow } from '../alert-episode.js'
import { type NcDeviceAlertSettings, NcDeviceAlerts } from '../device-alerts.js'

const MIN = 60_000

const SETTINGS: NcDeviceAlertSettings = {
  batteryLowPercent: 20,
  renotifyMinutes: 720,
  notifyRecovery: true,
}

interface Harness {
  readonly alerts: NcDeviceAlerts
  readonly sent: NcIncomingEvent[]
  readonly rows: Map<string, NcAlertRow>
  now: number
  /** What the door answers: did any rule match? */
  heard: boolean
  rulesVersion: string
}

function harness(settings: Partial<NcDeviceAlertSettings> = {}): Harness {
  const sent: NcIncomingEvent[] = []
  const rows = new Map<string, NcAlertRow>()
  const h: Harness = {
    now: 1_000,
    sent,
    rows,
    heard: false,
    rulesVersion: 'v1',
    alerts: new NcDeviceAlerts({
      emit: async (event) => {
        sent.push(event)
        return h.heard
      },
      settings: () => ({ ...SETTINGS, ...settings }),
      lookup: () => undefined,
      rulesVersion: () => h.rulesVersion,
      consumableThresholds: () => [15],
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

/** Let the door's answer land. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('an undelivered raise stays pending', () => {
  it('no rule matched → the row is alerting and NOT notified', async () => {
    const h = harness()
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    expect(h.sent).toHaveLength(1)
    const row = h.rows.get('battery:3615')
    expect(row?.alerting).toBe(true)
    expect(row?.lastNotifiedAt).toBe(0)
  })

  it('a rule matched → the row is notified, as before', async () => {
    const h = harness()
    h.heard = true
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    expect(h.rows.get('battery:3615')?.lastNotifiedAt).toBe(1_000)
  })

  it('is retried on the tick after the RULES change — same record id — and then notified', async () => {
    const h = harness()
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    h.now += 5 * MIN
    h.rulesVersion = 'v2'
    h.heard = true
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.subject.systemEvent?.kind).toBe('device-battery-low')
    // The same episode, said for the first time: the record id is the RAISE's,
    // so a rule that had already delivered it is deduplicated by the outbox.
    expect(h.sent[1]?.subject.recordId).toBe(h.sent[0]?.subject.recordId)
    expect(h.rows.get('battery:3615')?.lastNotifiedAt).toBe(1_000 + 5 * MIN)
  })

  it('is NOT retried while the rules are unchanged — bounded, not every tick', async () => {
    const h = harness()
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    for (let tick = 0; tick < 10; tick += 1) {
      h.now += MIN
      h.alerts.tick()
      await settle()
    }
    expect(h.sent).toHaveLength(1)
  })

  it('a slice write on a pending row re-emits nothing (526 writes in 25 minutes)', async () => {
    const h = harness()
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    for (let i = 0; i < 50; i += 1) {
      h.now += 1_000
      h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: h.now })
    }
    await settle()
    expect(h.sent).toHaveLength(1)
  })

  it('retries even when reminders are OFF — the first notice is not a reminder', async () => {
    const h = harness({ renotifyMinutes: 0 })
    h.alerts.observeConsumable(4385, { key: 'sensor', label: 'Sensor', level: 13, status: null })
    await settle()
    expect(h.rows.get('consumable@15:4385:sensor')?.lastNotifiedAt).toBe(0)
    h.rulesVersion = 'v2'
    h.heard = true
    h.alerts.tick()
    await settle()
    expect(h.sent.map((e) => e.subject.systemEvent?.kind)).toEqual([
      'device-consumable-low',
      'device-consumable-low',
    ])
    expect(h.rows.get('consumable@15:4385:sensor')?.lastNotifiedAt).toBeGreaterThan(0)
  })

  it('a pending row never REMINDS — it is re-offered as the raise, same record id', async () => {
    const h = harness({ renotifyMinutes: 60 })
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    h.now += 600 * MIN
    h.alerts.tick()
    await settle()
    // One re-offer (the cadence), never an `:r<n>` reminder.
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.subject.recordId).toBe(h.sent[0]?.subject.recordId)
    expect(h.sent[1]?.subject.recordId).not.toMatch(/:r\d+$/)
  })
})

describe('forget — a deleted device leaves no alert behind', () => {
  it('drops the battery row AND every consumable row of that device, and nothing else', async () => {
    const h = harness()
    h.heard = true
    h.alerts.observeBattery(4385, { percentage: 5, lastUpdated: 5_000 })
    h.alerts.observeConsumable(4385, { key: 'sensor', label: 'Sensor', level: 13, status: null })
    h.alerts.observeConsumable(4385, { key: 'wheel', label: 'Wheel', level: 13, status: null })
    h.alerts.observeConsumable(43850, { key: 'wheel', label: 'Wheel', level: 13, status: null })
    h.alerts.observeBattery(3602, { percentage: 5, lastUpdated: 5_000 })
    await settle()
    expect(h.alerts.deviceIds().toSorted((a, b) => a - b)).toEqual([3602, 4385, 43850])
    const forgotten = await h.alerts.forget(4385)
    expect(forgotten).toBe(3)
    expect([...h.rows.keys()].toSorted()).toEqual(['battery:3602', 'consumable@15:43850:wheel'])
    // Nothing of the forgotten device is restated by a reminder either.
    h.now += 1_000 * MIN
    const before = h.sent.length
    h.alerts.tick()
    await settle()
    const restated = h.sent.slice(before).map((e) => e.subject.systemEvent?.deviceId)
    expect(restated).not.toContain(4385)
  })
})

/**
 * Review C1: a raise refused only by a rule's SCHEDULE (03:00, rule 08–22) must
 * still be delivered once the window opens — without anyone editing a rule.
 * The re-offer runs on a bounded cadence (the re-notify interval, hourly when
 * reminders are off) besides the rules-version change.
 */
describe('a pending raise blocked by a time gate is re-offered on a cadence', () => {
  it('raise outside the window, tick inside it → delivered once, no duplicates', async () => {
    const h = harness({ renotifyMinutes: 60 })
    // Outside the window: the door says no rule matched.
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    expect(h.rows.get('battery:3615')?.lastNotifiedAt).toBe(0)
    // Still outside, before the cadence: nothing.
    h.now += 30 * MIN
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(1)
    // The window opens; the cadence has elapsed; the rules are unchanged.
    h.heard = true
    h.now += 30 * MIN
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.subject.recordId).toBe(h.sent[0]?.subject.recordId)
    expect(h.rows.get('battery:3615')?.lastNotifiedAt).toBeGreaterThan(0)
    // Heard: later ticks are ordinary reminders on the interval, not re-offers.
    h.now += 10 * MIN
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(2)
  })

  it('with reminders OFF the cadence is hourly', async () => {
    const h = harness({ renotifyMinutes: 0 })
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    h.now += 59 * MIN
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(1)
    h.heard = true
    h.now += 1 * MIN
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(2)
  })
})

/** Review M4: a raise nobody heard has nothing to recover from. */
describe('a pending episode that recovers', () => {
  it('sends nothing — "back to normal" of an alert never sent is noise', async () => {
    const h = harness({ notifyRecovery: true })
    h.alerts.observeBattery(3615, { percentage: 5, lastUpdated: 5_000 })
    await settle()
    h.heard = true
    h.now += 1_000
    h.alerts.observeBattery(3615, { percentage: 90, lastUpdated: h.now })
    await settle()
    expect(h.sent.map((e) => e.subject.systemEvent?.kind)).toEqual(['device-battery-low'])
    expect(h.rows.get('battery:3615')?.alerting).toBe(false)
  })
})

/** Review M5: after a restart every pending row is offered once, when its reading arrives. */
describe('restart', () => {
  it('a pending row is re-offered once after a restart, not before its reading arrives', async () => {
    const h = harness()
    h.alerts.observeBattery(3615, { percentage: 0, lastUpdated: 5_000 })
    await settle()
    expect(h.rows.get('battery:3615')?.lastNotifiedAt).toBe(0)
    // A new process over the same durable rows, same rules.
    const sent: NcIncomingEvent[] = []
    const restarted = new NcDeviceAlerts({
      emit: async (event) => {
        sent.push(event)
        return true
      },
      settings: () => SETTINGS,
      lookup: () => undefined,
      rulesVersion: () => h.rulesVersion,
      consumableThresholds: () => [15],
      rows: {
        get: (subject) => h.rows.get(subject),
        put: (row) => {
          h.rows.set(row.subject, row)
        },
        all: () => [...h.rows.values()],
        remove: async (subject) => {
          h.rows.delete(subject)
        },
      },
      now: () => h.now,
    })
    restarted.tick()
    await settle()
    expect(sent).toHaveLength(0)
    h.now += 1_000
    restarted.observeBattery(3615, { percentage: 0, lastUpdated: h.now })
    await settle()
    // The slice alone never re-raises…
    expect(sent).toHaveLength(0)
    restarted.tick()
    await settle()
    // …the tick offers it once, and it is heard.
    expect(sent).toHaveLength(1)
    restarted.tick()
    await settle()
    expect(sent).toHaveLength(1)
  })
})
