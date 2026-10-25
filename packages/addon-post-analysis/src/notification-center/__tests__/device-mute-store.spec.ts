/**
 * NcDeviceMuteStore - the PERMANENT per-camera notification off switch.
 *
 * Deliberately not a snooze. A snooze is bounded at 24h so it cannot become an
 * outage the operator asked for once and forgot; a mute is the opposite thing
 * - an explicit, indefinite, admin-only decision that is REPORTED as off (via
 * `CameraStatus.switchedOff`) so a silent camera never reads as a working one.
 *
 * The mute is a per-device setting (key `notificationMuted`, D870), so the
 * central device delete takes it with the device.
 *
 * What these pin down:
 *  - the state survives a restart (a mute that forgets is worse than no mute);
 *  - a failed load keeps the mutes already in memory rather than un-muting the
 *    operator by accident - same reasoning as the snooze store;
 *  - unmuting a camera that was never muted succeeds;
 *  - the mute is ONE setting of the device, so clearing the device clears it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NOTIFICATION_MUTED_KEY, NcDeviceMuteStore } from '../device-mute-store.js'
import { type FakeDeviceSettings, makeFakeDeviceSettings } from './fake-device-settings.js'

describe('NcDeviceMuteStore', () => {
  let settings: FakeDeviceSettings
  let store: NcDeviceMuteStore

  beforeEach(async () => {
    settings = makeFakeDeviceSettings()
    store = new NcDeviceMuteStore({ settings, logger: makeSilentLogger() })
    await store.load()
  })

  it('nothing is muted by default', () => {
    expect(store.isMuted(101)).toBe(false)
    expect(store.listMuted()).toEqual([])
  })

  it('mutes and unmutes one camera', async () => {
    await store.setMuted(101, true)
    expect(store.isMuted(101)).toBe(true)
    expect(store.isMuted(102)).toBe(false)
    expect(store.listMuted()).toEqual([101])

    await store.setMuted(101, false)
    expect(store.isMuted(101)).toBe(false)
    expect(store.listMuted()).toEqual([])
  })

  it('unmuting a camera that was never muted succeeds', async () => {
    await expect(store.setMuted(999, false)).resolves.toBeUndefined()
    expect(store.isMuted(999)).toBe(false)
  })

  it('the mute is ONE setting of the device and leaves its other settings alone', async () => {
    settings.rows.set(101, { other: 1 })
    await store.setMuted(101, true)
    expect(Object.keys(settings.rows.get(101) ?? {}).toSorted()).toEqual([
      NOTIFICATION_MUTED_KEY,
      'other',
    ])
    await store.setMuted(101, false)
    expect(settings.rows.get(101)).toEqual({ other: 1 })
  })

  it('the mute survives a restart - it is durable, not in-memory', async () => {
    await store.setMuted(101, true)
    const reloaded = new NcDeviceMuteStore({ settings, logger: makeSilentLogger() })
    await reloaded.load()
    expect(reloaded.isMuted(101)).toBe(true)
    expect(reloaded.listMuted()).toEqual([101])
  })

  it('a device clear (the central delete) un-mutes it on the next load', async () => {
    await store.setMuted(101, true)
    settings.rows.delete(101)
    await store.load()
    expect(store.isMuted(101)).toBe(false)
  })

  it('listMuted is sorted, so two callers never disagree on order', async () => {
    await store.setMuted(102, true)
    await store.setMuted(104, true)
    await store.setMuted(101, true)
    expect(store.listMuted()).toEqual([101, 102, 104])
  })

  it('a failed load keeps the mutes already in memory', async () => {
    await store.setMuted(101, true)
    settings.failWith(new Error('store down'))
    await store.load()
    // Dropping every mute on a transient store error would start notifying for
    // a camera the operator silenced, without them asking.
    expect(store.isMuted(101)).toBe(true)
  })

  it('a failed write leaves the hot path unchanged', async () => {
    settings.failWith(new Error('store down'))
    await expect(store.setMuted(101, true)).rejects.toThrow('store down')
    expect(store.isMuted(101)).toBe(false)
  })
})
