/**
 * RetrainService — the bodies behind the eleven `pipelineAnalytics.*Retrain*`
 * cap methods.
 *
 * It exists as a service rather than as eleven more methods on a 7,500-line
 * addon class for the reason `analytics-query-facade.ts` and `track-flags.ts`
 * already exist: the interesting parts (the copy ordering, the assist plan, the
 * lifecycle preconditions) are decidable from injected contracts alone, and a
 * test that had to boot the addon to reach them would not be written.
 *
 * Everything durable lives in two collections and one blob prefix:
 * `pipeline-analytics:retrain-frames` (the copies),
 * `pipeline-analytics:retrain-annotations` (the ground truth), and
 * `retrain/<deviceId>/<trackId>/…` (the pixels). No age sweep and no owner
 * cascade walks any of them — that is the whole point of copying.
 */

import {
  classifyRetrainReview,
  type IScopedLogger,
  type MediaFileKind,
  type MediaFileRef,
  type PreparedTransactOp,
  type RetrainAssistResult,
  type RetrainCorpusFilter,
  type RetrainCorpusKpi,
  type RetrainCorpusPage,
  type RetrainDismissed,
  type RetrainFrameList,
  type RetrainFrameReview,
  type RetrainFrameSelection,
  type RetrainOrigin,
  retrainRevisionConflictMessage,
  summarizeReview,
  type RetrainPipelineBox,
  type RetrainStatus,
  type RetrainTrack,
  type RetrainTransitionResult,
  type RunStatelessStepInput,
  type RunStatelessStepResult,
  type Track,
  type RetrainAnnotation as WireAnnotation,
  type RetrainAnnotationDraft as WireDraft,
  type RetrainFrame as WireFrame,
  type RetrainMacroClass,
} from '@camstack/types'
import { displayLabel } from '../pipeline/label-tier.js'
import {
  type RetrainAnnotation,
  type RetrainAnnotationDraft,
  RetrainAnnotationStore,
} from './retrain-annotation-store.js'
import { pipelineBoxOrigin, proposalOrigin } from './retrain-origin.js'
import {
  type AssistSubject,
  mapAssistDetails,
  planAssist,
  proposalToDraft,
} from './retrain-assist.js'
import { autoPickRetrainFrame, selectableRetrainFrames } from './retrain-frame-selection.js'
import { loadRetrainCorpusPage } from './retrain-corpus-page-load.js'
import { aggregateCorpusKpi, type CorpusFrameRow } from './retrain-corpus-query.js'
import { type RetrainFrame, RetrainFrameStore } from './retrain-frame-store.js'
import { completeRetrainTrack, restageRetrainTrack } from './retrain-lifecycle.js'
import { type FrameSubjectBox, pipelineBoxesForFrame } from './retrain-pipeline-boxes.js'
import { checkTierSeparation, isRetrainMacroClass } from './retrain-taxonomy.js'
import { isAnnotatedSceneKind } from '../../notification-center/rule-engine.js'

/** Default page size for the staging worklist. Staging is bounded at 500 per
 *  camera (D81), so this is a page, not a ceiling. */
const DEFAULT_STAGING_LIMIT = 100

/** Tries a last-write-wins save gets when it keeps losing the revision race. */
const LAST_WRITE_WINS_ATTEMPTS = 3

/** The track-store surface this needs — nothing more. */
export interface RetrainTrackSource {
  readonly listStaging: (deviceId: number, limit: number) => Promise<readonly Track[]>
  readonly listDeviceIds: () => Promise<readonly number[]>
  readonly getPersistedByTrackId: (trackId: string) => Promise<Track | null>
  readonly readStatus: (trackId: string) => Promise<RetrainStatus | null>
  readonly setStatus: (trackId: string, status: RetrainStatus) => Promise<void>
}

/** What {@link RetrainService.selectFrames} is asked — named, because a
 *  signature never carries an inline type in this repo. */
export interface SelectRetrainFramesRequest {
  readonly deviceId: number
  readonly trackId: string
  readonly mediaIds: readonly number[]
}

/** One copy-on-select that could not be honoured, named by the SOURCE row. */
export interface RetrainCopyRefusalRow {
  readonly sourceMediaId: number
  readonly reason: 'source-missing' | 'unreadable-image' | 'write-failed'
}

/** The media surface: the track's index rows, and one blob by media id. */
export interface RetrainMediaSource {
  readonly listTrackMedia: (trackId: string) => Promise<readonly MediaFileRef[]>
  readonly readBlob: (mediaId: number) => Promise<Buffer | null>
}

/** The runner call, injected so the assist is testable without a cluster. */
export type RetrainRunner = (
  input: RunStatelessStepInput,
  nodeId?: string,
) => Promise<RunStatelessStepResult>

/**
 * What the track store knows about a frame's instant — the read side of
 * Step 1 (the boxes the pipeline drew). Optional: without it a listed copy
 * simply carries no `pipelineBoxes`.
 */
