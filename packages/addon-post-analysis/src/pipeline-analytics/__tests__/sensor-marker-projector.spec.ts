/**
 * Sensor markers — the projection from a mapped sensor/control cap state
 * change to a synthetic track on the camera's timeline.
 *
 * The red test is the first one: a doorbell cap is bound on the CAMERA
 * itself, so the camera is linked to nothing and `camerasFor` answers []. That
 * is exactly camera 101 on 2026-08-08 06:59Z — the press produced a
 * `SensorEvent` row, a HomeKit ring, an Alexa post and a matched notification
 * rule, and no track at all.
 *
 * Also covers: the history-row ingest and this projection resolve the SAME
 * cameras (one derivation), and every branch that lands no marker reports a
 * reason.
 */
import { describe, expect, it } from 'vitest'
import { ingestSensorStateChange, LinkedCamerasCache } from '../services/event-kinds.js'
import {
  projectSensorMarkers,
  SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS,
  type SensorMarkerProjected,
  type SensorMarkerSink,
  type SensorMarkerSkipped,
} from '../services/sensor-marker-projector.js'
import type { SyntheticTrackInput } from '../services/synthetic-track.js'

/** A cache whose index/camera set is seeded directly (no device-manager). */
function seededCache(
  index: ReadonlyMap<number, readonly number[]>,
  cameraIds: readonly number[],
): LinkedCamerasCache {
  const cache = new LinkedCamerasCache({
    cameras: { listCameraIds: async () => cameraIds },
    linkedDevices: { getLinkedDevices: async () => ({ mode: 'manual', devices: [] }) },
  })
  cache.seed(index, Date.now(), cameraIds)
  return cache
}

interface Harness {
  readonly inputs: SyntheticTrackInput[]
  readonly projected: SensorMarkerProjected[]
  readonly skipped: SensorMarkerSkipped[]
  readonly markers: SensorMarkerSink
}

function harness(materializes = true): Harness {
  const inputs: SyntheticTrackInput[] = []
  let n = 0
  return {
    inputs,
    projected: [],
    skipped: [],
    markers: {
      materializeOrShare: async (input) => {
        inputs.push(input)
        return materializes
          ? { kind: 'materialized', track: { trackId: `synth-${n++}`, snapshots: [{}] } }
          : { kind: 'not-materialized' }
      },
    },
  }
}

