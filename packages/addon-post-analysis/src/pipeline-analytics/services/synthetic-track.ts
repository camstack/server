/**
 * Synthetic tracks — the ONE projector for every non-spatial event that
 * deserves a marker on a camera's timeline (event-kinds-taxonomy §8, D62).
 *
 * A non-spatial event is projected into the UNIFIED track store as a
 * SYNTHETIC track: `className` = the event kind (`contact` / `lock` /
 * `switch` / `audio` …), a `source` naming the projection
 * ({@link SyntheticTrackSource}), media = an on-demand best shot of the
 * camera in the SAME `getTrackMedia` shape the UIs consume (no bbox → full
 * frame), persisted under `kind: 'keyFrameSmall'` — the kind the viewer
 * representative-image selectors (hero/clean/reel) actually consume; a
 * `'snapshot'`-kind blob is ignored by those chains, which is what stuck the
 * pa-synth reel on "loading". `positions: []`. It joins the timeline via the
 * existing time-based clustering — no new join mechanism.
 *
 * **There is deliberately only one of these.** Linked sensors were here
 * first; audio markers reuse it rather than growing a second projector,
 * because a parallel projector diverges — the `keyFrameSmall`-vs-`snapshot`
 * lesson above would have had to be re-learned per copy.
 *
 * The raw event (`SensorEvent`, `AudioEvent`) remains the durable record;
 * this track is its projection. Snapshots are debounced per `(camera, kind)`
 * so a chattery source doesn't hammer the snapshot cap. Spatial consumers
 * MUST skip synthetic tracks (they carry no trajectory) — see
 * {@link isSpatialTrack}.
 */
import { newTrackId } from '../pipeline/track-id.js'
import type { Track, TrackSource } from '@camstack/types'
import {
  downscaleFullFrameJpeg,
  SYNTHETIC_SNAPSHOT_MAX_HEIGHT,
  SYNTHETIC_SNAPSHOT_MAX_WIDTH,
} from '../../shared/frame/downscale-full-frame.js'

/** On-demand snapshot fetch (the `snapshot` cap, thin subset). */
export interface SnapshotClient {
  getSnapshot(input: {
    deviceId: number
    force?: boolean
  }): Promise<{ base64: string; contentType: string } | null>
}

/** Media write surface (MediaStore.put subset). Returns the media id (D482). */
export interface SyntheticTrackMediaSink {
  put(input: {
    deviceId: number
    ownerKind: 'track'
    ownerId: string
    kind: 'keyFrameSmall'
    timestamp: number
    data: Buffer
  }): Promise<number>
}

/** Track persist surface (TrackStore.persistSyntheticTrack subset). */
export interface SyntheticTrackSink {
  persistSyntheticTrack(track: Track): Promise<void>
}

export interface SyntheticTrackDeps {
  readonly snapshot: SnapshotClient
  readonly media: SyntheticTrackMediaSink
  readonly tracks: SyntheticTrackSink
  /** Min ms between snapshots for the same (camera, kind). Default 10s. */
  readonly debounceMs?: number
  /** Max ms to await the snapshot cap before skipping media. Default 10s. */
  readonly snapshotTimeoutMs?: number
  readonly makeId?: () => string
  readonly now?: () => number
  /**
   * Report a failed step. `deviceId` is the CAMERA the projection was for and
   * is passed on every call that has one — a snapshot that times out is asked
   * about per camera ("why does 101's doorbell marker have no picture?"), and a
   * line that cannot be grouped by camera cannot answer it.
   */
  readonly onError?: (scope: string, err: unknown, deviceId?: number) => void
}

/**
 * The `TrackSource` values this projector may write: everything EXCEPT
 * `pipeline`, which is the spatial pipeline's own and is never synthetic.
 * Excluding it in the type is what stops a caller mislabelling a
 * position-less track as a real one and readmitting it to the tracker.
 */
export type SyntheticTrackSource = Exclude<TrackSource, 'pipeline'>

