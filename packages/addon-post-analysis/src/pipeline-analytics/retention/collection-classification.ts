/**
 * Every analytics collection, classified — and the classification DERIVED from
 * the declared schema wherever the schema can carry it.
 *
 * ## Why derivation matters here
 *
 * The 5,598 orphaned `keyFrame` rows were not produced by a bug in a sweep.
 * They were produced by a hand-written list: someone added an owned entity and
 * the list that says "these things belong to a track" was never updated, so
 * nothing ever came to collect them. Re-writing that list by hand — even
 * carefully, even today — recreates the same failure a release from now.
 *
 * So the ownership fact is READ OFF the column declarations the tables are
 * created from: **a collection whose declared columns include `trackId` is
 * owned by a track**, and **a collection that also declares `assigned` treats
 * an assigned row as enrolled and therefore exempt**. Both are already true of
 * every such collection; neither is restated here.
 *
 * ## What could NOT be derived, and why
 *
 * Two things, both stated as `explicit` so a reader can see the boundary:
 *
 * 1. **`pipeline-analytics:media`** carries `(ownerKind, ownerId)` — an
 *    indirection. No column list can say that `ownerId` means a trackId when
 *    `ownerKind` is `'track'`, a PREFIXED trackId when it is `'face'`, an
 *    eventId when it is `'event'`, and something retention must never touch
 *    when it is `'identity'`. That mapping is code, and it lives in
 *    `orphan-audit.ts`.
 *
 * 2. **`pipeline-analytics:stationary-objects`** declares `sourceTrackId`, and
 *    a naive "any column ending in TrackId" rule would classify it as owned and
 *    delete the parked-object registry every time a source track aged out. It
 *    is a REFERENCE, not ownership: a parked object outliving the track that
 *    first saw it is the entire point of the registry. The derivation therefore
 *    matches the exact name `trackId`, and this collection is classified by
 *    hand with that reason attached.
 *
 * The registry below is the input to the orphan audit AND the thing
 * `scripts/check-age-keyed-retention.ts` cross-checks every
 * `*_COLLECTION` constant against — so a new store cannot be added without
 * someone deciding, in writing, what happens to its rows when their owner goes
 * away.
 */

import { PACKAGE_BACKGROUND_COLLECTION } from '../pipeline/package/package-background.js'
import { PHANTOM_CELLS_COLLECTION } from '../pipeline/stationary/phantom-cells.js'
import { STATIONARY_EVIDENCE_COLLECTION } from '../pipeline/stationary/stationary-evidence-ledger.js'
import { STATIONARY_COLLECTION } from '../pipeline/stationary/stationary-registry.js'
import { RETRAIN_ANNOTATIONS_COLLECTION } from '../retrain/retrain-annotation-store.js'
import {
  RETRAIN_COLLECTION_FRAMES_COLLECTION,
  RETRAIN_COLLECTIONS_COLLECTION,
} from '../retrain/retrain-collection-store.js'
import { RETRAIN_FRAMES_COLLECTION } from '../retrain/retrain-frame-store.js'
import { SCENE_COLLECTION, SCENE_LATCH_COLLECTION } from '../scene/scene-store.js'
import { FACE_RESCORE_STATE_COLLECTION } from '../store/face-rescore-state-store.js'
import { MIGRATION_MARKER_COLLECTION } from '../store/label-tier-migration.js'
import { SWEEP_CURSOR_COLLECTION } from '../store/sweep-cursor-store.js'
import {
  AUDIO_COLUMNS,
  AUDIO_EVENTS_COLLECTION,
  MOTION_COLUMNS,
  MOTION_EVENTS_COLLECTION,
  OBJECT_COLUMNS,
  OBJECT_EVENTS_COLLECTION,
} from '../store/event-store.js'
import { FACE_COLUMNS, FACES_COLLECTION } from '../store/face-store.js'
import {
  IDENTITIES_COLLECTION,
  IDENTITY_COLUMNS,
  IDENTITY_SAMPLES_COLLECTION,
  SAMPLE_COLUMNS as IDENTITY_SAMPLE_COLUMNS,
} from '../store/identity-store.js'
import { BIRTH_DECISION_LEDGER_COLLECTION } from '../store/birth-decision-ledger-store.js'
import { DEBUG_NOTE_ARCHIVE_COLLECTION } from '../store/debug-note-archive-store.js'
import { TRACKING_TAPES_COLLECTION } from '../store/tracking-tape-index-store.js'
import {
  TRACK_PURITY_COLLECTION,
  TRACK_RELATIONS_COLLECTION,
} from '../store/track-relations-store.js'
import { MEDIA_COLLECTION, MEDIA_COLUMNS } from '../store/media-store.js'
import { OPS_LOG_COLLECTION, OPS_LOG_COLUMNS } from '../store/ops-log-store.js'
import { PLATE_COLUMNS, PLATES_COLLECTION } from '../store/plate-store.js'
import { SENSOR_EVENT_COLUMNS, SENSOR_EVENTS_COLLECTION } from '../store/sensor-event-store.js'
import { TRACK_ALIAS_COLUMNS, TRACK_ALIASES_COLLECTION } from '../store/track-alias-store.js'
import { TRACKS_COLLECTION, TRACKS_COLUMNS } from '../store/track-store.js'
import {
  SAMPLE_COLUMNS as VEHICLE_SAMPLE_COLUMNS,
  VEHICLE_COLUMNS,
  VEHICLE_SAMPLES_COLLECTION,
  VEHICLES_COLLECTION,
} from '../store/vehicle-store.js'
import type { RetentionRootId } from './retention-model.js'

