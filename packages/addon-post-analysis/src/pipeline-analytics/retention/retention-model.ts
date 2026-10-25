/**
 * The retention model, stated once — WHO owns what, WHO may be deleted by age,
 * and WHO must outlive its producer.
 *
 * ## Why this file exists
 *
 * Retention used to be a set of independent age sweeps that each picked their
 * own cutoff arithmetic and disagreed with each other. TEN were found (D59
 * named four): the track row, object events + their crops, an `ownerKind`-blind
 * media sweep, the CLIP vectors, the face buffer, the plate buffer, sensor
 * events, the ops log, and two operator-initiated prunes. Two of the
 * disagreements were measured, not theorised — embeddings outliving their
 * events by 14–21 days on one camera (events per-device, vectors on the fleet
 * MINIMUM), and 5,598 `keyFrame` media rows whose track had already been
 * pruned.
 *
 * The fix is not "make the cutoffs agree". Cutoffs that must agree eventually
 * will not. The fix is that **an entity a track owns has no clock of its own**:
 * it is deleted when its track is deleted, and at no other time.
 *
 * ## The three categories, and the rule for each
 *
 * 1. **{@link TRACK_OWNED_FAMILIES}** — reachable from a track in the ownership
 *    graph. Deleted ONLY by the track cascade (`delete-track-cascade.ts`).
 *    **Never by age.** A row of one of these families whose track is already
 *    gone is an ORPHAN, and orphans are collected by OWNERSHIP
 *    (`orphan-collector.ts`), never by age.
 *
 * 2. **{@link RETENTION_ROOTS}** — the entities an age-keyed sweep may select.
 *    `track` is the only one that CASCADES; the rest are TERMINAL — they own
 *    nothing and nothing owns them, so their clock cannot disagree with
 *    anybody's. Adding an entry here is the conscious act
 *    `scripts/check-age-keyed-retention.ts` exists to force.
 *
 * 3. **{@link RETENTION_EXEMPT_OWNER_KINDS}** / {@link RETENTION_EXEMPT_FAMILIES}
 *    — entities that MUST outlive the track that produced them. Enrolment is a
 *    deliberate operator act; retention is a background process, and the
 *    background process does not get to undo the deliberate one.
 *
 * Nothing in this file executes. It is the declaration the sweep, the orphan
 * collector, the cascade-completeness test and the CI guard all read, so those
 * four cannot drift from each other.
 */

import type { OwnerKind } from '../store/media-store.js'

// ── Exemptions — what must outlive its track ─────────────────────────────

/**
 * Media owner kinds that are NEVER deleted by retention of any shape.
 *
 * Both are enrolment products. A face crop is REOWNED from `face` to `identity`
 * the moment the operator confirms the match (and a plate crop from `plate` to
 * `vehicle`), so the owner kind IS the enrolment flag — an unassigned crop
 * cascades with its track, an enrolled one is out of retention's reach forever.
 *
 * This set is what `MediaStore.evictBefore` did not consult. It deleted
 * `identity` media by age regardless, quietly defeating the exemption the
 * cascade was careful to honour (D59, "Consequences"). That method is gone; the
 * exemption lives here now, and the orphan collector — the only sweep that
 * walks media it was not handed by name — reads it.
 */
export const RETENTION_EXEMPT_OWNER_KINDS: ReadonlySet<OwnerKind> = new Set<OwnerKind>([
  'identity',
  'vehicle',
  // A scene reference is an operator-curated photograph with no cascade that
  // owns it and nothing anywhere that could regenerate it — the same standing
  // as an enrolled face. Its lifetime is the scene's: `deleteScene` and the
  // per-reference bound in `boundReferences` are what remove it, never age and
  // never a sweep. See `OWNER_KINDS`.
  'scene',
])

export function isRetentionExemptOwnerKind(kind: OwnerKind): boolean {
  return RETENTION_EXEMPT_OWNER_KINDS.has(kind)
}

export type RetentionExemptFamilyId =
  | 'identity-media'
  | 'vehicle-media'
  | 'enrolled-faces'
  | 'enrolled-plates'
  | 'identity-samples'
  | 'vehicle-samples'

/** An entity family that survives the deletion of the track that produced it. */
export interface RetentionExemptFamily {
  readonly id: RetentionExemptFamilyId
  /** Where the rows live — a settings-store collection or a vector index. */
  readonly store: string
  /** What makes a row of this family exempt, in terms a query can express. */
  readonly predicate: string
  readonly why: string
}

/**
 * Every family that legitimately outlives its track, enumerated so the
 * cascade-completeness test can assert each one SURVIVES a prune — the mirror
 * of asserting the owned families do not.
 */