describe('projectSensorMarkers', () => {
  it('projects a marker onto the camera when the cap is bound on the CAMERA ITSELF', async () => {
    // Camera 101 carries a composed doorbell (D671). It is linked to no
    // other camera, and no other device is linked to it.
    const cache = seededCache(new Map(), [101])
    const h = harness()

    const landed = await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => 'Front door',
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 101, capName: 'doorbell' },
      1_786_172_340_934,
    )

    expect(landed).toBe(1)
    expect(h.skipped).toEqual([])
    expect(h.inputs).toEqual([
      {
        cameraId: 101,
        sourceDeviceId: 101,
        source: 'sensor',
        kind: 'doorbell',
        timestamp: 1_786_172_340_934,
        producingDeviceName: 'Front door',
        // The notification about this press waits for the marker, so the
        // marker's snapshot is bounded — see SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS.
        snapshotTimeoutMs: SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS,
      },
    ])
    expect(h.projected[0]).toMatchObject({
      cameraId: 101,
      kind: 'doorbell',
      selfCamera: true,
      trackId: 'synth-0',
      // The marker carries its frame ⇒ the notification has one to attach.
      hasMedia: true,
    })
  })

  it('projects onto every LINKED camera of a sensor that is not itself a camera', async () => {
    const cache = seededCache(new Map([[42, [101, 102]]]), [101, 102])
    const h = harness()

    const landed = await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => 'Front Door Contact',
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 42, capName: 'contact' },
      1000,
    )

    expect(landed).toBe(2)
    expect(h.inputs.map((i) => i.cameraId)).toEqual([101, 102])
    expect(h.projected.every((p) => p.selfCamera === false)).toBe(true)
  })

  it('resolves the SAME cameras as the history-row ingest — one derivation', async () => {
    // The divergence this guards: the ingest gained the self-camera half and
    // the projection did not, so 101 got a row and no marker.
    const rows: number[] = []
    const cache = seededCache(new Map(), [101])
    const h = harness()

    await ingestSensorStateChange(
      {
        sink: { insert: async (ev) => void rows.push(ev.deviceId) },
        cache,
      },
      { deviceId: 101, capName: 'doorbell', slice: { lastPressedAt: 1 } },
      1000,
    )
    await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 101, capName: 'doorbell' },
      1000,
    )

    expect(rows).toEqual([101])
    expect(h.inputs.map((i) => i.cameraId)).toEqual(rows)
  })

  it("says WHY when a camera's own excluded native cap projects nothing", async () => {
    const cache = seededCache(new Map(), [104])
    const h = harness()

    const landed = await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 104, capName: 'motion' },
      1000,
    )

    expect(landed).toBe(0)
    expect(h.inputs).toEqual([])
    expect(h.skipped).toEqual([
      {
        cameraId: null,
        sourceDeviceId: 104,
        capName: 'motion',
        kind: 'motion-sensor',
        reason: 'camera-native-cap',
      },
    ])
  })

  it('says WHY when the device is neither a camera nor linked to one', async () => {
    const cache = seededCache(new Map(), [101])
    const h = harness()

    await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 99, capName: 'contact' },
      1000,
    )

    expect(h.skipped.map((s) => s.reason)).toEqual(['no-camera'])
  })

  it('says WHY when the cap carries no taxonomy kind', async () => {
    const cache = seededCache(new Map(), [101])
    const h = harness()

    await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 101, capName: 'battery-operated' },
      1000,
    )

    expect(h.skipped.map((s) => s.reason)).toEqual(['unmapped-cap'])
  })

  it('reports a failed materialize instead of dropping it silently', async () => {
    const cache = seededCache(new Map(), [101])
    const h = harness(false)

    const landed = await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 101, capName: 'doorbell' },
      1000,
    )

    expect(landed).toBe(0)
    expect(h.projected).toEqual([])
    expect(h.skipped).toEqual([
      {
        cameraId: 101,
        sourceDeviceId: 101,
        capName: 'doorbell',
        kind: 'doorbell',
        reason: 'not-materialized',
      },
    ])
  })

  it('projects a DEBOUNCED change onto the window marker, by its own reason — never a skip', async () => {
    const cache = seededCache(new Map(), [101])
    const h = harness()
    h.markers.materializeOrShare = async () => ({
      kind: 'debounced',
      track: { trackId: 'pa-synth-window', snapshots: [{}] },
    })

    const landed = await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 101, capName: 'doorbell' },
      1000,
    )

    expect(landed).toBe(1)
    expect(h.skipped).toEqual([])
    expect(h.projected[0]).toMatchObject({
      cameraId: 101,
      trackId: 'pa-synth-window',
      hasMedia: true,
      via: 'debounced',
    })
  })

  it('reports a marker that landed WITHOUT its picture — the notification has none either', async () => {
    // The marker is the doorbell notification's media owner. A snapshot that
    // timed out still lands the track, and this is the flag that tells the
    // notification path (and the log) there is nothing to attach.
    const cache = seededCache(new Map(), [101])
    const h = harness()
    h.markers.materializeOrShare = async () => ({
      kind: 'materialized',
      track: { trackId: 'synth-nomedia', snapshots: [] },
    })

    const landed = await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 101, capName: 'doorbell' },
      1000,
    )

    expect(landed).toBe(1)
    expect(h.skipped).toEqual([])
    expect(h.projected[0]).toMatchObject({ trackId: 'synth-nomedia', hasMedia: false })
  })

  it('materializes every camera concurrently — N slow snapshots cost one bound, not N', async () => {
    // The notification waits for these markers: three cameras one after
    // another used to cost three snapshot bounds before the centre saw a thing.
    const cache = seededCache(new Map([[3243, [101, 102, 620]]]), [101, 102, 620])
    let inFlight = 0
    let peak = 0
    const markers: SensorMarkerSink = {
      materializeOrShare: async (input) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        return { kind: 'materialized', track: { trackId: `t-${input.cameraId}`, snapshots: [] } }
      },
    }
    const projected: number[] = []

    const landed = await projectSensorMarkers(
      {
        cache,
        markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void projected.push(r.cameraId),
        onSkipped: () => undefined,
      },
      { deviceId: 3243, capName: 'contact' },
      1_000,
    )

    expect(landed).toBe(3)
    expect(peak).toBe(3)
    // Reported in CAMERA order, whatever order the snapshots answered in.
    expect(projected).toEqual([101, 102, 620])
  })

  it('reports a THROWING materialize as not-materialized on ITS camera — the others still land', async () => {
    const cache = seededCache(new Map([[3243, [101, 102]]]), [101, 102])
    const h = harness()
    h.markers.materializeOrShare = async (input) => {
      if (input.cameraId === 101) throw new Error('persist exploded')
      return { kind: 'materialized', track: { trackId: `t-${input.cameraId}`, snapshots: [{}] } }
    }

    const landed = await projectSensorMarkers(
      {
        cache,
        markers: h.markers,
        producingDeviceName: async () => undefined,
        onProjected: (r) => void h.projected.push(r),
        onSkipped: (r) => void h.skipped.push(r),
      },
      { deviceId: 3243, capName: 'contact' },
      1_000,
    )

    expect(landed).toBe(1)
    expect(h.projected.map((r) => r.cameraId)).toEqual([102])
    expect(h.skipped).toEqual([
      {
        cameraId: 101,
        sourceDeviceId: 3243,
        capName: 'contact',
        kind: 'contact',
        reason: 'not-materialized',
        // A rejection is a bug, not a debounce: its message travels with the
        // skip so the caller can log it at WARN on the camera.
        error: 'persist exploded',
      },
    ])
  })
})
