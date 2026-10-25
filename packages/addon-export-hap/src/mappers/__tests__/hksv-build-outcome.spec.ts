/**
 * A camera HomeKit never recorded must be able to SAY so.
 *
 * `buildHksvRecording` already logs each of its three refusals with
 * `tags: { deviceId }` — and a log line is not an answer to a surface. The clip
 * source's `index-empty` state ("the switch says record and the store holds
 * nothing") is only honest if it can name WHICH refusal fired, so the build
 * writes its verdict to a mirror the source reads (`build-outcome.ts`).
 *
 * Driven through the REAL `buildCameraAccessory`, the same way the withdrawal
 * itself is tested: a fake that "notes" an outcome nothing ever writes would
 * pass while the wire lied.
 */
import type { AddonContext } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import type { HksvBuildOutcome } from '../../hksv/build-outcome.js'
import { createHapDecodeMemos } from '../builders/stream-hwaccel-memo.js'
import { buildCameraAccessory } from '../camera-accessory.js'
import type { CameraMapperOptions } from '../types.js'

const DEVICE_ID = 101

function makeLogger(): AddonContext['logger'] {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeCtx(codec: string): AddonContext {
  const proxy = {
    deviceId: DEVICE_ID,
    binding: { entries: [{ capName: 'motion-detection' }, { capName: 'camera-streams' }] },
    deviceManager: {
      getDevice: async () => ({ name: 'Cam 101', metadata: {} }),
      getChildren: async () => [],
    },
    motion: { isDetected: async () => false },
    cameraStreams: {
      getProfileRtspEntries: async () => [
        {
          profile: 'mid',
          brokerId: `${String(DEVICE_ID)}/mid`,
          url: `rtsp://hub/${String(DEVICE_ID)}/mid`,
          mutedUrl: `rtsp://hub/${String(DEVICE_ID)}/mid?muted=1`,
          enabled: true,
          codec,
          resolution: { width: 1280, height: 720 },
        },
      ],
      getBrokerStreams: async () => [],
      getCameraStreams: async () => [],
    },
    webrtcSession: { listStreams: async () => [] },
  }
  const ctx = {
    logger: makeLogger(),
    eventBus: { subscribe: () => () => {} },
    fetchDevice: async () => proxy,
  }
  // Documented type boundary, as in `camera-accessory-recording.spec.ts`: the
  // orchestrator reaches for three members of `AddonContext` and this supplies
  // exactly those.
  return ctx as unknown as AddonContext
}

function optionsNoting(
  noted: HksvBuildOutcome[],
  codecRecording = true,
  allowTranscode = true,
): CameraMapperOptions {
  return {
    decodeMemos: createHapDecodeMemos(),
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    hksvClipStore: null,
    noteHksvOutcome: (outcome) => noted.push(outcome),
    hapDeviceSettings: { streamPreference: 'auto', hksvRecording: codecRecording, allowTranscode },
  }
}

describe('buildHksvRecording records its verdict for the clip source', () => {
  it('names the refusal when the camera has no H.264 slot and the operator refuses a transcode', async () => {
    const noted: HksvBuildOutcome[] = []
    const mapper = await buildCameraAccessory({
      ctx: makeCtx('hevc'),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: optionsNoting(noted, true, false),
    })
    expect(noted).toHaveLength(1)
    expect(noted[0]?.deviceId).toBe(DEVICE_ID)
    expect(noted[0]?.advertised).toBe(false)
    expect(noted[0]?.withheld).toBe('no-recordable-stream')
    expect(noted[0]?.detail).toBeTruthy()
    await mapper.dispose()
  })

  it('advertises an H.265 camera when transcoding is allowed — 14 of this fleet have no other way', async () => {
    const noted: HksvBuildOutcome[] = []
    const mapper = await buildCameraAccessory({
      ctx: makeCtx('hevc'),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: optionsNoting(noted, true, true),
    })
    expect(noted).toHaveLength(1)
    expect(noted[0]?.advertised).toBe(true)
    expect(noted[0]?.withheld).toBeNull()
    await mapper.dispose()
  })

  it('records the ADVERTISED case too — silence is not a verdict', async () => {
    const noted: HksvBuildOutcome[] = []
    const mapper = await buildCameraAccessory({
      ctx: makeCtx('h264'),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: optionsNoting(noted),
    })
    expect(noted).toHaveLength(1)
    expect(noted[0]?.advertised).toBe(true)
    expect(noted[0]?.withheld).toBeNull()
    await mapper.dispose()
  })
})
