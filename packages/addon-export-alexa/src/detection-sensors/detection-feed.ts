/**
 * The detection sensors' live feed (R1, D772): the pipeline's track events in,
 * one presence transition per `(camera, class)` out, and a reconcile against
 * the pipeline's ACTIVE tracks every {@link DETECTION_RECONCILE_INTERVAL_MS}
 * for every camera that still shows something present — so a dropped `end`
 * (events are telemetry, D8) cannot leave "Front door Person" detected (D49's
 * event-plus-reconcile shape).
 */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { EventCategory, errMsg } from '@camstack/types'
import { z } from 'zod'
import type { DetectionSensorClass } from '../handlers/endpoint-id.js'
import { type ActiveTrackLike, DetectionTracker } from './detection-tracker.js'

export const DETECTION_RECONCILE_INTERVAL_MS = 60_000

const TrackLifecycleSchema = z.object({
  deviceId: z.number(),
  trackId: z.string(),
  phase: z.enum(['start', 'update', 'end']),
  bestClassName: z.string().optional(),
  classes: z.array(z.string()).optional(),
})

const PackageDeliveredSchema = z.object({
  deviceId: z.number(),
  entryId: z.string(),
})

export interface DetectionFeedDeps {
  readonly eventBus: AddonContext['eventBus']
  /** The integration's "Detection sensors" switch. */
  readonly enabled: () => boolean
  readonly isExposed: (deviceId: number) => boolean
  /** The pipeline's active tracks for a camera — the reconcile authority. */
  readonly readActiveTracks: (deviceId: number) => Promise<readonly ActiveTrackLike[]>
  readonly push: (
    deviceId: number,
    cls: DetectionSensorClass,
    detected: boolean,
    timestamp: number,
  ) => Promise<void>
  readonly logger: IScopedLogger
}

export class DetectionSensorFeed {
  private readonly tracker: DetectionTracker
  private readonly offs: Array<() => void> = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: DetectionFeedDeps) {
    this.tracker = new DetectionTracker((deviceId, cls, present) => {
      this.onTransition(deviceId, cls, present)
    })
  }

  start(): void {
    this.offs.push(
      this.deps.eventBus.subscribe(
        { category: EventCategory.PipelineAnalyticsTrackLifecycle },
        (event) => {
          // pipeline-analytics events carry the camera in `data.deviceId`
          // only — never on `source`.
          const parsed = TrackLifecycleSchema.safeParse(event.data)
          if (parsed.success) this.tracker.onTrackLifecycle(parsed.data)
        },
      ),
      this.deps.eventBus.subscribe(
        { category: EventCategory.PipelineAnalyticsPackageDelivered },
        (event) => {
          const parsed = PackageDeliveredSchema.safeParse(event.data)
          if (parsed.success)
            this.tracker.onPackageDelivered(parsed.data.deviceId, parsed.data.entryId)
        },
      ),
    )
    this.timer = setInterval(() => void this.reconcile(), DETECTION_RECONCILE_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off()
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.tracker.clear()
  }

  isPresent(deviceId: number, cls: DetectionSensorClass): boolean {
    return this.deps.enabled() && this.tracker.isPresent(deviceId, cls)
  }

  /** One reconcile pass over every camera that shows a class present. A read
   *  that fails changes nothing for that camera. */
  async reconcile(): Promise<void> {
    for (const deviceId of this.tracker.camerasWithPresence()) {
      try {
        this.tracker.reconcile(deviceId, await this.deps.readActiveTracks(deviceId))
      } catch (err) {
        this.deps.logger.debug('alexa detection sensors: active-track read failed — kept as is', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  private onTransition(deviceId: number, cls: DetectionSensorClass, present: boolean): void {
    if (!this.deps.enabled() || !this.deps.isExposed(deviceId)) return
    void this.deps.push(deviceId, cls, present, Date.now()).catch((err: unknown) => {
      this.deps.logger.warn('alexa detection sensors: change report failed', {
        tags: { deviceId },
        meta: { detectionClass: cls, present, error: errMsg(err) },
      })
    })
  }
}
