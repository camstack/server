/**
 * photo-enroll-actions — the operator's two gestures for enrolling from a
 * photograph: analyse, then name.
 *
 * ## Why these ride `addons.custom` and are not cap methods
 *
 * A cap method's wire schema lives in `@camstack/types`, which travels inside
 * the `@camstack/server` closure — so a new one is not callable until a server
 * train ships, however current the addon is. The hub validates cap inputs
 * against ITS compiled Zod, so a method the hub has never heard of simply does
 * not exist as a tRPC path. `addons.custom` is the opposite: the per-action
 * schema lives in the addon's own dist and the hub forwards an opaque envelope,
 * so a `camstack deploy` is the whole delivery. `embedding.*` and `debug.*`
 * already ship this way.
 *
 * ## Why analysis and confirmation are two calls and not one
 *
 * Because the operator is the one who names the faces. A family photograph is
 * several people and one of them may be a stranger; a single "enrol this photo"
 * call would have to guess, and guessing is how a gallery acquires the samples
 * that recognise everybody as one person. Analysis therefore answers with
 * crops and a session id, and holds the VECTORS server-side — confirmation
 * enrols the exact vector whose crop was on screen, which is what keeps the
 * gallery image 1:1 with the vector it claims to show.
 */
import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

/**
 * The largest photograph accepted, in base64 characters.
 *
 * ~24 MB of base64 is ~18 MB of JPEG — comfortably above any phone camera and
 * comfortably below the WebSocket frame the admin UI's tRPC client rides
 * (`ws` defaults to 100 MiB, and the browser client uses `wsLink`). A bound
 * exists at all because the bytes are held in hub-main's heap for the length of
 * the session: unbounded here means an upload can decide how much memory the
 * hub uses.
 */
export const MAX_PHOTO_BASE64_CHARS = 24 * 1024 * 1024

const PhotoBboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

/** Why a face cannot become a sample — the addon's vocabulary, mirrored from
 *  `photo-enrollment.ts`'s `PhotoFaceRefusal`. */
const PhotoFaceRefusalSchema = z.enum([
  'no-embedding',
  'no-model-id',
  'no-aligned-crop',
  'magnitude',
])

const PhotoFaceQualitySchema = z.object({
  detectionShortSidePx: z.number(),
  score: z.number(),
  magnitude: z.number().optional(),
})

/**
 * One face, as the operator sees it.
 *
 * NO embedding, deliberately, and for the same reason `listRecentFaces` has
 * never exposed one: a vector is the gallery, and a surface that hands it out
 * has handed out the gallery.
 */
const PhotoFaceSchema = z.object({
  faceIndex: z.number().int().nonnegative(),
  bbox: PhotoBboxSchema,
  score: z.number(),
  enrollable: z.boolean(),
  refusedReason: PhotoFaceRefusalSchema.optional(),
  /** The EXACT aligned model input, base64 JPEG — what the vector was made of. */
  alignedCropBase64: z.string().optional(),
  /** The model that RAN. Never one this surface chose. */
  modelId: z.string().optional(),
  quality: PhotoFaceQualitySchema,
})

const PhotoAnalyzeInputSchema = z.object({
  /** The photograph, base64. Sent whole: nothing on this side cuts it. */
  photoBase64: z.string().min(1).max(MAX_PHOTO_BASE64_CHARS),
  /** Shown back in the log line so an operator can tell two uploads apart. */
  filename: z.string().max(255).optional(),
})

const PhotoAnalyzeResultSchema = z.object({
  /** Hands this back to `photo.enroll`. Expires; see `PhotoAnalysisSessions`. */
  sessionId: z.string(),
  faces: z.array(PhotoFaceSchema).readonly(),
  /** The node the detect+align+embed actually ran on — the operator's next
   *  question when a photo comes back with no faces. */
  ranOnNodeId: z.string(),
})

const PhotoEnrollInputSchema = z.object({
  sessionId: z.string().min(1),
  faceIndex: z.number().int().nonnegative(),
  /** An EXISTING identity. A new person is created through
   *  `faceGallery.createIdentity` first — this action must not become a second
   *  authority over who exists. */
  identityId: z.string().min(1),
})

const PhotoEnrollResultSchema = z.object({
  sampleId: z.string(),
  identityId: z.string(),
  /** The model stamped on the row — read back off the detection, never chosen. */
  modelId: z.string(),
})

const PhotoDiscardInputSchema = z.object({ sessionId: z.string().min(1) })
const PhotoDiscardResultSchema = z.object({ discarded: z.boolean() })

export const photoEnrollActions = defineCustomActions({
  'photo.analyze': customAction(PhotoAnalyzeInputSchema, PhotoAnalyzeResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  'photo.enroll': customAction(PhotoEnrollInputSchema, PhotoEnrollResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
  /** Release a session's photograph early. The TTL covers a closed tab; this
   *  covers an operator who finished and does not want the bytes held. */
  'photo.discard': customAction(PhotoDiscardInputSchema, PhotoDiscardResultSchema, {
    kind: 'mutation',
    auth: 'admin',
  }),
})

export type PhotoEnrollActions = typeof photoEnrollActions
export type PhotoAnalyzeInput = z.infer<typeof PhotoAnalyzeInputSchema>
export type PhotoAnalyzeResult = z.infer<typeof PhotoAnalyzeResultSchema>
export type PhotoEnrollActionInput = z.infer<typeof PhotoEnrollInputSchema>
export type PhotoEnrollActionResult = z.infer<typeof PhotoEnrollResultSchema>
export type PhotoDiscardInput = z.infer<typeof PhotoDiscardInputSchema>
export type PhotoDiscardResult = z.infer<typeof PhotoDiscardResultSchema>
export type PhotoFaceWireSchema = z.infer<typeof PhotoFaceSchema>
