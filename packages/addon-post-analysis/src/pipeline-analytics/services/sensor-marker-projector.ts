/**
 * Sensor markers — the gate between "a mapped sensor/control cap changed
 * state" and "a synthetic track exists on the camera's timeline"
 * (event-kinds-taxonomy §8).
 *
 * It is the sibling of {@link ../services/audio-marker-projector.ts} and it
 * exists for the same reason: the projection has gates, and a gate that drops
 * work without saying so is indistinguishable from a feature that was never
 * wired.
 *
 * **What this fixes.** The projection used to resolve its cameras with
 * `camerasFor` alone — LINKED cameras only — while the history-row ingest
 * beside it had gained the self-camera half on 2026-08-07. A doorbell can be
 * served on the CAMERA itself (a composed doorbell, D671, writes the `doorbell`
 * slice onto camera 101; Reolink registers it at camera level), so
 * `camerasFor(101)` answered `[]` and the
 * projection returned on a `debug` line nobody runs at. Camera 101's real
 * press at 2026-08-08 06:59Z therefore produced a `SensorEvent` row, a HomeKit
 * ring, an Alexa post and a matched notification rule — and no track. Both
 * halves now derive their cameras from {@link resolveSensorEventCameras}.
 *
 * **The asymmetry that used to be here was defended by a wrong premise.** The
 * old comment argued a self-projected track would feed the NC `track-end`
 * trigger and make every press evaluate the camera's object rules. It does
 * not: `persistSyntheticTrack` writes the row directly and the NC track-end
 * hook lives in the LIVE tracker's closer, which no synthetic track ever
 * enters. A linked contact sensor has been projecting onto its camera all
 * along under exactly the same mechanism.
 *
 * **Nothing here is silent.** A marker that lands emits one `info` line; every
 * branch that lands none emits one line carrying the reason. Both carry
 * `tags: { deviceId }` with the CAMERA id, because the question always arrives
 * as "why did 102 get a marker and 101 not".
 *
 * **The marker is also the notification's PICTURE.** A doorbell press has no
 * detection behind it, so nothing else on the notification path owns a frame of
 * it — until 2026-08-08 every device-event notification this hub ever sent was
 * text-only for exactly that reason. The fix is not a second photograph taken at
 * delivery time: the marker this projector materialises already carries a
 * `keyFrameSmall` of the camera, taken BEFORE the track is persisted, and the
 * notification simply names that track as its media owner (`buildEntries` freezes
 * `subject.trackId`) and resolves it through the ordinary attachment ladder. One
 * snapshot, one owner, one persistence point — the producer's. That is why the
 * sensor half of `handleSensorStateChanged` now runs the projection BEFORE it
 * hands the row to the notification centre, and why the snapshot here is bounded
 * ({@link SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS}): the press is waiting on it.
 */
import { EVENT_KIND_BY_CAP, errMsg } from '@camstack/types'
import {
  type LinkedCamerasCache,
  resolveSensorEventCameras,
  type SensorIngestDropReason,
} from './event-kinds.js'
import type { SyntheticTrackInput } from './synthetic-track.js'

/**
 * The materializer half of {@link SyntheticTrackMaterializer}.
 *
 * `snapshots` is read for its LENGTH only — the projector never looks inside a
 * frame. It is here because a marker that landed WITHOUT its picture is the one
 * case the notification about that press has to know about: the marker is the
 * notification's media owner, so an empty `snapshots` is exactly why a doorbell
 * arrives text-only.
 */
export interface SensorMarkerSink {
  materializeOrShare(input: SyntheticTrackInput): Promise<SensorMarkerMaterialization>
}

/** The marker as the projector reads it: its id, and its snapshots for their LENGTH. */
export interface SensorMarkerTrack {
  readonly trackId: string
  readonly snapshots: readonly unknown[]
}

/**
 * What the sink answers. `debounced` is the WINDOW's marker — a second state
 * change of the same event inside the per-`(camera, kind)` window names the
 * marker the first one landed (with its media), never none.
 */
export type SensorMarkerMaterialization =
  | { readonly kind: 'materialized' | 'debounced'; readonly track: SensorMarkerTrack }
  | { readonly kind: 'not-materialized' }

/** Why a mapped sensor event produced no marker on a given camera. */
export type SensorMarkerSkipReason =
  | SensorIngestDropReason
  /** The cap carries no taxonomy kind — nothing to draw on a timeline. */
  | 'unmapped-cap'
  /**
   * A camera WAS resolved but no marker exists for it: the persist failed
   * (already reported through the materializer's own `onError`), the window's
   * marker this call was debounced into never landed, or the materialize call
   * for THIS camera rejected. A debounce into a marker that DID land is not a
   * skip — it is projected with `via: 'debounced'`.
   */
  | 'not-materialized'

/** One landed marker. */
export interface SensorMarkerProjected {
  readonly cameraId: number
  readonly sourceDeviceId: number
  readonly capName: string
  readonly kind: string
  readonly trackId: string
  /** True when the cap is bound on the camera itself (e.g. a camera-level doorbell). */
  readonly selfCamera: boolean
  /**
   * `materialized`: this change landed the marker. `debounced`: it fell inside
   * the window of an earlier change and names THAT marker — logged by its own
   * reason, so two state changes of one press read as one marker, twice.
   */
  readonly via: 'materialized' | 'debounced'
  /**
   * Whether the marker carries its snapshot.
   *
   * A marker is persisted either way — a track must never be lost for a picture
   * — but this is what decides whether the NOTIFICATION about the same press
   * has anything to attach, so it is reported rather than inferred.
   */
  readonly hasMedia: boolean
}

