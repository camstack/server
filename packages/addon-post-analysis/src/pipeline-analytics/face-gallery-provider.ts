/**
 * FaceGalleryProvider — implements the `face-gallery` system capability.
 *
 * Task 5: identity CRUD + samples (listIdentities, createIdentity,
 * renameIdentity, deleteIdentity, listIdentitySamples, removeSample).
 *
 * Task 6: faces + assign/unassign (listRecentFaces, getFaceByTrack,
 * getFaceMedia, assignFace, unassignFace).
 *
 * Samples enrolled via assignFace carry the model id the FACE ROW recorded —
 * see LEGACY_MODEL_ID for what a row that recorded none is assumed to be.
 */

import type {
  FaceCluster,
  FaceInfo,
  Identity,
  IdentitySampleAudit,
  IdentitySampleInfo,
  IFaceGalleryProvider,
  IScopedLogger,
  ListRecentFacesInput,
  PipelineAnalyticsFaceGalleryChangedPayload,
  SuggestFaceClustersInput,
} from '@camstack/types'
import { type GalleryMediaRow, toGalleryMediaRow } from './gallery-media-row.js'
import { resolveIncludeCrops } from './include-crops-default.js'
import { mapWithConcurrency } from './map-with-concurrency.js'
import { mediaFileUrl } from './media-file-url.js'
import { applyTrackLabelCandidate } from './pipeline/apply-track-label.js'
import { clusterByEmbedding } from './pipeline/face-clustering.js'
import { enrollmentPromiscuity } from './pipeline/face-matcher.js'
import type { EventStore } from './store/event-store.js'
import { type Face, FACE_SWEEP_PAGE, type FaceStore } from './store/face-store.js'
import type { AddIdentitySampleInput, IdentityStore } from './store/identity-store.js'
import { type AuditSampleInput, auditIdentitySamples } from './identity-audit.js'
import { alignmentForCapturedFace } from './face-alignment-version.js'
import type { MediaStore } from './store/media-store.js'
import type { TrackStore } from './store/track-store.js'

/** The source frame an enrolment carries into the sample (D644). */
interface EnrolledSourceFrame {
  readonly mediaId: number
  /** What the face named before the enrolment — restored on rollback. */
  readonly previousMediaId: number
  /** true = the face's own frame was moved; false = the track keyFrame was copied. */
  readonly reowned: boolean
}

/** The sample's source fields, from the face's box and landmarks on that frame. */
type SampleSourceFields = Pick<
  AddIdentitySampleInput,
  'sourceMediaId' | 'sourceBbox' | 'sourceLandmarks'
>