export const RETENTION_EXEMPT_FAMILIES: readonly RetentionExemptFamily[] = [
  {
    id: 'identity-media',
    store: 'pipeline-analytics:media',
    predicate: "ownerKind = 'identity'",
    why: 'the enrolled face gallery — the crop the operator chose as the reference image for a person. Deleting it un-enrols them silently.',
  },
  {
    id: 'vehicle-media',
    store: 'pipeline-analytics:media',
    predicate: "ownerKind = 'vehicle'",
    why: 'the enrolled plate gallery. Same argument as identity-media.',
  },
  {
    id: 'enrolled-faces',
    store: 'pipeline-analytics:faces',
    predicate: 'assigned = 1',
    why: 'an assigned face row is the link between a track observation and an identity. The observation may age out; the assignment is a curation act and does not.',
  },
  {
    id: 'enrolled-plates',
    store: 'pipeline-analytics:plates',
    predicate: 'assigned = 1',
    why: 'the plate mirror of enrolled-faces.',
  },
  {
    id: 'identity-samples',
    store: 'pipeline-analytics:identity-samples',
    predicate: 'the whole table',
    why: 'the durable ArcFace MATCHING vectors. Distinct from the per-track CLIP search vectors, which are ephemeral and DO cascade. Pruning these breaks recognition itself, not just the history of it.',
  },
  {
    id: 'vehicle-samples',
    store: 'pipeline-analytics:vehicle-samples',
    predicate: 'the whole table',
    why: 'the plate mirror of identity-samples.',
  },
]

// ── The ownership graph — what a track pulls away with it ────────────────

export type TrackOwnedFamilyId =
  | 'object-events'
  | 'event-media'
  | 'track-media'
  | 'face-rows'
  | 'face-media'
  | 'plate-rows'
  | 'plate-media'
  | 'object-embeddings'

/**
 * How a row of a family names the track that owns it. This is exactly what an
 * ORPHAN check has to evaluate, so it is stated as data rather than left
 * implicit in each store.
 */
export type TrackOwnershipLink =
  /** The row's primary key IS the trackId (`object-embeddings`). */
  | 'row-id-is-track-id'
  /** The row carries a `trackId` column (object events, faces, plates). */
  | 'track-id-column'
  /** A media row whose `ownerId` is the trackId, under a fixed `ownerKind`. */
  | 'media-owner-is-track-id'
  /** A media row whose `ownerId` is `<prefix><trackId>` (face / plate crops). */
  | 'media-owner-is-prefixed-track-id'
  /** A media row owned by an entity that is ITSELF track-owned (event child
   *  crops) — two hops from the track, and the reason a one-hop cascade leaks. */
  | 'media-owner-is-owned-entity'

export interface TrackOwnedFamily {
  readonly id: TrackOwnedFamilyId
  /** Where the rows live — a settings-store collection or a vector index. */
  readonly store: string
  readonly link: TrackOwnershipLink
  /** The `TrackScopedStore` method that removes this family in the cascade. */
  readonly cascadedBy: string
  readonly why: string
}

/**
 * Everything a track owns, directly or transitively.
 *
 * This list is the contract the cascade is tested against: the
 * cascade-completeness spec seeds one row of EVERY entry and asserts none
 * survives a prune. Adding a family here without wiring it into the cascade
 * turns that test red — which is the failure mode that produced 5,598 orphaned
 * `keyFrame` rows, caught before it ships rather than measured a month later.
 */
export const TRACK_OWNED_FAMILIES: readonly TrackOwnedFamily[] = [
  {
    id: 'object-events',
    store: 'pipeline-analytics:object-events',
    link: 'track-id-column',
    cascadedBy: 'EventStore.deleteByTracks',
    why: 'an object event IS a state transition of a track. It cannot mean anything once the track is gone.',
  },
  {
    id: 'event-media',
    store: 'pipeline-analytics:media',
    link: 'media-owner-is-owned-entity',
    cascadedBy: 'EventStore.deleteByTracks (folds in MediaStore.deleteForEvents)',
    why: 'the enrichment child crops (faceCrop / plateCrop) hang off an event, which hangs off a track. Two hops — the media delete is folded INTO the event delete so a caller cannot hold the event ids and skip the crops.',
  },
  {
    id: 'track-media',
    store: 'pipeline-analytics:media',
    link: 'media-owner-is-track-id',
    cascadedBy: 'MediaStore.deleteByTracks',
    why: 'keyFrame / keyFrameSmall / thumbnail / firstFrame / lastFrame and the periodic snapshots. The bytes, and the bulk of the disk.',
  },
  {
    id: 'face-rows',
    store: 'pipeline-analytics:faces',
    link: 'track-id-column',
    cascadedBy: 'FaceStore.deleteByTracks (UNassigned only)',
    why: 'the buffered face read for a track. Assigned rows are exempt — see RETENTION_EXEMPT_FAMILIES.',
  },
  {
    id: 'face-media',
    store: 'pipeline-analytics:media',
    link: 'media-owner-is-prefixed-track-id',
    cascadedBy: 'MediaStore.deleteByTracks',
    why: "the unassigned face crop, owned by `face-<trackId>`. An ENROLLED crop is not here: it was reowned to ownerKind 'identity' at assignment.",
  },
  {
    id: 'plate-rows',
    store: 'pipeline-analytics:plates',
    link: 'track-id-column',
    cascadedBy: 'PlateStore.deleteByTracks (UNassigned only)',
    why: 'the plate mirror of face-rows.',
  },
  {
    id: 'plate-media',
    store: 'pipeline-analytics:media',
    link: 'media-owner-is-prefixed-track-id',
    cascadedBy: 'MediaStore.deleteByTracks',
    why: 'the plate mirror of face-media, owned by `plate-<trackId>`.',
  },
  {
    id: 'object-embeddings',
    store: 'vector indexes object-clip-<model>',
    link: 'row-id-is-track-id',
    cascadedBy: 'ObjectEmbeddingStore.deleteByTracks',
    why: 'the per-track CLIP search vector — exactly one row per track, keyed BY the trackId. This is the family measured 14–21 days out of step with its events.',
  },
]

