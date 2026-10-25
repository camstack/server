/**
 * LIVENESS IS A DEVICE FACT — and the rule decides which devices count.
 *
 * The night this file exists for (2026-08-12, 23:36:40): one zigbee smart plug
 * ("Presa tapparella sala da pranzo", integration `int_0019`) went offline and
 * its SIXTEEN sub-entities — power / current / voltage sensors, child lock,
 * countdown, battery, the container, the switch, the update entity, the button
 * — each emitted `device.offline`. The intake mapped every one of them to
 * `camera-offline`, and sixteen notifications went out saying "La camera 2018 è
 * offline". Not one of those ids was a camera, and none of them had a name in
 * the text either.
 *
 * The design that answers it is NOT a filter in the producer. The intake states
 * what happened — a device went offline, this is its name, this is its type —
 * and the RULE says which types are worth waking someone for
 * (`conditions.systemEvent.deviceTypes`). A filter baked into the intake is a
 * filter no operator can change, and it would have made "tell me when the
 * freezer plug drops" unexpressible.
 *
 * So the properties pinned here are:
 *
 *  1. EVERY device type produces `device-offline` / `device-online`, named.
 *  2. The subject carries the device TYPE, read from the mirrored directory —
 *     never a per-event RPC (D49).
 *  3. A `deviceTypes` rule matches its types and nothing else, and FAILS CLOSED
 *     on a device the mirror cannot name: "only my cameras" is never satisfied
 *     by a device nobody can identify.
 */
import type { NcRule, SystemEvent } from '@camstack/types'
import { DeviceType, NcRuleInputSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceIdentity, NcDeviceLookup } from '../device-directory.js'
import { discardedSystemEvent, incomingFromSystemEvent } from '../event-intake.js'
import { evaluateRule } from '../rule-engine.js'

function identity(
  deviceId: number,
  type: DeviceType,
  name: string,
  isCamera = type === DeviceType.Camera,
): NcDeviceIdentity {
  return { deviceId, type, name, isCamera }
}

function directoryOf(...entries: readonly NcDeviceIdentity[]): NcDeviceLookup {
  const map = new Map(entries.map((e) => [e.deviceId, e]))
  return (deviceId: number) => map.get(deviceId)
}

/** Nothing is known about anything — a cold mirror. */
const EMPTY: NcDeviceLookup = () => undefined

function livenessEvent(
  category: 'device.online' | 'device.offline',
  deviceId: number,
): SystemEvent {
  return {
    id: `lv-${category}-${deviceId}`,
    timestamp: new Date(3_000),
    source: { type: 'device', id: deviceId },
    category,
    data: { deviceId, integrationId: 'int_0019' },
  }
}

describe('the system-event intake reports a device, not a camera', () => {
  it('turns a camera going offline into device-offline, named and typed', () => {
    const lookup = directoryOf(identity(102, DeviceType.Camera, 'Front door'))
    const incoming = incomingFromSystemEvent(livenessEvent('device.offline', 102), lookup)
    expect(incoming?.subject.systemEvent).toMatchObject({
      kind: 'device-offline',
      subject: 'device:102',
      bodyKey: 'system.device-offline.body',
      textParams: { deviceId: '102', deviceName: 'Front door' },
      deviceId: 102,
      deviceType: 'camera',
    })
    expect(incoming?.log().tags).toEqual({ deviceId: 102 })
    expect(discardedSystemEvent(livenessEvent('device.offline', 102))).toBeNull()
  })

  it('reports EVERY other device type the same way — no kind is a camera', () => {
    // The exact families that flooded: the plug's sensors, its switch, its
    // controls, and the container that anchors them.
    const nonCameras: readonly [DeviceType, string][] = [
      [DeviceType.Sensor, 'Presa tapparella sala da pranzo potenza'],
      [DeviceType.Switch, 'Presa tapparella sala da pranzo'],
      [DeviceType.Control, 'Presa tapparella sala da pranzo countdown'],
      [DeviceType.Container, 'Presa tapparella sala da pranzo'],
      [DeviceType.Update, 'Presa tapparella sala da pranzo aggiornamento'],
      [DeviceType.Button, 'Presa tapparella sala da pranzo identifica'],
    ]
    for (const [type, name] of nonCameras) {
      const lookup = directoryOf(identity(2018, type, name))
      const system = incomingFromSystemEvent(livenessEvent('device.offline', 2018), lookup)?.subject
        .systemEvent
      expect(system?.kind, type).toBe('device-offline')
      expect(system?.deviceType, type).toBe(type)
      expect(system?.textParams?.['deviceName'], type).toBe(name)
    }
  })

  it('still reports a device the mirror cannot name — with no type to narrow on', () => {
    const system = incomingFromSystemEvent(livenessEvent('device.offline', 2018), EMPTY)?.subject
      .systemEvent
    expect(system?.kind).toBe('device-offline')
    // The id, so the sentence is never a hole; and NO type, so every
    // type-narrowed rule fails closed on it.
    expect(system?.textParams).toEqual({ deviceId: '2018', deviceName: '2018' })
    expect(system?.deviceType).toBeUndefined()
  })

  it('falls back to the id when a device has no name', () => {
    const lookup = directoryOf(identity(101, DeviceType.Camera, ''))
    expect(
      incomingFromSystemEvent(livenessEvent('device.offline', 101), lookup)?.subject.systemEvent
        ?.textParams,
    ).toEqual({ deviceId: '101', deviceName: '101' })
  })

  it('carries the type through the runtime-state route as well', () => {
    const stateChanged: SystemEvent = {
      id: 'sc-102',
      timestamp: new Date(3_000),
      source: { type: 'device', id: 102 },
      category: 'device.state-changed',
      data: { deviceId: 102, capName: 'device-status', slice: { online: false } },
    }
    const lookup = directoryOf(identity(102, DeviceType.Camera, 'Front door'))
    expect(incomingFromSystemEvent(stateChanged, lookup)?.subject.systemEvent).toMatchObject({
      kind: 'device-offline',
      deviceType: 'camera',
    })
  })

  it('reports the SWITCH generically too, on its own subject family', () => {
    const switchEvent: SystemEvent = {
      id: 'sw-2018',
      timestamp: new Date(3_000),
      source: { type: 'device', id: 2018 },
      category: 'device.disabled',
      data: { deviceId: 2018 },
    }
    const lookup = directoryOf(identity(2018, DeviceType.Switch, 'Presa'))
    expect(incomingFromSystemEvent(switchEvent, lookup)?.subject.systemEvent).toMatchObject({
      kind: 'device-disabled',
      subject: 'device-switch:2018',
      deviceType: 'switch',
      textParams: { deviceId: '2018', deviceName: 'Presa' },
    })
  })

  it('leaves a malformed device payload out of the discard log', () => {
    const noIdentity: SystemEvent = {
      id: 'bad-1',
      timestamp: new Date(3_000),
      source: { type: 'device', id: 1 },
      category: 'device.offline',
      data: { integrationId: 'int_0019' },
    }
    expect(incomingFromSystemEvent(noIdentity, EMPTY)).toBeNull()
    expect(discardedSystemEvent(noIdentity)).toBeNull()
  })

  it('names the camera in a stream outage as well', () => {
    const lookup = directoryOf(identity(101, DeviceType.Camera, 'Vialetto'))
    const stream: SystemEvent = {
      id: 'sh-1',
      timestamp: new Date(3_000),
      source: { type: 'stream-broker', id: '101/native:main' },
      category: 'stream.offline',
      data: { deviceId: 101, camStreamId: 'native:main', profile: 'high', reason: 'stale-timeout' },
    }
    expect(incomingFromSystemEvent(stream, lookup)?.subject.systemEvent?.textParams).toEqual({
      deviceId: '101',
      deviceName: 'Vialetto',
      profile: 'high',
    })
  })
})