export interface RetrainPipelineEvidence {
  /** The camera's tracks alive around `atMs` (a superset is fine — the
   *  pairing keeps only positions within its tolerance). */
  readonly tracksAround: (deviceId: number, atMs: number) => Promise<readonly Track[]>
  /** The track's media rows that recorded where the subject was (D510). */
  readonly subjectBoxes: (
    trackId: string,
    deviceId: number,
  ) => Promise<readonly { readonly mediaId: number; readonly subjectBox: FrameSubjectBox }[]>
}

/**
 * The collection membership a frame carries (`retrain-collection-store.ts`).
 * Optional: without it a listed frame carries no `collectionIds`, and a
 * deselected frame has no memberships to remove.
 */
export interface RetrainMembershipPort {
  readonly collectionsOf: (
    frameIds: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly string[]>>
  /** Frame ids of one collection, from the membership index. Absent ⇒ a
   *  collection filter cannot be answered and the page is dropped. */
  readonly listFrameIds?: (collectionId: string) => Promise<readonly string[]>
  /** The delete ops of every membership of the frame, committed WITH the frame row. */
  readonly forgetFrameOps: (frameId: string) => Promise<readonly PreparedTransactOp[]>
}

/**
 * Which frame a frame-scoped call is about. `trackId` is optional because a
 * recording still has none; when it IS given it must be the frame's own.
 */
export interface RetrainFrameRef {
  readonly deviceId: number
  readonly trackId?: string
  readonly frameId: string
}

export interface RetrainServiceDeps {
  readonly tracks: RetrainTrackSource
  readonly media: RetrainMediaSource
  readonly frames: RetrainFrameStore
  readonly annotations: RetrainAnnotationStore
  readonly runner: RetrainRunner
  readonly logger: IScopedLogger
  readonly pipelineEvidence?: RetrainPipelineEvidence
  readonly memberships?: RetrainMembershipPort
  /** The admin data-plane URL of a frame's pixels (`retrain-frame-handler.ts`).
   *  Absent where no data plane is served: the wire frame then carries none. */
  readonly frameUrl?: (frameId: string, size: 'thumb' | 'full') => string
}

/** A macro class that failed validation — the write is refused, never coerced. */
class RetrainAnnotationError extends Error {}

/** A store frame on the wire. A recording still carries no track and no
 *  source media row, and says so by leaving both out. */
function toWireFrame(f: RetrainFrame): WireFrame {
  return {
    frameId: f.frameId,
    deviceId: f.deviceId,
    origin: f.origin,
    ...(f.origin === 'track' ? { trackId: f.trackId, sourceMediaId: f.sourceMediaId } : {}),
    ...(f.epochMs !== undefined ? { epochMs: f.epochMs } : {}),
    sourceKind: f.sourceKind,
    sizeBytes: f.sizeBytes,
    width: f.width,
    height: f.height,
    copiedAt: f.copiedAt,
    ...(f.capturedAt !== undefined ? { capturedAt: f.capturedAt } : {}),
    complete: f.complete,
    revision: f.revision ?? 0,
    dismissed: f.dismissed ?? [],
  }
}

/**
 * What the operator did with the proposals on a frame (`retrain-review.ts`).
 *
 * A frame whose rows predate origins is judged against the pipeline boxes
 * re-derived now, and a proposal nobody kept is reported `removed` — both
 * flagged approximate. A frame with snapshots is judged on them alone.
 */
function reviewOfFrame(
  annotations: readonly RetrainAnnotation[],
  pipelineBoxes: readonly RetrainPipelineBox[],
  dismissed: readonly RetrainDismissed[],
): RetrainFrameReview {
  const legacy = annotations.some((a) => !a.origin)
  const review = classifyRetrainReview(
    annotations.map((a) => ({
      id: a.id,
      bbox: a.bbox,
      macroClass: a.macroClass,
      ...(a.label !== undefined ? { label: a.label } : {}),
      kind: a.kind,
      origin: a.origin ?? null,
    })),
    pipelineBoxes.map(pipelineBoxOrigin),
    dismissed,
    { inferRemoved: legacy },
  )
  return { boxes: review.boxes, summary: summarizeReview(review) }
}

function toWireAnnotation(a: RetrainAnnotation): WireAnnotation {
  return {
    id: a.id,
    ...(a.trackId !== '' ? { trackId: a.trackId } : {}),
    deviceId: a.deviceId,
    mediaKey: a.mediaKey,
    bbox: a.bbox,
    macroClass: a.macroClass,
    ...(a.label !== undefined ? { label: a.label } : {}),
    ...(a.subLabel !== undefined ? { subLabel: a.subLabel } : {}),
    kind: a.kind,
    source: a.source,
    ...(a.assistModelId !== undefined ? { assistModelId: a.assistModelId } : {}),
    ...(a.assistScore !== undefined ? { assistScore: a.assistScore } : {}),
    origin: a.origin ?? null,
    ...(a.exportedInBatch !== undefined ? { exportedInBatch: a.exportedInBatch } : {}),
    createdAt: a.createdAt,
  }
}

export class RetrainService {
  private readonly deps: RetrainServiceDeps

  constructor(deps: RetrainServiceDeps) {
    this.deps = deps
  }

