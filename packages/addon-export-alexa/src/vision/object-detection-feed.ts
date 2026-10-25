/**
 * The `ObjectDetection` feed (R4, D779): the pipeline's track lifecycle in,
 * one `Alexa.SmartVision.ObjectDetectionSensor/ObjectDetection` event per
 * (track, class) out.
 *
 *  - Same input and the same class mapping as the detection sensors
 *    (`detectionClassOf`), so the two surfaces never disagree about a class.
 *    Only `person` and `package` exist on Amazon's side.
 *  - Ids are derived from the track (`vision-ids.ts`): the history
 *    (`DataController.ReportData`) hands Alexa the same ids later.
 *  - Amazon: "wait at least 30 seconds before sending another ObjectDetection
 *    event for the same object" — enforced per objectIdentifier.
 *  - At most one event per camera and class per
 *    {@link CAMERA_EVENT_MIN_INTERVAL_MS} (D779 amendment): a busy room fragments into a
 *    new track every few seconds (measured: 141 events in 20 min on one
 *    camera, real people, ~8 s apart). A track held back is not forgotten — a
 *    later update past the window reports it.
 *  - Camera firmware motion never produces one: a pixel change is not a
 *    person (the pre-D779 gateway posted `person` for every motion edge).
 *
 * The decision of WHAT may be reported (integration switch, camera toggle,
 * exposure, declared classes, the user's choice in the app) is one dep,
 * `reportableClasses`; an empty answer means "report nothing for this camera".
 */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { EventCategory, errMsg } from '@camstack/types'
import { z } from 'zod'
import { detectionClassOf } from '../detection-sensors/detection-tracker.js'
import type { SmartVisionClass } from '../endpoints/builder.js'
import { eventIdentifierFor, objectIdentifierFor } from './vision-ids.js'
import type { VisionIndexEntry } from './vision-state.js'

export const OBJECT_EVENT_MIN_INTERVAL_MS = 30_000

/** Minimum spacing of two events of one class on one camera (D779 amendment). */
export const CAMERA_EVENT_MIN_INTERVAL_MS = 30_000

/** Bound on the per-track bookkeeping should `end` events be lost (D8). */
const MAX_TRACKED = 5_000

export interface VisionDetection {
  readonly trackId: string
  readonly imageNetClass: SmartVisionClass
  readonly eventIdentifier: string
  readonly objectIdentifier: string
  readonly timestamp: number
}

export interface TrackLifecycleInput {
  readonly deviceId: number
  readonly trackId: string
  readonly phase: 'start' | 'update' | 'end'
  readonly bestClassName?: string
  readonly classes?: readonly string[]
}

const TrackLifecycleSchema = z.object({
  deviceId: z.number(),
  trackId: z.string(),
  phase: z.enum(['start', 'update', 'end']),
  bestClassName: z.string().optional(),
  classes: z.array(z.string()).optional(),
})

export interface ObjectDetectionFeedDeps {
  readonly eventBus: AddonContext['eventBus']
  /** What this camera reports right now; empty = nothing. */
  readonly reportableClasses: (deviceId: number) => Promise<readonly SmartVisionClass[]>
  /** The hub's id namespace (a UUID). */
  readonly namespace: () => string
  readonly post: (deviceId: number, detection: VisionDetection) => Promise<void>
  /** Index the event for `ReportData` BY_IDENTIFIER. */
  readonly remember: (deviceId: number, entry: VisionIndexEntry) => Promise<void>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

function isVisionClass(cls: string | null): cls is SmartVisionClass {
  return cls === 'person' || cls === 'package'
}

export class ObjectDetectionFeed {
  /** `${deviceId}|${trackId}|${class}` already handled → insertion time. */
  private readonly handled = new Map<string, number>()
  /** objectIdentifier → last event time. */
  private readonly lastPosted = new Map<string, number>()
  /** `${deviceId}|${class}` → last event time, and tracks held back since. */
  private readonly lastCameraPost = new Map<string, number>()
  private readonly heldBack = new Map<string, number>()
  private off: (() => void) | null = null

