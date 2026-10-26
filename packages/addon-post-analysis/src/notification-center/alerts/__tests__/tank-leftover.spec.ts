/**
 * Leftover `tank:<deviceId>:<key>` rows are not batteries (D934, D393).
 *
 * The evening summary listed a dishwasher twice as "reports a low battery"
 * because `openAlertOf` treated every non-consumable subject as a battery and
 * invented `{ percentage: 0, binary: true }` for a row with no reading.
 * Device 3615 at 0% is a real battery and must stay listed.
 */
import type { IScopedLogger } from '@camstack/types'
import { NcRuleInputSchema, type NcRuleInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../../pipeline-analytics/__tests__/test-helpers.js'
import { makeNcRecords, ncTable } from '../../__tests__/support/nc-test-deps.js'
import type { NcDeviceIdentity } from '../../device-directory.js'
import { legacyConsumableSubject } from '../consumable-subject.js'
import { parseConsumableSliceItem } from '../consumable-routing.js'
import type { NcAlertRow } from '../alert-episode.js'
import { type NcDeviceAlertSettings, NcDeviceAlerts } from '../device-alerts.js'
import { NcAlertStore } from '../alert-store.js'
import { NcTextCatalog } from '../../text-catalog.js'
import { stateSources, type NcStateSourcePorts } from '../../state-summary/state-sources.js'
import { collectStateSummary, stateSummaryText } from '../../state-summary/state-summary.js'

const DISHWASHER = 4970
const THERMOMETER = 3615
const BINARY = 3560
const NOW = Date.UTC(2026, 9, 26, 18, 0)

const DEVICES: Readonly<Record<number, NcDeviceIdentity>> = {
  [DISHWASHER]: {
    deviceId: DISHWASHER,
    type: 'dishwasher',
    name: 'Dishwasher SMI4ECS24E',
    isCamera: false,
  },
  [THERMOMETER]: {
    deviceId: THERMOMETER,
    type: 'sensor',
    name: 'Termometro sala server',
    isCamera: false,
  },
  [BINARY]: {
    deviceId: BINARY,
    type: 'sensor',
    name: 'Termostato',
    isCamera: false,
  },
}

interface WarnLine {
  readonly message: string
  readonly deviceId: number | undefined
  readonly subject: string | undefined
}

interface Harness {
  readonly alerts: NcDeviceAlerts
  readonly rows: Map<string, NcAlertRow>
  readonly warns: WarnLine[]
  now: number
}

function capturingLogger(warns: WarnLine[]): IScopedLogger {
  const base = makeSilentLogger()
  return {
    ...base,
    warn: (message, extras) => {
      const subject = extras?.meta?.['subject']
      warns.push({
        message,
        deviceId: extras?.tags?.deviceId,
        subject: typeof subject === 'string' ? subject : undefined,
      })
    },
    child: () => capturingLogger(warns),
    withTags: () => capturingLogger(warns),
  }
}

function row(subject: string): NcAlertRow {
  return {
    subject,
    alerting: true,
    since: NOW - 86_400_000,
    lastNotifiedAt: NOW - 86_400_000,
    reminders: 0,
  }
}

function harness(): Harness {
  const rows = new Map<string, NcAlertRow>()
  const warns: WarnLine[] = []
  const h: Harness = {
    now: NOW,
    rows,
    warns,
    alerts: new NcDeviceAlerts({
      emit: async () => true,
      settings: (): NcDeviceAlertSettings => ({
        batteryLowPercent: 20,
        renotifyMinutes: 0,
        notifyRecovery: true,
      }),
      consumableThresholds: () => [15],
      lookup: (id) => DEVICES[id],
      rulesVersion: () => 'v1',
      rows: {
        get: (subject) => rows.get(subject),
        put: (next) => {
          rows.set(next.subject, next)
        },
        all: () => [...rows.values()],
        remove: async (subject) => {
          rows.delete(subject)
        },
      },
      now: () => h.now,
      logger: capturingLogger(warns),
    }),
  }
  return h
}

function summaryText(alerts: ReturnType<NcDeviceAlerts['openEpisodes']>): string {
  const open = alerts ?? []
  const sources: NcStateSourcePorts = {
    alerts: () => open,
    liveness: () => [],
    state: () => [],
    lookup: (id) => DEVICES[id],
    devicesAnswered: () => true,
    nodes: { complete: true, online: () => true },
    livenessHoldoffMs: 0,
  }
  const rule: NcRuleInput = NcRuleInputSchema.parse({
    name: 'Riepilogo serale',
    delivery: 'system-event',
    conditions: { systemEvent: { kinds: ['device-battery-low'] } },
    targets: [{ targetId: 't' }],
  })
  const summary = collectStateSummary({
    rule,
    sources: stateSources(sources),
    nowMs: NOW,
    isMuted: () => false,
  })
  return stateSummaryText({
    texts: new NcTextCatalog({ language: 'en' }),
    summary,
    nowMs: NOW,
    timeZone: 'UTC',
  }).text
}

describe('leftover tank rows are not batteries', () => {
  it('a summary with tank rows lists no battery entry for them, and a real 0% battery still lists', () => {
    const h = harness()
    h.rows.set(`tank:${DISHWASHER}:salt`, row(`tank:${DISHWASHER}:salt`))
    h.rows.set(`tank:${DISHWASHER}:rinseAid`, row(`tank:${DISHWASHER}:rinseAid`))
    h.alerts.observeBattery(THERMOMETER, { percentage: 0, lastUpdated: NOW })
    const open = h.alerts.openEpisodes()
    const batteries = (open ?? []).filter((item) => item.family === 'battery')
    expect(batteries.map((item) => item.subject.deviceId)).toEqual([THERMOMETER])
    expect(batteries[0]?.subject.bodyKey).toBe('system.device-battery-low.body')
    expect(batteries[0]?.subject.textParams?.['percentage']).toBe('0')
    const text = summaryText(open)
    expect(text).toContain('Termometro sala server is down to 0% battery')
    expect(text).not.toContain('Dishwasher')
    expect(h.warns.map((line) => line.subject).toSorted()).toEqual([
      `tank:${DISHWASHER}:rinseAid`,
      `tank:${DISHWASHER}:salt`,
    ])
    expect(h.warns.every((line) => line.deviceId === DISHWASHER)).toBe(true)
  })

  it('the binary sentence is used only for a real binary battery', () => {
    const h = harness()
    h.rows.set(`tank:${DISHWASHER}:salt`, row(`tank:${DISHWASHER}:salt`))
    h.rows.set(`battery:${THERMOMETER}`, row(`battery:${THERMOMETER}`))
    h.alerts.observeBattery(BINARY, { percentage: 15, lastUpdated: NOW, binary: true })
    const open = h.alerts.openEpisodes() ?? []
    const binary = open.filter((item) => item.subject.bodyKey?.endsWith('.binary'))
    expect(binary.map((item) => item.subject.deviceId)).toEqual([BINARY])
    const unmeasured = open.find((item) => item.subject.deviceId === THERMOMETER)
    expect(unmeasured?.subject.bodyKey).toBe('system.device-battery-low.body.unmeasured')
    expect(unmeasured?.subject.textParams?.['percentage']).toBeUndefined()
    expect(summaryText(open)).not.toContain('Dishwasher')
  })

  it('seeing the consumable key closes the matching tank row and leaves a battery row', async () => {
    const h = harness()
    h.rows.set(`tank:${DISHWASHER}:salt`, row(`tank:${DISHWASHER}:salt`))
    h.rows.set(`tank:${DISHWASHER}:rinseAid`, row(`tank:${DISHWASHER}:rinseAid`))
    h.rows.set(`battery:${THERMOMETER}`, row(`battery:${THERMOMETER}`))
    h.alerts.observeConsumableItem(
      DISHWASHER,
      parseConsumableSliceItem({
        key: 'salt',
        label: 'Salt',
        level: null,
        status: 'ok',
        kind: 'supply',
        form: 'product',
      }),
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(h.rows.has(`tank:${DISHWASHER}:salt`)).toBe(false)
    expect(h.rows.get(`tank:${DISHWASHER}:rinseAid`)?.alerting).toBe(true)
    expect(h.rows.get(`battery:${THERMOMETER}`)?.alerting).toBe(true)
  })
})

describe('boot sweep closes open tank leftovers', () => {
  const tank = `tank:${DISHWASHER}:salt`
  const battery = `battery:${THERMOMETER}`
  const consumable = legacyConsumableSubject(DISHWASHER, 'salt')

  async function loaded(subjects: readonly string[]): Promise<NcAlertStore> {
    const world = makeNcRecords()
    const writer = new NcAlertStore({ records: world.records, logger: makeSilentLogger() })
    await writer.load()
    for (const subject of subjects) writer.port().put(row(subject))
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(ncTable(world, 'device-alerts')?.has(subjects[0] ?? '')).toBe(true)
    const reader = new NcAlertStore({ records: world.records, logger: makeSilentLogger() })
    await reader.load()
    return reader
  }

  it('closes an open tank row whose consumable key is already known, and keeps a real battery', async () => {
    const store = await loaded([tank, consumable, battery])
    const once = await store.sweepOpenTankLeftovers({ liveOwner: () => true })
    expect(once).toEqual({ closed: 1, kept: 0 })
    expect(store.port().get(tank)).toBeUndefined()
    expect(store.port().get(battery)?.alerting).toBe(true)
    expect(store.port().get(consumable)?.alerting).toBe(true)
    const again = await store.sweepOpenTankLeftovers({ liveOwner: () => true })
    expect(again).toEqual({ closed: 0, kept: 0 })
  })

  it('closes an open tank row with no live owner, and keeps one whose owner is live but whose key is unknown', async () => {
    const gone = await loaded([tank, battery])
    const closed = await gone.sweepOpenTankLeftovers({ liveOwner: () => false })
    expect(closed.closed).toBe(1)
    expect(gone.port().get(battery)?.subject).toBe(battery)

    const live = await loaded([tank, battery])
    const kept = await live.sweepOpenTankLeftovers({ liveOwner: () => true })
    expect(kept).toEqual({ closed: 0, kept: 1 })
    expect(live.port().get(tank)?.alerting).toBe(true)
    expect(live.port().get(battery)?.alerting).toBe(true)

    const unknown = await loaded([tank])
    const held = await unknown.sweepOpenTankLeftovers({ liveOwner: () => undefined })
    expect(held).toEqual({ closed: 0, kept: 1 })
    expect(unknown.port().get(tank)?.alerting).toBe(true)
  })
})