  /**
   * The staging worklist. On demand, over the staging set only.
   *
   * The two counts come from ONE query each across the whole page rather than
   * per track: a worklist that issues 2N round trips to render N rows is how a
   * curation page becomes unusable at the exact camera count that makes it
   * worth having.
   */
  async listStaging(input: {
    deviceIds?: readonly number[]
    limit?: number
  }): Promise<readonly RetrainTrack[]> {
    const limit = input.limit ?? DEFAULT_STAGING_LIMIT
    const devices =
      input.deviceIds !== undefined && input.deviceIds.length > 0
        ? input.deviceIds
        : await this.deps.tracks.listDeviceIds()
    const tracks: Track[] = []
    for (const deviceId of devices) {
      tracks.push(...(await this.deps.tracks.listStaging(deviceId, limit)))
    }
    const ids = tracks.map((t) => t.trackId)
    const [frameCounts, annotationCounts] = await Promise.all([
      this.deps.frames.countsByTrack(ids),
      this.deps.annotations.countsByTrack(ids),
    ])
    return tracks.map(
      (t): RetrainTrack => ({
        trackId: t.trackId,
        deviceId: t.deviceId,
        className: t.className,
        ...(displayLabel(t) !== undefined ? { label: displayLabel(t) } : {}),
        firstSeen: t.firstSeen,
        lastSeen: t.lastSeen,
        frameCount: frameCounts.get(t.trackId) ?? 0,
        annotationCount: annotationCounts.get(t.trackId) ?? 0,
      }),
    )
  }

  /**
   * What a track can contribute, and what it already has.
   *
   * Index reads only. A candidate whose copy already exists is flagged, because
   * that is the one selection guaranteed to succeed regardless of what
   * retention did to the original.
   */
  async listFrames(trackId: string): Promise<RetrainFrameList> {
    const [media, copies] = await Promise.all([
      this.deps.media.listTrackMedia(trackId),
      this.deps.frames.listByTrack(trackId),
    ])
    const copiedSources = new Set(copies.map((c) => c.sourceMediaId))
    const candidates = selectableRetrainFrames(media).map((c) => ({
      mediaId: c.mediaId,
      kind: c.kind,
      timestamp: c.timestamp,
      sizeBytes: c.sizeBytes,
      copied: copiedSources.has(c.mediaId),
    }))
    const autoPick = autoPickRetrainFrame(media)
    if (candidates.length === 0) await this.logNoAnnotatableFrame(trackId, media, copies.length)
    return {
      candidates,
      copies: await this.toWireFrames(copies),
      ...(autoPick !== null ? { autoPickMediaId: autoPick.mediaId } : {}),
    }
  }

  /**
   * The wire frames, each with the boxes the pipeline drew on it (Step 1) and
   * the collections it belongs to.
   *
   * Index reads only — the track rows and the media rows' subject boxes, no
   * blob and no inference. One read per distinct track and per distinct
   * instant, not per box. A failed read degrades to fewer boxes, logged, and
   * never to a failed listing: the frames are the operator's work and must
   * stay reachable when the evidence is not.
   */
  async toWireFrames(copies: readonly RetrainFrame[]): Promise<readonly WireFrame[]> {
    const collections =
      this.deps.memberships !== undefined && copies.length > 0
        ? await this.deps.memberships.collectionsOf(copies.map((c) => c.frameId)).catch((err) => {
            this.deps.logger.warn('retrain frames: collection membership unreadable', {
              meta: { frames: copies.length, error: String(err) },
            })
            return new Map<string, readonly string[]>()
          })
        : null
    const evidence = this.deps.pipelineEvidence
    const ownTracks = new Map<string, Track | null>()
    const subjectBoxes = new Map<string, ReadonlyMap<number, FrameSubjectBox>>()
    const annotationsByFrame = await this.annotationsByFrame(copies)
    const out: WireFrame[] = []
    for (const copy of copies) {
      const wire = toWireFrame(copy)
      const collectionIds = collections?.get(copy.frameId)
      const withCollections: WireFrame = {
        ...(collections !== null ? { ...wire, collectionIds: collectionIds ?? [] } : wire),
        ...this.frameUrls(copy.frameId),
      }
      const reviewOf = (boxes: readonly RetrainPipelineBox[]): RetrainFrameReview =>
        reviewOfFrame(annotationsByFrame.get(copy.frameId) ?? [], boxes, copy.dismissed ?? [])
      if (evidence === undefined) {
        out.push({ ...withCollections, review: reviewOf([]) })
        continue
      }
      const trackId = copy.origin === 'track' ? copy.trackId : ''
      if (trackId !== '' && !ownTracks.has(trackId)) {
        ownTracks.set(
          trackId,
          await this.deps.tracks.getPersistedByTrackId(trackId).catch(() => null),
        )
        subjectBoxes.set(trackId, await this.readSubjectBoxes(evidence, trackId, copy.deviceId))
      }
      const neighbours =
        copy.capturedAt !== undefined
          ? await this.readTracksAround(evidence, copy.deviceId, copy.capturedAt)
          : []
      const pipelineBoxes = pipelineBoxesForFrame({
        frame: {
          deviceId: copy.deviceId,
          ...(trackId !== '' ? { trackId } : {}),
          ...(copy.capturedAt !== undefined ? { capturedAt: copy.capturedAt } : {}),
        },
        ownTrack: trackId !== '' ? (ownTracks.get(trackId) ?? null) : null,
        ownSubjectBox:
          trackId !== '' ? (subjectBoxes.get(trackId)?.get(copy.sourceMediaId) ?? null) : null,
        neighbours,
      })
      out.push({ ...withCollections, pipelineBoxes, review: reviewOf(pipelineBoxes) })
    }
    return out
  }

