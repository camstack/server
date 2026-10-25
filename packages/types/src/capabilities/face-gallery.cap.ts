import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { BoundingBoxSchema } from './schemas/detection-shared.js'

const IdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
  sampleCount: z.number().int().nonnegative(),
  coverMediaId: z.number().int().optional(),
  /** Inline base64 of the cover sample's crop, resolved from `coverMediaId`.
   *  Lets the UI render the person's face avatar instead of a placeholder icon. */
  coverBase64: z.string().optional(),
})
export type Identity = z.infer<typeof IdentitySchema>

const IdentitySampleInfoSchema = z.object({
  id: z.string(),
  source: z.enum(['detected', 'photo']),
  addedAt: z.number().int(),
  deviceId: z.number().int().optional(),
  base64: z.string().optional(), // crop image, inline
})
export type IdentitySampleInfo = z.infer<typeof IdentitySampleInfoSchema>

/**
 * One enrolled sample, judged against the gallery it lives in.
 *
 * The gallery is the one input to recognition nobody re-reads: a sample
 * enrolled from the wrong face keeps voting forever, and because the matches it
 * pulls then look confident, nobody goes back. The 2026-09-08 audit found
 * exactly one such pair on this cluster — a sample scoring 0.61 against three
 * samples of ANOTHER person, enrolled from the same camera in the same minute,
 * where every other cross-identity pair sits under 0.50.
 */
const IdentitySampleAuditRowSchema = z.object({
  sampleId: z.string(),
  enrolledAt: z.number().int(),
  deviceId: z.number().int().optional(),
  source: z.enum(['detected', 'photo']),
  /** The enrolled crop's media row id, so the panel can show the evidence. */
  mediaId: z.number().int().optional(),
  /**
   * False = the sample is stamped with a DIFFERENT face model, and a cosine
   * across feature spaces is a well-formed float with no meaning. Every number
   * below then says nothing — it must read as "cannot say", never as an
   * accusation and never as a clean bill: this list ends in a Remove button.
   */
  comparable: z.boolean(),
  /** Mean cosine against this person's other samples. Null when there are none
   *  to compare with — never 0, which would read as "opposite". */
  selfMean: z.number().nullable(),
  /** The other person this sample looks most like, when it looks like one.
   *  This is the half that convicts: not looking like yourself can be a hard
   *  angle; looking like someone the gallery can NAME is a mis-enrolment. */
  bestForeign: z.object({ identityId: z.string(), name: z.string(), score: z.number() }).optional(),
  /** 0 = nothing to say. Higher = look at this one sooner. */
  suspicion: z.number(),
})
export type IdentitySampleAuditRow = z.infer<typeof IdentitySampleAuditRowSchema>

const IdentitySampleAuditSchema = z.object({
  identityId: z.string(),
  name: z.string(),
  /** The cluster face model every comparison was made in. */
  modelId: z.string(),
  totalSamples: z.number().int(),
  comparableSamples: z.number().int(),
  flagged: z.number().int(),
  /** The bar `flagged` counts against, so the panel states the RULE and not
   *  only its current result. */
  flagThreshold: z.number(),
  /** Worst first. A row with nothing to say still appears, at the bottom: the
   *  operator asked to see the gallery, not only its accusations. */
  rows: z.array(IdentitySampleAuditRowSchema).readonly(),
})
export type IdentitySampleAudit = z.infer<typeof IdentitySampleAuditSchema>

