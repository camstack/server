/**
 * A vacuum's TANKS notify like consumables (D642).
 *
 * The operator (2026-09-26): "si certo" — clean water or detergent running
 * low, the dirty-water tank or the dust bin full. Until then a tank reported
 * `low` / `full` reached the panel and nothing else. Since D915 the tanks are
 * `supply` / `waste` items of the `consumables` slice; how that slice reaches
 * `observeTank` is `consumable-routing.spec.ts`.
 *
 * The verdict is the PROVIDER's (the tank's own float switch): no hub
 * threshold second-guesses it. Everything else is the consumable machinery —
 * one durable episode per tank, the silent healthy seed, the pending raise no
 * rule heard, the hourly cadence, the reminder.
 */
import { describe, expect, it } from 'vitest'
import type { NcIncomingEvent } from '../../event-intake.js'
import type { NcAlertRow } from '../alert-episode.js'
import { type NcDeviceAlertSettings, NcDeviceAlerts } from '../device-alerts.js'
import { legacyConsumableSubject } from '../consumable-subject.js'
import { parseConsumableSliceItem, type NcConsumableSliceItem } from '../consumable-routing.js'
import { deriveSupplyBand, NC_SUPPLY_HOLD_MS } from '../supply-band.js'

const MIN = 60_000
const VACUUM = 4385

interface Harness {
  readonly alerts: NcDeviceAlerts
  readonly sent: NcIncomingEvent[]
  readonly rows: Map<string, NcAlertRow>
  now: number
  heard: boolean
  rulesVersion: string
  /** What the rule mirror reports. A provider episode must survive a census that is not 15. */
  thresholds: readonly number[]
}