/** The shape every store's column declaration has in common. */
export interface DeclaredColumn {
  readonly name: string
}

/** The exact column name that means "a track owns this row". */
const OWNERSHIP_COLUMN = 'trackId'

/** The exact column name that means "this row was enrolled and is exempt". */
const ENROLMENT_COLUMN = 'assigned'

export type CollectionClassification =
  /** Owned by a track through a declared `trackId` column. Orphaned when that
   *  track is gone. Deleted by the cascade; never by age. */
  | {
      readonly kind: 'track-owned'
      readonly derivation: 'declared-trackId-column'
      /** True when the collection also declares `assigned` — enrolled rows are
       *  exempt, derived the same way. */
      readonly enrolmentExempt: boolean
    }
  /** Owned through an indirection the column list cannot express. */
  | {
      readonly kind: 'owner-indirection'
      readonly derivation: 'explicit'
      readonly why: string
    }
  /** An age-keyed retention root (see `RETENTION_ROOTS`). Nothing owns it. */
  | { readonly kind: 'retention-root'; readonly rootId: RetentionRootId }
  /** Never orphaned by anything retention does. */
  | { readonly kind: 'never-orphaned'; readonly why: string }

export interface ClassifiedCollection {
  readonly collection: string
  readonly classification: CollectionClassification
}

/** Derive the track-ownership classification from a declared column list. */
function classifyByDeclaredColumns(columns: readonly DeclaredColumn[]): {
  readonly owned: boolean
  readonly enrolmentExempt: boolean
} {
  const names = new Set(columns.map((c) => c.name))
  return {
    owned: names.has(OWNERSHIP_COLUMN),
    enrolmentExempt: names.has(ENROLMENT_COLUMN),
  }
}

function derived(columns: readonly DeclaredColumn[]): CollectionClassification {
  const { owned, enrolmentExempt } = classifyByDeclaredColumns(columns)
  if (!owned) {
    throw new Error(
      'classification: a collection routed through the derivation declares no `trackId` column — classify it explicitly instead',
    )
  }
  return {
    kind: 'track-owned',
    derivation: 'declared-trackId-column',
    enrolmentExempt,
  }
}

/**
 * Every collection this addon declares, with what happens to its rows when
 * their owner goes away.
 *
 * The `derived(...)` entries are not decisions made here — they are read off
 * the same constant that creates the table. Change the columns and the
 * classification follows; forget to change this file and nothing drifts.
 */