export interface SyntheticTrackInput {
  /** The CAMERA the synthetic track is attributed to. */
  readonly cameraId: number
  /** The device whose event this is. For a linked sensor/control, the sensor;
   *  for an audio marker, the camera itself. */
  readonly sourceDeviceId: number
  /** Which projection this is — drives `Track.source`. */
  readonly source: SyntheticTrackSource
  /** The event kind id (from EVENT_KIND_BY_CAP, or an event-taxonomy macro
   *  such as `audio`). Also the debounce discriminator. */
  readonly kind: string
  readonly timestamp: number
  /** NAME of the device that produced the event (the linked sensor/control),
   *  persisted on the track so clients can label the synthetic marker. Left
   *  unset when the camera IS the producer (audio) — there is no other
   *  device to name. */
  readonly producingDeviceName?: string
  /** Audio-classification labels to stamp on the track. Set by the audio
   *  projection when the anomalous frame carried a confident class, so the
   *  marker labels itself ("dog", "glass_breaking") without inventing a
   *  taxonomy sub-class — `Track.audioLabels` already means exactly this. */
  readonly audioLabels?: Track['audioLabels']
  /**
   * How long THIS projection may wait for the snapshot, overriding
   * {@link SyntheticTrackDeps.snapshotTimeoutMs}.
   *
   * It is per-call because the two projections are on different critical paths.
   * Nothing waits on an audio marker, so it can afford the generous default; a
   * SENSOR marker is awaited by the notification that press is about — its
   * media owner is this track — so it takes a tight bound and accepts a
   * media-less marker rather than delaying the doorbell.
   */
  readonly snapshotTimeoutMs?: number
}

const DEFAULT_DEBOUNCE_MS = 10_000

/**
 * What {@link SyntheticTrackMaterializer.materializeOrShare} answers.
 *
 * `debounced` carries the WINDOW's marker — the one the first call of the
 * window landed, with its media — so a second state change of the same press
 * names the same media owner. `not-materialized` is reserved for a real
 * failure: the persist failed, or the window's marker never landed.
 */
export type SyntheticMaterialization =
  | { readonly kind: 'materialized'; readonly track: Track }
  | { readonly kind: 'debounced'; readonly track: Track }
  | { readonly kind: 'not-materialized' }

/** One debounce window: when it opened, and the marker its first call is landing. */
interface DebounceWindow {
  readonly at: number
  readonly landing: Promise<Track | null>
}

/**
 * What the debounce treats as "the same event happening again".
 *
 * `(camera, kind)` — plus, for an audio row, the class HEARD, and for a sensor
 * row, the SENSOR. Since D189 every
 * audio row carries `kind: 'audio'` and puts the class on `audioLabels`, so
 * keying on `kind` alone would collapse this to one bucket per camera. The
 * episode hysteresis cools down PER CLASS, so a bark three seconds after speech
 * is a legitimate second episode — and a per-camera bucket would drop it.
 *
 * Only the FIRST label is used: a materialize carries the one class the episode
 * opened on. Joining all of them would make `[speech]` and `[speech, dog]`
 * different buckets, which is the opposite of what a debounce is for.
 */
function debounceKey(input: SyntheticTrackInput): string {
  const heard = input.audioLabels?.[0]?.label
  if (heard !== undefined) return `${input.cameraId}:${input.kind}:${heard}`
  // A sensor marker is also keyed by its SENSOR: a debounced call shares the
  // window's marker (label included), and a second contact on the same camera
  // is a different event with a different producer, never the first one's
  // marker (review L2).
  return input.source === 'sensor'
    ? `${input.cameraId}:${input.kind}:${input.sourceDeviceId}`
    : `${input.cameraId}:${input.kind}`
}

/** A hanging snapshot cap must not stall the sensor state-change path. */
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10_000

/** Distinguishes a snapshot-cap timeout from a fetch failure for reporting. */
class SnapshotTimeoutError extends Error {
  constructor(ms: number) {
    super(`snapshot cap timed out after ${ms}ms`)
    this.name = 'SnapshotTimeoutError'
  }
}

/** Reject with `SnapshotTimeoutError` if `promise` doesn't settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SnapshotTimeoutError(ms)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/**
 * True when a track participates in the SPATIAL pipeline (tracker
 * association, occupancy count, re-id/embedding, resurrection). Synthetic
 * tracks carry no trajectory and MUST be skipped by those consumers. Live
 * tracks are built in-RAM (never synthetic), so this holds by construction —
 * the predicate is the explicit guard for any code that enumerates PERSISTED
 * tracks for spatial reasoning.
 *
 * It is an ALLOW-LIST on purpose. The first version read `source !== 'sensor'`,
 * which silently readmits every synthetic source added afterwards — adding
 * `audio` to `TrackSource` would have handed position-less tracks straight to
 * the tracker with no test failing. A new source is now non-spatial until
 * someone deliberately says otherwise.
 */