function harness(settings: Partial<NcDeviceAlertSettings> = {}): Harness {
  const sent: NcIncomingEvent[] = []
  const rows = new Map<string, NcAlertRow>()
  const h: Harness = {
    now: 1_000,
    sent,
    rows,
    heard: true,
    rulesVersion: 'v1',
    thresholds: [15],
    alerts: new NcDeviceAlerts({
      emit: async (event) => {
        sent.push(event)
        return h.heard
      },
      settings: () => ({
        batteryLowPercent: 20,
        renotifyMinutes: 720,
        notifyRecovery: true,
        ...settings,
      }),
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
    }),
  }
  return h
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/**
 * A reading that has HELD: observed, then observed again once the hold has
 * passed (review M2). What a stable float switch looks like to the ledger.
 */
function sliceItem(
  key: string,
  status: string | null,
  kind: 'supply' | 'waste' = 'supply',
  label?: string,
  form?: 'tank' | 'product' | 'bin',
): NcConsumableSliceItem {
  return parseConsumableSliceItem({
    key,
    label: label ?? key,
    level: null,
    status,
    kind,
    form,
  })
}

function observeHeld(h: Harness, item: NcConsumableSliceItem): void {
  h.alerts.observeConsumableItem(VACUUM, item)
  h.now += NC_SUPPLY_HOLD_MS
  h.alerts.observeConsumableItem(VACUUM, item)
}

function episodeSubject(key: string): string {
  return legacyConsumableSubject(VACUUM, key)
}

function kinds(h: Harness): readonly (string | undefined)[] {
  return h.sent.map((e) => e.subject.systemEvent?.kind)
}

describe('the tank band is the provider verdict', () => {
  it('low / full / ok map to their bands; an unknown status judges nothing', () => {
    expect(deriveSupplyBand({ key: 'cleanWater', level: null, status: 'low' })).toBe('low')
    expect(deriveSupplyBand({ key: 'dustBin', level: null, status: 'full' })).toBe('full')
    expect(deriveSupplyBand({ key: 'dustBin', level: 90, status: 'ok' })).toBe('normal')
    // A level alone is a measurement the hub has no threshold for.
    expect(deriveSupplyBand({ key: 'cleanWater', level: 3, status: null })).toBeNull()
  })
})

describe('a tank episode', () => {
  it('RAISES low on the clean-water tank, and FULL on the dust bin', async () => {
    const h = harness()
    observeHeld(h, sliceItem('cleanWater', 'low', 'supply', 'Clean water', 'tank'))
    observeHeld(h, sliceItem('dustBin', 'full', 'waste', 'Dust bin', 'bin'))
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low', 'device-consumable-low'])
    expect(h.sent[0]?.subject.systemEvent?.subject).toBe(episodeSubject('cleanWater'))
    expect(h.sent[0]?.subject.systemEvent?.deviceId).toBe(VACUUM)
    expect(h.sent[1]?.subject.systemEvent?.bodyKey).toBe('system.device-consumable-low.body.bin')
  })

  it('a supply with no sentence of its own (a dishwasher salt) is worded by its label (D915)', async () => {
    const h = harness()
    observeHeld(h, sliceItem('salt', 'low', 'supply', 'Salt', 'product'))
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low'])
    expect(h.sent[0]?.subject.systemEvent?.subject).toBe(episodeSubject('salt'))
    expect(h.sent[0]?.subject.systemEvent?.bodyKey).toBe(
      'system.device-consumable-low.body.product',
    )
    expect(h.sent[0]?.subject.systemEvent?.textParams?.['item']).toBe('Salt')
  })

  it('a healthy first observation seeds silently', async () => {
    const h = harness()
    observeHeld(h, sliceItem('detergent', 'ok', 'supply', undefined, 'tank'))
    await settle()
    expect(h.sent).toHaveLength(0)
    expect(h.rows.get(episodeSubject('detergent'))?.alerting).toBe(false)
  })

  it('CLEARS into normal once emptied, and a repeat says nothing', async () => {
    const h = harness()
    observeHeld(h, sliceItem('dirtyWater', 'full', 'waste', undefined, 'tank'))
    observeHeld(h, sliceItem('dirtyWater', 'full', 'waste', undefined, 'tank'))
    observeHeld(h, sliceItem('dirtyWater', 'ok', 'waste', undefined, 'tank'))
    observeHeld(h, sliceItem('dirtyWater', 'ok', 'waste', undefined, 'tank'))
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low', 'device-consumable-normal'])
  })

  it('an unknown status changes nothing — not even an open episode', async () => {
    const h = harness()
    observeHeld(h, sliceItem('cleanWater', 'low', 'supply', undefined, 'tank'))
    observeHeld(h, sliceItem('cleanWater', null, 'supply', undefined, 'tank'))
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low'])
    expect(h.rows.get(episodeSubject('cleanWater'))?.alerting).toBe(true)
  })

  it('a raise no rule heard stays PENDING and is re-offered on the cadence', async () => {
    const h = harness({ renotifyMinutes: 0 })
    h.heard = false
    observeHeld(h, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    await settle()
    expect(h.rows.get(episodeSubject('dustBin'))?.lastNotifiedAt).toBe(0)
    h.now += 30 * MIN
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(1)
    // The hour is up (reminders off → hourly): offered again, same record id.
    h.now += 31 * MIN
    h.heard = true
    h.alerts.tick()
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low', 'device-consumable-low'])
    expect(h.sent[1]?.subject.recordId).toBe(h.sent[0]?.subject.recordId)
    expect(h.rows.get(episodeSubject('dustBin'))?.lastNotifiedAt).toBeGreaterThan(0)
  })

  it('a rule change re-offers a pending tank raise on the next tick', async () => {
    const h = harness()
    h.heard = false
    observeHeld(h, sliceItem('cleanWater', 'low', 'supply', undefined, 'tank'))
    await settle()
    h.rulesVersion = 'v2'
    h.heard = true
    h.alerts.tick()
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low', 'device-consumable-low'])
  })

  it('reminds while still true, in the words of the LATEST reading', async () => {
    const h = harness({ renotifyMinutes: 60 })
    observeHeld(h, sliceItem('cleanWater', 'low', 'supply', undefined, 'tank'))
    await settle()
    h.now += 61 * MIN
    h.alerts.tick()
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low', 'device-consumable-low'])
    expect(h.sent[1]?.subject.recordId).toMatch(/:r1$/)
  })

  it('a deleted device takes its tank rows with it', async () => {
    const h = harness()
    observeHeld(h, sliceItem('cleanWater', 'low', 'supply', undefined, 'tank'))
    observeHeld(h, sliceItem('dustBin', 'ok', 'waste', undefined, 'bin'))
    await settle()
    expect(h.alerts.deviceIds()).toEqual([VACUUM])
    expect(await h.alerts.forget(VACUUM)).toBe(2)
    expect(h.rows.size).toBe(0)
  })
})

/**
 * Review M2: a float switch that flaps must not spam. A tank change counts only
 * once it has HELD for `NC_SUPPLY_HOLD_MS` — confirmed by a later slice write or
 * by the reload tick, never by a timer of its own.
 */
describe('a tank change counts only once it has held', () => {
  it('a raise is not said before the hold, and is said once it has held', async () => {
    const h = harness()
    h.alerts.observeConsumableItem(VACUUM, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    h.now += NC_SUPPLY_HOLD_MS / 2
    h.alerts.observeConsumableItem(VACUUM, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    await settle()
    expect(h.sent).toHaveLength(0)
    expect(h.rows.get(episodeSubject('dustBin'))).toBeUndefined()
    h.now += NC_SUPPLY_HOLD_MS / 2
    h.alerts.observeConsumableItem(VACUUM, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low'])
  })

  it('the reload tick confirms a held change with no further slice write', async () => {
    const h = harness()
    h.alerts.observeConsumableItem(
      VACUUM,
      sliceItem('cleanWater', 'low', 'supply', undefined, 'tank'),
    )
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(0)
    h.now += NC_SUPPLY_HOLD_MS
    h.alerts.tick()
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low'])
  })

  it('a flapping switch says nothing, however long it flaps', async () => {
    const h = harness()
    observeHeld(h, sliceItem('dirtyWater', 'ok', 'waste', undefined, 'tank'))
    for (let i = 0; i < 60; i += 1) {
      h.now += NC_SUPPLY_HOLD_MS / 3
      h.alerts.observeConsumableItem(
        VACUUM,
        sliceItem('dirtyWater', i % 2 === 0 ? 'full' : 'ok', 'waste', undefined, 'tank'),
      )
      h.alerts.tick()
    }
    await settle()
    expect(h.sent).toHaveLength(0)
    expect(h.rows.get(episodeSubject('dirtyWater'))?.alerting).toBe(false)
  })

  it('the clear is held too: a full tank that blinks ok stays open', async () => {
    const h = harness()
    observeHeld(h, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    h.now += 1_000
    h.alerts.observeConsumableItem(VACUUM, sliceItem('dustBin', 'ok', 'waste', undefined, 'bin'))
    h.now += 1_000
    h.alerts.observeConsumableItem(VACUUM, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    h.now += NC_SUPPLY_HOLD_MS
    h.alerts.tick()
    await settle()
    expect(kinds(h)).toEqual(['device-consumable-low'])
    expect(h.rows.get(episodeSubject('dustBin'))?.alerting).toBe(true)
  })

  it('a healthy first observation seeds at once — it says nothing, so there is nothing to hold', async () => {
    const h = harness()
    h.alerts.observeConsumableItem(
      VACUUM,
      sliceItem('detergent', 'ok', 'supply', undefined, 'tank'),
    )
    expect(h.rows.get(episodeSubject('detergent'))?.alerting).toBe(false)
  })

  it('a deleted device drops a change still on hold — nothing fires for it later', async () => {
    const h = harness()
    h.alerts.observeConsumableItem(VACUUM, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    await h.alerts.forget(VACUUM)
    h.now += NC_SUPPLY_HOLD_MS
    h.alerts.tick()
    await settle()
    expect(h.sent).toHaveLength(0)
  })
})

describe('the state summary words an open tank by the band it was RAISED as (D647 review M6)', () => {
  it('a full dust bin is still "full" after a restart with no reading, and a full-only rule keeps it', async () => {
    const h = harness()
    observeHeld(h, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    await settle()
    expect(h.rows.get(episodeSubject('dustBin'))?.detail).toBe('full:bin')
    // A new process over the same durable rows: no RAM reading.
    const restarted = new NcDeviceAlerts({
      emit: async () => true,
      settings: () => ({ batteryLowPercent: 20, renotifyMinutes: 0, notifyRecovery: true }),
      consumableThresholds: () => [15],
      lookup: () => undefined,
      rulesVersion: () => 'v1',
      rows: {
        get: (subject) => h.rows.get(subject),
        put: (row) => {
          h.rows.set(row.subject, row)
        },
        all: () => [...h.rows.values()],
        remove: async () => undefined,
      },
      now: () => h.now,
    })
    const [open] = restarted.openEpisodes() ?? []
    expect(open).toMatchObject({
      family: 'consumable',
      measured: true,
      subject: { kind: 'device-consumable-low', bodyKey: 'system.device-consumable-low.body.bin' },
    })
  })

  it('the band is dropped when the episode closes', async () => {
    const h = harness()
    observeHeld(h, sliceItem('dustBin', 'full', 'waste', undefined, 'bin'))
    observeHeld(h, sliceItem('dustBin', 'ok', 'waste', undefined, 'bin'))
    await settle()
    expect(h.rows.get(episodeSubject('dustBin'))?.detail).toBeUndefined()
  })
})

describe('a provider-verdict episode is not a 15 % threshold row', () => {
  function stored(subject: string, detail?: string): NcAlertRow {
    return {
      subject,
      alerting: true,
      since: 100,
      lastNotifiedAt: 100,
      reminders: 0,
      ...(detail !== undefined ? { detail } : {}),
    }
  }

  it('stays open when every consumable rule asks for a threshold other than 15', async () => {
    const h = harness()
    h.thresholds = [20]
    // Rows main already stores: the band alone, no form. The subject parses as
    // the old default (15), which this census does not ask for.
    h.rows.set(episodeSubject('rinseAid'), stored(episodeSubject('rinseAid'), 'low'))
    h.rows.set(episodeSubject('dustBin'), stored(episodeSubject('dustBin'), 'full'))
    // A pre-D642 wear row has the same subject shape and no provider detail.
    h.rows.set(episodeSubject('filter'), stored(episodeSubject('filter')))
    observeHeld(h, sliceItem('salt', 'low', 'supply', 'Salt', 'product'))
    await settle()
    const raised = h.sent.length
    h.alerts.tick()
    h.alerts.tick()
    await settle()
    expect(h.rows.get(episodeSubject('salt'))?.alerting).toBe(true)
    expect(h.rows.get(episodeSubject('rinseAid'))?.alerting).toBe(true)
    expect(h.rows.get(episodeSubject('dustBin'))?.alerting).toBe(true)
    expect(h.rows.has(episodeSubject('filter'))).toBe(false)
    // Retiring is silent, and a still-open provider episode is not raised again.
    expect(h.sent.length).toBe(raised)

    const restarted = new NcDeviceAlerts({
      emit: async () => true,
      settings: () => ({ batteryLowPercent: 20, renotifyMinutes: 0, notifyRecovery: true }),
      consumableThresholds: () => h.thresholds,
      lookup: () => undefined,
      rulesVersion: () => 'v1',
      rows: {
        get: (subject) => h.rows.get(subject),
        put: (row) => {
          h.rows.set(row.subject, row)
        },
        all: () => [...h.rows.values()],
        remove: async () => undefined,
      },
      now: () => h.now,
    })
    const open = restarted.openEpisodes() ?? []
    const body = (key: string): string | undefined =>
      open.find((episode) => episode.subject.subject === episodeSubject(key))?.subject.bodyKey
    expect(body('salt')).toBe('system.device-consumable-low.body.product')
    expect(body('dustBin')).toBe('system.device-consumable-low.body.bin')
    expect(body('rinseAid')).toBe('system.device-consumable-low.body.tank')
  })
})