  /** The URLs of a frame's pixels, when a data plane is served for them. */
  private frameUrls(frameId: string): { imageUrl?: string; thumbnailUrl?: string } {
    const frameUrl = this.deps.frameUrl
    if (frameUrl === undefined) return {}
    return { imageUrl: frameUrl(frameId, 'full'), thumbnailUrl: frameUrl(frameId, 'thumb') }
  }

  /** The saved annotations of these frames, grouped by frame. */
  private async annotationsByFrame(
    copies: readonly RetrainFrame[],
  ): Promise<ReadonlyMap<string, readonly RetrainAnnotation[]>> {
    const grouped = new Map<string, RetrainAnnotation[]>()
    if (copies.length === 0) return grouped
    for (const a of await this.deps.annotations.listByFrames(copies.map((c) => c.frameId))) {
      const list = grouped.get(a.mediaKey)
      if (list === undefined) grouped.set(a.mediaKey, [a])
      else list.push(a)
    }
    return grouped
  }

  /**
   * The frame a frame-scoped call names, or a refusal. The frame is the
   * authority: its camera must be the caller's, and a `trackId`, when the
   * caller sends one, must be the frame's own — a recording still has none.
   */
  async requireFrame(ref: RetrainFrameRef, action: string): Promise<RetrainFrame> {
    const frame = await this.deps.frames.get(ref.frameId)
    const trackMismatch =
      frame !== null &&
      ref.trackId !== undefined &&
      (frame.origin !== 'track' || frame.trackId !== ref.trackId)
    if (frame === null || frame.deviceId !== ref.deviceId || trackMismatch) {
      this.deps.logger.warn(
        `retrain ${action} refused: the frame does not belong to that camera or track`,
        {
          tags: { deviceId: ref.deviceId },
          meta: {
            frameId: ref.frameId,
            ...(ref.trackId !== undefined ? { trackId: ref.trackId } : {}),
          },
        },
      )
      throw new RetrainAnnotationError(
        frame === null
          ? `retrain frame ${ref.frameId} does not exist — select it before annotating it`
          : `retrain frame ${ref.frameId} does not belong to ${ref.trackId !== undefined ? `track ${ref.trackId}` : `camera ${String(ref.deviceId)}`}`,
      )
    }
    return frame
  }

  private async readSubjectBoxes(
    evidence: RetrainPipelineEvidence,
    trackId: string,
    deviceId: number,
  ): Promise<ReadonlyMap<number, FrameSubjectBox>> {
    try {
      const rows = await evidence.subjectBoxes(trackId, deviceId)
      return new Map(rows.map((r) => [r.mediaId, r.subjectBox]))
    } catch (err) {
      this.deps.logger.warn('retrain pipeline boxes: subject boxes unreadable', {
        tags: { deviceId },
        meta: { trackId, error: String(err) },
      })
      return new Map()
    }
  }

  private async readTracksAround(
    evidence: RetrainPipelineEvidence,
    deviceId: number,
    atMs: number,
  ): Promise<readonly Track[]> {
    try {
      return await evidence.tracksAround(deviceId, atMs)
    } catch (err) {
      this.deps.logger.warn('retrain pipeline boxes: tracks around the frame unreadable', {
        tags: { deviceId },
        meta: { atMs, error: String(err) },
      })
      return []
    }
  }

  /**
   * A track with no annotatable frame is a REAL state, and the page has to say
   * so rather than render an empty strip that reads as a slow load. Two causes,
   * named apart: the whole-frame media AGED OUT, or the track only ever held
   * the boxed timeline tiles — an annotated frame is never a model input
   * (D654), and before the clean twins existed that was every such track.
   * The device is read off the track only here, on the empty branch.
   */
  private async logNoAnnotatableFrame(
    trackId: string,
    media: readonly MediaFileRef[],
    copies: number,
  ): Promise<void> {
    const annotatedOnly = media.filter((m) => isAnnotatedSceneKind(m.kind)).length
    const track = await this.deps.tracks.getPersistedByTrackId(trackId).catch(() => null)
    this.deps.logger.info('retrain: track has no annotatable frame', {
      ...(track !== null ? { tags: { deviceId: track.deviceId } } : {}),
      meta: {
        trackId,
        reason: annotatedOnly > 0 ? 'annotated-frames-only' : 'no-whole-frame-media',
        annotatedRows: annotatedOnly,
        mediaRows: media.length,
        copies,
      },
    })
  }

