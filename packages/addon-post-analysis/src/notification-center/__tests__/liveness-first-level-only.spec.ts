/**
 * LIVENESS IS A FIRST-LEVEL DEVICE FACT. An accessory never produces one.
 *
 * ## What was measured, 2026-09-01
 *
 * `deviceState.getAllSnapshots` over the live hub: **100 devices read
 * `device-status.online === false`**, none of them disabled, all of them from
 * `@camstack/addon-provider-homeassistant`, **zero cameras**. Of those 100:
 *
 *  - **96 carry a `parentDeviceId`**, and **32 of their 35 distinct parents are
 *    ONLINE** — the physical thing is reachable, one of its entities is not;
 *  - **78 of them flipped inside the single minute 09:19** — one provider
 *    reconnect, not 78 outages;
 *  - **39 are HA `button` entities**, which are offline *by construction*:
 *    `ha-base-child-device.ts` reads `state !== 'unavailable' && state !==
 *    'unknown'`, and a `button` has no state until it is pressed. "Tapparella
 *    kitchen Manual open" is not a device anybody wants woken for.
 *
 * An offline rule that did not scope would therefore have delivered ~100
 * notifications on its first tick. The operator's live rule survives only
 * because it carries `deviceTypes: ['camera']` — i.e. because a human
 * remembered.
 *
 * ## The rule, and its cost
 *
 * A device with a `parentDeviceId` produces **no liveness subject at all** —
 * not a filtered one, not a fail-closed one: the intake returns `null` and the
 * drop is reported at debug, the way the stream-health gate already reports
 * its refusals. This is stricter than "exclude a child whose parent is online",
 * and it was chosen for being explainable in one sentence. The accepted cost is
 * stated out loud: **an accessory that is genuinely dead is never announced.**
 * The parent still is.
 *
 * The gate is liveness-ONLY. `device-disabled` / `device-enabled` are the
 * operator's own switch (D62) — somebody pressed something and is owed the
 * confirmation whatever level the device sits at.
 */
import type { SystemEvent } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceIdentity, NcDeviceLookup } from '../device-directory.js'
import { discardedSystemEvent, incomingFromSystemEvent } from '../event-intake.js'

function identity(
  deviceId: number,
  type: DeviceType,
  name: string,
  parentDeviceId: number | null,
): NcDeviceIdentity {
  return { deviceId, type, name, isCamera: type === DeviceType.Camera, parentDeviceId }
}

function directoryOf(...entries: readonly NcDeviceIdentity[]): NcDeviceLookup {
  const map = new Map(entries.map((e) => [e.deviceId, e]))
  return (deviceId: number) => map.get(deviceId)
}

function livenessEvent(
  category: 'device.online' | 'device.offline',
  deviceId: number,
): SystemEvent {
  return {
    id: `lv-${category}-${deviceId}`,
    timestamp: new Date(3_000),
    source: { type: 'device', id: deviceId },
    category,
    data: { deviceId },
  }
}

function sliceEvent(deviceId: number, online: boolean): SystemEvent {
  return {
    id: `slice-${deviceId}`,
    timestamp: new Date(3_000),
    source: { type: 'device', id: deviceId },
    category: 'device.state-changed',
    data: { deviceId, capName: 'device-status', slice: { online, lastChangedAt: 3_000 } },
  }
}

describe('an accessory never produces a liveness notification', () => {
  it('drops device.offline for a child, whatever its parent is doing', () => {
    // 1901 "Tapparella kitchen Manual open", parent 1893, which is online.
    const lookup = directoryOf(
      identity(1901, DeviceType.Button, 'Tapparella kitchen Manual open', 1893),
      identity(1893, DeviceType.Cover, 'Tapparella kitchen', null),
    )
    expect(incomingFromSystemEvent(livenessEvent('device.offline', 1901), lookup)).toBeNull()
  })

  it('drops it for a child whose parent is ALSO offline — the parent speaks for both', () => {
    const lookup = directoryOf(
      identity(1032, DeviceType.Button, 'Doorbell Restart', 1026),
      identity(1026, DeviceType.Container, 'Doorbell', null),
    )
    expect(incomingFromSystemEvent(livenessEvent('device.offline', 1032), lookup)).toBeNull()
  })

  it('drops device.online for a child too — a recovery nobody was told about', () => {
    const lookup = directoryOf(identity(1863, DeviceType.Sensor, 'Stato di carica', 1857))
    expect(incomingFromSystemEvent(livenessEvent('device.online', 1863), lookup)).toBeNull()
  })

  it('drops the device-status SLICE route for a child as well', () => {
    // Two categories reach `deviceLiveness`; a gate on one of them is a gate
    // that is not there. The copies had already drifted once.
    const lookup = directoryOf(identity(1901, DeviceType.Button, 'Manual open', 1893))
    expect(incomingFromSystemEvent(sliceEvent(1901, false), lookup)).toBeNull()
  })

  it('REPORTS the drop rather than swallowing it', () => {
    const lookup = directoryOf(identity(1901, DeviceType.Button, 'Manual open', 1893))
    const dropped = discardedSystemEvent(livenessEvent('device.offline', 1901), lookup)
    expect(dropped).not.toBeNull()
    expect(dropped?.reason).toBe('accessory')
    expect(dropped?.tags).toEqual({ deviceId: 1901 })
    expect(dropped?.meta).toMatchObject({ parentDeviceId: 1893, deviceType: 'button' })
  })

  it('reports nothing for a first-level device — that is not a drop', () => {
    const lookup = directoryOf(identity(102, DeviceType.Camera, 'Front door', null))
    expect(discardedSystemEvent(livenessEvent('device.offline', 102), lookup)).toBeNull()
  })
})

describe('a first-level device still produces one', () => {
  it('keeps a camera with no parent', () => {
    const lookup = directoryOf(identity(102, DeviceType.Camera, 'Front door', null))
    expect(
      incomingFromSystemEvent(livenessEvent('device.offline', 102), lookup)?.subject.systemEvent,
    ).toMatchObject({ kind: 'device-offline', subject: 'device:102' })
  })

  it('keeps a first-level HA container — 3 of the 100 measured offlines are these', () => {
    const lookup = directoryOf(identity(1026, DeviceType.Container, 'Doorbell', null))
    expect(
      incomingFromSystemEvent(livenessEvent('device.offline', 1026), lookup)?.subject.systemEvent,
    ).toMatchObject({ kind: 'device-offline', deviceType: 'container' })
  })

  it('keeps a device the directory cannot place — unknown is not an accessory', () => {
    // A cold mirror must not silence the fleet. `undefined` is "we do not know
    // who this is", and D49's direction here is to SPEAK: the notification is
    // named by its id and carries no type, so a type-narrowed rule still
    // declines it.
    const cold: NcDeviceLookup = () => undefined
    expect(
      incomingFromSystemEvent(livenessEvent('device.offline', 9999), cold)?.subject.systemEvent,
    ).toMatchObject({ kind: 'device-offline', subject: 'device:9999' })
  })
})

describe('the operator SWITCH is not liveness and is never scoped away', () => {
  it('still announces a child that was disabled by hand', () => {
    const lookup = directoryOf(identity(1901, DeviceType.Button, 'Manual open', 1893))
    const event: SystemEvent = {
      id: 'sw-1901',
      timestamp: new Date(3_000),
      source: { type: 'device', id: 1901 },
      category: 'device.disabled',
      data: { deviceId: 1901 },
    }
    expect(incomingFromSystemEvent(event, lookup)?.subject.systemEvent).toMatchObject({
      kind: 'device-disabled',
      subject: 'device-switch:1901',
    })
  })
})
