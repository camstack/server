/**
 * Which detection classes are currently present on each camera (R1, D772).
 *
 * Fed by the pipeline's track lifecycle (`PipelineAnalyticsTrackLifecycle`,
 * `data.deviceId` — these events carry no device on their `source`) and by
 * package deliveries. A class is present while at least one of ITS tracks is
 * open: the set is per `(camera, class)` and per `trackId`, so the end of one
 * person's track does not clear "Person" while another person is still in
 * view (the HA export's per-event flip has exactly that bug).
 *
 * Events are telemetry and may be dropped (D8), and the pipeline does not
 * promise an `end` for every `start` (a zero-media false birth or a discarded
 * stale track ends silently). So {@link reconcile} replaces a camera's sets
 * with an authoritative read of its ACTIVE tracks; a sensor can therefore never
 * stay "detected" past one reconcile after its last track closed. A read that
 * fails is not passed in — the sets then stay as they were.
 *
 * Emits a transition per `(camera, class)` only when presence changes; the
 * Alexa-facing hold (≥ 30 s DETECTED before NOT_DETECTED) is the gateway's.
 */
import { COCO_TO_MACRO } from '@camstack/types'
import type { DetectionSensorClass } from '../handlers/endpoint-id.js'
import { DETECTION_SENSOR_CLASSES } from '../handlers/endpoint-id.js'

/** A package delivery is an instant, not a track: it is present this long. */
export const PACKAGE_PULSE_MS = 1_000

export type DetectionTransition = (
  deviceId: number,
  cls: DetectionSensorClass,
  present: boolean,
) => void

/** The fields of a track-lifecycle event the tracker reads. */
export interface TrackLifecycleLike {
  readonly deviceId: number
  readonly trackId: string
  readonly phase: 'start' | 'update' | 'end'
  readonly bestClassName?: string
  readonly classes?: readonly string[]
}

/** One active track as the reconcile read reports it. */
export interface ActiveTrackLike {
  readonly trackId: string
  readonly className: string
}

/** The detection class a pipeline class name belongs to, or null. Pipeline
 *  classes are already macros; a raw COCO label is mapped the same way the
 *  executor maps it. */
export function detectionClassOf(className: string | undefined): DetectionSensorClass | null {
  if (className === undefined) return null
  const lower = className.toLowerCase()
  const isClass = (v: string): v is DetectionSensorClass =>
    (DETECTION_SENSOR_CLASSES as readonly string[]).includes(v)
  if (isClass(lower)) return lower
  const mapped = COCO_TO_MACRO.mapping[lower]
  return mapped !== undefined && isClass(mapped) ? mapped : null
}

export class DetectionTracker {
  /** `${deviceId}|${class}` → open track ids. */
  private readonly open = new Map<string, Set<string>>()
  private readonly pulseTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly onTransition: DetectionTransition) {}

  onTrackLifecycle(event: TrackLifecycleLike): void {
    const cls = detectionClassOf(event.bestClassName ?? event.classes?.[0])
    if (cls === null) return
    if (event.phase === 'end') {
      // A fused piece's end retires THAT id; the subject continues under the
      // survivor's id, which carries its own start/update.
      this.remove(event.deviceId, cls, event.trackId)
      // A track's class can change while it lives — drop the id everywhere.
      for (const other of DETECTION_SENSOR_CLASSES) {
        if (other !== cls) this.remove(event.deviceId, other, event.trackId)
      }
      return
    }
    this.add(event.deviceId, cls, event.trackId)
  }

  /** A package was delivered: "Package" is detected, as a pulse. */
  onPackageDelivered(deviceId: number, entryId: string): void {
    const id = `package:${entryId}`
    this.add(deviceId, 'package', id)
    const timer = setTimeout(() => {
      this.pulseTimers.delete(timer)
      this.remove(deviceId, 'package', id)
    }, PACKAGE_PULSE_MS)
    timer.unref?.()
    this.pulseTimers.add(timer)
  }

  /** Replace a camera's open tracks with what the pipeline says is ACTIVE. */
  reconcile(deviceId: number, active: readonly ActiveTrackLike[]): void {
    const truth = new Map<DetectionSensorClass, Set<string>>()
    for (const track of active) {
      const cls = detectionClassOf(track.className)
      if (cls === null) continue
      const set = truth.get(cls) ?? new Set<string>()
      set.add(track.trackId)
      truth.set(cls, set)
    }
    for (const cls of DETECTION_SENSOR_CLASSES) {
      const key = `${deviceId}|${cls}`
      const before = this.open.get(key) ?? new Set<string>()
      const after = truth.get(cls) ?? new Set<string>()
      // A delivery pulse is not a track; the read cannot see it.
      for (const id of before) if (id.startsWith('package:')) after.add(id)
      this.replace(deviceId, cls, before, after)
    }
  }

  /** Cameras with at least one class present — the ones worth reconciling. */
  camerasWithPresence(): readonly number[] {
    const out = new Set<number>()
    for (const [key, set] of this.open) {
      if (set.size > 0) out.add(Number(key.split('|')[0]))
    }
    return [...out]
  }

  isPresent(deviceId: number, cls: DetectionSensorClass): boolean {
    return (this.open.get(`${deviceId}|${cls}`)?.size ?? 0) > 0
  }

  clear(): void {
    this.open.clear()
    for (const t of this.pulseTimers) clearTimeout(t)
    this.pulseTimers.clear()
  }

  private add(deviceId: number, cls: DetectionSensorClass, id: string): void {
    const key = `${deviceId}|${cls}`
    const set = this.open.get(key) ?? new Set<string>()
    const was = set.size > 0
    set.add(id)
    this.open.set(key, set)
    if (!was) this.onTransition(deviceId, cls, true)
  }

  private remove(deviceId: number, cls: DetectionSensorClass, id: string): void {
    const set = this.open.get(`${deviceId}|${cls}`)
    if (set === undefined || !set.delete(id)) return
    if (set.size === 0) this.onTransition(deviceId, cls, false)
  }

  private replace(
    deviceId: number,
    cls: DetectionSensorClass,
    before: ReadonlySet<string>,
    after: Set<string>,
  ): void {
    this.open.set(`${deviceId}|${cls}`, after)
    if (before.size > 0 && after.size === 0) this.onTransition(deviceId, cls, false)
    else if (before.size === 0 && after.size > 0) this.onTransition(deviceId, cls, true)
  }
}