  /** COPY-ON-SELECT. See `RetrainFrameStore.copyFrame` for the ordering rule. */
  async selectFrames(input: SelectRetrainFramesRequest): Promise<RetrainFrameSelection> {
    const media = await this.deps.media.listTrackMedia(input.trackId)
    const kindOf = new Map<number, MediaFileKind>(media.map((m) => [m.mediaId, m.kind]))
    const capturedAtOf = new Map<number, number>(media.map((m) => [m.mediaId, m.timestamp]))
    const copied: WireFrame[] = []
    const refused: RetrainCopyRefusalRow[] = []
    for (const mediaId of input.mediaIds) {
      const result = await this.deps.frames.copyFrame({
        deviceId: input.deviceId,
        trackId: input.trackId,
        sourceMediaId: mediaId,
        // An id with no index row can still have a copy; `copyFrame` answers
        // from the copy first, so the kind is only needed on a NEW copy.
        sourceKind: kindOf.get(mediaId) ?? 'keyFrame',
        // When the camera saw it — the time a day/night flag and a
        // time-blocked split are about. Absent only when the row is gone.
        ...(capturedAtOf.has(mediaId) ? { capturedAt: capturedAtOf.get(mediaId) } : {}),
      })
      if (result.kind === 'copied') {
        copied.push({ ...toWireFrame(result.frame), ...this.frameUrls(result.frame.frameId) })
      } else refused.push({ sourceMediaId: result.sourceMediaId, reason: result.reason })
    }
    return { copied, refused }
  }

  /**
   * The operator's "every subject in this frame is boxed". Scoped to the
   * track the caller names: a frame of another track is refused, loudly.
   */
  async setFrameComplete(input: RetrainFrameRef & { complete: boolean }): Promise<WireFrame> {
    const frame = await this.requireFrame(input, 'complete')
    const updated = await this.deps.frames.setComplete(frame.frameId, input.complete)
    if (updated === null)
      throw new RetrainAnnotationError(`retrain frame ${input.frameId} vanished`)
    this.deps.logger.info('retrain frame completeness set', {
      tags: { deviceId: input.deviceId },
      meta: { trackId: frame.trackId, frameId: input.frameId, complete: input.complete },
    })
    return { ...toWireFrame(updated), ...this.frameUrls(updated.frameId) }
  }

  /** Un-select: the frame row, its annotations and its collection memberships
   *  leave in one transaction (an annotation whose frame is gone is unopenable
   *  and unfixable, so they never part); the blob is deleted after the row. */
  async deselectFrame(
    input: RetrainFrameRef,
  ): Promise<{ removed: boolean; removedAnnotations: number }> {
    const frame = await this.deps.frames.get(input.frameId)
    if (frame === null) {
      this.deps.logger.warn('retrain deselect: no such copied frame', {
        tags: { deviceId: input.deviceId },
        meta: { frameId: input.frameId },
      })
      return { removed: false, removedAnnotations: 0 }
    }
    await this.requireFrame(input, 'deselect')
    const removedAnnotations = await this.removeFrame(frame)
    return { removed: true, removedAnnotations }
  }

  /**
   * Remove a frame from the dataset. The frame row, its annotations and its
   * collection memberships leave in ONE transaction (a failure removes nothing
   * and throws); the blob is deleted after the row, never before.
   */
  async removeFrame(frame: RetrainFrame): Promise<number> {
    const annotationOps = await this.deps.annotations.deleteOpsForFrame(frame.frameId)
    const membershipOps = (await this.deps.memberships?.forgetFrameOps(frame.frameId)) ?? []
    await this.deps.frames.deleteFrame(frame, [...annotationOps, ...membershipOps])
    const removedAnnotations = annotationOps.length
    this.deps.logger.info('retrain frame removed from the dataset', {
      tags: { deviceId: frame.deviceId },
      meta: {
        origin: frame.origin,
        ...(frame.origin === 'track' ? { trackId: frame.trackId } : {}),
        frameId: frame.frameId,
        removedAnnotations,
      },
    })
    return removedAnnotations
  }

  /** The copy's pixels plus its exact dimensions — the canvas needs both. */
  async getFrameImage(frameId: string): Promise<{
    base64: string
    width: number
    height: number
  }> {
    const frame = await this.deps.frames.get(frameId)
    if (frame === null) throw new Error(`retrain frame ${frameId} does not exist`)
    const bytes = await this.deps.frames.readFrame(frame)
    if (bytes === null) throw new Error(`retrain frame ${frameId} has no readable copy`)
    return { base64: bytes.toString('base64'), width: frame.width, height: frame.height }
  }

