/**
 * planning#720 — a camera whose frames are refused because no inference device
 * is usable says so once per change, not once per frame.
 */
import { describe, expect, it } from 'vitest'
import { InferenceDeviceUnusableError } from '../../detection-pipeline/engine/inference-device-liveness.js'
import { InferenceRefusalNotes, inferenceDeviceRefusalOf } from '../inference-refusal-notes.js'

const GPU_FAILED =
  'inference device "openvino:gpu" is failed after 0 pool death(s): Failed to load model at index 0: no-gpu-device: OpenVINO sees no supported GPU'

describe('inferenceDeviceRefusalOf', () => {
  it('names the device and the state the executor refused with', () => {
    expect(inferenceDeviceRefusalOf(GPU_FAILED)).toEqual({
      deviceKey: 'openvino:gpu',
      state: 'failed',
    })
    expect(
      inferenceDeviceRefusalOf(
        'rpc failed: inference device "edgetpu:usb" is backoff after 1 pool death(s): hung',
      ),
    ).toEqual({ deviceKey: 'edgetpu:usb', state: 'backoff' })
  })

  it('reads the sentence the REAL executor error writes, in both states', () => {
    for (const state of ['failed', 'backoff'] as const) {
      const error = new InferenceDeviceUnusableError({
        deviceKey: 'openvino:gpu',
        state,
        since: 1,
        deaths: 3,
        lastError: 'no-gpu-device: OpenVINO sees no supported GPU',
      })
      // As it crosses the cap boundary: the message, with a transport prefix.
      expect(inferenceDeviceRefusalOf(`runPipeline failed: ${error.message}`)).toEqual({
        deviceKey: 'openvino:gpu',
        state,
      })
    }
  })

  it('any other fault is not a refusal', () => {
    expect(inferenceDeviceRefusalOf('PoolWorker[w0]: not initialized')).toBeNull()
    expect(inferenceDeviceRefusalOf('inference device "x" is busy')).toBeNull()
  })
})

describe('InferenceRefusalNotes', () => {
  it('owes one line per camera per change, and one when frames are served again', () => {
    const notes = new InferenceRefusalNotes()
    const failed = { deviceKey: 'openvino:gpu', state: 'failed' } as const
    expect(notes.refused(7, failed)).toBe(true)
    for (let frame = 0; frame < 100; frame++) expect(notes.refused(7, failed)).toBe(false)
    // Another camera is its own line.
    expect(notes.refused(8, failed)).toBe(true)
    // The state changed: said again.
    expect(notes.refused(7, { deviceKey: 'openvino:gpu', state: 'backoff' })).toBe(true)
    // Served again: owed once, then quiet.
    expect(notes.served(7)).toBe(true)
    expect(notes.served(7)).toBe(false)
    expect(notes.refused(7, failed)).toBe(true)
  })
})
