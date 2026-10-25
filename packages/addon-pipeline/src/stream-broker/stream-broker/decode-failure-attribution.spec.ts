import { describe, expect, it } from 'vitest'
import { isDecodeBackendFailure } from './decode-failure-attribution.js'

describe('isDecodeBackendFailure — who is actually at fault', () => {
  it('blames the backend for a device that could not be created', () => {
    // The real VAAPI failure, measured on the hub: ten concurrent 4K decodes
    // in the detection addon and a new device returns ENOMEM.
    expect(
      isDecodeBackendFailure(
        'egress push exited (code=244, signal=null): [hwupload @ 0x1] Device creation failed: -12',
      ),
    ).toBe(true)
    expect(isDecodeBackendFailure('Failed to create VAAPI device')).toBe(true)
    expect(isDecodeBackendFailure('No VA display found for device /dev/dri/renderD128')).toBe(true)
  })

  it('does NOT blame it for an input that was not there yet', () => {
    // Measured 2026-09-13 17:48: the egress child was spawned three seconds
    // before its source publisher materialised (`materializeMs=5486`), opened
    // an RTSP endpoint nobody was publishing to, and died. The decoder was
    // never reached — and quarantining it cost every OTHER camera hardware
    // decode for the next thirty minutes.
    expect(
      isDecodeBackendFailure(
        'egress push exited (code=183, signal=null): [in#0 @ 0x6880e80] Error opening input: Invalid data found when processing input',
      ),
    ).toBe(false)
    expect(isDecodeBackendFailure('Connection refused')).toBe(false)
    expect(isDecodeBackendFailure('Server returned 404 Not Found')).toBe(false)
    expect(isDecodeBackendFailure('Immediate exit requested')).toBe(false)
  })

  it('an INPUT failure wins even when the argv mentions the backend', () => {
    // The argv always carries `-hwaccel vaapi`, so a naive substring match on
    // the backend name would blame it for every failure ever logged.
    expect(
      isDecodeBackendFailure(
        'ffmpeg -hwaccel vaapi -i rtsp://x failed: Error opening input: Invalid data found when processing input',
      ),
    ).toBe(false)
  })

  it('an unattributable failure BLAMES the backend — the conservative side', () => {
    // Unknown is not "innocent": a backend that dies in a way nobody has seen
    // before should still be quarantined, because the cost of one wrong
    // quarantine is software decode, and the cost of missing a real one is
    // every session paying a three-second death.
    expect(isDecodeBackendFailure('exited (code=1, signal=null)')).toBe(true)
    expect(isDecodeBackendFailure('')).toBe(true)
  })
})