  /**
   * Ask the pipeline for a proposal on ONE copied frame.
   *
   * The runner receives the copy — the same pixels the operator is looking at
   * and the same pixels the export will ship — so a proposed box is in the
   * coordinate space of the image it will be drawn on. Sending the ORIGINAL
   * here would reintroduce exactly the two-crops-one-space failure the copy
   * exists to prevent.
   */
  async propose(
    input: RetrainFrameRef & { subject: AssistSubject; nodeId?: string },
  ): Promise<RetrainAssistResult> {
    const plan = planAssist(input.subject)
    if (plan === null) {
      this.deps.logger.warn('retrain assist refused — a package proposal needs a zone', {
        tags: { deviceId: input.deviceId },
        meta: { trackId: input.trackId, frameId: input.frameId },
      })
      return {
        kind: 'refused',
        reason: 'no-zone',
        detail:
          'a package proposal runs on the zone crop only — at 0.35 on a full frame the detector proposes furniture',
      }
    }
    const frame = await this.deps.frames.get(input.frameId)
    if (
      frame === null ||
      frame.deviceId !== input.deviceId ||
      (input.trackId !== undefined && frame.trackId !== input.trackId)
    ) {
      return { kind: 'refused', reason: 'unknown-frame' }
    }
    const bytes = await this.deps.frames.readFrame(frame)
    if (bytes === null) {
      return { kind: 'refused', reason: 'unreadable-frame' }
    }
    const result = await this.deps.runner(
      {
        stepId: plan.stepId,
        modelId: plan.modelId,
        frameJpeg: bytes.toString('base64'),
        bbox: plan.bbox,
        className: plan.className,
        sourceDeviceId: input.deviceId,
      },
      input.nodeId,
    )
    if (result.kind !== 'ran') {
      this.deps.logger.warn('retrain assist refused by the runner', {
        tags: { deviceId: input.deviceId },
        meta: {
          trackId: input.trackId,
          frameId: input.frameId,
          stepId: plan.stepId,
          modelId: plan.modelId,
          nodeId: result.nodeId,
          reason: result.reason,
        },
      })
      return {
        kind: 'refused',
        reason: result.reason,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      }
    }
    const mapping = mapAssistDetails({
      details: result.details,
      modelId: result.modelId,
      minScore: plan.minScore,
      frameWidth: frame.width,
      frameHeight: frame.height,
    })
    this.deps.logger.info('retrain assist proposed boxes', {
      tags: { deviceId: input.deviceId },
      meta: {
        trackId: input.trackId,
        frameId: input.frameId,
        stepId: plan.stepId,
        modelId: result.modelId,
        proposals: mapping.proposals.length,
        belowThreshold: mapping.belowThreshold,
        withoutBox: mapping.withoutBox,
      },
    })
    const owner = {
      trackId: frame.trackId,
      deviceId: frame.deviceId,
      mediaKey: input.frameId,
    }
    return {
      kind: 'proposed',
      modelId: result.modelId,
      stepId: plan.stepId,
      minScore: plan.minScore,
      proposals: mapping.proposals.map((p, index) => {
        const draft = proposalToDraft(p, owner)
        return {
          origin: proposalOrigin('assist', index, {
            bbox: draft.bbox,
            macroClass: draft.macroClass,
            ...(draft.label !== undefined ? { label: draft.label } : {}),
            ...(draft.assistScore !== undefined ? { score: draft.assistScore } : {}),
            ...(draft.assistModelId !== undefined ? { modelId: draft.assistModelId } : {}),
          }),
          bbox: draft.bbox,
          macroClass: draft.macroClass,
          ...(draft.label !== undefined ? { label: draft.label } : {}),
          kind: draft.kind,
          source: draft.source,
          ...(draft.assistModelId !== undefined ? { assistModelId: draft.assistModelId } : {}),
          ...(draft.assistScore !== undefined ? { assistScore: draft.assistScore } : {}),
        }
      }),
      belowThreshold: mapping.belowThreshold,
    }
  }

  /** The annotations of a track, or of named frames (a recording still has
   *  no track). One of the two must be given. */
  async listAnnotations(input: {
    readonly trackId?: string
    readonly frameIds?: readonly string[]
  }): Promise<readonly WireAnnotation[]> {
    if (input.trackId !== undefined && input.trackId !== '') {
      return (await this.deps.annotations.listByTrack(input.trackId)).map(toWireAnnotation)
    }
    if (input.frameIds !== undefined) {
      return (await this.deps.annotations.listByFrames(input.frameIds)).map(toWireAnnotation)
    }
    throw new RetrainAnnotationError('listRetrainAnnotations needs a trackId or frameIds')
  }

