import { describe, expect, it, vi } from 'vitest'
import {
  deriveCameraFunctions,
  resolveCameraFunctionWrite,
  type CameraFunctionReads,
} from '../camera-functions.js'
import { applyCameraFunctionWrite } from '../camera-function-writes.js'

const ALL_READ: CameraFunctionReads = {
  deviceDisabled: false,
  bindableCapNames: ['detection-pipeline', 'audio-analysis', 'pipeline-analytics'],
  wrappedCapNames: ['detection-pipeline', 'audio-analysis', 'pipeline-analytics'],
  wrapperAddonIdByCap: new Map([
    ['detection-pipeline', 'pipeline'],
    ['audio-analysis', 'pipeline'],
    ['pipeline-analytics', 'post-analysis'],
  ]),
  recordingEnabled: true,
  notificationsMuted: false,
  privacy: { maskEnabled: false, audioEnabled: true },
  brokerAudioMuted: false,
}

function byId(reads: CameraFunctionReads, id: string) {
  return deriveCameraFunctions(reads).find((fn) => fn.id === id)
}

describe('deriveCameraFunctions', () => {
  it('renders the nine functions with the labels HA already has', () => {
    const ids = deriveCameraFunctions(ALL_READ).map((fn) => fn.id)
    expect(ids).toEqual([
      'stream-broker',
      'object-detection',
      'privacy-mask',
      'device-audio',
      'broker-audio',
      'audio-analysis',
      'event-saving',
      'recording',
      'notifications',
    ])
    expect(byId(ALL_READ, 'stream-broker')?.label).toBe('Camera')
    expect(byId(ALL_READ, 'device-audio')?.label).toBe('Camera microphone')
  })

  it('a source that has not answered does NOT produce a control turned on', () => {
    // The rule this export has already written: a control that is `on`
    // because nobody answered tells the operator that a function is running.
    const blind: CameraFunctionReads = { ...ALL_READ, recordingEnabled: null }
    expect(byId(blind, 'recording')?.available).toBe(false)
  })

  it('a wrapper that no addon provides is not a control', () => {
    const noWrapper: CameraFunctionReads = { ...ALL_READ, wrapperAddonIdByCap: new Map() }
    expect(byId(noWrapper, 'object-detection')?.available).toBe(false)
  })

  it('a cap not bindable for this device type produces no row', () => {
    const noAudio: CameraFunctionReads = { ...ALL_READ, bindableCapNames: ['detection-pipeline'] }
    expect(byId(noAudio, 'audio-analysis')?.available).toBe(false)
  })

  it('the polarity of broker-audio is inverted: muted=true means off', () => {
    expect(byId({ ...ALL_READ, brokerAudioMuted: true }, 'broker-audio')?.enabled).toBe(false)
  })

  it('the polarity of privacy-mask is NOT inverted: enabled=true is the active mask', () => {
    // `addon-export-hap` mirrors `patch.enabled` verbatim and a HomeKit toggle
    // that disagrees with the HA one for the same camera is worse than neither.
    const masked: CameraFunctionReads = {
      ...ALL_READ,
      privacy: { maskEnabled: true, audioEnabled: true },
    }
    expect(byId(masked, 'privacy-mask')?.enabled).toBe(true)
  })

  it('audioEnabled null is UNKNOWN, never microphone off', () => {
    const unknownMic: CameraFunctionReads = {
      ...ALL_READ,
      privacy: { maskEnabled: false, audioEnabled: null },
    }
    expect(byId(unknownMic, 'device-audio')?.available).toBe(false)
  })

  it('without a privacy slice there is neither the mask nor the microphone', () => {
    const noPrivacy: CameraFunctionReads = { ...ALL_READ, privacy: null }
    expect(byId(noPrivacy, 'privacy-mask')?.available).toBe(false)
    expect(byId(noPrivacy, 'device-audio')?.available).toBe(false)
  })
})