function sourceFieldsOf(
  sourceMediaId: number,
  face: Pick<Face, 'sourceFrameBbox' | 'sourceFrameLandmarks'>,
): SampleSourceFields {
  const b = face.sourceFrameBbox
  return {
    sourceMediaId,
    ...(b !== undefined ? { sourceBbox: { x: b.x, y: b.y, width: b.w, height: b.h } } : {}),
    ...(face.sourceFrameLandmarks !== undefined
      ? { sourceLandmarks: face.sourceFrameLandmarks }
      : {}),
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Attribution of a face identity NAMED BY THE OPERATOR in the gallery. */
const OPERATOR_FACE_STEP_ID = 'operator:face-gallery'

/**
 * Model id assumed for a face row that recorded none.
 *
 * Every row written before 2026-08-20 predates `Face.embeddingModelId`, and
 * every one of them was embedded with `arcface-r100` — it was the only face
 * model the step had ever defaulted to. So this is a statement about history,
 * NOT a default for new work: a face that names its model is stamped with the
 * model it names, because a sample that lies about its feature space defeats
 * the only guard `face-matcher` has.
 *
 * Exported because `face.rescoreTrack` must answer about the SAME vector this
 * provider would enrol. A rescore that assumed a different id than `assignFace`
 * stamps would report a face as comparable and then enrol it into a space the
 * matcher cannot reach — two constants is how that happens.
 */
export const LEGACY_MODEL_ID = 'arcface-r100'

/**
 * How many face crops `listRecentFaces` resolves at once.
 *
 * Each crop costs a store round-trip plus a disk read, so the page is I/O-bound
 * and the serial form dominated the operator's assign latency. 16 recovers
 * nearly all of the win while leaving the UDS channel — shared with the live
 * detection path — far from saturated; unbounded would trade a slow page for a
 * stalled pipeline.
 */
const FACE_CROP_FETCH_CONCURRENCY = 16

/**
 * How many unassigned faces `suggestFaceClusters` reads when the caller names
 * no {@link SuggestFaceClustersInput.maxFacesScanned}.
 *
 * Clustering used to read EVERY unassigned face on the hub, unconditionally:
 * its only bound (`limit`) cut the finished clusters, so it shortened the
 * ANSWER and never the work. A UI showing a window of 100 paid for a scan of
 * the whole corpus — on an addon whose disk is under contention — and no caller
 * had any way to ask for less.
 *
 * `FACE_SWEEP_PAGE` is chosen on purpose rather than a round number: it is
 * exactly ONE store page, so on the live corpus (372 face rows) the default
 * reads what it read before, one page, and nothing about today's answers
 * changes. What changes is the ceiling — the unbounded scan cannot come back as
 * the table grows.
 */
const SUGGEST_CLUSTERS_DEFAULT_FACE_POOL = FACE_SWEEP_PAGE

/**
 * The camera set a face listing is scoped to, as ONE value.
 *
 * `deviceIds` is the authority whenever it is present — including when it is
 * EMPTY, which reads nothing (a request for no cameras is a request, not an
 * omission). `deviceId` is the legacy single-camera form and only applies when
 * no set was named, so the two can never disagree about the answer.
 */
function resolveFaceDeviceScope(input?: {
  readonly deviceId?: number
  readonly deviceIds?: readonly number[]
}): { readonly deviceIds?: readonly number[] } {
  if (input?.deviceIds !== undefined) return { deviceIds: input.deviceIds }
  if (input?.deviceId !== undefined) return { deviceIds: [input.deviceId] }
  return {}
}

export interface FaceGalleryProviderDeps {
  readonly identityStore: IdentityStore
  readonly faceStore: FaceStore
  readonly mediaStore: MediaStore
  readonly trackStore: TrackStore
  readonly eventStore: EventStore
  readonly logger: IScopedLogger
  /** Called after gallery mutations to refresh the face recognizer. */
  readonly refreshGallery: () => void
  /**
   * The cluster's pinned face-embedding model, or null when it cannot be
   * resolved. Injected because the pin lives behind `ctx.api`, which a
   * provider does not hold — and because the audit must REFUSE rather than
   * guess: a report against the wrong feature space accuses the wrong samples.
   */
  readonly resolveClusterModelId: () => Promise<string | null>
  /**
   * The recogniser's live `similarityThreshold`. The audit flags a sample when
   * its best foreign match reaches it — see `flaggedCount`. Injected for the
   * same reason as the model pin: the setting lives behind the addon's own
   * cascade, and a second copy here would drift from the one that decides.
   */
  readonly resolveAutoAssignThreshold: () => Promise<number>
  /**
   * Base URL of the `event-media` data plane, or null when the addon has no
   * data-plane facility. Read lazily (a function, not a value) because the
   * plane is served AFTER the providers are constructed — capturing the value
   * here would pin `null` forever.
   */
  readonly eventMediaBaseUrl: () => string | null
  /**
   * `/addon/<addonId>/event-media` — the path a media row is addressed under.
   *
   * Not `eventMediaBaseUrl`: that one is null until `dataPlane.serve`
   * succeeds, which is the right question for an OPTIONAL `cropUrl` stamp and
   * the wrong one for a row's only address.
   */
  readonly eventMediaPathPrefix: () => string
  /**
   * Best-effort bus notification fired AFTER assign/unassign/delete store
   * writes succeed. A lost emit only delays the admin-ui live-refresh (D8
   * telemetry semantics), never the mutation itself.
   */
  readonly emitFaceGalleryChanged: (payload: PipelineAnalyticsFaceGalleryChangedPayload) => void
  /**
   * An identity just gained a DETECTED sample. The addon runs the old-alignment
   * prune for that identity off it (D643) — the enrol that crosses the
   * threshold is the moment the rule becomes true. Fire-and-forget: a prune
   * that fails must never fail the assignment.
   */
  readonly onSampleEnrolled?: (identityId: string) => void
}

export class FaceGalleryProvider implements IFaceGalleryProvider {
  private readonly identityStore: IdentityStore
  private readonly faceStore: FaceStore
  private readonly mediaStore: MediaStore
  private readonly trackStore: TrackStore
  private readonly eventStore: EventStore
  private readonly logger: IScopedLogger
  private readonly refreshGallery: () => void
  private readonly resolveClusterModelId: () => Promise<string | null>
  private readonly resolveAutoAssignThreshold: () => Promise<number>
  private readonly eventMediaBaseUrl: () => string | null
  private readonly eventMediaPathPrefix: () => string
  private readonly emitFaceGalleryChanged: (
    payload: PipelineAnalyticsFaceGalleryChangedPayload,
  ) => void
  private readonly onSampleEnrolled: ((identityId: string) => void) | undefined

  constructor(deps: FaceGalleryProviderDeps) {
    this.identityStore = deps.identityStore
    this.faceStore = deps.faceStore
    this.mediaStore = deps.mediaStore
    this.trackStore = deps.trackStore
    this.eventStore = deps.eventStore
    this.logger = deps.logger
    this.refreshGallery = deps.refreshGallery
    this.resolveClusterModelId = deps.resolveClusterModelId
    this.resolveAutoAssignThreshold = deps.resolveAutoAssignThreshold
    this.eventMediaBaseUrl = deps.eventMediaBaseUrl
    this.eventMediaPathPrefix = deps.eventMediaPathPrefix
    this.emitFaceGalleryChanged = deps.emitFaceGalleryChanged
    this.onSampleEnrolled = deps.onSampleEnrolled
  }

  /** Best-effort emit — never allowed to fail the mutation it follows. */
  private safeEmitFaceGalleryChanged(payload: PipelineAnalyticsFaceGalleryChangedPayload): void {
    try {
      this.emitFaceGalleryChanged(payload)
    } catch {
      // Best-effort telemetry (D8): a lost/failed emit only delays a UI
      // refresh — swallow so it can never fail the caller's mutation.
    }
  }

  // ── Identity CRUD ────────────────────────────────────────────────────

  async listIdentities(input?: { readonly includeCrops?: boolean }): Promise<readonly Identity[]> {
    // Default FALSE (see `include-crops-default.ts`). The row still carries
    // `coverMediaKey`, which the `event-media` plane serves `immutable` — so the
    // avatar is not lost, it moves off the JSON and onto the browser's cache.
    const includeCrops = resolveIncludeCrops(input)
    const rows = await this.identityStore.listIdentities()
    const result: Identity[] = []
    for (const r of rows) {
      // Resolve the cover crop inline so the UI renders the face avatar instead
      // of a placeholder icon. Prefer `coverMediaId`; fall back to the first
      // sample's media (covers identities enrolled before the cover was set).
      let coverMediaId = r.coverMediaId ?? undefined
      if (coverMediaId === undefined) {
        const samples = await this.identityStore.listSamples(r.id)
        coverMediaId = samples.find((s) => s.mediaId !== undefined)?.mediaId
      }
      // Only READ the blob when it is going to be sent. The cheap question comes
      // first: without this the opt-out saved wire bytes but still paid every
      // MediaStore read that produced them.
      let coverBase64: string | undefined
      if (coverMediaId !== undefined && includeCrops) {
        const media = await this.mediaStore.getById(coverMediaId)
        if (media) coverBase64 = media.base64
      }
      result.push({
        id: r.id,
        name: r.name,
        sampleCount: r.sampleCount,
        ...(coverMediaId !== undefined ? { coverMediaId } : {}),
        ...(coverBase64 !== undefined ? { coverBase64 } : {}),
      })
    }
    return result
  }

  async createIdentity(input: { readonly name: string }): Promise<Identity> {
    const raw = await this.identityStore.createIdentity({ name: input.name })
    this.refreshGallery()
    return {
      id: raw.id,
      name: raw.name,
      sampleCount: raw.sampleCount,
      ...(raw.coverMediaId !== undefined ? { coverMediaId: raw.coverMediaId } : {}),
    }
  }

  async renameIdentity(input: { readonly id: string; readonly name: string }): Promise<void> {
    await this.identityStore.renameIdentity(input.id, input.name)
    const refs = await this.faceStore.listCameraRefsForIdentity(input.id)
    for (const ref of refs) {
      this.safeEmitFaceGalleryChanged({
        deviceId: ref.deviceId,
        faceId: ref.faceId,
        kind: 'identity-renamed',
      })
    }
  }

  async deleteIdentity(input: { readonly id: string }): Promise<void> {
    // Detach assigned faces FIRST: unassignFace re-owns each crop back to the
    // unassigned buffer (preserving the image, re-assignable) instead of leaving
    // the face pointing at a deleted identity + deleted media (→ image-less
    // "Unknown" faces). Detected-face crops survive; only the identity's own
    // (e.g. uploaded photo) media is deleted below.
    // The identity's OWN rows, through the `recognizedIdentityId` index. This
    // used to list the whole collection and compare in JS — past the engine's
    // default row cap that detaches the faces that fit and leaves the rest
    // pointing at an identity that no longer exists.
    for (const faceId of await this.faceStore.listFaceIdsForIdentity(input.id)) {
      await this.unassignFace({ faceId })
    }
    // Delete any remaining identity-owned media + cascade the identity rows.
    await this.mediaStore.deleteForOwner('identity', [input.id])
    await this.identityStore.deleteIdentity(input.id)
    this.refreshGallery()
  }

  // ── Samples ──────────────────────────────────────────────────────────

  async listIdentitySamples(input: {
    readonly identityId: string
  }): Promise<readonly IdentitySampleInfo[]> {
    const rows = await this.identityStore.listSamples(input.identityId)
    const result: IdentitySampleInfo[] = []
    for (const row of rows) {
      let base64: string | undefined
      if (row.mediaId !== undefined) {
        const media = await this.mediaStore.getById(row.mediaId)
        if (media) base64 = media.base64
      }
      result.push({
        id: row.id,
        source: row.source,
        addedAt: row.addedAt,
        ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}),
        ...(base64 !== undefined ? { base64 } : {}),
      })
    }
    return result
  }

  /**
   * Re-analyse one person's enrolled samples against the whole gallery.
   *
   * Reads every identity's samples and their vectors — 327 on this cluster —
   * and ranks the target's own by how little they look like the rest of that
   * person and how much they look like somebody else (`identity-audit.ts`).
   * Dot products, no inference, no write.
   *
   * The whole gallery is loaded on purpose: the accusation that matters is
   * "this looks like SOMEONE ELSE", and that cannot be computed from one
   * person's samples.
   */
  async auditIdentitySamples(input: { readonly identityId: string }): Promise<IdentitySampleAudit> {
    const modelId = await this.resolveClusterModelId()
    if (modelId === null) {
      throw new Error(
        'auditIdentitySamples: the cluster face-embedding model could not be resolved',
      )
    }
    const autoAssignThreshold = await this.resolveAutoAssignThreshold()
    const identities = await this.identityStore.listIdentities()
    const target = identities.find((i) => i.id === input.identityId)
    if (target === undefined) {
      throw new Error(`auditIdentitySamples: no identity ${input.identityId}`)
    }

    const samplesByIdentity = new Map<string, Awaited<ReturnType<IdentityStore['listSamples']>>>()
    for (const identity of identities) {
      samplesByIdentity.set(identity.id, await this.identityStore.listSamples(identity.id))
    }
    const vectors = await this.identityStore.loadSampleVectors(
      [...samplesByIdentity.values()].flat().map((sample) => sample.id),
    )

    const inputsFor = (identityId: string): readonly AuditSampleInput[] =>
      (samplesByIdentity.get(identityId) ?? []).flatMap((sample) => {
        const embedding = vectors.get(sample.id)
        // A sample whose vector the index cannot serve is DROPPED, never
        // scored: an absent vector's cosine is still a number, and here that
        // number would read as "looks like nobody" — an accusation.
        if (embedding === undefined) return []
        return [
          {
            sampleId: sample.id,
            embedding,
            modelId: sample.modelId,
            enrolledAt: sample.addedAt,
            ...(sample.deviceId === undefined ? {} : { deviceId: sample.deviceId }),
          },
        ]
      })

    const report = auditIdentitySamples({
      identityId: input.identityId,
      samples: inputsFor(input.identityId),
      others: identities
        .filter((identity) => identity.id !== input.identityId)
        .map((identity) => ({
          identityId: identity.id,
          name: identity.name,
          samples: inputsFor(identity.id),
        })),
      modelId,
      autoAssignThreshold,
    })

    const meta = new Map(
      (samplesByIdentity.get(input.identityId) ?? []).map((sample) => [sample.id, sample]),
    )
    return {
      identityId: report.identityId,
      name: target.name,
      modelId,
      totalSamples: report.totalSamples,
      comparableSamples: report.comparableSamples,
      flagged: report.flagged,
      flagThreshold: autoAssignThreshold,
      rows: report.rows.map((row) => {
        const sample = meta.get(row.sampleId)
        return {
          ...row,
          source: sample?.source ?? 'detected',
          ...(sample?.mediaId === undefined ? {} : { mediaId: sample.mediaId }),
        }
      }),
    }
  }

  async removeSample(input: {
    readonly identityId: string
    readonly sampleId: string
  }): Promise<void> {
    // Look up the sample's mediaId before deleting the row.
    const samples = await this.identityStore.listSamples(input.identityId)
    const sample = samples.find((s) => s.id === input.sampleId)

    // A buffered face enrolled as this sample holds its id AND (after the
    // re-own in `assignFace`) the very crop blob deleted below. Detach first:
    // the face keeps its assignment, loses the dead references, and a later
    // unassign/reassign no longer removes a sample twice (D643). A failure
    // here THROWS — deleting the sample under a face that still names it is
    // the state this exists to prevent.
    // The source frame is handled the same way (D644): after enrolment the
    // face and the sample name ONE blob, deleted below with the sample.
    if (sample !== undefined) {
      for (const ref of await this.faceStore.listFacesForSample(input.identityId, input.sampleId)) {
        await this.faceStore.detachSample(ref.faceId, {
          media: sample.mediaId !== undefined && ref.mediaId === sample.mediaId,
          sourceFrame:
            sample.sourceMediaId !== undefined && ref.sourceFrameMediaId === sample.sourceMediaId,
        })
      }
    }

    // Delete the durable media entries for this sample if any exist.
    if (sample?.mediaId !== undefined) {
      await this.mediaStore.deleteById(sample.mediaId)
    }
    // A `photo` sample owns TWO blobs: the aligned template and the original
    // photograph beside it. Both are `ownerKind: 'identity'`, which makes them
    // exempt from every sweep this repo has — so a source photo left behind
    // here would live forever, on the data volume, with nothing pointing at it.
    if (sample?.sourceMediaId !== undefined) {
      await this.mediaStore.deleteById(sample.sourceMediaId)
    }

    await this.identityStore.removeSample(input.identityId, input.sampleId)
  }

  // ── Faces ────────────────────────────────────────────────────────────

  /**
   * List recent buffered faces, mapped to FaceInfo.
   * NEVER exposes the raw embedding.
   */
  /**
   * Inline base64 of a face's crop. Prefers `mediaId` (which FOLLOWS the crop
   * after assignment re-owns it from `face` → `identity`), so an assigned face
   * still shows its image; falls back to the face-owned media for rows without a
   * mediaId.
   */
  private async faceCropBase64(face: {
    readonly id: string
    readonly mediaId?: number
  }): Promise<string | undefined> {
    if (face.mediaId !== undefined) {
      const m = await this.mediaStore.getById(face.mediaId)
      if (m) return m.base64
    }
    // Only a `crop`: a face also owns its full SOURCE frame (D644), and a
    // multi-megabyte frame inlined as a gallery tile is not a crop.
    const media = await this.mediaStore.listByOwner('face', face.id)
    return media.find((m) => m.kind === 'crop')?.base64
  }

  /**
   * The crop as a data-plane URL, or undefined when there is no stored media
   * row or no plane to serve it.
   *
   * The `event-media` plane serves a media row by its OWN id (D482), so a face
   * crop needs NO new plane and no new access decision — the same
   * `authenticated` level already serves the track thumbnails the same
   * operator is looking at.
   */
  private cropUrlFor(face: { readonly mediaId?: number }): string | undefined {
    if (face.mediaId === undefined) return undefined
    const base = this.eventMediaBaseUrl()
    if (base === null) return undefined
    return mediaFileUrl(base, face.mediaId)
  }

  async listRecentFaces(input?: ListRecentFacesInput): Promise<readonly FaceInfo[]> {
    const faces = await this.faceStore.listAllRecentFaces({
      ...resolveFaceDeviceScope(input),
      limit: input?.limit,
      filter: input?.filter,
      since: input?.since,
      until: input?.until,
      sortBy: input?.sortBy,
      sortDirection: input?.sortDirection,
    })

    // Names for the identities THIS PAGE references — not the collection.
    // Under `filter: 'unassigned'` that set is empty and the lookup costs no
    // round trip at all. See `IdentityStore.namesFor`.
    const nameMap = await this.identityStore.namesFor(
      faces.flatMap((f) => (f.recognizedIdentityId != null ? [f.recognizedIdentityId] : [])),
    )

    // Default FALSE since 2026-08-25 — `include-crops-default.ts` is the one
    // place that decides this, and records why the expensive shape has to be
    // the one a caller asks for by name.
    const includeCrops = resolveIncludeCrops(input)

    // One crop per row is a store round-trip PLUS a disk read, and resolving
    // them with `for … await` made the page cost N serial I/O pairs: at the 500
    // the Faces view asks for, 9.5 s warm and 61 s cold on the live hub — paid
    // again on every operator assign (the mutation itself is ~30 ms) and on
    // every 30 s poll. Bounded so a page cannot flood the UDS channel the live
    // detection path shares; ordering is the query's, and is preserved.
    //
    // With `includeCrops: false` the read disappears entirely — the row carries
    // `cropUrl` and the browser fetches the bytes itself, cached and ETagged.
    return mapWithConcurrency(faces, FACE_CROP_FETCH_CONCURRENCY, async (face) => {
      // base64 follows the crop via mediaId (works for assigned faces too).
      const base64 = includeCrops ? await this.faceCropBase64(face) : undefined
      const cropUrl = this.cropUrlFor(face)

      const identityName = face.recognizedIdentityId
        ? nameMap.get(face.recognizedIdentityId)
        : undefined

      const info: FaceInfo = {
        faceId: face.id,
        deviceId: face.deviceId,
        trackId: face.trackId,
        timestamp: face.timestamp,
        // `!= null` (not `!== undefined`): the relational face-store surfaces an
        // unset identity as SQL NULL, and the FaceInfo schema's `recognizedIdentityId`
        // is `z.string().optional()` which REJECTS null → output validation would
        // fail and the People page would render empty.
        ...(face.recognizedIdentityId != null
          ? { recognizedIdentityId: face.recognizedIdentityId }
          : {}),
        ...(identityName !== undefined ? { identityName } : {}),
        assigned: face.assigned,
        ...(base64 !== undefined ? { base64 } : {}),
        ...(cropUrl !== undefined ? { cropUrl } : {}),
        ...(face.faceBbox !== undefined ? { faceBbox: face.faceBbox } : {}),
        ...(face.keyFrameMediaId !== undefined ? { keyFrameMediaId: face.keyFrameMediaId } : {}),
        ...(face.bestMatchScore != null ? { bestMatchScore: face.bestMatchScore } : {}),
        ...(face.nativeFaceShortSidePx != null
          ? { nativeFaceShortSidePx: face.nativeFaceShortSidePx }
          : {}),
        ...(face.suggestedIdentityId != null
          ? { suggestedIdentityId: face.suggestedIdentityId }
          : {}),
        ...(face.suggestedMatchScore != null
          ? { suggestedMatchScore: face.suggestedMatchScore }
          : {}),
      }
      return info
    })
  }

  /**
   * Get a face by deviceId + trackId. Returns null if not found or if
   * the stored face belongs to a different device.
   *
   * Invariant: faceId === 'face-' + trackId (one buffered face per track,
   * keyed this way by the frame-processor pipeline).
   */
  async getFaceByTrack(input: { deviceId: number; trackId: string }): Promise<FaceInfo | null> {
    const face = await this.faceStore.get('face-' + input.trackId)
    if (!face) return null
    if (face.deviceId !== input.deviceId) return null

    const nameMap = await this.identityStore.namesFor(
      face.recognizedIdentityId != null ? [face.recognizedIdentityId] : [],
    )
    const identityName = face.recognizedIdentityId
      ? nameMap.get(face.recognizedIdentityId)
      : undefined

    const cropUrl = this.cropUrlFor(face)

    return {
      faceId: face.id,
      deviceId: face.deviceId,
      trackId: face.trackId,
      timestamp: face.timestamp,
      ...(face.recognizedIdentityId != null
        ? { recognizedIdentityId: face.recognizedIdentityId }
        : {}),
      ...(identityName !== undefined ? { identityName } : {}),
      assigned: face.assigned,
      ...(cropUrl !== undefined ? { cropUrl } : {}),
      ...(face.faceBbox !== undefined ? { faceBbox: face.faceBbox } : {}),
      ...(face.keyFrameMediaId !== undefined ? { keyFrameMediaId: face.keyFrameMediaId } : {}),
      ...(face.bestMatchScore != null ? { bestMatchScore: face.bestMatchScore } : {}),
      ...(face.nativeFaceShortSidePx != null
        ? { nativeFaceShortSidePx: face.nativeFaceShortSidePx }
        : {}),
      ...(face.suggestedIdentityId != null
        ? { suggestedIdentityId: face.suggestedIdentityId }
        : {}),
      ...(face.suggestedMatchScore != null
        ? { suggestedMatchScore: face.suggestedMatchScore }
        : {}),
    }
  }

  /**
   * Get all media files for a buffered face (the face's own crops, not
   * the enrolled identity copies — those live under identity owner).
   */
  async getFaceMedia(input: { faceId: string }): Promise<readonly GalleryMediaRow[]> {
    const media = await this.mediaStore.listByOwner('face', input.faceId)
    return media.map((m) => toGalleryMediaRow(m, this.eventMediaPathPrefix()))
  }

  /**
   * Assign a buffered face to an identity:
   * 1. Re-own the face crop to the identity (durable).
   * 2. Enroll a new sample with the face's embedding.
   * 3. Mark the face as assigned.
   * 4. Propagate the identity name as the track label.
   * 5. Refresh the recognizer gallery.
   */
  async assignFace(input: { faceId: string; identityId: string }): Promise<void> {
    const { faceId, identityId } = input

    const face = await this.faceStore.get(faceId)
    if (!face) {
      throw new Error(`FaceGalleryProvider.assignFace: face not found: ${faceId}`)
    }

    // 0. If the face is already assigned (reassign case), clean up the prior
    //    enrollment first so we don't orphan the old sample + its durable media.
    if (face.assignedSampleId !== undefined) {
      const priorIdentityId = face.recognizedIdentityId
      if (priorIdentityId !== undefined) {
        // Remove the prior sample (also deletes its durable media via removeSample).
        // After this call the media row that face.mediaId points to is gone — we
        // must also clear mediaId from the face row so the subsequent reown
        // doesn't try to move a non-existent row.
        await this.removeSample({ identityId: priorIdentityId, sampleId: face.assignedSampleId })
      }
      // Clear assignment fields (assigned, recognizedIdentityId, assignedSampleId)
      // and also nullify mediaId: its blob was deleted above by removeSample, so
      // the old id no longer resolves to any row. Nullifying prevents the
      // subsequent reown from trying to move a non-existent resource.
      // Use null (not undefined) so it explicitly overwrites the stored id;
      // mirrors clearAssignment's null pattern for
      // recognizedIdentityId/assignedSampleId. `FaceColumnPatch` says `null`
      // clears the column, so this is no longer a cast (D482).
      await this.faceStore.clearAssignment(faceId)
      await this.faceStore.update(faceId, { mediaId: null })
    }

    // Re-fetch the face after potential clearAssignment so mediaId reflects current state.
    // WITH its vector: enrolment is the one read that genuinely needs the 512
    // floats — the promiscuity gate ranks them and `addSample` copies them into
    // the gallery index.
    const currentFace = await this.faceStore.getWithEmbedding(faceId)
    if (!currentFace) {
      throw new Error(
        `FaceGalleryProvider.assignFace: face disappeared after pre-cleanup: ${faceId}`,
      )
    }

    // 0.5. Quality gate, BEFORE any media moves (the cheap question first):
    // an embedding that sits near a sample of a DIFFERENT identity is in the
    // low-information attractor and must never become a gallery sample — 22 of
    // 50 live samples were enrolled that way (2026-08-18) and each became a
    // magnet that "recognised" every degraded probe as its owner. Runs after
    // the reassign pre-cleanup so the face's own prior sample cannot condemn
    // it. The face itself stays label-able later with a better crop; refusing
    // loudly beats re-poisoning the gallery silently.
    const enrolledModelId = currentFace.embeddingModelId ?? LEGACY_MODEL_ID
    const verdict = enrollmentPromiscuity(
      currentFace.embedding,
      enrolledModelId,
      identityId,
      await this.identityStore.loadGallery(),
    )
    if (verdict !== null) {
      this.logger.warn('assignFace refused: embedding too close to a FOREIGN identity sample', {
        tags: { deviceId: currentFace.deviceId },
        meta: { faceId, identityId, foreignIdentityId: verdict.identityId, cosine: verdict.cosine },
      })
      throw new Error(
        `FaceGalleryProvider.assignFace: embedding is ambiguous — cosine ${verdict.cosine.toFixed(3)} with a sample of another identity (${verdict.identityId}); pick a clearer crop`,
      )
    }

    // 1. Re-own the crop to the identity if one exists
    let newMediaId: number | undefined
    if (currentFace.mediaId !== undefined) {
      newMediaId = await this.mediaStore.reown({
        fromOwnerKind: 'face',
        fromOwnerId: faceId,
        toOwnerKind: 'identity',
        toOwnerId: identityId,
        mediaId: currentFace.mediaId,
      })
      // Persist the new (identity-owned) id onto the face row so that a future
      // reassign or unassign sees the correct current id instead of the stale
      // face-owned id whose blob+row no longer exists.
      await this.faceStore.update(faceId, { mediaId: newMediaId })
    }

    // 1b. The face's SOURCE frame goes to the identity with it (D644): the
    // sample's `sourceMediaId`, what a future alignment re-derives from.
    const source = await this.moveSourceFrameToIdentity(currentFace, identityId)

    // 2. Enroll the embedding as a new identity sample, then mark assigned.
    // If either step fails AFTER a successful reown, attempt to reverse the
    // move so the face crop returns to its original owner and the face stays
    // in a retryable state.
    const alignment = alignmentForCapturedFace(currentFace.timestamp)
    let sample: Awaited<ReturnType<typeof this.identityStore.addSample>>
    try {
      sample = await this.identityStore.addSample({
        identityId,
        embedding: currentFace.embedding,
        ...(newMediaId !== undefined ? { mediaId: newMediaId } : {}),
        modelId: enrolledModelId,
        source: 'detected',
        deviceId: currentFace.deviceId,
        // D643: the face row records WHEN it was captured, not which detector
        // aligned it — a buffered pre-fix face assigned today is still v1.
        ...(alignment !== undefined ? { alignment } : {}),
        ...(source !== null ? sourceFieldsOf(source.mediaId, currentFace) : {}),
      })

      // 3. Mark the face as assigned
      await this.faceStore.markAssigned(faceId, identityId, sample.id)
    } catch (err) {
      await this.rollBackSourceFrame(faceId, identityId, source)
      // Roll back the reown so the crop is not orphaned under the identity owner.
      if (newMediaId !== undefined) {
        try {
          await this.mediaStore.reown({
            fromOwnerKind: 'identity',
            fromOwnerId: identityId,
            toOwnerKind: 'face',
            toOwnerId: faceId,
            mediaId: newMediaId,
          })
        } catch {
          // Best-effort rollback — log nothing to keep the path simple; the
          // original error is the actionable one.
        }
      }
      throw err
    }

    // 4. Propagate the identity name as label to track + events
    const identities = await this.identityStore.listIdentities()
    const identity = identities.find((i) => i.id === identityId)
    const identityName = identity?.name
    if (identityName !== undefined) {
      // An identity is TIER 2 — the finest thing sayable about the subject —
      // and this write carries OPERATOR authority: the person naming a face in
      // the gallery is correcting the machine, so it takes the tier without a
      // score comparison. Importance is recomputed inside (late label → the
      // identity term of an already-persisted track's score).
      await applyTrackLabelCandidate(
        { trackStore: this.trackStore, eventStore: this.eventStore, logger: this.logger },
        currentFace.deviceId,
        currentFace.trackId,
        {
          text: identityName,
          tier: 2,
          score: 1,
          stepId: OPERATOR_FACE_STEP_ID,
          decidedAt: Date.now(),
          operatorAuthority: true,
          // Same id an ArcFace match would have carried — an operator-assigned
          // identity must satisfy exactly the rules a recognised one satisfies.
          identityId,
        },
      )
    }

    // 5. Refresh the recognizer gallery
    this.refreshGallery()

    // 5.5. The identity gained a detected sample — the enrol that can cross the
    // old-alignment prune threshold (D643). Guarded like the emit below: the
    // assignment already happened and nothing downstream may un-happen it.
    try {
      this.onSampleEnrolled?.(identityId)
    } catch (err: unknown) {
      this.logger.warn('assignFace: the after-enrol hook threw — the assignment stands', {
        tags: { deviceId: currentFace.deviceId },
        meta: { faceId, identityId, error: err instanceof Error ? err.message : String(err) },
      })
    }

    // 6. Best-effort live-update notification — emitted AFTER the store
    // writes above succeeded, never before.
    this.safeEmitFaceGalleryChanged({
      deviceId: currentFace.deviceId,
      faceId,
      kind: 'assigned',
    })
  }

  /**
   * Unassign a buffered face from its identity:
   * 1. Remove the enrolled sample (and its durable media via removeSample).
   *    Only runs if assignedSampleId is present (sample exists only when
   *    assignFace ran; a recognizer-auto-marked face has no sample to remove).
   * 2. Clear the face assignment (always).
   * 3. Clear the label on the track and its emitted events.
   * 4. Refresh the recognizer gallery.
   */
  async unassignFace(input: { faceId: string }): Promise<void> {
    const { faceId } = input

    const face = await this.faceStore.get(faceId)
    if (!face) {
      throw new Error(`FaceGalleryProvider.unassignFace: face not found: ${faceId}`)
    }
    const owningIdentityId = face.recognizedIdentityId

    // 0. The source frame goes back to the face too (D644) — before the row
    //    goes, so the frame is never owned by nothing.
    if (
      face.sourceFrameMediaId !== undefined &&
      owningIdentityId !== undefined &&
      (await this.isIdentityOwned(face.sourceFrameMediaId, owningIdentityId))
    ) {
      try {
        const restored = await this.mediaStore.reown({
          fromOwnerKind: 'identity',
          fromOwnerId: owningIdentityId,
          toOwnerKind: 'face',
          toOwnerId: faceId,
          mediaId: face.sourceFrameMediaId,
        })
        await this.faceStore.update(faceId, { sourceFrameMediaId: restored })
      } catch (err: unknown) {
        // It could not come back to the face. The sample row is about to go,
        // and an identity-owned blob is exempt from every sweep — left here it
        // would be referenced by nothing, forever. So it goes, and the face
        // stops naming it.
        await this.dropUnreturnedSourceFrame(face.deviceId, faceId, face.sourceFrameMediaId, err)
      }
    }

    // 1. Re-own the crop back from the identity to the face so the IMAGE IS
    //    PRESERVED — the face returns to the unassigned buffer, re-assignable.
    //    (Previously the sample + its media were deleted, destroying the crop.)
    if (face.mediaId !== undefined && owningIdentityId !== undefined) {
      try {
        const restoredMediaId = await this.mediaStore.reown({
          fromOwnerKind: 'identity',
          fromOwnerId: owningIdentityId,
          toOwnerKind: 'face',
          toOwnerId: faceId,
          mediaId: face.mediaId,
        })
        await this.faceStore.update(faceId, { mediaId: restoredMediaId })
      } catch {
        // Media missing / already moved — best-effort; still unassign below.
      }
    }

    // 2. Remove the enrolled identity sample ROW only (its media was moved back
    //    to the face above, NOT deleted). Safe no-op when no sample was enrolled.
    if (face.assignedSampleId !== undefined && owningIdentityId !== undefined) {
      await this.identityStore.removeSample(owningIdentityId, face.assignedSampleId)
    }

    // 3. Clear the face assignment fields (assigned / recognizedIdentityId / sampleId).
    await this.faceStore.clearAssignment(faceId)

    // 4. Label-clear: revert the label on the track and its object events.
    // TIER 2 only: the identity is what is being taken back. A tier-1 sub-class
    // on the same track was decided by something else and is still true.
    await this.eventStore.clearLabelForTrack(face.trackId, 2)
    await this.trackStore.clearLabel(face.trackId, 2)

    // 5. Refresh the recognizer gallery
    this.refreshGallery()

    // 6. Best-effort live-update notification — emitted AFTER the store
    // writes above succeeded, never before.
    this.safeEmitFaceGalleryChanged({ deviceId: face.deviceId, faceId, kind: 'unassigned' })
  }

  /**
   * Take the face's source frame to the identity for enrolment (D644).
   *
   * - The face's OWN frame (`face`-owned) is re-owned: the face and the
   *   sample then name ONE identity blob, exactly like the crop, and
   *   `removeSample` deletes it and detaches the face.
   * - A frame that is the TRACK's stored keyFrame (reused when the instant
   *   matched) is copied — the track still shows it — and the face is pointed
   *   at the copy, so the same one-blob rule holds.
   * - Anything else is not enrolled with; the sample is written without a
   *   source and the line says why.
   */
  private async moveSourceFrameToIdentity(
    face: Pick<Face, 'id' | 'deviceId' | 'sourceFrameMediaId'>,
    identityId: string,
  ): Promise<EnrolledSourceFrame | null> {
    const mediaId = face.sourceFrameMediaId
    if (mediaId === undefined) return null
    const without = (why: string, extra: Record<string, unknown> = {}): null => {
      this.logger.warn('assignFace: enrolled WITHOUT the source frame', {
        tags: { deviceId: face.deviceId },
        meta: { faceId: face.id, mediaId, why, ...extra },
      })
      return null
    }
    try {
      const owner = await this.mediaStore.ownerOf(mediaId)
      if (owner === null) return without('the frame is gone')
      if (owner.ownerKind === 'face' && owner.ownerId === face.id) {
        const moved = await this.mediaStore.reown({
          fromOwnerKind: 'face',
          fromOwnerId: face.id,
          toOwnerKind: 'identity',
          toOwnerId: identityId,
          mediaId,
        })
        await this.faceStore.update(face.id, { sourceFrameMediaId: moved })
        return { mediaId: moved, previousMediaId: mediaId, reowned: true }
      }
      if (owner.ownerKind !== 'track') {
        return without("the frame is not this face's nor its track's", { owner })
      }
      const file = await this.mediaStore.getById(mediaId)
      if (file === null) return without('the track keyFrame blob is gone')
      const copied = await this.mediaStore.put({
        deviceId: face.deviceId,
        ownerKind: 'identity',
        ownerId: identityId,
        kind: 'fullFrame',
        timestamp: file.timestamp,
        data: Buffer.from(file.base64, 'base64'),
      })
      await this.faceStore.update(face.id, { sourceFrameMediaId: copied })
      return { mediaId: copied, previousMediaId: mediaId, reowned: false }
    } catch (err: unknown) {
      return without('the move threw', { error: errMessage(err) })
    }
  }

  /** Only an IDENTITY-owned frame goes back; a face or track frame is already where it belongs. */
  private async isIdentityOwned(mediaId: number, identityId: string): Promise<boolean> {
    const owner = await this.mediaStore.ownerOf(mediaId).catch(() => null)
    return owner?.ownerKind === 'identity' && owner.ownerId === identityId
  }

  /** Unassign could not re-own the frame back: delete it and clear the face's reference. */
  private async dropUnreturnedSourceFrame(
    deviceId: number,
    faceId: string,
    mediaId: number,
    cause: unknown,
  ): Promise<void> {
    this.logger.warn('unassignFace: source frame could not return to the face — deleted', {
      tags: { deviceId },
      meta: { faceId, mediaId, error: errMessage(cause) },
    })
    await this.mediaStore.deleteById(mediaId).catch((err: unknown) => {
      this.logger.warn('unassignFace: the unreturned source frame would not delete', {
        tags: { deviceId },
        meta: { faceId, mediaId, error: errMessage(err) },
      })
    })
    await this.faceStore.update(faceId, { sourceFrameMediaId: null })
  }

  /** The enrolment failed: put the source frame back where it was. Best effort, logged. */
  private async rollBackSourceFrame(
    faceId: string,
    identityId: string,
    source: EnrolledSourceFrame | null,
  ): Promise<void> {
    if (source === null) return
    try {
      if (!source.reowned) {
        await this.mediaStore.deleteById(source.mediaId)
        await this.faceStore.update(faceId, { sourceFrameMediaId: source.previousMediaId })
        return
      }
      const back = await this.mediaStore.reown({
        fromOwnerKind: 'identity',
        fromOwnerId: identityId,
        toOwnerKind: 'face',
        toOwnerId: faceId,
        mediaId: source.mediaId,
      })
      await this.faceStore.update(faceId, { sourceFrameMediaId: back })
    } catch (err: unknown) {
      this.logger.warn('assignFace: source frame rollback failed', {
        meta: { faceId, identityId, mediaId: source.mediaId, error: errMessage(err) },
      })
    }
  }

  /**
   * Delete a buffered face entirely (row + its crop media). If the face is
   * currently assigned, it is unassigned first (re-owning the crop back to the
   * face) so no identity sample is orphaned. Idempotent: a missing face is a no-op.
   */
  async deleteFace(input: { faceId: string }): Promise<void> {
    const face = await this.faceStore.get(input.faceId)
    if (!face) return
    if (face.assigned) await this.unassignFace({ faceId: input.faceId })
    await this.mediaStore.deleteForOwner('face', [input.faceId])
    await this.faceStore.delete(input.faceId)
    this.refreshGallery()

    // Best-effort live-update notification — emitted AFTER the row + its
    // media were removed, never before.
    this.safeEmitFaceGalleryChanged({
      deviceId: face.deviceId,
      faceId: input.faceId,
      kind: 'deleted',
    })
  }

  /** Batch-assign many faces to one identity. Per-face failures are collected,
   *  not thrown, so one bad face doesn't abort the rest. */
  async assignFaces(input: {
    faceIds: readonly string[]
    identityId: string
  }): Promise<{ assigned: number; failed: readonly string[] }> {
    let assigned = 0
    const failed: string[] = []
    for (const faceId of input.faceIds) {
      try {
        await this.assignFace({ faceId, identityId: input.identityId })
        assigned += 1
      } catch (err: unknown) {
        // Collecting a failure IS dropping work, so it is logged. The id used
        // to survive and the reason did not: on 2026-09-10 the viewer proved
        // the hub had answered and refused a specific face, and the trail
        // ended here because this catch bound nothing. The faces were in the
        // gallery, so it was not the one refusal `assignFace` names out loud.
        this.logger.error('assignFaces refused a face', {
          meta: {
            faceId,
            identityId: input.identityId,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          },
        })
        failed.push(faceId)
      }
    }
    return { assigned, failed }
  }

  /** Batch-detach many faces (mass unassign). Per-face failures collected. */
  async unassignFaces(input: {
    faceIds: readonly string[]
  }): Promise<{ unassigned: number; failed: readonly string[] }> {
    let unassigned = 0
    const failed: string[] = []
    for (const faceId of input.faceIds) {
      try {
        await this.unassignFace({ faceId })
        unassigned += 1
      } catch {
        failed.push(faceId)
      }
    }
    return { unassigned, failed }
  }

  /**
   * Suggest clusters of look-alike UNASSIGNED faces (greedy cosine on their
   * embeddings) so the operator can batch-assign a whole group. Embeddings stay
   * server-side; only faceId groupings are returned.
   *
   * TWO bounds, and they cut different things — which is the whole point of the
   * rename:
   *  - `maxFacesScanned` bounds the POOL, i.e. the work. Newest unassigned
   *    faces first, default {@link SUGGEST_CLUSTERS_DEFAULT_FACE_POOL}.
   *  - `maxClusters` (formerly the ambiguous `limit`) bounds the ANSWER.
   *    It has never made this method read one row less.
   */
  async suggestFaceClusters(input?: SuggestFaceClustersInput): Promise<readonly FaceCluster[]> {
    const threshold = input?.threshold ?? 0.5
    const minClusterSize = input?.minClusterSize ?? 2
    const maxFacesScanned = input?.maxFacesScanned ?? SUGGEST_CLUSTERS_DEFAULT_FACE_POOL
    // `maxClusters` is the name; `limit` is the deprecated alias. Resolved in
    // exactly one place so the two can never disagree.
    const maxClusters = input?.maxClusters ?? input?.limit

    const faces = await this.faceStore.listAllRecentFaces({
      filter: 'unassigned',
      limit: maxFacesScanned,
    })

    if (faces.length >= maxFacesScanned) {
      // The pool is saturated: faces older than the horizon were NOT considered,
      // so a group living entirely beyond it is absent from this answer. Silence
      // here would read as "there was nothing more to find".
      this.logger.info('suggestFaceClusters pool saturated — older faces not considered', {
        meta: { maxFacesScanned, scanned: faces.length, threshold, minClusterSize },
      })
    }

    // The vectors are fetched BY NAME, for exactly the rows this pass will
    // cluster — the gallery list itself carries none, which is what stopped the
    // 30-second Unassigned poll from reading 11 MB of floats it never used.
    const vectors = await this.faceStore.loadEmbeddings(faces.map((f) => f.id))
    const items: Array<{ id: string; embedding: readonly number[] }> = []
    for (const face of faces) {
      const embedding = vectors.get(face.id)
      if (embedding === undefined || embedding.length === 0) continue
      items.push({ id: face.id, embedding })
    }
    if (items.length < faces.length) {
      // A face that cannot be clustered is a face the operator will never be
      // offered. Counting it beats a quietly smaller answer.
      this.logger.warn('suggestFaceClusters skipped faces with no vector in the index', {
        meta: { scanned: faces.length, clusterable: items.length },
      })
    }
    const clusters = clusterByEmbedding(items, threshold).filter((c) => c.size >= minClusterSize)
    return maxClusters === undefined ? clusters : clusters.slice(0, maxClusters)
  }
}
