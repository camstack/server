/**
 * The stream-health gate — WHICH broker health flips become a notification.
 *
 * The operator contract this pins (2026-08-12): a stream-offline notification
 * means the stream has been down for TWO SUSTAINED MINUTES. "Un reboot non ci
 * passa" — a camera that reboots and comes back inside the window must produce
 * nothing at all.
 *
 * Every other health flip the broker reports is a state change that is NOT an
 * outage: a stream coming up for the first time, a lazy-dial suspend when the
 * last consumer left, its resume, and a broker released on purpose. Each one
 * used to arrive at the Notification Center as a full "Stream offline" /
 * "Stream online" pair.
 */
import type { SystemEvent } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceLookup } from '../device-directory.js'
import { discardedSystemEvent, incomingFromSystemEvent } from '../event-intake.js'

/** 101 is a camera. The mirror supplies the NAME a stream sentence uses, and
 *  the TYPE a `deviceTypes` rule narrows the `device.*` categories on. */
const CAMERAS: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Camera,
  name: 'Vialetto',
  isCamera: true,
})

function streamEvent(online: boolean, reason: string | undefined): SystemEvent {
  return {
    id: `sh-${reason ?? 'none'}`,
    timestamp: new Date(1_000),
    source: { type: 'stream-broker', id: '101/native:main' },
    category: online ? 'stream.online' : 'stream.offline',
    data: {
      deviceId: 101,
      camStreamId: 'native:main',
      profile: 'high',
      brokerId: '101/native:main',
      sourceType: 'rfc4571',
      lastPacketAt: 500,
      ...(reason !== undefined ? { reason } : {}),
    },
  }
}

describe('the stream-health notification gate', () => {
  it('turns a sustained stale stream into stream-offline', () => {
    const incoming = incomingFromSystemEvent(streamEvent(false, 'stale-timeout'), CAMERAS)
    expect(incoming?.subject.systemEvent).toMatchObject({
      kind: 'stream-offline',
      subject: 'stream:101',
      deviceId: 101,
    })
    expect(discardedSystemEvent(streamEvent(false, 'stale-timeout'))).toBeNull()
  })

  it('accepts the battery failures the broker names, one subject per device (D883)', () => {
    for (const reason of ['wake-timeout', 'connection-error', 'battery-unreachable']) {
      const incoming = incomingFromSystemEvent(streamEvent(false, reason), CAMERAS)
      expect(incoming?.subject.systemEvent).toMatchObject({
        kind: 'stream-offline',
        subject: 'stream:101',
      })
      expect(discardedSystemEvent(streamEvent(false, reason))).toBeNull()
    }
  })

  it('names no single profile for an outage covering several streams (D883)', () => {
    const event = streamEvent(false, 'stale-timeout')
    const several: SystemEvent = {
      ...event,
      data: { ...event.data, camStreamIds: ['native:main', 'native:sub'] },
    }
    const incoming = incomingFromSystemEvent(several, CAMERAS)
    expect(incoming?.subject.systemEvent?.bodyKey).toBe('system.stream-offline.body')
  })

  it('turns the matching recovery into stream-online', () => {
    const incoming = incomingFromSystemEvent(streamEvent(true, 'recovered'), CAMERAS)
    expect(incoming?.subject.systemEvent).toMatchObject({
      kind: 'stream-online',
      deviceId: 101,
    })
  })

  it('discards a lazy-dial suspend and its resume, and says so with a device tag', () => {
    for (const [online, reason] of [
      [false, 'suspended'],
      [true, 'resumed'],
    ] as const) {
      const event = streamEvent(online, reason)
      expect(incomingFromSystemEvent(event, CAMERAS)).toBeNull()
      const dropped = discardedSystemEvent(event)
      expect(dropped?.tags).toEqual({ deviceId: 101 })
      expect(dropped?.reason).toBe(reason)
      expect(dropped?.category).toBe(online ? 'stream.online' : 'stream.offline')
    }
  })

  it('discards a first-packet arrival — a stream coming up is not a recovery', () => {
    expect(incomingFromSystemEvent(streamEvent(true, 'first-packet'), CAMERAS)).toBeNull()
    expect(discardedSystemEvent(streamEvent(true, 'first-packet'))?.tags).toEqual({
      deviceId: 101,
    })
  })

  it('discards a deliberately released broker — an unpublish is not an outage', () => {
    expect(incomingFromSystemEvent(streamEvent(false, 'broker-destroyed'), CAMERAS)).toBeNull()
    expect(discardedSystemEvent(streamEvent(false, 'broker-destroyed'))?.reason).toBe(
      'broker-destroyed',
    )
  })

  it('fails CLOSED on a health flip that states no reason', () => {
    // The stream-broker watchdog is the only emitter of these categories and it
    // always states a reason. An event without one comes from a version the gate
    // cannot reason about — notifying on it would resurrect exactly the noise
    // this gate exists to remove.
    expect(incomingFromSystemEvent(streamEvent(false, undefined), CAMERAS)).toBeNull()
    expect(discardedSystemEvent(streamEvent(false, undefined))?.reason).toBe('unstated')
  })

  it('leaves every non-stream system event to its own rules', () => {
    const device: SystemEvent = {
      id: 'd-1',
      timestamp: new Date(1_000),
      source: { type: 'device', id: 101 },
      category: 'device.offline',
      data: { deviceId: 101 },
    }
    expect(incomingFromSystemEvent(device, CAMERAS)?.subject.systemEvent?.kind).toBe(
      'device-offline',
    )
    expect(discardedSystemEvent(device)).toBeNull()
  })
})