export function isSpatialTrack(t: { readonly source?: TrackSource }): boolean {
  // Deliberately said, which is what the note above asks for: `onboard` is the
  // camera's own firmware and its boxes live in the decoded frame's pixel
  // space — the same kind of fact `pipeline` produces, from another detector.
  return t.source === undefined || t.source === 'pipeline' || t.source === 'onboard'
}

/** Full-frame, position-less placeholder (spatial consumers skip these). */
function zeroPosition(timestamp: number): Track['snapshots'][number]['position'] {
  return { x: 0, y: 0, timestamp, bbox: { x: 0, y: 0, w: 0, h: 0 } }
}

export class SyntheticTrackMaterializer {
  private readonly deps: SyntheticTrackDeps
  private readonly debounceMs: number
  private readonly snapshotTimeoutMs: number
  private readonly makeId: () => string
  private readonly now: () => number
  /** The open window per {@link debounceKey}: its start and the marker it lands. */
  private readonly windows = new Map<string, DebounceWindow>()

  constructor(deps: SyntheticTrackDeps) {
    this.deps = deps
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.snapshotTimeoutMs = deps.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS
    // The `pa-synth-` prefix stays: nothing PARSES it, but it is what tells an
    // operator reading a log that this track has no detection behind it. The
    // random half shrinks with every other track id (see `track-id.ts`).
    this.makeId = deps.makeId ?? ((): string => `pa-synth-${newTrackId()}`)
    this.now = deps.now ?? Date.now
  }

  /**
   * Fetch the linked camera's snapshot under a bounded timeout. A hanging
   * snapshot cap is skipped (returns null + warns) so the track still lands;
   * a null / failed fetch is likewise reported and skipped.
   *
   * Deliberately NOT `force`. `snapshot.cap.ts` defines `force` as the
   * operator's refresh button — *"On battery cams this WILL wake the camera —
   * accept the cost only when the user explicitly asks for it"* — and a
   * synthetic track is materialised from an EVENT, with nobody asking. Forcing
   * here walked straight past the snapshot addon's sleep gate and woke a
   * sleeping battery camera per event (roadmap 4f). Without it the cache
   * answers: ≤10 s old on a mains camera, and on a battery camera the
   * intentionally stale-but-honest frame that costs no wake.
   */
  private async fetchSnapshot(
    cameraId: number,
    timeoutMs: number,
  ): Promise<{ base64: string; contentType: string } | null> {
    try {
      const snap = await withTimeout(
        this.deps.snapshot.getSnapshot({ deviceId: cameraId }),
        timeoutMs,
      )
      if (snap === null) {
        this.deps.onError?.('getSnapshot', new Error('snapshot returned null'), cameraId)
      }
      return snap
    } catch (err) {
      this.deps.onError?.(
        err instanceof SnapshotTimeoutError ? 'snapshotTimeout' : 'snapshotMedia',
        err,
        cameraId,
      )
      return null
    }
  }

  /** The window `input` falls in, or null when it opens a new one. */
  private openWindow(input: SyntheticTrackInput): DebounceWindow | null {
    const window = this.windows.get(debounceKey(input))
    return window !== undefined && this.now() - window.at < this.debounceMs ? window : null
  }

  private startWindow(input: SyntheticTrackInput): Promise<Track | null> {
    const landing = this.land(input)
    this.windows.set(debounceKey(input), { at: this.now(), landing })
    return landing
  }

  /**
   * Materialize a synthetic track for a non-spatial event on `cameraId`.
   * Returns the persisted track, or null when debounced. Snapshot failure
   * still lands a track (with no media) — it never blocks the durable record.
   *
   * The AUDIO contract: a debounced call is a second episode that must not
   * adopt the first one's row, so it answers null. A SENSOR projection wants
   * the window's marker instead — {@link materializeOrShare}.
   */
  async materialize(input: SyntheticTrackInput): Promise<Track | null> {
    if (this.openWindow(input) !== null) return null
    return this.startWindow(input)
  }

