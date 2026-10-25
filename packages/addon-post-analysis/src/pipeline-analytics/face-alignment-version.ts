/**
 * Which face ALIGNMENT produced a gallery sample's template (D643).
 *
 * The SCRFD fix of 2026-09-26 (anchor centres at `x·stride`, input
 * `(x − 127.5) / 128`) moved every landmark the aligner warps on, so a face
 * aligned before it and one aligned after are different pixels of the same
 * person — measured median cosine 0.66 between them on camera faces.
 *
 * The stamp is AUDIT-ONLY. Matching reads every sample regardless of it
 * (partitioning the gallery would drop the old samples that still carry the
 * match rate); the prune (`face-gallery-prune.ts`) and the photo re-enrol pass
 * (`face-photo-reenrol-pass.ts`) read it. An unstamped row is v1 — every
 * sample written before this record has none.
 */

/** The alignment every sample written after the SCRFD fix carries. */
export const FACE_ALIGNMENT_SCRFD_V2 = 'scrfd-v2' as const

export type FaceAlignmentVersion = typeof FACE_ALIGNMENT_SCRFD_V2

/**
 * The moment every node was running the fixed detector.
 *
 * `addon-pipeline` landed on the hub at 12:08:18Z and on agent-a at
 * 12:08:27Z on 2026-09-26 (package.json mtimes, read 2026-09-26); the Mac agent
 * was deployed in the same run. 12:30Z leaves margin for the Mac and for a
 * runner respawn.
 *
 * A DETECTED sample has no alignment of its own to read: the face row it is
 * enrolled from recorded the embedding, not the detector that aligned it. The
 * buffer keeps faces for days, so an operator assigning a face captured before
 * the fix must not get a v2 stamp — that is the one error that matters, because
 * the prune counts v2 detected samples before deleting old ones. A face
 * captured in the margin is stamped v1, which only delays a prune.
 */
export const SCRFD_V2_ALIGNMENT_SINCE_MS = Date.UTC(2026, 8, 26, 12, 30)

/** The stamp for a DETECTED face, from the time it was captured. */
export function alignmentForCapturedFace(capturedAtMs: number): FaceAlignmentVersion | undefined {
  return capturedAtMs >= SCRFD_V2_ALIGNMENT_SINCE_MS ? FACE_ALIGNMENT_SCRFD_V2 : undefined
}

/** Narrow a stored column value. Anything unknown reads as v1 (unstamped). */
export function parseFaceAlignment(value: unknown): FaceAlignmentVersion | undefined {
  return value === FACE_ALIGNMENT_SCRFD_V2 ? FACE_ALIGNMENT_SCRFD_V2 : undefined
}

/** The slice of a sample the v1/v2 question reads. */
export interface AlignmentStamped {
  readonly alignment?: FaceAlignmentVersion
}

export function isV2Aligned(sample: AlignmentStamped): boolean {
  return sample.alignment === FACE_ALIGNMENT_SCRFD_V2
}