/** The rule's half of the design — the filter the operator owns. */
describe('the deviceTypes condition', () => {
  function systemRule(deviceTypes?: readonly string[]): NcRule {
    const input = NcRuleInputSchema.parse({
      name: 'liveness',
      delivery: 'system-event',
      conditions: {
        systemEvent: {
          kinds: ['device-offline'],
          ...(deviceTypes !== undefined ? { deviceTypes: [...deviceTypes] } : {}),
        },
      },
      targets: [{ targetId: 't1' }],
    })
    return {
      ...input,
      id: 'r1',
      createdAt: 0,
      updatedAt: 0,
      createdBy: 'admin',
      disabledTargetIds: [],
    }
  }

  function subjectFor(deviceId: number, lookup: NcDeviceLookup) {
    const incoming = incomingFromSystemEvent(livenessEvent('device.offline', deviceId), lookup)
    if (incoming === null) throw new Error('the intake refused a well-formed liveness event')
    return incoming.subject
  }

  const mirror = directoryOf(
    identity(102, DeviceType.Camera, 'Front door'),
    identity(2018, DeviceType.Switch, 'Presa tapparella sala da pranzo'),
    identity(2019, DeviceType.Sensor, 'Presa tapparella potenza'),
  )

  it("matches the camera and REJECTS the plug when the rule says ['camera']", () => {
    const rule = systemRule(['camera'])
    expect(evaluateRule(rule, subjectFor(102, mirror)).matched).toBe(true)
    expect(evaluateRule(rule, subjectFor(2018, mirror)).matched).toBe(false)
    expect(evaluateRule(rule, subjectFor(2019, mirror)).matched).toBe(false)
  })

  it('matches EVERY type when the rule names none', () => {
    const rule = systemRule()
    for (const deviceId of [102, 2018, 2019]) {
      expect(evaluateRule(rule, subjectFor(deviceId, mirror)).matched, String(deviceId)).toBe(true)
    }
  })

  it('accepts several types at once', () => {
    const rule = systemRule(['camera', 'switch'])
    expect(evaluateRule(rule, subjectFor(2018, mirror)).matched).toBe(true)
    expect(evaluateRule(rule, subjectFor(2019, mirror)).matched).toBe(false)
  })

  it('FAILS CLOSED on a device the mirror cannot name', () => {
    // No type on the subject ⇒ no type-narrowed rule may claim it. The
    // opposite (treating unknown as "probably a camera") is how sixteen
    // notifications about a smart plug went out in the first place.
    const rule = systemRule(['camera'])
    expect(evaluateRule(rule, subjectFor(9_999, EMPTY)).matched).toBe(false)
    expect(evaluateRule(rule, subjectFor(9_999, EMPTY)).failedCondition).toBe('systemEvent')
    // …and a rule with no type list still hears about it.
    expect(evaluateRule(systemRule(), subjectFor(9_999, EMPTY)).matched).toBe(true)
  })

  it('does not multiply: sixteen sub-entities, one camera rule, zero matches', () => {
    const subEntities = Array.from({ length: 16 }, (_, i) =>
      identity(2000 + i, i === 0 ? DeviceType.Container : DeviceType.Sensor, `Presa ${i}`),
    )
    const lookup = directoryOf(...subEntities)
    const rule = systemRule(['camera'])
    const matched = subEntities.filter(
      (e) => evaluateRule(rule, subjectFor(e.deviceId, lookup)).matched,
    )
    expect(matched).toHaveLength(0)
  })
})