  constructor(private readonly deps: ObjectDetectionFeedDeps) {}

  start(): void {
    this.off = this.deps.eventBus.subscribe(
      { category: EventCategory.PipelineAnalyticsTrackLifecycle },
      (event) => {
        // pipeline-analytics events carry the camera in `data.deviceId` only.
        const parsed = TrackLifecycleSchema.safeParse(event.data)
        if (!parsed.success) return
        void this.onTrackLifecycle(parsed.data).catch((err: unknown) => {
          this.deps.logger.warn('alexa object detection: event failed', {
            tags: { deviceId: parsed.data.deviceId },
            meta: { trackId: parsed.data.trackId, error: errMsg(err) },
          })
        })
      },
    )
  }

  stop(): void {
    this.off?.()
    this.off = null
    this.handled.clear()
    this.lastPosted.clear()
    this.lastCameraPost.clear()
    this.heldBack.clear()
  }

  /** Per-track entries currently held (tests, diagnostics). */
  trackedCount(): number {
    return this.handled.size
  }

  async onTrackLifecycle(event: TrackLifecycleInput): Promise<void> {
    const prefix = `${event.deviceId}|${event.trackId}|`
    if (event.phase === 'end') {
      for (const key of [...this.handled.keys()])
        if (key.startsWith(prefix)) this.handled.delete(key)
      return
    }
    const cls = detectionClassOf(event.bestClassName ?? event.classes?.[0])
    if (!isVisionClass(cls)) return
    const key = `${prefix}${cls}`
    if (this.handled.has(key)) return
    const now = this.deps.now?.() ?? Date.now()
    const namespace = this.deps.namespace()
    const objectIdentifier = objectIdentifierFor(namespace, event.deviceId, event.trackId)
    const last = this.lastPosted.get(objectIdentifier)
    // Not marked handled: a later update past the window may still report it.
    if (last !== undefined && now - last < OBJECT_EVENT_MIN_INTERVAL_MS) return
    const cameraKey = `${event.deviceId}|${cls}`
    const lastOnCamera = this.lastCameraPost.get(cameraKey)
    if (lastOnCamera !== undefined && now - lastOnCamera < CAMERA_EVENT_MIN_INTERVAL_MS) {
      // Not marked handled either: still present past the window = reported then.
      if (event.phase === 'start')
        this.heldBack.set(cameraKey, (this.heldBack.get(cameraKey) ?? 0) + 1)
      return
    }
    this.mark(key, now)
    const classes = await this.deps.reportableClasses(event.deviceId)
    if (!classes.includes(cls)) return
    const detection: VisionDetection = {
      trackId: event.trackId,
      imageNetClass: cls,
      eventIdentifier: eventIdentifierFor(namespace, event.deviceId, event.trackId, cls),
      objectIdentifier,
      timestamp: now,
    }
    this.lastPosted.set(objectIdentifier, now)
    this.lastCameraPost.set(cameraKey, now)
    this.pruneLastPosted(now)
    const held = this.heldBack.get(cameraKey) ?? 0
    if (held > 0) {
      this.heldBack.delete(cameraKey)
      this.deps.logger.info('alexa object detection: tracks held back by the per-camera window', {
        tags: { deviceId: event.deviceId },
        meta: { imageNetClass: cls, heldBack: held, windowMs: CAMERA_EVENT_MIN_INTERVAL_MS },
      })
    }
    await this.deps.remember(event.deviceId, {
      e: detection.eventIdentifier,
      t: event.trackId,
      c: cls,
      at: now,
    })
    await this.deps.post(event.deviceId, detection)
  }

  private mark(key: string, now: number): void {
    this.handled.set(key, now)
    if (this.handled.size <= MAX_TRACKED) return
    const oldest = this.handled.keys().next().value
    if (oldest !== undefined) this.handled.delete(oldest)
  }

  private pruneLastPosted(now: number): void {
    for (const [id, at] of this.lastPosted) {
      if (now - at >= OBJECT_EVENT_MIN_INTERVAL_MS) this.lastPosted.delete(id)
    }
  }
}
