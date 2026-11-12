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
  deviceNamesWithParents,
  frozenDeviceLabel,
  nameWithParent,
  NcDeviceDirectory,
  type NcDeviceIdentity,
} from '../device-directory.js'
import { sensorOf } from '../appliance-cycle.js'
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
    expect(frozenDeviceLabel(5693, DeviceType.Sensor, 'Battery (System)', 'en', 'System')).toBe(
      'Battery (System · Sensor)',
    )
    // A name already ending with the type is left alone.
    expect(
      frozenDeviceLabel(5693, DeviceType.Sensor, 'Battery (System · Sensor)', 'en', 'System'),
    ).toBe('Battery (System · Sensor)')
  })

  it('a detection {{device}} names the parent too: getDeviceName reads the same helper', async () => {
    // The slim listAll rows the dispatcher's getDeviceName is built from.
    const names = deviceNamesWithParents(
      ROWS.map((row) => ({ id: row.deviceId, name: row.name, parentDeviceId: row.parentDeviceId })),
    )
    expect(names.get(5693)).toBe('Battery (System)')
    expect(names.get(10)).toBe('Sensore porta')
    expect(names.get(11)).toBe('Termometro')
    expect(names.get(4385)).toBe('Robot piano terra')
    // The dispatcher dresses the fetched name with the identity's type; the
    // parent the fetched name already carries is not added a second time.
    const directory = await warmDirectory()
    const identity = directory.get(5693)
    if (identity === undefined) throw new Error('no identity')
    expect(deviceDisplayLabel({ ...identity, name: names.get(5693) ?? '' }, 5693, 'en')).toBe(
      'Battery (System · Sensor)',
    )
  })

  it("a parenthesis that is NOT the parent's stays the device's own: 'Cam (old) (Camera)'", () => {
    const own: NcDeviceIdentity = {
      deviceId: 7,
      type: DeviceType.Camera,
      name: 'Cam (old)',
      isCamera: true,
      parentDeviceId: null,
    }
    expect(deviceDisplayLabel(own, 7, 'en')).toBe('Cam (old) (Camera)')
    // A frozen row with no parent is the same device.
    expect(frozenDeviceLabel(7, DeviceType.Camera, 'Cam (old)', 'en')).toBe('Cam (old) (Camera)')
  })

  it('the parent is already in the name only as a whole word, never as part of one', () => {
    expect(nameWithParent('Luxury lamp', 'Lux')).toBe('Luxury lamp (Lux)')
    expect(nameWithParent('Lux kitchen', 'Lux')).toBe('Lux kitchen')
    expect(nameWithParent('Robot piano terra', 'Robot piano terra')).toBe('Robot piano terra')
    expect(nameWithParent('Pompa - Caldaia', 'caldaia')).toBe('Pompa - Caldaia')
  })

  it('a battery-low row freezes the parent, so its label is one parenthesis in any language', async () => {
    const directory = await warmDirectory()
    const event = incomingFromBatteryBand({
      facts: FACTS,
      deviceId: 5693,
      band: 'low',
      reading: { percentage: 19, lastUpdated: NOW },
      identity: directory.get(5693),
    }).subject.systemEvent
    const params = event?.textParams ?? {}
    expect(params['deviceParentName']).toBe('System')
    expect(
      frozenDeviceLabel(
        5693,
        event?.deviceType,
        params['deviceName'],
        'it',
        params['deviceParentName'],
      ),
    ).toBe('Battery (System · Sensore)')
  })

  it("a child sensor's notification title names its parent", async () => {
    const directory = await warmDirectory()
    expect(
      sensorOf({ deviceId: 5693, source: 'sensor' }, (id) => directory.displayName(id)),
    ).toEqual({ sensor: { deviceId: 5693, name: 'Battery (System)' } })
    // A nameless device still freezes nothing.
    expect(directory.displayName(424242)).toBeUndefined()
  })
})
