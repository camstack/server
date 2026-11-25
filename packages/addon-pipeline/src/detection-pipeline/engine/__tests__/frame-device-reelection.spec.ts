/**
 * A session elected onto a device that is in backoff (its pool died — the
 * Coral USB libedgetpu stall on agent-b) used to keep sending every frame
 * at it, and every frame was refused by `refuseIfDeviceUnusable` until the
 * session ended. A live frame now re-elects: the node's default pool serves it
 * while the elected device is unusable, and the camera says so — once per
 * change, with the device and the camera.
 */
import { describe, expect, it } from 'vitest'
import type { InferenceDeviceUnhealthy } from '../inference-device-liveness.js'
import { nextUsableDefaultDevice } from '../default-device-rederivation.js'
import { FrameReelectionNotes, routeLiveFrameDevice } from '../frame-device-reelection.js'

const usbBackoff: InferenceDeviceUnhealthy = {
  deviceKey: 'edgetpu:usb',
  state: 'backoff',
  since: 1,
  deaths: 1,
  lastError: 'pool worker hung',
}

const unusable =
  (bad: readonly InferenceDeviceUnhealthy[]) =>
  (deviceKey: string): InferenceDeviceUnhealthy | null =>
    bad.find((b) => b.deviceKey === deviceKey) ?? null

describe('routeLiveFrameDevice', () => {
  it('a healthy elected device serves its frames', () => {
    expect(
      routeLiveFrameDevice({
        requestedDeviceKey: 'edgetpu:usb',
        defaultDeviceKey: 'openvino:gpu',
        unusable: unusable([]),
      }),
    ).toEqual({ kind: 'as-elected', deviceKey: 'edgetpu:usb' })
  })

  it('an elected device in backoff re-elects the frame onto the node default pool', () => {
    expect(
      routeLiveFrameDevice({
        requestedDeviceKey: 'edgetpu:usb',
        defaultDeviceKey: 'openvino:gpu',
        unusable: unusable([usbBackoff]),
      }),
    ).toEqual({ kind: 're-elected', deviceKey: undefined, from: usbBackoff, to: 'openvino:gpu' })
  })

  it('no alternative when the default pool is the same device or unusable too', () => {
    expect(
      routeLiveFrameDevice({
        requestedDeviceKey: 'edgetpu:usb',
        defaultDeviceKey: 'edgetpu:usb',
        unusable: unusable([usbBackoff]),
      }),
    ).toMatchObject({ kind: 'no-alternative', deviceKey: 'edgetpu:usb' })
    expect(
      routeLiveFrameDevice({
        requestedDeviceKey: 'edgetpu:usb',
        defaultDeviceKey: 'openvino:gpu',
        unusable: unusable([usbBackoff, { ...usbBackoff, deviceKey: 'openvino:gpu' }]),
      }),
    ).toMatchObject({ kind: 'no-alternative', deviceKey: 'edgetpu:usb' })
  })

  it('no elected device means the default pool, as before', () => {
    expect(
      routeLiveFrameDevice({
        requestedDeviceKey: undefined,
        defaultDeviceKey: 'openvino:gpu',
        unusable: unusable([usbBackoff]),
      }),
    ).toEqual({ kind: 'as-elected', deviceKey: undefined })
  })

  // planning#720: a frame with no elected device and an unusable default pool
  // has nowhere to go on this node — a routing of its own, so the camera says
  // it once instead of failing every frame without a line.
  it('no elected device and an unusable default pool is no-alternative', () => {
    const gpuFailed: InferenceDeviceUnhealthy = {
      ...usbBackoff,
      deviceKey: 'openvino:gpu',
      state: 'failed',
    }
    expect(
      routeLiveFrameDevice({
        requestedDeviceKey: undefined,
        defaultDeviceKey: 'openvino:gpu',
        unusable: unusable([gpuFailed]),
      }),
    ).toEqual({ kind: 'no-alternative', deviceKey: undefined, from: gpuFailed })
  })
})

describe('nextUsableDefaultDevice', () => {
  const poolKeyOf = (candidate: string): string => (candidate === 'cpu' ? 'cpu:cpu' : candidate)

  it('moves down the enumerated list, past the current default and every failed device', () => {
    expect(
      nextUsableDefaultDevice({
        candidates: ['openvino:npu', 'openvino:gpu', 'cpu'],
        currentKey: 'openvino:gpu',
        poolKeyOf,
        failed: (key) => key === 'openvino:gpu' || key === 'openvino:npu',
      }),
    ).toBe('cpu')
  })

  it('a device failed under its pool key is skipped too, and nothing left is null', () => {
    expect(
      nextUsableDefaultDevice({
        candidates: ['openvino:gpu', 'cpu'],
        currentKey: 'openvino:gpu',
        poolKeyOf,
        failed: (key) => key === 'openvino:gpu' || key === 'cpu:cpu',
      }),
    ).toBeNull()
  })
})

describe('FrameReelectionNotes', () => {
  it('says each change once per camera: re-elected, then restored', () => {
    const notes = new FrameReelectionNotes()
    const away = routeLiveFrameDevice({
      requestedDeviceKey: 'edgetpu:usb',
      defaultDeviceKey: 'openvino:gpu',
      unusable: unusable([usbBackoff]),
    })
    const back = routeLiveFrameDevice({
      requestedDeviceKey: 'edgetpu:usb',
      defaultDeviceKey: 'openvino:gpu',
      unusable: unusable([]),
    })
    expect(notes.note(3835, away)).toMatchObject({ kind: 're-elected' })
    expect(notes.note(3835, away)).toBeNull()
    expect(notes.note(637, away)).toMatchObject({ kind: 're-elected' })
    expect(notes.note(3835, back)).toEqual({ kind: 'restored', deviceKey: 'edgetpu:usb' })
    expect(notes.note(3835, back)).toBeNull()
  })
})