// ── Age-keyed retention roots — the ONLY things a clock may select ───────

export type RetentionRootId = 'track' | 'motion-event' | 'audio-event' | 'sensor-event' | 'ops-log'

export interface RetentionRoot {
  readonly id: RetentionRootId
  readonly store: string
  /** The column the age predicate is written against. */
  readonly ageColumn: string
  /** Does deleting this row pull other entities away with it? */
  readonly cascades: boolean
  /** Is the cutoff resolved per device, or is it a single global window? */
  readonly cutoff: 'per-device' | 'global'
  readonly why: string
}

/**
 * The complete set of entities an age-keyed sweep is permitted to select.
 *
 * **`track` is the only cascading root.** It is the root of the analytics data
 * model and it pulls {@link TRACK_OWNED_FAMILIES} away with it.
 *
 * The other four are TERMINAL: they own nothing and nothing owns them, so an
 * age window on them cannot contradict anyone else's. That is the whole test
 * for membership — not "is it small", not "is it cheap", but *can its clock
 * disagree with another entity's clock*. If it can, it is not a root; it is
 * owned, and it belongs in {@link TRACK_OWNED_FAMILIES}.
 *
 * **A terminal root still needs a clock, and it gets the DEVICE's** (D62). The
 * cascade can never reach motion, audio or sensor events — no track owns them —
 * so without a clock they are immortal, and motion alone was measured at ~7,200
 * rows/day/camera. They take the same `DeviceRetentionCutoffs.cutoffMs` the
 * track sweep uses, for the same device, resolved once. Not a setting each:
 * `retentionMotionDays` / `retentionObjectDays` / `retentionAudioDays` are gone,
 * because three windows nobody sets differently is three ways to disagree with
 * nothing to gain. The operator reads one sentence — *a device has one retention
 * window, and everything scoped to that device is deleted on it* — and the ops
 * log is the single stated exception.
 *
 * `scripts/check-age-keyed-retention.ts` fails the build when a store grows an
 * age-keyed deletion that is not one of these.
 */
export const RETENTION_ROOTS: readonly RetentionRoot[] = [
  {
    id: 'track',
    store: 'pipeline-analytics:tracks',
    ageColumn: 'lastSeen',
    cascades: true,
    cutoff: 'per-device',
    why: 'THE sweep. Per-device by `trackRetentionDays` or the follow-recordings horizon — measured 1 day on 104, 7 on 101/102, and that difference is deliberate.',
  },
  {
    id: 'motion-event',
    store: 'pipeline-analytics:motion-events',
    ageColumn: 'timestamp',
    cascades: false,
    cutoff: 'per-device',
    why: 'camera-level motion. No trackId. May own a visit still (`kind: snapshot`) so events-mode recordings have a videoclip thumbnail; that media leaves in lockstep via EventStore.evictTracklessBefore → MediaStore.deleteForEvents. Swept on the DEVICE window, the same one the track sweep uses (D62); it had a per-family day window of its own until then.',
  },
  {
    id: 'audio-event',
    store: 'pipeline-analytics:audio-events',
    ageColumn: 'timestamp',
    cascades: false,
    cutoff: 'per-device',
    why: 'an RMS/dBFS sample with an optional class. Terminal for the same reason as motion-event, and on the same device window (D62).',
  },
  {
    id: 'sensor-event',
    store: 'pipeline-analytics:sensor-events',
    ageColumn: 'timestamp',
    cascades: false,
    cutoff: 'per-device',
    why: 'a linked device state change, denormalised per watching camera. Terminal. It was swept on the fleet MINIMUM cutoff because the store had no device scope, then briefly on the OBJECT-EVENT day window — a setting named after an entity sensor events have nothing to do with, which is how that wiring survived review. It has a `deviceId` column, so it is on the device window like everything else now (D62).',
  },
  {
    id: 'ops-log',
    store: 'pipeline-analytics:ops-log',
    ageColumn: 'at',
    cascades: false,
    cutoff: 'global',
    why: 'the retention audit trail. The one root that must NOT follow a device window — it records what retention did, including for devices that no longer exist, and it is the only reason a future session can tell an eviction from a bug. Global, and fixed at 30 days (OPS_LOG_RETENTION_MS): longer than the 7-day default, and deliberately NOT stretched to match a camera configured above it, because the audit trail is not history of the camera, it is history of the sweep.',
  },
]

/** The one cascading root — the sweep this whole model exists to make singular. */
export const CASCADING_RETENTION_ROOT: RetentionRoot = RETENTION_ROOTS[0]!
