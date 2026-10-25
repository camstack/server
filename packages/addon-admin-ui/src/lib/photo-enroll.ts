/**
 * Photo enrollment — the client half of the `photo.*` bridge.
 *
 * The server finds the faces in an uploaded photograph and enrols NONE of them;
 * the operator names them. That split is the whole feature, and it is why this
 * file has a "draft" at all: a family photograph is several independent
 * decisions, two of which may be "ignore", so the operator's state is a map
 * keyed by face and never a single selection.
 *
 * `addons.custom` is typed `z.unknown()` at the cap boundary — the per-action
 * schema lives in the addon and the client never sees it. So every reply is
 * narrowed here, in one file, with type guards rather than casts: a malformed
 * reply yields `null` and the dialog says it could not read it, instead of
 * rendering `undefined` into a face grid.
 */

import i18n from '../i18n/index'

/** The addonId for `addons.custom` is the MANIFEST id, never the npm package. */
export const PHOTO_ADDON_ID = 'pipeline-analytics'
export const PHOTO_ANALYZE_ACTION = 'photo.analyze'
export const PHOTO_ENROLL_ACTION = 'photo.enroll'
export const PHOTO_DISCARD_ACTION = 'photo.discard'

/**
 * The largest photograph the dialog will send, in bytes.
 *
 * Mirrors the addon's `MAX_PHOTO_BASE64_CHARS` (24 MB of base64 ≈ 18 MB of
 * JPEG) with the base64 inflation taken off, so the file picker refuses BEFORE
 * a large upload is read into memory and rejected on the far side.
 */
export const MAX_PHOTO_BYTES = 18 * 1024 * 1024

