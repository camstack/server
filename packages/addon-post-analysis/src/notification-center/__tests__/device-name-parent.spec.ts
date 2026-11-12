/**
 * #523 — a device notification names a CHILD device with its parent:
 * `<name> (<parent name>)`. One helper (`deviceDisplayName`, fed by the
 * directory's `parentName`) words every device sentence; a first-level device,
 * an unknown parent and a parent whose name the child already carries keep the
 * bare name — never an id.
 */
import { DeviceType, NcRuleInputSchema, type NcRuleInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  deviceDisplayLabel,
  deviceDisplayName,
  frozenDeviceLabel,
  NcDeviceDirectory,
  type NcDeviceIdentity,
} from '../device-directory.js'
import { incomingFromBatteryBand, type NcSystemEventFacts } from '../event-intake.js'
import { NcTextCatalog } from '../text-catalog.js'
import { stateSources } from '../state-summary/state-sources.js'
import { collectStateSummary, stateSummaryText } from '../state-summary/state-summary.js'

const NOW = Date.UTC(2026, 10, 12, 20, 0)
const FACTS: NcSystemEventFacts = {
  eventId: 'x',
  timestamp: NOW,
  category: 'test',
  data: {},
}

const ROWS: readonly NcDeviceIdentity[] = [
  {
    deviceId: 5684,
    type: DeviceType.Container,
    name: 'System',
    isCamera: false,
    parentDeviceId: null,
  },
  {
    deviceId: 5693,
    type: DeviceType.Sensor,
    name: 'Battery',
    isCamera: false,
    parentDeviceId: 5684,
  },
  {
    deviceId: 10,
    type: DeviceType.Sensor,
    name: 'Sensore porta',
    isCamera: false,
    parentDeviceId: null,
  },
  // The parent is not in the answer: bare name, never the id.
  {
    deviceId: 11,
    type: DeviceType.Sensor,
    name: 'Termometro',
    isCamera: false,
    parentDeviceId: 999,
  },
  // The child already carries its parent's name: not repeated.
  {
    deviceId: 4384,
    type: DeviceType.Container,
    name: 'Robot piano terra',
    isCamera: false,
    parentDeviceId: null,
  },
  {
    deviceId: 4385,
    type: 'vacuum',
    name: 'Robot piano terra',
    isCamera: false,
    parentDeviceId: 4384,
  },
]

async function warmDirectory(): Promise<NcDeviceDirectory> {
  const directory = new NcDeviceDirectory({
    logger: makeSilentLogger(),
    listDevices: async () => ROWS,
  })
  await directory.refresh()
  return directory
}

function rule(systemEvent: Record<string, unknown>): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'Stato',
    delivery: 'system-event',
    conditions: { systemEvent },
    targets: [{ targetId: 't' }],
  })
}

describe('#523 — the parent in a device name', () => {
  it('the directory names a child after its parent; a root, an unknown parent and a repeated name stay bare', async () => {
    const directory = await warmDirectory()
    expect(deviceDisplayName(directory.get(5693), 5693)).toBe('Battery (System)')
    expect(deviceDisplayName(directory.get(10), 10)).toBe('Sensore porta')
    expect(deviceDisplayName(directory.get(11), 11)).toBe('Termometro')
    expect(deviceDisplayName(directory.get(4385), 4385)).toBe('Robot piano terra')
  })

  it("a child's battery-low names the parent; a root device's does not", async () => {
    const directory = await warmDirectory()
    const child = incomingFromBatteryBand({
      facts: FACTS,
      deviceId: 5693,
      band: 'low',
      reading: { percentage: 19, lastUpdated: NOW },
      identity: directory.get(5693),
    })
    expect(child.subject.systemEvent?.textParams?.['deviceName']).toBe('Battery (System)')
    const root = incomingFromBatteryBand({
      facts: FACTS,
      deviceId: 10,
      band: 'low',
      reading: { percentage: 8, lastUpdated: NOW },
      identity: directory.get(10),
    })
    expect(root.subject.systemEvent?.textParams?.['deviceName']).toBe('Sensore porta')
  })

  it("the evening summary's battery line carries (Parent) for a child", async () => {
    const directory = await warmDirectory()
    const subject = incomingFromBatteryBand({
      facts: FACTS,
      deviceId: 5693,
      band: 'low',
      reading: { percentage: 19, lastUpdated: NOW },
      identity: directory.get(5693),
    }).subject.systemEvent
    if (subject === undefined) throw new Error('no subject')
    const summary = collectStateSummary({
      rule: rule({ kinds: ['device-battery-low'] }),
      sources: stateSources({
        alerts: () => [
          {
            family: 'battery',
            since: NOW - 3_600_000,
            subject,
            measured: true,
          },
        ],
        liveness: () => [],
        state: () => [],
        lookup: directory.lookup(),
        devicesAnswered: () => true,
        nodes: { complete: true, online: () => true },
        livenessHoldoffMs: 5 * 60_000,
      }),
      nowMs: NOW,
      isMuted: () => false,
    })
    const text = stateSummaryText({
      texts: new NcTextCatalog({ language: 'en' }),
      summary,
      nowMs: NOW,
      timeZone: 'UTC',
    })
    expect(text.text).toContain('Battery (System · Sensor) is down to 19%')
  })

  it('{{deviceLabel}} is ONE parenthesis: the type joins the parent, never a second suffix', async () => {
    const directory = await warmDirectory()
    expect(deviceDisplayLabel(directory.get(5693), 5693, 'en')).toBe('Battery (System · Sensor)')
    expect(deviceDisplayLabel(directory.get(5693), 5693, 'it')).toBe('Battery (System · Sensore)')
    // A root keeps the plain form.
    expect(deviceDisplayLabel(directory.get(10), 10, 'en')).toBe('Sensore porta (Sensor)')
    // A row frozen at intake carries 'Battery (System)': same single form.
    expect(frozenDeviceLabel(5693, DeviceType.Sensor, 'Battery (System)', 'en')).toBe(
      'Battery (System · Sensor)',
    )
    // A name already ending with the type is left alone.
    expect(frozenDeviceLabel(5693, DeviceType.Sensor, 'Battery (System · Sensor)', 'en')).toBe(
      'Battery (System · Sensor)',
    )
  })
})