const FaceInfoSchema = z.object({
  faceId: z.string(),
  deviceId: z.number().int(),
  trackId: z.string(),
  timestamp: z.number().int(),
  recognizedIdentityId: z.string().optional(),
  identityName: z.string().optional(),
  assigned: z.boolean(),
  /**
   * The crop, inline, base64.
   *
   * **Prefer {@link cropUrl}.** At the 500 rows the Faces view asks for this
   * field alone is ~2.87 MiB, re-sent in full on every operator assign and
   * every 30 s poll, base64-inflated over the msgpack socket and held in the
   * query heap. It stays for callers that have not migrated; `includeCrops:
   * false` turns it off once they have.
   */
  base64: z.string().optional(),
  /**
   * Same crop, as a data-plane URL for `<img src>` — the move the admin
   * snapshot surfaces made on 2026-08-08.
   *
   * Served by the `event-media` plane, which resolves a raw MediaStore key and
   * is `access: 'authenticated'`: a bare `<img>` carries the `camstack_session`
   * cookie, so no header plumbing is needed. The bytes then ride the browser's
   * HTTP cache with an ETag and `immutable`, instead of the WebSocket.
   *
   * Absent when the face has no stored crop, or when the addon has no data
   * plane — callers fall back to {@link base64}.
   */
  cropUrl: z.string().optional(),
  /** Design B: the face bbox (pixel space) on the key frame — lets a detail
   *  view draw the box over the native `keyFrameMediaId` frame. Absent on
   *  legacy rows written before design B. */
  faceBbox: BoundingBoxSchema.optional(),
  /** Design B: MediaStore key of the track's native-resolution key frame.
   *  Fetch the native JPEG via the event-media data-plane
   *  (`/addon/<addonId>/event-media/m/<keyFrameMediaId>`). Absent when the
   *  track produced no key frame (e.g. native/onboard source) — the UI falls
   *  back to the inline `base64` face crop. */
  keyFrameMediaId: z.number().int().optional(),
  /** Winning identity-match cosine (0..1) for this face's track, when an
   *  identity was auto-confirmed. Lets the UI surface WHY a face was assigned
   *  (confidence badge / low-confidence audit). Absent on legacy rows and on
   *  faces that were never auto-recognized. */
  bestMatchScore: z.number().optional(),
  /** Native-scale face short side (px) at recognition time, when the runner
   *  measured it. Lets the UI flag low-resolution auto-assignments. Absent on
   *  legacy rows / runners that reported no native measure. */
  nativeFaceShortSidePx: z.number().optional(),
  /** SUGGESTED identity for this face — a plausible-but-not-confident match that
   *  MISSED auto-assignment (cosine in the suggestion band, or above threshold
   *  but blocked only by the recognition size floor). Mutually exclusive with
   *  `recognizedIdentityId` (a suggestion is NEVER an assignment): the face stays
   *  UNASSIGNED and everything else keeps treating it as unrecognized — the UI
   *  merely offers a one-tap "is this <name>?" confirm. Absent on legacy rows and
   *  on faces that were auto-assigned or below the suggestion band. (2026-07-24) */
  suggestedIdentityId: z.string().optional(),
  /** Peak identity-match cosine (0..1) for `suggestedIdentityId`, captured at the
   *  same moment as `bestMatchScore` (track peak, at close). Lets the UI rank /
   *  badge suggestion confidence. Present iff `suggestedIdentityId` is. (2026-07-24) */
  suggestedMatchScore: z.number().optional(),
})
export type FaceInfo = z.infer<typeof FaceInfoSchema>

const FaceFilterEnum = z.enum(['unassigned', 'recognized', 'identified', 'all'])

/**
 * What a `listRecentFaces` page is ORDERED BY.
 *
 *  - `timestamp` — when the face was seen. The historical (and default) order.
 *  - `suggestionConfidence` — {@link FaceInfo.suggestedMatchScore}, the peak
 *    cosine of the face's SUGGESTED identity. This is the "review by certainty"
 *    order: it puts the suggestions an operator can confirm with one tap at the
 *    top, and it is the reason this enum exists — a client that ranked a capped
 *    page client-side was ranking the newest N, never the most certain N.
 *
 * A row with NO suggestion (`suggestedMatchScore` absent — a legacy row, an
 * auto-assigned face, or a face below the suggestion band) has no certainty to
 * compare. Under `suggestionConfidence` it sorts **LAST, in BOTH directions**
 * — flipping the direction reorders the rows that HAVE a certainty and never
 * floods the page with the ones that do not. `addon-post-analysis`'s
 * `store/face-sort.ts` is the single implementation, tiebreaks newest-first
 * then by faceId, and is what makes this a total order instead of the
 * backend's NULL-collation accident.
 */
const FaceSortFieldEnum = z.enum(['timestamp', 'suggestionConfidence'])
export type FaceSortField = z.infer<typeof FaceSortFieldEnum>

const FaceSortDirectionEnum = z.enum(['asc', 'desc'])
export type FaceSortDirection = z.infer<typeof FaceSortDirectionEnum>

/** One suggested group of look-alike UNASSIGNED faces. Ids only — an embedding
 *  never leaves the server. */
const FaceClusterSchema = z.object({
  faceIds: z.array(z.string()).readonly(),
  representativeFaceId: z.string(),
  size: z.number().int(),
  cohesion: z.number(),
})
export type FaceCluster = z.infer<typeof FaceClusterSchema>

/**
 * One gallery media row: what the crop is, how big it is, and WHERE its bytes
 * are — never the bytes.
 *
 * `base64` was deleted here rather than deprecated. `MediaFile.base64` (the
 * track/event contract) is still populated because a deployed viewer requires
 * the field to parse a row at all; this method has no such reader. Its ONE
 * caller is the admin UI's detail modal, which was building
 * `data:image/jpeg;base64,…` from a row whose `key` sat right beside it, in a
 * dialog already rendering its key FRAME from the `event-media` plane.
 *
 * `url` is `/addon/<addonId>/event-media/m/<mediaId>` (D482). The plane
 * resolves a media row by its own id, so this needed no new plane and no new
 * access decision.
 */
