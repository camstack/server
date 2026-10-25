/**
 * The camera microphone control — the derivation behind D113's `device-audio`
 * row.
 *
 * The distinctions pinned here are the ones the switch group got right and that
 * a fresh surface is most likely to flatten: unsupported ≠ off, unread ≠ off,
 * and the polarity is straight-through while both of its siblings invert.
 */
import { describe, expect, it } from 'vitest'
import {
  CAMERA_MICROPHONE_LABEL,
  cameraMicrophoneWrite,
  resolveCameraMicrophone,
} from '../privacy-mask-audio'

describe('resolveCameraMicrophone', () => {
  it('a camera capturing sound reads ON', () => {
    const state = resolveCameraMicrophone({ supportsAudioMute: true, audioEnabled: true })
    expect(state.on).toBe(true)
    expect(state.supported).toBe(true)
    expect(state.available).toBe(true)
    expect(state.label).toBe(CAMERA_MICROPHONE_LABEL)
  })

  it('STATE SURVIVAL: a camera muted through the deprecated group reads OFF on the first read', () => {
    // The shim wrote `privacyMask.setAudioEnabled`, and the CAMERA is the store
    // — so the first read of the new surface is the operator's own decision.
    const state = resolveCameraMicrophone({ supportsAudioMute: true, audioEnabled: false })
    expect(state.on).toBe(false)
    expect(state.available).toBe(true)
  })

  it('a camera with no writable microphone is UNSUPPORTED, not off', () => {
    const state = resolveCameraMicrophone({ supportsAudioMute: false, audioEnabled: null })
    expect(state.supported).toBe(false)
    expect(state.available).toBe(false)
    expect(state.on).toBeNull()
  })

  it('options that did not answer are UNKNOWN, never "no microphone here"', () => {
    const state = resolveCameraMicrophone({ supportsAudioMute: null, audioEnabled: true })
    expect(state.available).toBe(false)
    expect(state.on).toBeNull()
  })

  it('supported but unread is UNKNOWN, never off', () => {
    const state = resolveCameraMicrophone({ supportsAudioMute: true, audioEnabled: null })
    expect(state.supported).toBe(true)
    expect(state.on).toBeNull()
    expect(state.available).toBe(false)
  })

  it('an in-flight write wins over the last camera answer', () => {
    const state = resolveCameraMicrophone({
      supportsAudioMute: true,
      audioEnabled: true,
      pendingOn: false,
    })
    expect(state.on).toBe(false)
  })

  it('an in-flight write over an UNKNOWN read stays unknown', () => {
    const state = resolveCameraMicrophone({
      supportsAudioMute: true,
      audioEnabled: null,
      pendingOn: false,
    })
    expect(state.on).toBeNull()
  })
})

describe('cameraMicrophoneWrite', () => {
  it('turning it OFF writes enabled: false — the polarity is straight-through', () => {
    const on = resolveCameraMicrophone({ supportsAudioMute: true, audioEnabled: true })
    expect(cameraMicrophoneWrite(on)).toEqual({ enabled: false })
  })

  it('turning it ON writes enabled: true', () => {
    const off = resolveCameraMicrophone({ supportsAudioMute: true, audioEnabled: false })
    expect(cameraMicrophoneWrite(off)).toEqual({ enabled: true })
  })

  it('an unsupported plane produces NO write', () => {
    const none = resolveCameraMicrophone({ supportsAudioMute: false, audioEnabled: null })
    expect(cameraMicrophoneWrite(none)).toBeNull()
  })

  it('an unknown state produces NO write', () => {
    const unknown = resolveCameraMicrophone({ supportsAudioMute: true, audioEnabled: null })
    expect(cameraMicrophoneWrite(unknown)).toBeNull()
  })
})