/** One marker that did NOT land, and why. */
export interface SensorMarkerSkipped {
  /** The camera it would have landed on; null when none was resolved at all. */
  readonly cameraId: number | null
  readonly sourceDeviceId: number
  readonly capName: string
  /** The taxonomy kind, or null when the cap maps to none. */
  readonly kind: string | null
  readonly reason: SensorMarkerSkipReason
  /**
   * The message of a materialize that REJECTED for this camera. Absent on
   * every ordinary skip (debounce, no camera, unmapped cap): a rejection is a
   * bug, not a debounce, and the caller logs it louder.
   */
  readonly error?: string
}

export interface SensorMarkerProjectorDeps {
  readonly cache: LinkedCamerasCache
  readonly markers: SensorMarkerSink
  /**
   * NAME of the device that produced the event, for the marker's label.
   * Best-effort: `undefined` leaves the marker unlabelled, it never blocks
   * the projection.
   */
  readonly producingDeviceName: (deviceId: number) => Promise<string | undefined>
  readonly onProjected: (r: SensorMarkerProjected) => void
  readonly onSkipped: (r: SensorMarkerSkipped) => void
  /**
   * How long the materializer may wait for the camera's snapshot.
   *
   * Tighter than the materializer's own default on purpose: the notification
   * about this press waits for this projection, because the marker is its media
   * owner. Past the bound the marker lands WITHOUT media (reported by the
   * materializer's `onError`) and the notification ships text-only — never the
   * other way round. See {@link SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS}.
   */
  readonly snapshotTimeoutMs?: number
}

/**
 * The bound a sensor marker's snapshot gets: 2.5 s.
 *
 * Measured rather than guessed — a `snapshot.getSnapshot` on camera 101 answers
 * in ~0.6 s end-to-end from OUTSIDE the hub (the cap serves a ≤10 s cached
 * frame; `force` is never set here). 2.5 s leaves four times the observed cost
 * and still bounds what the doorbell notification waits for.
 */
export const SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS = 2_500

/**
 * Project one `DeviceStateChanged` of a mapped sensor/control cap into a
 * synthetic track per camera the event belongs to. Returns the number of
 * markers that landed. Best-effort (telemetry, D8).
 *
 * Every camera is materialized CONCURRENTLY — the notification about this
 * event waits for the markers, so N cameras cost one snapshot bound, not N —
 * and reported afterwards in camera order. A materializer that throws for one
 * camera no longer propagates to the caller (where it was logged against the
 * SENSOR): it is reported as `not-materialized` on ITS camera, carrying the
 * rejection's message in `error`, and the other cameras still land.
 */
export async function projectSensorMarkers(
  deps: SensorMarkerProjectorDeps,
  data: { readonly deviceId: number; readonly capName: string },
  timestamp: number,
): Promise<number> {
  const descriptor = EVENT_KIND_BY_CAP[data.capName]
  if (descriptor === undefined) {
    deps.onSkipped({
      cameraId: null,
      sourceDeviceId: data.deviceId,
      capName: data.capName,
      kind: null,
      reason: 'unmapped-cap',
    })
    return 0
  }

  const { cameraIds, dropReason } = await resolveSensorEventCameras(deps.cache, data)
  if (dropReason !== null) {
    deps.onSkipped({
      cameraId: null,
      sourceDeviceId: data.deviceId,
      capName: data.capName,
      kind: descriptor.kind,
      reason: dropReason,
    })
    return 0
  }

  const producingDeviceName = await deps.producingDeviceName(data.deviceId)
  // Concurrently: the notification waits for these markers, and N cameras one
  // after another cost N snapshot bounds before the centre saw anything.
  // Reported in CAMERA order afterwards, so the log reads the same as before.
  const settled = await Promise.allSettled(
    cameraIds.map((cameraId) =>
      deps.markers.materializeOrShare({
        cameraId,
        sourceDeviceId: data.deviceId,
        source: 'sensor',
        kind: descriptor.kind,
        timestamp,
        snapshotTimeoutMs: deps.snapshotTimeoutMs ?? SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS,
        ...(producingDeviceName !== undefined ? { producingDeviceName } : {}),
      }),
    ),
  )
  let landed = 0
  settled.forEach((outcome, i) => {
    const cameraId = cameraIds[i]
    if (cameraId === undefined) return
    const result = outcome.status === 'fulfilled' ? outcome.value : null
    if (result === null || result.kind === 'not-materialized') {
      deps.onSkipped({
        cameraId,
        sourceDeviceId: data.deviceId,
        capName: data.capName,
        kind: descriptor.kind,
        reason: 'not-materialized',
        ...(outcome.status === 'rejected' ? { error: errMsg(outcome.reason) } : {}),
      })
      return
    }
    landed++
    deps.onProjected({
      cameraId,
      sourceDeviceId: data.deviceId,
      capName: data.capName,
      kind: descriptor.kind,
      trackId: result.track.trackId,
      selfCamera: cameraId === data.deviceId,
      hasMedia: result.track.snapshots.length > 0,
      via: result.kind,
    })
  })
  return landed
}
