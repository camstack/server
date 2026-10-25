/**
 * The per-device notification mute — the DERIVATION.
 *
 * Three properties, each of which has already been got wrong once in this
 * repo's switch work:
 *
 *  - **Unknown is unknown.** A `listDeviceMutes` that did not answer renders no
 *    control and produces no write. On 2026-08-08 a failed read rendered as
 *    "the operator turned nothing off" and a switched-off camera read as
 *    broken.
 *  - **Polarity.** The fact is `muted`; the control is "Notifications". The
 *    write is the inverse of what the control shows, computed in ONE place.
 *  - **State survival.** A camera muted through the deprecated switch group —
 *    which wrote this same store — reads OFF here on the first derivation, with
 *    no normalisation and no write.
 */
import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_MUTE_LABEL,
  notificationMuteWrite,
  resolveNotificationMute,
} from '../device-notification-mute'

describe('resolveNotificationMute', () => {
  it('reads a camera absent from the mute list as ON', () => {
    const state = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: [101],
      deviceId: 102,
    })
    expect(state.on).toBe(true)
    expect(state.available).toBe(true)
    expect(state.label).toBe(NOTIFICATION_MUTE_LABEL)
  })

  it('STATE SURVIVAL: a camera muted through the deprecated group reads OFF on the first read', () => {
    // The shim wrote `notificationRules.setDeviceMuted`, i.e. this very store.
    // Nothing here migrates, normalises or writes — the row is simply read.
    const state = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: [101, 102],
      deviceId: 102,
    })
    expect(state.on).toBe(false)
    expect(state.available).toBe(true)
  })

  it('a read that did not answer is UNKNOWN, never "not muted"', () => {
    const state = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: null,
      deviceId: 102,
    })
    expect(state.on).toBeNull()
    expect(state.available).toBe(false)
  })

  it('an in-flight write wins over the last server answer', () => {
    const state = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: [102],
      deviceId: 102,
      pendingOn: true,
    })
    expect(state.on).toBe(true)
  })

  it('an in-flight write over an UNKNOWN read stays unknown', () => {
    const state = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: null,
      deviceId: 102,
      pendingOn: true,
    })
    expect(state.on).toBeNull()
    expect(state.available).toBe(false)
  })

  it('says what a CAMERA loses while it is off — and that its media is kept', () => {
    const state = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: [102],
      deviceId: 102,
    })
    expect(state.costWhenOff.text).toMatch(/^This camera never notifies/)
    expect(state.costWhenOff.text).toMatch(/tracks and recordings/)
  })

  it('a NON-camera device is named generically, with no camera-only media (a dishwasher)', () => {
    const state = resolveNotificationMute({
      isCamera: false,
      mutedDeviceIds: [501],
      deviceId: 501,
    })
    expect(state.costWhenOff.text).toMatch(/^This device never notifies/)
    expect(state.costWhenOff.text).not.toMatch(/camera|track|recording/i)
    // Two sentences, two keys: a translation cannot merge them back.
    expect(state.costWhenOff.i18nKey).not.toBe(
      resolveNotificationMute({
        isCamera: true,
        mutedDeviceIds: [],
        deviceId: 1,
      }).costWhenOff.i18nKey,
    )
  })
})

describe('notificationMuteWrite', () => {
  it('turning the control OFF writes muted: true', () => {
    const on = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: [],
      deviceId: 102,
    })
    expect(notificationMuteWrite(on, 102)).toEqual({
      deviceId: 102,
      muted: true,
    })
  })

  it('turning the control ON writes muted: false', () => {
    const off = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: [102],
      deviceId: 102,
    })
    expect(notificationMuteWrite(off, 102)).toEqual({
      deviceId: 102,
      muted: false,
    })
  })

  it('an unknown state produces NO write', () => {
    const unknown = resolveNotificationMute({
      isCamera: true,
      mutedDeviceIds: null,
      deviceId: 102,
    })
    expect(notificationMuteWrite(unknown, 102)).toBeNull()
  })
})