describe('resolveCameraFunctionWrite', () => {
  it('sends every function to ITS authority', () => {
    expect(resolveCameraFunctionWrite('stream-broker', false, ALL_READ)).toEqual({
      kind: 'device-disabled',
      disabled: true,
    })
    expect(resolveCameraFunctionWrite('object-detection', false, ALL_READ)).toEqual({
      kind: 'wrapper-binding',
      capName: 'detection-pipeline',
      wrapperAddonId: 'pipeline',
      active: false,
    })
    expect(resolveCameraFunctionWrite('recording', false, ALL_READ)).toEqual({
      kind: 'recording-enabled',
      enabled: false,
    })
    expect(resolveCameraFunctionWrite('notifications', false, ALL_READ)).toEqual({
      kind: 'notification-mute',
      muted: true,
    })
    expect(resolveCameraFunctionWrite('privacy-mask', true, ALL_READ)).toEqual({
      kind: 'camera-mask',
      enabled: true,
    })
    expect(resolveCameraFunctionWrite('device-audio', false, ALL_READ)).toEqual({
      kind: 'camera-audio',
      enabled: false,
    })
    expect(resolveCameraFunctionWrite('broker-audio', false, ALL_READ)).toEqual({
      kind: 'broker-audio-mute',
      muted: true,
    })
  })

  it('refuses the write on an unavailable function instead of persisting it', () => {
    const blind: CameraFunctionReads = { ...ALL_READ, recordingEnabled: null }
    expect(resolveCameraFunctionWrite('recording', false, blind)).toBeNull()
  })
})

function fakeApi() {
  return {
    deviceManager: { setDisabled: { mutate: vi.fn() }, setWrapperActive: { mutate: vi.fn() } },
    recordingArchive: {
      getDeviceConfig: { query: vi.fn().mockResolvedValue({ enabled: true, bands: ['B'] }) },
      setDeviceConfig: { mutate: vi.fn() },
    },
    notificationRules: { setDeviceMuted: { mutate: vi.fn() } },
    privacyMask: { setMask: { mutate: vi.fn() }, setAudioEnabled: { mutate: vi.fn() } },
    streamBroker: { setDeviceAudioMute: { mutate: vi.fn() } },
  }
}

describe('applyCameraFunctionWrite', () => {
  it('recording touches `enabled` and leaves `bands` byte for byte', async () => {
    // `bands` is the only intent written by the operator and `mode` derives from it:
    // emptying them to say "off" destroys the schedule and turning back on would not
    // record anything any more.
    const api = fakeApi()
    await applyCameraFunctionWrite(api, 101, { kind: 'recording-enabled', enabled: false }, 'hub')
    expect(api.recordingArchive.setDeviceConfig.mutate).toHaveBeenCalledWith({
      deviceId: 101,
      config: { enabled: false, bands: ['B'] },
    })
  })

  it('broker-audio is PINNED to the node that owns the source', async () => {
    const api = fakeApi()
    await applyCameraFunctionWrite(api, 101, { kind: 'broker-audio-mute', muted: true }, 'agent-1')
    const [input, opts] = api.streamBroker.setDeviceAudioMute.mutate.mock.calls[0]!
    expect(input).toEqual({ deviceId: 101, muted: true })
    expect(opts).toBeDefined()
  })

  it('refuses broker-audio without a node instead of writing to the hub', async () => {
    const api = fakeApi()
    await expect(
      applyCameraFunctionWrite(api, 101, { kind: 'broker-audio-mute', muted: true }, null),
    ).rejects.toThrow(/source node/)
    expect(api.streamBroker.setDeviceAudioMute.mutate).not.toHaveBeenCalled()
  })

  it('the mask writes only `enabled`, never the regions', async () => {
    const api = fakeApi()
    await applyCameraFunctionWrite(api, 101, { kind: 'camera-mask', enabled: true }, 'hub')
    expect(api.privacyMask.setMask.mutate).toHaveBeenCalledWith({
      deviceId: 101,
      patch: { enabled: true },
    })
  })
})
