/**
 * HomeKit Secure Video is advertised IF AND ONLY IF the operator turned it on
 * for this camera.
 *
 * It used to be advertised unconditionally, with a stub delegate whose
 * `handleRecordingStreamRequest` returned without yielding a single
 * `RecordingPacket`, so it never set `RecordingPacket.isLast`. hap-nodejs
 * answered every request with `Delegate finished streaming for N without
 * setting RecordingPacket.isLast` and the controller then sat through a ~12 s
 * timeout — on every camera with motion detection, every 20-60 s, all day
 * (D50). It was then withdrawn entirely for want of a live fMP4 source.
 *
 * There is one now (D80, D84), so the withdrawal is no longer unconditional —
 * it is the DEFAULT. These tests drive the REAL `buildCameraAccessory` against
 * a faked device proxy and assert both halves: off ⇒ neither recording service
 * exists; on ⇒ both do, plus the controller's own MotionSensor (HKSV derives
 * its motion trigger from that one and is blind to any other).
 */

import type { AddonContext } from '@camstack/types'
import { Service, uuid } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'
import { createHapDecodeMemos } from '../builders/stream-hwaccel-memo.js'
import { buildCameraAccessory } from '../camera-accessory.js'
import type { CameraMapperOptions } from '../types.js'

const DEVICE_ID = 101

const OPTIONS: CameraMapperOptions = {
  decodeMemos: createHapDecodeMemos(),
  resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
  hksvClipStore: null,
  hapDeviceSettings: { streamPreference: 'auto' },
}

/** The same camera with the operator's per-camera HKSV switch turned on. */
const OPTIONS_RECORDING: CameraMapperOptions = {
  ...OPTIONS,
  hapDeviceSettings: { streamPreference: 'auto', hksvRecording: true },
}

/** Recording on, and the operator's transcode switch OFF: copy or nothing. */
const OPTIONS_RECORDING_NO_TRANSCODE: CameraMapperOptions = {
  ...OPTIONS,
  hapDeviceSettings: { streamPreference: 'auto', hksvRecording: true, allowTranscode: false },
}

interface LogLine {
  readonly message: string
  readonly meta: Record<string, unknown>
}