  /**
   * Like {@link materialize}, but a call inside an open window answers the
   * window's OWN marker (awaiting it while it is still landing) with kind
   * `debounced`. Two state changes of one doorbell press are one event: the
   * second must name the same media owner, not none (2026-09-29, camera 101 —
   * the notification that won the rule was the debounced one, and shipped
   * without a still).
   */
  async materializeOrShare(input: SyntheticTrackInput): Promise<SyntheticMaterialization> {
    const window = this.openWindow(input)
    const track = await (window === null ? this.startWindow(input) : window.landing)
    if (track === null) return { kind: 'not-materialized' }
    return { kind: window === null ? 'materialized' : 'debounced', track }
  }

  private async land(input: SyntheticTrackInput): Promise<Track | null> {
    const trackId = this.makeId()
    const ts = input.timestamp
    let mediaId: number | null = null

    const snap = await this.fetchSnapshot(
      input.cameraId,
      input.snapshotTimeoutMs ?? this.snapshotTimeoutMs,
    )
    if (snap !== null) {
      try {
        // Best shot (native-media-persistence design C): the snapshot cap
        // returns a RAW native-resolution frame (e.g. 4K). A synthetic event
        // has no detection bbox, so the best shot is the whole CLEAN frame
        // downscaled to the ≤960×540 envelope (no box) BEFORE it is persisted —
        // matching the pipeline tracks' `keyFrameSmall` resolution, never the
        // retired ≤640 crop cap. Persisted under `kind: 'keyFrameSmall'` so the
        // viewer hero/clean/reel selectors pick it up (a `'snapshot'` blob is
        // ignored there — that stuck the pa-synth reel on "loading"). A decode
        // failure falls back to the raw bytes so a marker still lands media
        // (best-effort, never blocks the sensor record).
        const raw = Buffer.from(snap.base64, 'base64')
        let data: Buffer = raw
        try {
          data = await downscaleFullFrameJpeg(
            raw,
            SYNTHETIC_SNAPSHOT_MAX_WIDTH,
            SYNTHETIC_SNAPSHOT_MAX_HEIGHT,
          )
        } catch (err) {
          this.deps.onError?.('downscaleSnapshot', err, input.cameraId)
        }
        mediaId = await this.deps.media.put({
          deviceId: input.cameraId,
          ownerKind: 'track',
          ownerId: trackId,
          kind: 'keyFrameSmall',
          timestamp: ts,
          data,
        })
      } catch (err) {
        this.deps.onError?.('snapshotMedia', err, input.cameraId)
      }
    }

    const track: Track = {
      trackId,
      deviceId: input.cameraId,
      className: input.kind,
      /**
       * The accumulated-class column, seeded with the one class this row will
       * ever have. A pipeline track gets `classes: [className]` on its first
       * observation; a synthetic row was left with the column NULL, and
       * `whereJsonArrayAny` — the operator `classes` compiles to — is a
       * deliberate SUPERSET that KEEPS a row whose column it cannot read.
       *
       * So every class selection returned every synthetic row and no class
       * selection ever SELECTED one: measured on the live hub, `classes:
       * ['person']` came back with 66 contact markers and 29 audio markers
       * attached, `classes: ['contact']` returned no contact row by its class
       * (only the 116 rows the escape hatch keeps), and a class that exists
       * nowhere answered those same 116. That is the "the sensor and control
       * filters do nothing" report, exactly.
       *
       * Writing it here makes a synthetic row selectable BY ITS KIND like any
       * other. Rows already on disk keep a NULL column and stay in the
       * superset — which is what `excludeSources` is for: provenance is not a
       * class, and the source filter is exact for the whole history.
       */
      classes: [input.kind],
      source: input.source,
      ...(input.producingDeviceName !== undefined
        ? { producingDeviceName: input.producingDeviceName }
        : {}),
      ...(input.audioLabels !== undefined && input.audioLabels.length > 0
        ? { audioLabels: input.audioLabels }
        : {}),
      firstSeen: ts,
      lastSeen: ts,
      positions: [],
      snapshots: mediaId !== null ? [{ timestamp: ts, position: zeroPosition(ts), mediaId }] : [],
      zonesVisited: [],
      totalDistance: 0,
      state: 'idle',
      active: false,
    }

    try {
      await this.deps.tracks.persistSyntheticTrack(track)
    } catch (err) {
      this.deps.onError?.('persistSyntheticTrack', err, input.cameraId)
      return null
    }
    return track
  }
}