  /**
   * Replace every annotation on one frame.
   *
   * Validates the TIERS before anything is written. A macro class typed into
   * `label` cannot be un-mixed by reading the table afterwards, so the refusal
   * has to be here — and it refuses the whole write, not the offending row: a
   * partial save on a curation surface silently drops boxes the operator
   * believes they stored.
   */
  async saveAnnotations(
    input: RetrainFrameRef & {
      annotations: readonly WireDraft[]
      expectedRevision?: number
      dismissed?: readonly RetrainDismissed[]
    },
  ): Promise<readonly WireAnnotation[]> {
    const frame = await this.requireFrame(input, 'save')
    for (const a of input.annotations) {
      if (!isRetrainMacroClass(a.macroClass)) {
        throw new RetrainAnnotationError(`"${a.macroClass}" is not a macro class`)
      }
      const violation = checkTierSeparation(a)
      if (violation !== null) {
        throw new RetrainAnnotationError(
          `"${violation.value}" is a MACRO CLASS and cannot be a ${violation.field} — the tiers are separate (person / postman / Marco)`,
        )
      }
    }
    const drafts = input.annotations.map(
      (a): RetrainAnnotationDraft => ({
        trackId: frame.trackId,
        deviceId: frame.deviceId,
        mediaKey: input.frameId,
        bbox: a.bbox,
        macroClass: a.macroClass,
        ...(a.label !== undefined ? { label: a.label } : {}),
        ...(a.subLabel !== undefined ? { subLabel: a.subLabel } : {}),
        kind: a.kind,
        source: a.source,
        ...(a.assistModelId !== undefined ? { assistModelId: a.assistModelId } : {}),
        ...(a.assistScore !== undefined ? { assistScore: a.assistScore } : {}),
        origin: a.origin ?? null,
      }),
    )
    // A proposal the operator kept again is no longer dismissed: the saved box
    // wins, so a frame cannot hold both "this was removed" and the box itself.
    const keptRefs = new Set(drafts.flatMap((d) => (d.origin ? [d.origin.ref] : [])))
    const dismissed =
      input.dismissed !== undefined
        ? input.dismissed.filter((d) => !keptRefs.has(d.ref))
        : undefined
    const saved = await this.replaceGuarded(frame, input, drafts, dismissed)
    const errors = saved.filter((a) => a.kind === 'model_error').length
    this.deps.logger.info('retrain annotations saved', {
      tags: { deviceId: input.deviceId },
      meta: {
        origin: frame.origin,
        trackId: frame.trackId,
        frameId: input.frameId,
        subjects: saved.length - errors,
        modelErrors: errors,
        dismissed: dismissed?.length,
      },
    })
    return saved.map(toWireAnnotation)
  }

  /**
   * The guarded replace. A caller that names the revision it saw gets exactly
   * one attempt: a different current revision is a conflict, never a retry —
   * the point is that it must look again. A caller that names none asked for
   * last-write-wins, so a race lost between our revision read and the records
   * `transact` that commits the save (a per-frame lock serialises the two) is
   * retried on the fresh revision, a bounded number of times.
   */
  private async replaceGuarded(
    frame: RetrainFrame,
    input: RetrainFrameRef & { expectedRevision?: number },
    drafts: readonly RetrainAnnotationDraft[],
    dismissed: readonly RetrainDismissed[] | undefined,
  ): Promise<readonly RetrainAnnotation[]> {
    const saved = await this.underRevision(frame, input, async (revision) => {
      const result = await this.deps.annotations.replaceForFrame(input.frameId, drafts, {
        fromRevision: revision,
        ...(dismissed !== undefined ? { dismissed } : {}),
      })
      return result.kind === 'saved'
        ? { kind: 'done', value: result.rows }
        : { kind: 'conflict', currentRevision: result.currentRevision }
    })
    return saved
  }

  /**
   * Run one revision-guarded write. `attempt` is handed the revision to guard
   * on and reports `done` or `conflict` (the frame moved; `null` = it is gone).
   */
  private async underRevision<T>(
    frame: RetrainFrame,
    input: RetrainFrameRef & { expectedRevision?: number },
    attempt: (
      revision: number,
    ) => Promise<
      | { readonly kind: 'done'; readonly value: T }
      | { readonly kind: 'conflict'; readonly currentRevision: number | null }
    >,
  ): Promise<T> {
    let revision = frame.revision ?? 0
    for (let tries = 0; tries < LAST_WRITE_WINS_ATTEMPTS; tries += 1) {
      if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
        this.refuseStale(input, revision, input.expectedRevision)
      }
      const result = await attempt(revision)
      if (result.kind === 'done') return result.value
      if (result.currentRevision === null) {
        throw new RetrainAnnotationError(`retrain frame ${input.frameId} vanished`)
      }
      revision = result.currentRevision
      if (input.expectedRevision !== undefined) {
        this.refuseStale(input, revision, input.expectedRevision)
      }
    }
    throw new RetrainAnnotationError(
      `retrain frame ${input.frameId} kept changing under the save — try again`,
    )
  }

  /**
   * Give rows saved before origins existed the origin a caller reconstructed
   * for them — and touch nothing else (ids, creation time and the export stamp
   * of the row stay). Only rows that have NO origin yet are written; a row that
   * already has one is skipped, because a snapshot taken at accept time is
   * evidence and a reconstruction must never overwrite it.
   */
  async backfillOrigins(
    input: RetrainFrameRef & {
      origins: readonly { readonly annotationId: string; readonly origin: RetrainOrigin }[]
      expectedRevision?: number
    },
  ): Promise<{ updated: number; skipped: number; revision: number }> {
    const frame = await this.requireFrame(input, 'backfill-origins')
    const wanted = new Map(input.origins.map((o) => [o.annotationId, o.origin]))
    const result = await this.underRevision(frame, input, async (revision) => {
      const outcome = await this.deps.annotations.setOrigins(input.frameId, wanted, {
        fromRevision: revision,
      })
      return outcome.kind === 'updated'
        ? { kind: 'done', value: outcome }
        : { kind: 'conflict', currentRevision: outcome.currentRevision }
    })
    this.deps.logger.info('retrain origins backfilled', {
      tags: { deviceId: input.deviceId },
      meta: {
        frameId: input.frameId,
        updated: result.updated,
        skipped: input.origins.length - result.updated,
      },
    })
    return {
      updated: result.updated,
      skipped: input.origins.length - result.updated,
      revision: result.revision,
    }
  }

