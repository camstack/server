/**
 * The hub methods the track-review tools use, behind one typed interface.
 *
 * Every shape is derived from the capability schemas in `@camstack/types`
 * (`z.infer` of the schema the hub itself validates with), and every answer is
 * parsed with the same schema, so a hub that drifts fails loudly here instead
 * of feeding a half-shaped value into a decision. The interface exists so the
 * tools can be exercised against a fake with no socket.
 */
import { z } from 'zod'
import {
  DeviceInfoSchema,
  MediaFileSchema,
  RetrainAnnotationDraftSchema,
  RetrainAnnotationSchema,
  RetrainCollectionCreateResultSchema,
  RetrainCollectionSchema,
  RetrainCorpusKpiSchema,
  RetrainCorpusPageSchema,
  RetrainFrameListSchema,
  RetrainFrameSchema,
  RetrainFrameSelectionSchema,
  RetrainOriginSchema,
  TrackFlagsSchema,
  TrackSchema,
} from '@camstack/types'
import type { HubClient } from '@camstack/develop'

/** The Track fields triage reads — a pick of the hub's own schema. */
export const TriageTrackSchema = TrackSchema.pick({
  trackId: true,
  deviceId: true,
  className: true,
  label: true,
  labelScore: true,
  subLabel: true,
  source: true,
  firstSeen: true,
  lastSeen: true,
  classes: true,
  totalDistance: true,
  state: true,
  envelope: true,
  hasFace: true,
  hasEmbeddedFace: true,
  hasRider: true,
  bestEventId: true,
}).extend({ positions: TrackSchema.shape.positions.optional() })
export type TriageTrack = z.infer<typeof TriageTrackSchema>

export const CameraSchema = DeviceInfoSchema.pick({
  id: true,
  name: true,
  type: true,
  disabled: true,
})
export type Camera = z.infer<typeof CameraSchema>

export type RetrainFrame = z.infer<typeof RetrainFrameSchema>
export type RetrainFrameList = z.infer<typeof RetrainFrameListSchema>
export type RetrainFrameSelection = z.infer<typeof RetrainFrameSelectionSchema>
export type RetrainAnnotation = z.infer<typeof RetrainAnnotationSchema>
export type RetrainAnnotationDraft = z.infer<typeof RetrainAnnotationDraftSchema>
export type RetrainCollection = z.infer<typeof RetrainCollectionSchema>
export type RetrainCorpusKpi = z.infer<typeof RetrainCorpusKpiSchema>
export type RetrainCorpusPage = z.infer<typeof RetrainCorpusPageSchema>
export type RetrainOrigin = z.infer<typeof RetrainOriginSchema>

/** The corpus page filter the backfill walks a collection with. */
export interface CorpusPageQuery {
  /** Absent = the whole corpus, every collection or none. */
  readonly collectionId?: string
  readonly page: number
  readonly pageSize: number
}

export interface OriginBackfill {
  readonly annotationId: string
  readonly origin: RetrainOrigin
}

export interface OriginBackfillResult {
  readonly updated: number
  readonly skipped: number
  readonly revision: number
}
export type MediaFile = z.infer<typeof MediaFileSchema>
export type MediaKind = MediaFile['kind']
export type TrackFlags = z.infer<typeof TrackFlagsSchema>
export type CollectionCreateResult = z.infer<typeof RetrainCollectionCreateResultSchema>

export interface RecentTracksQuery {
  readonly deviceIds: readonly number[]
  readonly since: number
  readonly until: number
  readonly limit: number
  readonly cursor?: string
  readonly classes?: readonly string[]
}

export interface RecentTracksPage {
  readonly tracks: readonly TriageTrack[]
  readonly nextCursor: string | null
}

export interface AddToCollectionResult {
  readonly added: number
  readonly alreadyMember: number
  readonly unknownFrameIds: readonly string[]
}

/** Reads and writes in one place; `track_review_apply` and `track_review_backfill_origin` are the only callers of the writes. */
export interface ReviewHub {
  listCameras(): Promise<readonly Camera[]>
  listRecentTracks(query: RecentTracksQuery): Promise<RecentTracksPage>
  getTrack(deviceId: number, trackId: string): Promise<TriageTrack | null>
  listTrackMedia(deviceId: number, trackId: string): Promise<readonly Omit<MediaFile, 'base64'>[]>
  getTrackMedia(
    deviceId: number,
    trackId: string,
    kinds: readonly MediaKind[],
  ): Promise<readonly MediaFile[]>
  getCorpusKpi(): Promise<RetrainCorpusKpi>
  listCollections(): Promise<readonly RetrainCollection[]>
  listRetrainFrames(trackId: string): Promise<RetrainFrameList>
  listRetrainAnnotations(frameIds: readonly string[]): Promise<readonly RetrainAnnotation[]>
  listRetrainCorpusPage(query: CorpusPageQuery): Promise<RetrainCorpusPage>
  // ── writes ──
  setTrackFlags(deviceId: number, trackId: string, markForTrain: boolean): Promise<TrackFlags>
  selectRetrainFrames(
    deviceId: number,
    trackId: string,
    mediaIds: readonly number[],
  ): Promise<RetrainFrameSelection>
  saveRetrainAnnotations(
    deviceId: number,
    trackId: string,
    frameId: string,
    annotations: readonly RetrainAnnotationDraft[],
    /** The frame revision the caller saw; a stale one is refused by the hub. */
    expectedRevision?: number,
  ): Promise<readonly RetrainAnnotation[]>
  backfillRetrainOrigins(
    deviceId: number,
    trackId: string | undefined,
    frameId: string,
    origins: readonly OriginBackfill[],
    expectedRevision?: number,
  ): Promise<OriginBackfillResult>
  setRetrainFrameComplete(
    deviceId: number,
    trackId: string,
    frameId: string,
    complete: boolean,
  ): Promise<Pick<RetrainFrame, 'frameId' | 'complete'>>
  createCollection(name: string): Promise<CollectionCreateResult>
  addFramesToCollection(
    collectionId: string,
    frameIds: readonly string[],
  ): Promise<AddToCollectionResult>
}