export const ANALYTICS_COLLECTIONS: readonly ClassifiedCollection[] = [
  // ── Track-owned, derived from the declared `trackId` column ──────────
  {
    collection: OBJECT_EVENTS_COLLECTION,
    classification: derived(OBJECT_COLUMNS),
  },
  { collection: FACES_COLLECTION, classification: derived(FACE_COLUMNS) },
  { collection: PLATES_COLLECTION, classification: derived(PLATE_COLUMNS) },
  // D683: the alias collection is owned by its SURVIVOR through the declared
  // `trackId` column — the same derivation as every other track-owned table.
  // Its cascade leg is widened (`expandLeafIds`) the other direction: it is
  // the one table whose OWN rows are found by `trackId` even though the id
  // they name (`id`, the absorbed provisional id) is what the rest of the
  // cascade must also reach.
  { collection: TRACK_ALIASES_COLLECTION, classification: derived(TRACK_ALIAS_COLUMNS) },

  // ── Owned through an indirection no column list can express ──────────
  {
    collection: MEDIA_COLLECTION,
    classification: {
      kind: 'owner-indirection',
      derivation: 'explicit',
      why: "(ownerKind, ownerId) means a different entity per kind — a trackId for 'track', a PREFIXED trackId for 'face'/'plate', an eventId for 'motion'/'object'/'audio' (D476 split 'event' into the three tables it used to cover), and an enrolled gallery row for 'identity'/'vehicle' that retention must never touch. A RETIRED ownerKind (the deleted group entity) resolves to an owner that can never exist again and is always an orphan. The mapping is `resolveMediaOwner` in orphan-audit.ts.",
    },
  },

  // ── Age-keyed retention roots — nothing owns these ───────────────────
  {
    collection: TRACKS_COLLECTION,
    classification: { kind: 'retention-root', rootId: 'track' },
  },
  {
    collection: MOTION_EVENTS_COLLECTION,
    classification: { kind: 'retention-root', rootId: 'motion-event' },
  },
  {
    collection: AUDIO_EVENTS_COLLECTION,
    classification: { kind: 'retention-root', rootId: 'audio-event' },
  },
  {
    collection: SENSOR_EVENTS_COLLECTION,
    classification: { kind: 'retention-root', rootId: 'sensor-event' },
  },
  {
    collection: OPS_LOG_COLLECTION,
    classification: { kind: 'retention-root', rootId: 'ops-log' },
  },

  // ── Never orphaned ───────────────────────────────────────────────────
  {
    collection: IDENTITIES_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'an identity is created by the operator and exists independently of any observation of it.',
    },
  },
  {
    collection: IDENTITY_SAMPLES_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'the durable ArcFace matching vectors. They carry a trackId-shaped provenance but they are NOT owned by it — deleting a sample because its track aged out would silently degrade recognition for the identity.',
    },
  },
  {
    collection: VEHICLES_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'the plate mirror of identities.',
    },
  },
  {
    collection: VEHICLE_SAMPLES_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'the plate mirror of identity-samples.',
    },
  },
  {
    collection: PACKAGE_BACKGROUND_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'a package-background cell is a property of the SCENE — "this position keeps producing ghost delivered→vanished cycles with nobody around" (D206) — not of any track: the cycles that armed it were rejected precisely for having no deliverer. Its bound is its own 7-day cycle window (aged on the next touch of the cell) plus a 128-cell-per-device LRU cap, both enforced by the ledger on write — deliberately not an age sweep, which would be a second clock (D61).',
    },
  },
  {
    collection: PHANTOM_CELLS_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'a phantom cell is a property of the SCENE — "this patch of pixels keeps producing 4-second motionless tracks" — not of any track. The tracks that produced it are dead by construction (that is the entire premise: the stationary registry cannot see them because they never live long enough to be promoted), so there is no owner it could be orphaned from. Its bound is its own 24h close window plus a 512-cell-per-device cap, both enforced by the registry on write — deliberately not an age sweep, which would be a second clock (D61).',
    },
  },
  {
    collection: RETRAIN_ANNOTATIONS_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: "the ground truth an operator DREW. It declares `trackId` and must be classified by hand for that reason: the id is provenance, not ownership. The dataset addresses COPIES (D81), which is precisely what makes a 'trained' track evictable again — so a track ageing out leaves the annotations standing. Rows go only through `deleteForFrame`, when the operator deselects the frame. Deleting one because its track expired would destroy labelling work no sweep can recreate.",
    },
  },
  {
    collection: RETRAIN_FRAMES_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: "the frame COPIES the dataset owns outright, in the `retrain/` subtree of the durable `artifacts` class (D781), which no owner cascade and no age sweep walks (D81). Also declares `trackId` as provenance. Rows go only through `deleteFrame`, after their annotations, on operator deselection. NOTE: nothing caps this table or the disk it consumes — that is a deliberate decision, not an oversight, and it is the one collection here whose bound is an operator's habit.",
    },
  },
  {
    collection: RETRAIN_COLLECTIONS_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'the named training corpora an operator CREATES from playback — one metadata row per collection (id, name, timestamps), keyed by nothing that can expire: no trackId, no event id, no device. There is no owner to go away, and no age clock applies, because a collection the operator built and has not opened since is not stale, it is kept. Rows leave only through an explicit operator delete.',
    },
  },
  {
    collection: RETRAIN_COLLECTION_FRAMES_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: "the membership of a retrain frame COPY in a named collection — one row per (collectionId, frameId), keyed by a hash of the pair. Both ends are operator-owned rows that no cascade and no age sweep walks (the two entries above), so retention can never take either owner away. The owner-cleanup is self-contained in the dataset: `RetrainService.removeFrame` deletes a frame's memberships in the SAME transaction as the frame row (`forgetFrameOps`), and `RetrainCollectionStore.delete` deletes a collection's memberships in the same transaction as the collection. Deliberately NOT `owner-indirection`: that kind enrols a collection into `auditableCollections()`, and the audit has a resolver only for `pipeline-analytics:media`.",
    },
  },
  {
    collection: FACE_RESCORE_STATE_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'one KV row (`last-run`) holding the fingerprint and report of the last COMPLETED face rescore (D866). It summarises a run over the whole gallery, so there is no entity it can be orphaned from, and no age clock applies: an old row is still the truth about the last run. Losing it costs one extra rescore, never a wrong suggestion — which is why it is overwritten in place and never swept.',
    },
  },
  {
    collection: SCENE_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'operator intent — one row per (deviceId, monitorId), created and destroyed by scene CRUD or by a device-removal sweep. Nothing retention does can orphan it, and no age clock applies: a scene the operator configured and never revisits is not stale, it is configured.',
    },
  },
  {
    collection: SCENE_LATCH_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'it IS owned — by the scene set — but the owner-cleanup is self-contained: `pruneExcept(the scene set)` runs on every scene reload, so a latch whose scene is gone is collected there and never by retention. Deliberately NOT `owner-indirection`: that kind puts a collection into `auditableCollections()`, and the orphan audit resolves only the indirections it has a resolver for (`pipeline-analytics:media`).',
    },
  },
  {
    collection: SWEEP_CURSOR_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: "one row holding the orphan audit's per-scope resume offsets (D480). It summarises where a sweep got to, so there is no entity it can be orphaned from — and deleting it costs the next pass its reach, which is the failure the row exists to prevent.",
    },
  },
  {
    collection: MIGRATION_MARKER_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'a one-row completion marker for the label-tier 4g pass. It summarises a one-time event, so there is no entity it can be orphaned from — and its PRESENCE is what stops the migration running again, so deleting it is not cleanup, it is a re-run over every track, face and object-event row.',
    },
  },
  {
    collection: DEBUG_NOTE_ARCHIVE_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'the archived operator notes (D405) — the ONE table here whose whole purpose is to outlive the track it names. `debug` never pinned a track against retention and D405 does not change that, so the track a note was written on IS expected to be evicted; deleting the note with it is the failure the archive was built to fix (25–27 notes from one sweep unreadable the same afternoon). Its column is called `sourceTrackId` and not `trackId` precisely so the ownership derivation cannot reach it, and its bound is a fleet-wide ROW COUNT trimmed on append — never an age sweep, which would delete the corpus for the one property that makes it valuable.',
    },
  },
  {
    collection: TRACKING_TAPES_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'the promoted tracking-tape windows (D681) — history the operator is labelling, whose whole purpose is to outlive the tracks it names. Its `trackIds` column is a JSON list of PROVENANCE references, deliberately not `trackId`, so the ownership derivation cannot reach it. Bounded by the promotion budget (60 rows, 1 GiB), which REFUSES a promotion rather than evicting one — never by age.',
    },
  },
  {
    collection: BIRTH_DECISION_LEDGER_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'the birth-decision ledger (D409) — a measurement of what the confirmation gate decided, not analytics data about a track. Most of its rows describe births that were SUPPRESSED and therefore never had a track at all, and the confirmed ones are expected to outlive theirs: a miss rate needs its denominator for as long as the table holds, and cascading rows away with their tracks would silently shorten the window while leaving the numerator behind. Its column is called `sourceTrackId` and not `trackId` precisely so the ownership derivation cannot reach it, and its bound is a fleet-wide ROW COUNT trimmed on append — never an age sweep.',
    },
  },
  {
    collection: TRACK_RELATIONS_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'ground-truth identity marks for the tracking bench (D681). A row NAMES two tracks as provenance (`leftTrackId`/`rightTrackId`, deliberately not `trackId`) and must outlive both: a relation is most valuable once its tracks have aged out and the pattern has repeated (the D405 argument). Bounded by ROW COUNT (20 000), oldest `updatedAt` first — never by age.',
    },
  },
  {
    collection: TRACK_PURITY_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'the purity half of the tracking-bench ground truth (D681): `sourceTrackId` is provenance, not ownership, for the same reason as the relations table next to it. Bounded by ROW COUNT (5 000), oldest `updatedAt` first — never by age.',
    },
  },
  {
    collection: STATIONARY_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: 'declares `sourceTrackId`, which is a REFERENCE and not ownership — a parked object outliving the track that first saw it is the entire purpose of the registry. It has its own TTL sweep keyed on OBSERVED frame time, not wall clock. Classified by hand precisely because the derivation must not see it.',
    },
  },
  {
    collection: STATIONARY_EVIDENCE_COLLECTION,
    classification: {
      kind: 'never-orphaned',
      why: "the candidate half of the registry above, and it inherits that entry's argument for the same reason: `sourceTrackId` is the PROVENANCE of whichever track happened to be looking, never ownership. It cannot be `track-owned` on the behaviour, not merely on the name — a candidate is fed by a SUCCESSION of tracks (`StationaryEvidenceLedger.observe` re-binds under D280, and `retainTracks` drops a binding the moment the tracker forgets the track) while the row itself survives, because agreement accumulating ACROSS tracks is the whole measurement. Cascading it on the first contributor's eviction would delete evidence still being gathered by tracks alive right now. Its bounds are its own and stay inside D61's one-clock rule: a candidate untouched for EVIDENCE_WINDOW_MS (6h) is dropped by `expire`, on the next OBSERVATION of that device and against the frame timestamp — the same observed-time clock the registry uses, never wall clock and never a sweep; a device is capped at EVIDENCE_MAX_CANDIDATES_PER_DEVICE (512, least-recently-touched evicted); a promotion deletes the candidate the instant the registry entry is born, so the two tables cannot both hold the object; and `clearDevice` takes the rest when a camera is removed. Deliberately NOT `owner-indirection`: that kind enrols a collection into `auditableCollections()`, and the audit has a resolver only for `pipeline-analytics:media`.",
    },
  },
]