const MediaFileLiteSchema = z.object({
  /** The media row's own id — the same address `MediaFileRef.mediaId` carries
   *  (D482). It was the row's composite key, which embedded the owner. */
  mediaId: z.number().int(),
  kind: z.string(),
  url: z.string(),
  sizeBytes: z.number(),
  timestamp: z.number(),
})

export const faceGalleryCapability = {
  name: 'face-gallery',
  // Every method not labelled otherwise is the 'face-assignment' feature (D921).
  role: { feature: 'face-assignment' },
  scope: 'system',
  mode: 'singleton',
  methods: {
    // Names in events are shown to anyone who sees the event (D921): this read is viewer baseline.
    listIdentities: method(
      z
        .object({
          /**
           * Inline {@link IdentitySchema.coverBase64} on every row.
           *
           * Default `false`, the same inversion `listRecentFaces` and
           * `listPlates` took on 2026-08-25 (see `include-crops-default.ts` for
           * why the burden belongs on the caller that WANTS the bytes). Measured
           * on the live hub the same day: four identities cost 40,979 B with the
           * covers inline, ~10 KB of base64 per row, on a query this UI mounts
           * four times and the viewer holds at `staleTime: 30_000`.
           *
           * Nothing loses its avatar: `coverMediaId` is already on every row and
           * the `event-media` plane serves that key `immutable` with an ETag.
           *
           * **This is an INPUT field, so it does not reach the addon until the
           * next train** — the hub router validates cap inputs against its own
           * compiled Zod and strips a key it does not know. Until then the
           * provider sees `undefined`, which resolves to `false`: the cheap shape
           * is what ships, and the opt-in becomes reachable when the train lands.
           */
          includeCrops: z.boolean().optional(),
        })
        .optional(),
      z.array(IdentitySchema).readonly(),
      { role: 'viewer' },
    ),
    createIdentity: method(z.object({ name: z.string().min(1) }), IdentitySchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    renameIdentity: method(z.object({ id: z.string(), name: z.string().min(1) }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    deleteIdentity: method(z.object({ id: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    listIdentitySamples: method(
      z.object({ identityId: z.string() }),
      z.array(IdentitySampleInfoSchema).readonly(),
    ),
    /**
     * Re-analyse ONE person's enrolled samples against the whole gallery.
     *
     * A pure read — no write, no inference, just dot products over vectors the
     * hub already holds (327 of them on this cluster). `admin` for the same
     * reason `listIdentitySamples` is: the answer names every enrolled person
     * and how well one person's samples match them, which is the gallery's
     * shape and not a viewer-level fact.
     *
     * Removal deliberately stays `removeSample`: an analysis that could also
     * delete would be one confirmation away from emptying a gallery.
     */
    auditIdentitySamples: method(
      z.object({ identityId: z.string().min(1) }),
      IdentitySampleAuditSchema,
      { auth: 'admin' },
    ),
    removeSample: method(z.object({ identityId: z.string(), sampleId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    listRecentFaces: method(
      z
        .object({
          /**
           * Restrict to ONE camera. Absent keeps the cluster-wide gallery view.
           *
           * The legacy single-camera form, kept verbatim for every caller that
           * already sends it. A caller that wants a SET sends {@link deviceIds}
           * instead — never both: `deviceIds` is the authority whenever it is
           * present, and this field is then ignored rather than unioned, so
           * there is exactly one answer to "which cameras did I ask for".
           */
          deviceId: z.number().int().optional(),
          /**
           * Restrict to a SET of cameras — the review UI's camera filter, which
           * until now had to fetch the cluster-wide page and drop rows in the
           * client (so the `limit` it asked for was spent on cameras it was
           * about to discard).
           *
           * An **empty array reads NOTHING** — `[]` is an empty page, never
           * "every camera". A request for no devices is a request, not an
           * omission; same contract as `deviceManager.listAll`'s `deviceIds`
           * and `pipelineAnalytics.listRecentTracks`.
           *
           * Absent (`undefined`) is the omission, and keeps the cluster-wide view.
           */
          deviceIds: z.array(z.number().int()).optional(),
          limit: z.number().int().positive().optional(),
          filter: FaceFilterEnum.optional(),
          /**
           * Window lower bound on {@link FaceInfo.timestamp}, INCLUSIVE.
           * Absent means no lower bound.
           */
          since: z.number().int().optional(),
          /**
           * Window upper bound on {@link FaceInfo.timestamp}, INCLUSIVE.
           * Absent means no upper bound.
           */
          until: z.number().int().optional(),
          /**
           * Order the page by time or by suggestion certainty. Default
           * `'timestamp'` — the historical order, unchanged for every caller
           * that does not ask.
           *
           * See {@link FaceSortFieldEnum} for what a row with no suggestion
           * does under `'suggestionConfidence'`.
           *
           * Cost note: `'timestamp'` is served by the `(deviceId, timestamp)`
           * index and stops reading as soon as `limit` rows have PASSED the
           * filter. `'suggestionConfidence'` cannot stop early — the most
           * certain row may be the oldest — so it walks the window. Narrow it
           * with {@link since} / {@link until}.
           */
          sortBy: FaceSortFieldEnum.optional(),
          /** Sort direction for {@link sortBy}. Default `'desc'`. */
          sortDirection: FaceSortDirectionEnum.optional(),
          /**
           * Inline the base64 crop on every row.
           *
           * Default `false` since the 2026-08-25 inversion — see
           * `include-crops-default.ts`, which is the ONE place that resolves
           * this for every gallery, and which records why the inline shape had
           * to become the one you ASK for (60 457 ms → UDS timeout at 500 rows).
           * The doc here used to still say `true`; it was wrong, and a leftover
           * that describes the old design reads as permission to rely on it.
           *
           * Nothing loses its image: the row carries {@link FaceInfo.cropUrl},
           * which the browser fetches off the `event-media` plane in parallel,
           * cached and ETagged.
           */
          includeCrops: z.boolean().optional(),
        })
        .optional(),
      z.array(FaceInfoSchema).readonly(),
    ),
    // Names in events are shown to anyone who sees the event (D921): this read is viewer baseline.
    getFaceByTrack: method(
      z.object({ deviceId: z.number().int(), trackId: z.string() }),
      FaceInfoSchema.nullable(),
      { role: 'viewer' },
    ),
    getFaceMedia: method(z.object({ faceId: z.string() }), z.array(MediaFileLiteSchema).readonly()),
    assignFace: method(z.object({ faceId: z.string(), identityId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    unassignFace: method(z.object({ faceId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Delete an unassigned face from the buffer (row + its crop media). */
    deleteFace: method(z.object({ faceId: z.string() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Batch-assign many buffered faces to one identity. Returns per-face results. */
    assignFaces: method(
      z.object({ faceIds: z.array(z.string()).min(1), identityId: z.string() }),
      z.object({ assigned: z.number().int(), failed: z.array(z.string()).readonly() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Batch-detach many faces (mass unassign). Returns per-face results. */
    unassignFaces: method(
      z.object({ faceIds: z.array(z.string()).min(1) }),
      z.object({ unassigned: z.number().int(), failed: z.array(z.string()).readonly() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Suggest clusters of look-alike UNASSIGNED faces (cosine on embeddings) for
     *  batch assignment. Embeddings never leave the server — only faceId groups. */
    suggestFaceClusters: method(
      z
        .object({
          threshold: z.number().min(0).max(1).optional(),
          minClusterSize: z.number().int().min(2).optional(),
          /**
           * Cap on the number of CLUSTERS returned. Renamed from `limit`,
           * which read as though it bounded the work — it never did.
           *
           * Wins over {@link limit} when both are sent.
           */
          maxClusters: z.number().int().positive().optional(),
          /**
           * @deprecated Ambiguous name for {@link maxClusters} — it cuts the
           * RESULT, not the scan. Kept so existing callers keep working; send
           * `maxClusters` (and, if you care about cost, {@link maxFacesScanned}).
           */
          limit: z.number().int().positive().optional(),
          /**
           * Cap on the number of unassigned faces READ AND CLUSTERED — the
           * POOL, not the result.
           *
           * This is the knob {@link maxClusters} was mistaken for. Clustering
           * used to read every unassigned face on the hub no matter what the
           * caller asked for, because the only bound cut the finished clusters
           * afterwards; a UI showing a window of 100 paid for a scan of the
           * whole corpus, on an addon whose disk is under contention.
           *
           * The pool is the NEWEST matching faces first — the same order the
           * gallery shows — so a bound here shortens the horizon, it does not
           * sample it randomly.
           *
           * Default: 1 000 (`FACE_SWEEP_PAGE`, exactly one store page). Chosen
           * so the live corpus — 372 face rows — is unaffected while the
           * unbounded scan can never come back as the table grows.
           */
          maxFacesScanned: z.number().int().positive().optional(),
        })
        .optional(),
      z.array(FaceClusterSchema).readonly(),
    ),
  },
} as const satisfies CapabilityDefinition

export type IFaceGalleryProvider = InferProvider<typeof faceGalleryCapability>

/**
 * The inputs, as the PROVIDER sees them.
 *
 * Named so an implementation can annotate its methods without re-typing the
 * shape (`z.infer`, never a hand copy — a duplicated input shape is how a new
 * field arrives at the router and is dropped by the provider).
 */
export type ListRecentFacesInput = z.infer<
  typeof faceGalleryCapability.methods.listRecentFaces.input
>
export type SuggestFaceClustersInput = z.infer<
  typeof faceGalleryCapability.methods.suggestFaceClusters.input
>
