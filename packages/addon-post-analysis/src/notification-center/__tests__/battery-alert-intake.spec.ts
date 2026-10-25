/**
 * The battery alert's SUBJECT — built at the intake, from the slice that was
 * already arriving.
 *
 * `EventCategory.DeviceStateChanged` has been in `NC_SYSTEM_EVENT_CATEGORIES`
 * since the liveness intake was written, so every `battery` slice write already
 * reaches `onSystemEvent`; `incomingFromSystemEvent` returned `null` for it
 * because `capName !== 'device-status'`. This feature needs **no new bus
 * category, no producer change and no new addon** — only the branch that was
 * missing.
 *
 * Two things are decided HERE and nowhere downstream:
 *
 *  - **the subject family is its own.** `battery:<id>`, never `device:<id>`.
 *    D141 split `device-switch:<id>` off liveness for exactly this reason: two
 *    facts about one device that share a cooldown slot cancel each other out,
 *    and an operator would lose the outage to the battery or the reverse.
 *
 *  - **the BODY VARIANT.** Binary and numeric are two different sentences, not
 *    one sentence with a different number in it — a binary source has no
 *    percentage to say. `systemSubject`'s docblock already states the rule:
 *    the variant is a fact about the event, so it is chosen where the event is,
 *    and the catalog stays a flat list of finished sentences.
 */
import type { SystemEvent } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceIdentity, NcDeviceLookup } from '../device-directory.js'
import { incomingFromBatteryBand } from '../event-intake.js'

function identity(deviceId: number, type: DeviceType, name: string): NcDeviceIdentity {
  return { deviceId, type, name, isCamera: type === DeviceType.Camera, parentDeviceId: null }
}

function directoryOf(...entries: readonly NcDeviceIdentity[]): NcDeviceLookup {
  const map = new Map(entries.map((e) => [e.deviceId, e]))
  return (deviceId: number) => map.get(deviceId)
}

function batterySlice(deviceId: number, slice: Record<string, unknown>): SystemEvent {
  return {
    id: `bat-${deviceId}`,
    timestamp: new Date(7_000),
    source: { type: 'device', id: deviceId },
    category: 'device.state-changed',
    data: { deviceId, capName: 'battery', slice },
  }
}

describe('incomingFromBatteryBand — the numeric sentence', () => {
  it('names the device, the percentage and its own subject family', () => {
    // 3602 "Termostato frigorifero", the closest genuine numeric on the fleet.
    const lookup = directoryOf(identity(3602, DeviceType.Sensor, 'Termostato frigorifero'))
    const incoming = incomingFromBatteryBand({
      facts: {
        eventId: 'battery:3602:7000',
        timestamp: 7_000,
        category: 'device.state-changed',
        data: {},
      },
      deviceId: 3602,
      band: 'low',
      reading: { percentage: 23, lastUpdated: 7_000 },
      identity: lookup(3602),
    })
    expect(incoming.subject.systemEvent).toMatchObject({
      kind: 'device-battery-low',
      subject: 'battery:3602',
      titleKey: 'system.device-battery-low.title',
      bodyKey: 'system.device-battery-low.body',
      textParams: { deviceId: '3602', deviceName: 'Termostato frigorifero', percentage: '23' },
      deviceId: 3602,
      deviceType: 'sensor',
    })
    expect(incoming.subject.recordId).toBe('battery:3602:7000')
    expect(incoming.log().tags).toEqual({ deviceId: 3602 })
  })

  it('is NOT the liveness subject — the two must never share a cooldown slot', () => {
    const incoming = incomingFromBatteryBand({
      facts: { eventId: 'x', timestamp: 7_000, category: 'device.state-changed', data: {} },
      deviceId: 102,
      band: 'low',
      reading: { percentage: 4, lastUpdated: 7_000 },
      identity: undefined,
    })
    expect(incoming.subject.systemEvent?.subject).not.toBe('device:102')
    expect(incoming.subject.systemEvent?.subject).toBe('battery:102')
  })
})

describe('incomingFromBatteryBand — the binary sentence says no number', () => {
  it('picks the binary body variant and omits the percentage', () => {
    // 3560 "Termostato bathroom bedroom": binary, reading LOW right now.
    const lookup = directoryOf(identity(3560, DeviceType.Sensor, 'Termostato bathroom bedroom'))
    const incoming = incomingFromBatteryBand({
      facts: { eventId: 'y', timestamp: 7_000, category: 'device.state-changed', data: {} },
      deviceId: 3560,
      band: 'low',
      reading: { percentage: 15, lastUpdated: 7_000, binary: true },
      identity: lookup(3560),
    })
    expect(incoming.subject.systemEvent?.bodyKey).toBe('system.device-battery-low.body.binary')
    expect(incoming.subject.systemEvent?.textParams).not.toHaveProperty('percentage')
  })
})

describe('incomingFromBatteryBand — the recovery is its own kind', () => {
  it('words a return to normal as device-battery-normal', () => {
    const incoming = incomingFromBatteryBand({
      facts: { eventId: 'z', timestamp: 9_000, category: 'device.state-changed', data: {} },
      deviceId: 3602,
      band: 'normal',
      reading: { percentage: 61, lastUpdated: 9_000 },
      identity: undefined,
    })
    expect(incoming.subject.systemEvent).toMatchObject({
      kind: 'device-battery-normal',
      titleKey: 'system.device-battery-normal.title',
      bodyKey: 'system.device-battery-normal.body',
    })
  })

  it('keeps the SAME subject as the low it recovers from — one episode key', () => {
    const low = incomingFromBatteryBand({
      facts: { eventId: 'a', timestamp: 1, category: 'device.state-changed', data: {} },
      deviceId: 3602,
      band: 'low',
      reading: { percentage: 4, lastUpdated: 1 },
      identity: undefined,
    })
    const normal = incomingFromBatteryBand({
      facts: { eventId: 'b', timestamp: 2, category: 'device.state-changed', data: {} },
      deviceId: 3602,
      band: 'normal',
      reading: { percentage: 90, lastUpdated: 2 },
      identity: undefined,
    })
    expect(normal.subject.systemEvent?.subject).toBe(low.subject.systemEvent?.subject)
  })
})

describe('the raw slice route still refuses to speak on its own', () => {
  it('a battery slice is not turned into a notification by incomingFromSystemEvent', async () => {
    // The band + the ledger decide; the bus event alone never does. If this
    // ever returns a subject, every one of the 526-writes-in-25-minutes becomes
    // a candidate notification.
    const { incomingFromSystemEvent } = await import('../event-intake.js')
    const lookup = directoryOf(identity(3602, DeviceType.Sensor, 'Termostato frigorifero'))
    expect(
      incomingFromSystemEvent(batterySlice(3602, { percentage: 4, lastUpdated: 7_000 }), lookup),
    ).toBeNull()
  })
})