  private refuseStale(input: RetrainFrameRef, current: number, expected: number): never {
    this.deps.logger.warn('retrain annotations save refused — the frame moved on', {
      tags: { deviceId: input.deviceId },
      meta: { frameId: input.frameId, currentRevision: current, expectedRevision: expected },
    })
    throw new RetrainAnnotationError(
      retrainRevisionConflictMessage(input.frameId, {
        currentRevision: current,
        expectedRevision: expected,
      }),
    )
  }

  /**
   * Paginated corpus list for the Frames grid. The page's copies only — see
   * `retrain-corpus-page-load.ts`. No JPEG.
   */
  async listCorpusPage(filter: RetrainCorpusFilter): Promise<RetrainCorpusPage> {
    return loadRetrainCorpusPage(
      {
        frames: this.deps.frames,
        annotations: this.deps.annotations,
        memberships: this.deps.memberships,
        logger: this.deps.logger,
      },
      filter,
      (copies) => this.toWireFrames(copies),
    )
  }

  /** Unfiltered corpus KPI — globals + per-camera rows via {@link workStateOf}. */
  async getCorpusKpi(): Promise<RetrainCorpusKpi> {
    return aggregateCorpusKpi(await this.loadCorpusRows())
  }

  /** Index facts for every corpus copy. */
  private async loadCorpusRows(): Promise<readonly CorpusFrameRow[]> {
    const frames = await this.deps.frames.listAll()
    if (frames.length === 0) return []
    const frameIds = frames.map((f) => f.frameId)
    const annotations = await this.deps.annotations.listByFrames(frameIds)
    const countByFrame = new Map<string, number>()
    const classesByFrame = new Map<string, Set<RetrainMacroClass>>()
    for (const a of annotations) {
      countByFrame.set(a.mediaKey, (countByFrame.get(a.mediaKey) ?? 0) + 1)
      const classes = classesByFrame.get(a.mediaKey) ?? new Set<RetrainMacroClass>()
      classes.add(a.macroClass)
      classesByFrame.set(a.mediaKey, classes)
    }
    const collections =
      this.deps.memberships !== undefined
        ? await this.deps.memberships.collectionsOf(frameIds).catch((err) => {
            this.deps.logger.warn('retrain corpus: collection membership unreadable', {
              meta: { frames: frameIds.length, error: String(err) },
            })
            return new Map<string, readonly string[]>()
          })
        : new Map<string, readonly string[]>()
    return frames.map(
      (f): CorpusFrameRow => ({
        frameId: f.frameId,
        deviceId: f.deviceId,
        complete: f.complete,
        annotationCount: countByFrame.get(f.frameId) ?? 0,
        copiedAt: f.copiedAt,
        collectionIds: collections.get(f.frameId) ?? [],
        classes: [...(classesByFrame.get(f.frameId) ?? [])].toSorted(),
      }),
    )
  }

  /** `staging → trained` — the first and only writer of that state. */
  async complete(input: { deviceId: number; trackId: string }): Promise<RetrainTransitionResult> {
    const result = await completeRetrainTrack(this.lifecycleDeps(), input)
    return this.toTransitionResult(input.trackId, result)
  }

  /** `trained → staging` — the deliberate return the toggle refuses to make. */
  async restage(input: { deviceId: number; trackId: string }): Promise<RetrainTransitionResult> {
    const result = await restageRetrainTrack(this.lifecycleDeps(), input)
    return this.toTransitionResult(input.trackId, result)
  }

  private lifecycleDeps() {
    return {
      store: {
        readStatus: (trackId: string) => this.deps.tracks.readStatus(trackId),
        setStatus: (trackId: string, status: RetrainStatus) =>
          this.deps.tracks.setStatus(trackId, status),
      },
      logger: this.deps.logger,
      countFrames: async (trackId: string) => (await this.deps.frames.listByTrack(trackId)).length,
      countAnnotations: async (trackId: string) =>
        (await this.deps.annotations.listByTrack(trackId)).length,
    }
  }

  /**
   * Collapse the lifecycle union onto the wire shape.
   *
   * The wire always reports WHERE THE TRACK ENDED UP, even on a refusal, so a
   * surface never has to re-fetch to find out whether its optimistic badge was
   * right. A refusal with no status (unknown track) reports `'none'` — there is
   * nothing else true to say, and the `reason` carries the real answer.
   */
  private toTransitionResult(
    trackId: string,
    result: Awaited<ReturnType<typeof completeRetrainTrack>>,
  ): RetrainTransitionResult {
    if (result.kind === 'moved') {
      return { trackId, retrainStatus: result.to, changed: true }
    }
    if (result.kind === 'unchanged') {
      return { trackId, retrainStatus: result.status, changed: false, reason: 'unchanged' }
    }
    return {
      trackId,
      retrainStatus: result.status ?? 'none',
      changed: false,
      reason: result.reason,
    }
  }
}
