/**
 * R4 (D779) wiring: everything the camera's object detection and event
 * history need at runtime, kept out of the (already large) addon class.
 *
 * Switches, all default ON:
 *   - integration: `AlexaSettings.objectDetection` — the quick kill switch;
 *   - per camera: {@link OBJECT_DETECTION_KEY} in this addon's per-device
 *     store (`<addonId>:addon-devices`), written by the device-settings
 *     aggregate. Absent = on.
 * Images ride the R2 "Snapshots" switch: off ⇒ events and history carry no
 * image URIs at all.
 *
 * What a camera DECLARES is `person`, plus `package` where its pipeline
 * produces package events (the detection-class answer the sensors use). What
 * it REPORTS is that, narrowed by the user's choice in the Alexa app
 * (`SetObjectDetectionClasses`).
 */
import type {
  AddonContext,
  ConfigFieldWithValue,
  IScopedLogger,
  MediaFileKind,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import { z } from 'zod'
import type { SmartVisionClass } from '../endpoints/builder.js'
import type { VisionContext, VisionImageUris, VisionTrack } from '../handlers/data-controller.js'
import type { DetectionSensorClass } from '../handlers/endpoint-id.js'
import type { VisionDetectionLike } from '../lwa-event-gateway.js'
import { type AlexaJpeg, toAlexaJpeg } from '../snapshots/snapshot-image.js'
import type { SnapshotStore } from '../snapshots/snapshot-store.js'
import { ObjectDetectionFeed } from './object-detection-feed.js'
import { reportableVisionClasses, VisionStateStore } from './vision-state.js'

/** Per-device store key of the camera's object-detection toggle. */
export const OBJECT_DETECTION_KEY = 'alexaObjectDetection'

/** Clean scene first; the boxed frames never (they are annotated). */
const FRAME_KINDS: readonly MediaFileKind[] = [
  'keyFrameSmall',
  'sceneFrame',
  'keyFrame',
  'fullFrame',
]
const CROP_KINDS: readonly MediaFileKind[] = ['thumbnailSmall', 'thumbnail', 'crop']

/** A live event whose track has no stored frame yet may show the camera's
 *  current snapshot — but only this soon after the detection. Older history
 *  never does: it would show a different moment. */
const LIVE_FALLBACK_MS = 60_000

const MediaRowSchema = z.object({ kind: z.string(), base64: z.string() })
const SnapshotImageSchema = z.object({ base64: z.string().min(1) })
const RecentTracksSchema = z.object({
  tracks: z.array(
    z.object({
      trackId: z.string(),
      className: z.string(),
      firstSeen: z.number(),
      lastSeen: z.number(),
    }),
  ),
})
const TrackSchema = z
  .object({
    trackId: z.string(),
    className: z.string(),
    firstSeen: z.number(),
    lastSeen: z.number(),
  })
  .nullable()

export interface PostObjectDetection {
  (opts: {
    readonly deviceId: number
    readonly detection: VisionDetectionLike
    readonly imagesFor?: (userId: string) => VisionImageUris
  }): Promise<void>
}

export interface VisionRuntimeDeps {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  /** `AlexaSettings.objectDetection`. */
  readonly integrationOn: () => boolean
  /** `AlexaSettings.snapshots` — gates every image URI. */
  readonly snapshotsOn: () => boolean
  readonly isExposed: (deviceId: number) => boolean
  /** The camera's last persisted detection classes (no read). */
  readonly knownClasses: (deviceId: number) => readonly DetectionSensorClass[]
  readonly namespace: () => string
  readonly publicHubUrl: () => string
  readonly store: SnapshotStore
  readonly post: PostObjectDetection
  readonly encode?: (bytes: Buffer) => Promise<AlexaJpeg>
  readonly now?: () => number
}

/** The classes a camera declares, from what its pipeline produces. */
export function declaredVisionClasses(
  available: readonly DetectionSensorClass[],
): readonly SmartVisionClass[] {
  return available.includes('package') ? ['person', 'package'] : ['person']
}

/** The camera's toggle in a per-device store blob (absent = on). */
export function cameraObjectDetectionOn(store: Readonly<Record<string, unknown>>): boolean {
  return store[OBJECT_DETECTION_KEY] !== false
}

export function objectDetectionKey(deviceId: number): string {
  return `alexa:${deviceId}:objectDetection`
}

/** The camera's "Object detection in Alexa" field. */
export function objectDetectionField(input: {
  readonly deviceId: number
  readonly store: Readonly<Record<string, unknown>>
  readonly enabledKey: string
  readonly integrationOn: boolean
}): ConfigFieldWithValue {
  const showWhen = { field: input.enabledKey, equals: true }
  if (!input.integrationOn) {
    return {
      type: 'info',
      key: `${objectDetectionKey(input.deviceId)}:off`,
      label: 'Object detection in Alexa (experimental)',
      content:
        'Object detection is switched off for the whole Alexa integration (Alexa settings → Object detection).',
      variant: 'info',
      showWhen,
    }
  }
  return {
    type: 'boolean',
    key: objectDetectionKey(input.deviceId),
    label: 'Object detection in Alexa (experimental)',
    description:
      "Send this camera's person (and, with a package zone, package) detections to Alexa as events, with their history on the camera in the Alexa app. Amazon documents this for US English only. If Alexa stops showing the camera after this is on, switch it off: the camera returns after the next re-sync.",
    style: 'switch',
    value: cameraObjectDetectionOn(input.store),
    showWhen,
    immediate: true,
  }
}

export class AlexaVisionRuntime {
  readonly state: VisionStateStore
  private readonly feed: ObjectDetectionFeed

  constructor(private readonly deps: VisionRuntimeDeps) {
    this.state = new VisionStateStore({
      read: (deviceId) => this.readPrefs(deviceId),
      write: (deviceId, patch) => this.writePrefs(deviceId, patch),
    })
    this.feed = new ObjectDetectionFeed({
      eventBus: deps.ctx.eventBus,
      reportableClasses: (deviceId) => this.reportable(deviceId),
      namespace: deps.namespace,
      remember: (deviceId, entry) => this.state.remember(deviceId, [entry]),
      post: (deviceId, detection) =>
        deps.post({
          deviceId,
          detection,
          imagesFor: (userId) =>
            this.imagesFor(userId, deviceId, detection.trackId, detection.timestamp),
        }),
      logger: deps.logger,
    })
  }

  start(): void {
    this.feed.start()
  }

  stop(): void {
    this.feed.stop()
  }

  /** This addon's per-device store for a camera; `{}` when unreadable. */
  async readPrefs(deviceId: number): Promise<Readonly<Record<string, unknown>>> {
    try {
      return (await this.deps.ctx.settings?.readDeviceStore(deviceId)) ?? {}
    } catch (err) {
      this.deps.logger.debug('alexa: per-device settings unreadable — using defaults', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return {}
    }
  }

  async writePrefs(deviceId: number, patch: Record<string, unknown>): Promise<void> {
    const settings = this.deps.ctx.settings
    if (settings === undefined) throw new Error('export-alexa: no per-device settings store')
    await settings.writeDeviceStore(deviceId, patch)
    this.state.invalidate(deviceId)
  }

  /** What the endpoint build declares for a camera, from a FRESH class read. */
  async buildClasses(
    deviceId: number,
    available: readonly DetectionSensorClass[],
  ): Promise<readonly SmartVisionClass[]> {
    if (!this.deps.integrationOn()) return []
    if (!cameraObjectDetectionOn(await this.readPrefs(deviceId))) return []
    return declaredVisionClasses(available)
  }

  /** What a camera declares right now, without reading its pipeline. */
  async declared(deviceId: number): Promise<readonly SmartVisionClass[]> {
    if (!this.deps.integrationOn() || !this.deps.isExposed(deviceId)) return []
    if (!cameraObjectDetectionOn(await this.readPrefs(deviceId))) return []
    return declaredVisionClasses(this.deps.knownClasses(deviceId))
  }

  async reportable(deviceId: number): Promise<readonly SmartVisionClass[]> {
    const declared = await this.declared(deviceId)
    if (declared.length === 0) return []
    return reportableVisionClasses(declared, await this.state.get(deviceId))
  }

  /** Fresh, per-user, ten-minute image URIs for one event — or none. */
  imagesFor(userId: string, deviceId: number, trackId: string, at: number): VisionImageUris {
    if (!this.deps.snapshotsOn()) return {}
    const base = this.deps.publicHubUrl().replace(/\/+$/, '')
    if (!base.startsWith('https://')) return {}
    const frame = this.deps.store.mintLazy({
      deviceId,
      userId,
      capturedAt: at,
      load: () => this.loadImage(deviceId, trackId, FRAME_KINDS, at),
    })
    const crop = this.deps.store.mintLazy({
      deviceId,
      userId,
      capturedAt: at,
      load: () => this.loadImage(deviceId, trackId, CROP_KINDS, null),
    })
    return { frameImageUri: `${base}${frame.path}`, croppedImageUri: `${base}${crop.path}` }
  }

  /** The directive handlers' view (`handlers/data-controller.ts`). */
  context(): VisionContext {
    const api = this.deps.ctx.api
    return {
      ctx: this.deps.ctx,
      logger: this.deps.logger,
      vision: this.state,
      declaredClasses: (deviceId) => this.declared(deviceId),
      namespace: this.deps.namespace,
      listTracks: async (deviceId, q): Promise<readonly VisionTrack[]> => {
        const page = RecentTracksSchema.parse(
          await api.pipelineAnalytics.listRecentTracks.query({
            deviceIds: [deviceId],
            since: q.since,
            until: q.until,
            limit: q.limit,
            projection: 'slim',
          }),
        )
        return page.tracks
      },
      getTrack: async (deviceId, trackId) =>
        TrackSchema.parse(await api.pipelineAnalytics.getTrack.query({ deviceId, trackId })),
      imagesFor: (userId, deviceId, trackId, at) => this.imagesFor(userId, deviceId, trackId, at),
    }
  }

  private async loadImage(
    deviceId: number,
    trackId: string,
    kinds: readonly MediaFileKind[],
    liveFallbackAt: number | null,
  ): Promise<Buffer | null> {
    const encode = this.deps.encode ?? toAlexaJpeg
    try {
      const rows = z.array(MediaRowSchema).parse(
        await this.deps.ctx.api.pipelineAnalytics.getTrackMedia.query({
          trackId,
          deviceId,
          kinds: [...kinds],
        }),
      )
      for (const kind of kinds) {
        const row = rows.find((r) => r.kind === kind)
        if (row !== undefined) return (await encode(Buffer.from(row.base64, 'base64'))).bytes
      }
      const now = this.deps.now?.() ?? Date.now()
      if (liveFallbackAt !== null && now - liveFallbackAt < LIVE_FALLBACK_MS) {
        const snap = SnapshotImageSchema.safeParse(
          await this.deps.ctx.api.snapshot.getSnapshot.query({ deviceId }),
        )
        if (snap.success) return (await encode(Buffer.from(snap.data.base64, 'base64'))).bytes
      }
      return null
    } catch (err) {
      this.deps.logger.warn('alexa object detection: image read failed', {
        tags: { deviceId },
        meta: { trackId, error: errMsg(err) },
      })
      return null
    }
  }
}