/** The columns each classified collection declares — kept next to the
 *  classification so the guard can re-derive it without importing every store. */
export const ANALYTICS_COLLECTION_COLUMNS: ReadonlyMap<string, readonly DeclaredColumn[]> = new Map<
  string,
  readonly DeclaredColumn[]
>([
  [OBJECT_EVENTS_COLLECTION, OBJECT_COLUMNS],
  [MOTION_EVENTS_COLLECTION, MOTION_COLUMNS],
  [AUDIO_EVENTS_COLLECTION, AUDIO_COLUMNS],
  [SENSOR_EVENTS_COLLECTION, SENSOR_EVENT_COLUMNS],
  [FACES_COLLECTION, FACE_COLUMNS],
  [PLATES_COLLECTION, PLATE_COLUMNS],
  [MEDIA_COLLECTION, MEDIA_COLUMNS],
  [TRACKS_COLLECTION, TRACKS_COLUMNS],
  [TRACK_ALIASES_COLLECTION, TRACK_ALIAS_COLUMNS],
  [OPS_LOG_COLLECTION, OPS_LOG_COLUMNS],
  [IDENTITIES_COLLECTION, IDENTITY_COLUMNS],
  [IDENTITY_SAMPLES_COLLECTION, IDENTITY_SAMPLE_COLUMNS],
  [VEHICLES_COLLECTION, VEHICLE_COLUMNS],
  [VEHICLE_SAMPLES_COLLECTION, VEHICLE_SAMPLE_COLUMNS],
])

/** The collections the orphan audit actually scans — everything with an owner. */
export function auditableCollections(): readonly ClassifiedCollection[] {
  return ANALYTICS_COLLECTIONS.filter(
    (c) => c.classification.kind === 'track-owned' || c.classification.kind === 'owner-indirection',
  )
}