export interface PhotoBboxView {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PhotoFaceQualityView {
  readonly detectionShortSidePx: number
  readonly score: number
  readonly magnitude?: number
}

export interface PhotoFaceView {
  readonly faceIndex: number
  readonly bbox: PhotoBboxView
  readonly score: number
  readonly enrollable: boolean
  /** The addon's vocabulary. Kept as an open string on purpose — a newer addon
   *  may name a refusal this build has never heard of, and `refusalLabel`
   *  degrades to an honest sentence rather than guessing one. */
  readonly refusedReason?: string
  /** The EXACT aligned model input, base64 JPEG. */
  readonly alignedCropBase64?: string
  /** The model that RAN on the server. Never chosen here. */
  readonly modelId?: string
  readonly quality: PhotoFaceQualityView
}

export interface PhotoAnalyzeView {
  readonly sessionId: string
  readonly ranOnNodeId: string
  readonly faces: readonly PhotoFaceView[]
}

export interface PhotoEnrollView {
  readonly sampleId: string
  readonly identityId: string
  readonly modelId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function parseBbox(raw: unknown): PhotoBboxView | null {
  if (!isRecord(raw)) return null
  const x = num(raw, 'x')
  const y = num(raw, 'y')
  const width = num(raw, 'width')
  const height = num(raw, 'height')
  if (x === null || y === null || width === null || height === null) return null
  return { x, y, width, height }
}

function parseQuality(raw: unknown): PhotoFaceQualityView | null {
  if (!isRecord(raw)) return null
  const detectionShortSidePx = num(raw, 'detectionShortSidePx')
  const score = num(raw, 'score')
  if (detectionShortSidePx === null || score === null) return null
  const magnitude = num(raw, 'magnitude')
  return {
    detectionShortSidePx,
    score,
    ...(magnitude === null ? {} : { magnitude }),
  }
}

function parseFace(raw: unknown): PhotoFaceView | null {
  if (!isRecord(raw)) return null
  const faceIndex = num(raw, 'faceIndex')
  const score = num(raw, 'score')
  const enrollable = bool(raw, 'enrollable')
  const bbox = parseBbox(raw['bbox'])
  const quality = parseQuality(raw['quality'])
  if (
    faceIndex === null ||
    score === null ||
    enrollable === null ||
    bbox === null ||
    quality === null
  ) {
    return null
  }
  const refusedReason = str(raw, 'refusedReason')
  const alignedCropBase64 = str(raw, 'alignedCropBase64')
  const modelId = str(raw, 'modelId')
  return {
    faceIndex,
    bbox,
    score,
    enrollable,
    quality,
    ...(refusedReason === null ? {} : { refusedReason }),
    ...(alignedCropBase64 === null ? {} : { alignedCropBase64 }),
    ...(modelId === null ? {} : { modelId }),
  }
}

/** Narrow a `photo.analyze` reply. `null` when it is not the shape promised. */
export function parsePhotoAnalyze(raw: unknown): PhotoAnalyzeView | null {
  if (!isRecord(raw)) return null
  const sessionId = str(raw, 'sessionId')
  const ranOnNodeId = str(raw, 'ranOnNodeId')
  const facesRaw = raw['faces']
  if (sessionId === null || ranOnNodeId === null || !Array.isArray(facesRaw)) return null
  const faces: PhotoFaceView[] = []
  for (const item of facesRaw) {
    const parsed = parseFace(item)
    // One unreadable face must not discard the rest of the photograph — the
    // faces are independent observations, not one document.
    if (parsed !== null) faces.push(parsed)
  }
  return { sessionId, ranOnNodeId, faces }
}

/** Narrow a `photo.enroll` reply. `null` when it is not the shape promised. */
export function parsePhotoEnroll(raw: unknown): PhotoEnrollView | null {
  if (!isRecord(raw)) return null
  const sampleId = str(raw, 'sampleId')
  const identityId = str(raw, 'identityId')
  // A sample that does not name its model is the failure mode D196 exists
  // against, so an unstamped reply is unreadable rather than partially read.
  const modelId = str(raw, 'modelId')
  if (sampleId === null || identityId === null || modelId === null) return null
  return { sampleId, identityId, modelId }
}

// ── The operator's draft ────────────────────────────────────────────────────

/** `faceIndex → identityId`. A face absent from the map is IGNORED. */
export type PhotoAssignmentDraft = Readonly<Record<number, string>>

/** Assign a face, or (with `null`) take the assignment back. Immutable. */
export function setAssignment(
  draft: PhotoAssignmentDraft,
  faceIndex: number,
  identityId: string | null,
): PhotoAssignmentDraft {
  const next: Record<number, string> = { ...draft }
  if (identityId === null || identityId === '') delete next[faceIndex]
  else next[faceIndex] = identityId
  return next
}

/** How many faces would actually be enrolled — assigned AND server-enrollable. */
export function countAssignable(
  faces: readonly PhotoFaceView[],
  draft: PhotoAssignmentDraft,
): number {
  return faces.filter((f) => f.enrollable && draft[f.faceIndex] !== undefined).length
}

export interface PhotoEnrollRequest {
  readonly sessionId: string
  readonly faceIndex: number
  readonly identityId: string
}

/**
 * The confirmations to send, in face order.
 *
 * A face the SERVER refused is never planned, however it was assigned: the
 * request could only fail, and a failure there reads to the operator as a
 * broken photograph rather than as a property of that one face.
 */
export function buildEnrollPlan(
  sessionId: string,
  faces: readonly PhotoFaceView[],
  draft: PhotoAssignmentDraft,
): readonly PhotoEnrollRequest[] {
  const plan: PhotoEnrollRequest[] = []
  for (const face of faces) {
    if (!face.enrollable) continue
    const identityId = draft[face.faceIndex]
    if (identityId === undefined) continue
    plan.push({ sessionId, faceIndex: face.faceIndex, identityId })
  }
  return plan
}

/**
 * The sentence shown under a refused face.
 *
 * The CODES are the addon's vocabulary; these sentences are this surface's, and
 * they are kept apart deliberately — the same split `events-debug.helpers.ts`
 * makes. An unknown code degrades to the honest general statement rather than
 * to a guessed one.
 */
export function refusalLabel(reason: string | undefined): string {
  switch (reason) {
    case 'no-embedding':
      return i18n.t('helpers.photoEnroll.refusal.noEmbedding')
    case 'no-model-id':
      return i18n.t('helpers.photoEnroll.refusal.noModelId')
    case 'no-aligned-crop':
      return i18n.t('helpers.photoEnroll.refusal.noAlignedCrop')
    case 'magnitude':
      return i18n.t('helpers.photoEnroll.refusal.magnitude')
    default:
      return i18n.t('helpers.photoEnroll.refusal.default')
  }
}