function makeLogger(sink: LogLine[] = []): AddonContext['logger'] {
  const record = (message: string, payload?: { meta?: Record<string, unknown> }): void => {
    sink.push({ message, meta: payload?.meta ?? {} })
  }
  const logger = {
    debug: () => {},
    info: record,
    warn: record,
    error: record,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/**
 * Minimal stand-in for the pieces of `AddonContext` the camera orchestrator
 * touches. `motion-detection` is bound on purpose: it was the exact gate that
 * used to wire the HKSV stub, so a test without it would pass for the wrong
 * reason.
 */
function makeCtx(over: { codec?: string; logs?: LogLine[] } = {}): AddonContext {
  const proxy = {
    deviceId: DEVICE_ID,
    binding: {
      entries: [{ capName: 'motion-detection' }, { capName: 'camera-streams' }],
    },
    deviceManager: {
      getDevice: async () => ({ name: 'Cam 101', metadata: {} }),
      getChildren: async () => [],
    },
    motion: { isDetected: async () => false },
    cameraStreams: {
      getProfileRtspEntries: async () => [
        {
          profile: 'mid',
          brokerId: `${DEVICE_ID}/mid`,
          url: `rtsp://hub/${DEVICE_ID}/mid`,
          mutedUrl: `rtsp://hub/${DEVICE_ID}/mid?muted=1`,
          enabled: true,
          codec: over.codec ?? 'h264',
          resolution: { width: 1280, height: 720 },
        },
      ],
      getBrokerStreams: async () => [],
      getCameraStreams: async () => [],
    },
    webrtcSession: { listStreams: async () => [] },
  }
  const ctx = {
    logger: makeLogger(over.logs),
    eventBus: { subscribe: () => () => {} },
    fetchDevice: async () => proxy,
  }
  // Documented type boundary: `AddonContext` is the kernel's full injected
  // surface and this fake supplies only the three members the camera
  // orchestrator reaches for. Widening the fake to the whole interface would
  // add hundreds of lines that assert nothing.
  return ctx as unknown as AddonContext
}

/** UUIDs hap-nodejs assigns to the two services `recording` brings with it. */
const CAMERA_RECORDING_MANAGEMENT_UUID = Service.CameraRecordingManagement.UUID
const CAMERA_OPERATING_MODE_UUID = Service.CameraOperatingMode.UUID

describe('buildCameraAccessory — HKSV withdrawal (a camera we cannot serve)', () => {
  // Withdrawal is now a statement about the CAMERA, not a preference: the
  // per-camera switch is gone and HomeKit owns the decision (D589). What must
  // still never happen is offering a toggle backed by nothing.
  it('does not add CameraRecordingManagement', async () => {
    const mapper = await buildCameraAccessory({
      ctx: makeCtx({ codec: 'hevc' }),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: OPTIONS_RECORDING_NO_TRANSCODE,
    })

    const uuids = mapper.accessory.services.map((s) => s.UUID)
    expect(uuids).not.toContain(CAMERA_RECORDING_MANAGEMENT_UUID)
    await mapper.dispose()
  })

  it('does not add CameraOperatingMode — the service the stub also dragged in', async () => {
    const mapper = await buildCameraAccessory({
      ctx: makeCtx({ codec: 'hevc' }),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: OPTIONS_RECORDING_NO_TRANSCODE,
    })

    const uuids = mapper.accessory.services.map((s) => s.UUID)
    expect(uuids).not.toContain(CAMERA_OPERATING_MODE_UUID)
    await mapper.dispose()
  })

  it('still publishes the live camera + motion services', async () => {
    // Guards against the withdrawal being "passed" by an accessory that
    // failed to build anything at all.
    const mapper = await buildCameraAccessory({
      ctx: makeCtx(),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: OPTIONS,
    })

    const uuids = mapper.accessory.services.map((s) => s.UUID)
    expect(uuids).toContain(Service.CameraRTPStreamManagement.UUID)
    expect(uuids).toContain(Service.MotionSensor.UUID)
    expect(mapper.accessory.UUID).toBe(uuid.generate(`camstack:camera:${DEVICE_ID}`))
    await mapper.dispose()
  })
})

describe('buildCameraAccessory — HKSV advertised', () => {
  it('adds BOTH recording services when the operator turned it on', async () => {
    const mapper = await buildCameraAccessory({
      ctx: makeCtx(),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: OPTIONS_RECORDING,
    })

    const uuids = mapper.accessory.services.map((s) => s.UUID)
    expect(uuids).toContain(CAMERA_RECORDING_MANAGEMENT_UUID)
    expect(uuids).toContain(CAMERA_OPERATING_MODE_UUID)
    await mapper.dispose()
  })

  it("publishes exactly ONE MotionSensor — the controller's, adopted by the builder", async () => {
    // HKSV derives `EventTriggerOption.MOTION` from the service the
    // CameraController created and is blind to any other. A second sensor added
    // beside it would keep working in the Home app while triggering NO
    // recording at all — a failure with no symptom except an empty timeline.
    const mapper = await buildCameraAccessory({
      ctx: makeCtx(),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: OPTIONS_RECORDING,
    })

    const motion = mapper.accessory.services.filter((s) => s.UUID === Service.MotionSensor.UUID)
    expect(motion).toHaveLength(1)
    await mapper.dispose()
  })

  it('still withholds recording when the camera has no H.264 slot and no transcode is allowed', async () => {
    // A permanent transcode was measured at 128x the copy branch, so it happens
    // only where the operator allowed it. With the switch off the picker
    // refuses, and the ADVERTISEMENT must go with it rather than promise a
    // toggle backed by nothing.
    const ctx = makeCtx({ codec: 'hevc' })
    const mapper = await buildCameraAccessory({
      ctx,
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options: OPTIONS_RECORDING_NO_TRANSCODE,
    })

    const uuids = mapper.accessory.services.map((s) => s.UUID)
    expect(uuids).not.toContain(CAMERA_RECORDING_MANAGEMENT_UUID)
    await mapper.dispose()
  })
})

/**
 * A store stand-in. Only its IDENTITY matters here — whether the tee is built
 * at all is decided before a single method is called, which is the point: a
 * camera the operator switched off must not reach the store, not merely fail
 * once it gets there.
 */
function fakeClipStore(): CameraMapperOptions['hksvClipStore'] {
  const store = {
    maxClipBytes: 1_000,
    open: async () => null,
    listRecords: async () => [],
    acknowledge: async () => {},
  }
  // Documented type boundary: the builder only ever passes this object on.
  return store as unknown as NonNullable<CameraMapperOptions['hksvClipStore']>
}

describe('buildCameraAccessory — the clip tee is per camera, and `clipsKept` is honest', () => {
  async function advertise(options: CameraMapperOptions): Promise<LogLine | undefined> {
    const logs: LogLine[] = []
    const mapper = await buildCameraAccessory({
      ctx: makeCtx({ logs }),
      deviceId: String(DEVICE_ID),
      displayName: 'Cam 101',
      options,
    })
    await mapper.dispose()
    return logs.find((l) => l.message.includes('HKSV ADVERTISED'))
  }

  it('tees when the operator left the switch alone and a store exists', async () => {
    const line = await advertise({
      ...OPTIONS_RECORDING,
      hksvClipStore: fakeClipStore(),
    })
    expect(line?.meta).toMatchObject({ clipsKept: true, clipsSwitchedOn: true })
  })

  it('does NOT tee when the operator switched the copies off for this camera', async () => {
    // The failure this exists for: `clipsKept` saying true because a store was
    // configured, while the operator had turned the camera's copies off. The
    // log is the only place that answers "is this camera being kept?".
    const line = await advertise({
      ...OPTIONS_RECORDING,
      hksvClipStore: fakeClipStore(),
      hapDeviceSettings: {
        ...OPTIONS_RECORDING.hapDeviceSettings,
        keepHomekitClips: false,
      },
    })
    expect(line?.meta).toMatchObject({ clipsKept: false, clipsSwitchedOn: false })
  })

  it('separates "switched off" from "no store", because they are different fixes', async () => {
    const line = await advertise({ ...OPTIONS_RECORDING, hksvClipStore: null })
    expect(line?.meta).toMatchObject({ clipsKept: false, clipsSwitchedOn: true })
  })
})