const OriginBackfillAnswer = z.object({
  updated: z.number().int(),
  skipped: z.number().int(),
  revision: z.number().int(),
})
const NullableTrack = TriageTrackSchema.nullable()
const AddResult = z.object({
  added: z.number(),
  alreadyMember: z.number(),
  unknownFrameIds: z.array(z.string()),
})
const MediaInfoList = z.array(MediaFileSchema.omit({ base64: true }))
const Cameras = z.array(CameraSchema)
const RecentPage = z.object({
  tracks: z.array(TriageTrackSchema),
  nextCursor: z.string().nullable(),
})

/** The production adapter over the hub's tRPC client. */
export function createReviewHub(client: HubClient): ReviewHub {
  const read = (path: string, input?: unknown): Promise<unknown> => client.call('GET', path, input)
  const write = (path: string, input: unknown): Promise<unknown> => client.call('POST', path, input)
  return {
    async listCameras() {
      const all = Cameras.parse(
        await read('deviceManager.listAll', {
          isCamera: true,
          projection: 'slim',
        }),
      )
      return all.filter((d) => !d.disabled)
    },
    async listRecentTracks(q) {
      return RecentPage.parse(
        await read('pipelineAnalytics.listRecentTracks', {
          deviceIds: [...q.deviceIds],
          since: q.since,
          until: q.until,
          limit: q.limit,
          projection: 'slim',
          ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
          ...(q.classes !== undefined && q.classes.length > 0 ? { classes: [...q.classes] } : {}),
        }),
      )
    },
    async getTrack(deviceId, trackId) {
      return NullableTrack.parse(await read('pipelineAnalytics.getTrack', { deviceId, trackId }))
    },
    async listTrackMedia(deviceId, trackId) {
      return MediaInfoList.parse(
        await read('pipelineAnalytics.listTrackMedia', { deviceId, trackId }),
      )
    },
    async getTrackMedia(deviceId, trackId, kinds) {
      return z.array(MediaFileSchema).parse(
        await read('pipelineAnalytics.getTrackMedia', {
          deviceId,
          trackId,
          kinds: [...kinds],
        }),
      )
    },
    async getCorpusKpi() {
      return RetrainCorpusKpiSchema.parse(await read('pipelineAnalytics.getRetrainCorpusKpi', {}))
    },
    async listCollections() {
      return z
        .array(RetrainCollectionSchema)
        .parse(await read('pipelineAnalytics.listRetrainCollections', {}))
    },
    async listRetrainFrames(trackId) {
      return RetrainFrameListSchema.parse(
        await read('pipelineAnalytics.listRetrainFrames', { trackId }),
      )
    },
    async listRetrainAnnotations(frameIds) {
      return z.array(RetrainAnnotationSchema).parse(
        await read('pipelineAnalytics.listRetrainAnnotations', {
          frameIds: [...frameIds],
        }),
      )
    },
    async listRetrainCorpusPage(query) {
      return RetrainCorpusPageSchema.parse(
        await read('pipelineAnalytics.listRetrainCorpusPage', { ...query }),
      )
    },
    async setTrackFlags(deviceId, trackId, markForTrain) {
      return TrackFlagsSchema.parse(
        await write('pipelineAnalytics.setTrackFlags', {
          deviceId,
          trackId,
          flags: { markForTrain },
        }),
      )
    },
    async selectRetrainFrames(deviceId, trackId, mediaIds) {
      return RetrainFrameSelectionSchema.parse(
        await write('pipelineAnalytics.selectRetrainFrames', {
          deviceId,
          trackId,
          mediaIds: [...mediaIds],
        }),
      )
    },
    async saveRetrainAnnotations(deviceId, trackId, frameId, annotations, expectedRevision) {
      return z.array(RetrainAnnotationSchema).parse(
        await write('pipelineAnalytics.saveRetrainAnnotations', {
          deviceId,
          trackId,
          frameId,
          annotations: [...annotations],
          ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        }),
      )
    },
    async backfillRetrainOrigins(deviceId, trackId, frameId, origins, expectedRevision) {
      return OriginBackfillAnswer.parse(
        await write('pipelineAnalytics.backfillRetrainOrigins', {
          deviceId,
          ...(trackId !== undefined ? { trackId } : {}),
          frameId,
          origins: [...origins],
          ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        }),
      )
    },
    async setRetrainFrameComplete(deviceId, trackId, frameId, complete) {
      return RetrainFrameSchema.pick({ frameId: true, complete: true }).parse(
        await write('pipelineAnalytics.setRetrainFrameComplete', {
          deviceId,
          trackId,
          frameId,
          complete,
        }),
      )
    },
    async createCollection(name) {
      return RetrainCollectionCreateResultSchema.parse(
        await write('pipelineAnalytics.createRetrainCollection', { name }),
      )
    },
    async addFramesToCollection(collectionId, frameIds) {
      return AddResult.parse(
        await write('pipelineAnalytics.addRetrainFramesToCollection', {
          collectionId,
          frameIds: [...frameIds],
        }),
      )
    },
  }
}
