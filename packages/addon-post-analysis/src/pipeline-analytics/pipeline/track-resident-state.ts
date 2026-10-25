/**
 * `TrackResidentState` — the ONE owner of ALL per-track live (in-RAM) state.
 *
 * Refactor S1 (spec `2026-07-22-post-analysis-maintainability-refactor-design.md`):
 * the addon used to hold 12 per-track containers (two "best" trackers, a
 * key-frame key map, the rolling-lastFrame clock, four RC-1 in-flight sets, the
 * firstFrame-pending + thumbnail-landed sets, the lifecycle update-gate memory
 * and the close-policy state) with FIVE independently drifting teardown litanies
 * — `clearLiveTrackState` cleared 3/14 items and the device-removal paths
 * cleared 0 (containers keyed by bare trackId, no device index): two confirmed
 * leaks. Here every per-track record carries its `deviceId` and there is ONE
 * close that empties EVERY container, plus a device-indexed `closeDevice`.
 *
 * Refactor S3: the four RC-1 IN-FLIGHT gates (lastFrame / firstFrame /
 * thumbnail / keyFrame) moved OUT of this class — in-flight ownership now
 * lives in the `CaptureScheduler` (`runtime/capture-scheduler.ts`) as
 * coalesce/hold keys. This class keeps only the LANDED/PENDING semantics
 * (`thumbnailLanded`, `firstFramePending`). `close` additionally invokes the
 * injected `onClose` hook (every mode; `closeDevice` fans in through it) so
 * the scheduler cancels the closed track's still-queued capture requests.
 *
 * External side effects at close (face/plate recognizer `onTrackEnd`, detail
 * dispatcher / overlay `onTrackEnded`, lifecycle events) deliberately stay
 * orchestrated by the caller — this class owns STATE, not policy. The
 * `onClose` hook is the one exception, chosen over per-call-site wiring
 * because close() is the single choke point all five teardown paths share.
 *
 * Deferred keyFrame-key drop (Design B, preserved exactly): on close modes
 * `end` / `suppress` / `stationary` the caller starts the recognizers'
 * `onTrackEnd` (which read the track's id via `keyFrameMediaId`) and drops the key
 * only once the face promise settles. `close` therefore parks the key in a
 * deferred-drop area — still served by `keyFrameMediaId()` — until the caller's
 * `dropKeyFrameKey` settles it. Mode `prune` (cascade deletion; no recognizer
 * end is fired there) drops the key immediately, as does `closeDevice`.
 */

import { BestDetectionTracker, type BestDetection } from './best-detection-tracker.js'
import type { BestFrameCandidate, BestFrameComparison } from './edge-clear.js'
import { BEST_FRAME_POLICY, BEST_OBJECT_EMBED_POLICY } from './best-selection-policies.js'
import { TrackBestSelector, type TrackBestObservation } from './track-best-detection.js'
import type { KeyFrameCaptureState } from './key-frame-retry.js'
import type { TrackLifecycleUpdateMemory } from '../track-lifecycle.js'

/** How a track leaves the live set. Every mode runs the FULL cleanup litany;
 *  the modes differ only in which EXTERNAL side effects the caller orchestrates
 *  around the close (recognizer ends, lifecycle events, cascades) and in the
 *  keyFrame-key drop timing (deferred for the recognizer-linked modes). */
export type TrackCloseMode = 'end' | 'suppress' | 'stationary' | 'prune'

/** A retained detection-raster subject crop for the zero-media fallback. */
export interface RetainedRasterFallback {
  readonly jpeg: Buffer
  readonly timestamp: number
}

/**
 * The track's BEST-SEEN subject bbox (#27-A degenerate-retry fix): recorded on
 * every accepted PLAUSIBLE new-best observe. Carries the full geometry (not
 * just the area) because it serves two consumers:
 *  - the best-`thumbnail` RETRY gate compares the CURRENT frame's bbox area
 *    against this best-seen area (`isPlausibleRetryBox`), and
 *  - the close-time keyFrame-derived thumbnail fallback crops exactly this
 *    region (in ITS frame's pixel space) out of the persisted native keyFrame.
 */
export interface BestSeenBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Detection-frame dims the bbox is expressed in (needed to normalize). */
  readonly frameWidth: number
  readonly frameHeight: number
  /** Frame instant (ms) of the best-seen observation — the keyFrame re-shot
   *  moment, used for the temporal-skew guard of the close-time crop. */
  readonly timestamp: number
}

/** Read-only view of a track's close-policy state (spec §"Zero-media track
 *  policy"): consulted at close to decide suppress / raster-fallback / persist. */
export interface TrackClosureView {
  /** True (sticky) once the track reached `trackAge >= minHits`. */
  readonly confirmed: boolean
  /** First detection-raster subject crop retained for the track (last-resort
   *  preview, committed as a `thumbnail` at close only if still media-less). */
  readonly rasterFallback?: RetainedRasterFallback
}

/** The outcome of an {@link TrackResidentState.adopt} — which side's best
 *  shot (and the parked frame / face / plate state keyed on it) survived. */
export interface AdoptOutcome {
  readonly bestShotFrom: BestShotSide
}

/** The per-track resident record. Exported (read-only use: `keyof` for
 *  {@link RESIDENT_MERGE_RULES}) — call sites otherwise go through the
 *  accessors, never the raw record/Map. */
export interface TrackResident {
  readonly deviceId: number
  /** Design B: the track's shared native key-frame media ROW id (D482),
   *  captured at the best-detection moment. Read by the face / plate /
   *  object-embedding rows so they LINK the SAME single native key frame. */
  keyFrameMediaId?: number
  /** Wall-clock of the track's last ACTUALLY-written rolling `lastFrame`. */
  lastFrameAt?: number
  /** DEFECT A: confirmed birth whose `firstFrame` has not yet persisted. */
  firstFramePending: boolean
  /** A `firstFrame` HAS persisted for this track. Distinguishes "pending was
   *  cleared because the write landed" from "pending was never set" (a birth
   *  the confirmation gate suppressed, or a resurrection) — the resume path
   *  re-arms pending ONLY when nothing ever landed, so a later retry can never
   *  overwrite the true first view. */
  firstFrameLanded: boolean
  /** #27-A: the best `thumbnail` has ACTUALLY been persisted. */
  thumbnailLanded: boolean
  /** The native `keyFrame` has ACTUALLY been persisted (2026-08-06). The
   *  thumbnail's analogue, and the reason it now exists: the keyFrame fired on
   *  `isNewBest` ALONE, a peak signal most tracks raise once, so a single
   *  native miss was permanent for 71.6% of the tracks that hit one. */
  keyFrameLanded: boolean
  /** Attempts spent on the BOUNDED catch-up retry path (new-best attempts are
   *  deliberately not counted — see `key-frame-retry.ts`). */
  keyFrameRetries: number
  /** Wall clock of the last key-frame attempt of EITHER path (min-gap floor). */
  keyFrameLastAttemptAt?: number
  /** Update-gate memory for lifecycle `phase:'update'` emits. */
  lifecycleUpdateMem?: TrackLifecycleUpdateMemory
  /** Sticky hit-confirmation flag (zero-media close policy). */
  confirmed: boolean
  /**
   * The operator's `debug` flag, as of the last `setTrackFlags` on this track.
   *
   * Lives HERE — in the map the frame path already touches for every track —
   * because it is read on the decision path (best shot, birth confirmation,
   * reflection suspect) and a camera with no marked track must pay one map
   * lookup and nothing else. It is WRITTEN exactly once per mark, by the cap
   * mutation the operator's button calls; the frame path never reads the
   * track store for it.
   *
   * A brand-new track is not marked (nobody has seen it yet), so `false` is the
   * correct and free default — the flag arrives, if it ever does, on the
   * mutation that sets it.
   */
  debugMarked: boolean
  /** First retained detection-raster crop (first wins, zero-media fallback). */
  rasterFallback?: RetainedRasterFallback
  /** #27-A: best-seen subject bbox — updated on every accepted plausible
   *  new-best observe (see {@link BestSeenBbox}). */
  bestBbox?: BestSeenBbox
  /** D276/B2: last preview-capture failure (`<kind>:<cause>`) and how many
   *  failures the track saw in total — what turns a close-time
   *  `no-key-frame` into "the lease died" vs "the queue shed it". */
  previewCaptureMiss?: PreviewCaptureMiss
  /** D400: frame instant of the last best-shot promotion REFUSAL line logged
   *  for this track. Throttles the refusal side of the promotion log (see
   *  `best-shot-promotion-log.ts#PROMOTION_REFUSAL_LOG_GAP_MS`); acceptances
   *  are never throttled. */
  bestShotRefusalLoggedAt?: number
}

/** One track's accumulated preview-capture failure note (D276/B2). */
export interface PreviewCaptureMiss {
  readonly reason: string
  readonly count: number
}

/** Which side's best shot survived a fusion (D683). */
export type BestShotSide = 'survivor' | 'absorbed'

/** What every merge rule may consult beyond the two residents. */
export interface ResidentMergeContext {
  readonly bestShotFrom: BestShotSide
}

/** One field's merge rule: `a` the survivor, `b` the absorbed piece. */
export type ResidentMergeFn<K extends keyof TrackResident> = (
  a: TrackResident,
  b: TrackResident,
  ctx: ResidentMergeContext,
) => TrackResident[K]

/** The resident fields that are plain booleans (the `either` rule's domain). */
type ResidentFlagKey =
  | 'firstFramePending'
  | 'firstFrameLanded'
  | 'thumbnailLanded'
  | 'keyFrameLanded'
  | 'confirmed'
  | 'debugMarked'

/** The survivor's value, unconditionally. */
const survivor =
  <K extends keyof TrackResident>(k: K): ResidentMergeFn<K> =>
  (a) =>
    a[k]
/** The absorbed piece's value when set (it is the later piece), else the survivor's. */
const laterIfSet =
  <K extends keyof TrackResident>(k: K): ResidentMergeFn<K> =>
  (a, b) =>
    b[k] ?? a[k]
/** The earlier piece's value when set, else the later one's ("first wins"). */
const firstIfSet =
  <K extends keyof TrackResident>(k: K): ResidentMergeFn<K> =>
  (a, b) =>
    a[k] ?? b[k]
/** True when either side is. */
const either =
  <K extends ResidentFlagKey>(k: K): ResidentMergeFn<K> =>
  (a, b) =>
    a[k] || b[k]
/**
 * The WINNING best shot's side, and only that side — no fallback (review H4):
 * these fields describe one specific captured frame, and borrowing the losing
 * side's value would say a shot landed that did not, closing the bounded
 * retry (D58) on the frame the ranking actually chose.
 */
const winner =
  <K extends keyof TrackResident>(k: K): ResidentMergeFn<K> =>
  (a, b, ctx) =>
    ctx.bestShotFrom === 'absorbed' ? b[k] : a[k]
/** The winning side's value when set, else the other side's — for a fallback
 *  whose whole point is to exist (M5: the zero-media raster crop). */
const winnerElseOther =
  <K extends keyof TrackResident>(k: K): ResidentMergeFn<K> =>
  (a, b, ctx) =>
    ctx.bestShotFrom === 'absorbed' ? (b[k] ?? a[k]) : (a[k] ?? b[k])
/** M5: the later reason, and the failures of BOTH pieces counted. */
const summedMiss: ResidentMergeFn<'previewCaptureMiss'> = (a, b) => {
  const x = a.previewCaptureMiss
  const y = b.previewCaptureMiss
  if (x === undefined || y === undefined) return y ?? x
  return { reason: y.reason, count: x.count + y.count }
}

/**
 * D683 §6.2: how each `TrackResident` field merges when L2 fuses two pieces —
 * one FUNCTION per field, run by {@link mergeResidents} and nothing else, so
 * the table IS the behaviour (review H2; the same mechanism as
 * `TRACK_MERGE_RULES` in `store/track-merge.ts`). The `-?` makes every
 * optional field mandatory here: dropping a rule, or adding a field to
 * `TrackResident` without one, does not compile.
 */
export const RESIDENT_MERGE_RULES: {
  readonly [K in keyof TrackResident]-?: ResidentMergeFn<K>
} = {
  deviceId: survivor('deviceId'),
  // The four fields that say what happened to the WINNING shot (H4).
  keyFrameMediaId: winner('keyFrameMediaId'),
  keyFrameLanded: winner('keyFrameLanded'),
  keyFrameRetries: winner('keyFrameRetries'),
  thumbnailLanded: winner('thumbnailLanded'),
  // The box the winning frame was cropped from — never a box of the other frame.
  bestBbox: winner('bestBbox'),
  lastFrameAt: laterIfSet('lastFrameAt'),
  firstFramePending: survivor('firstFramePending'),
  firstFrameLanded: either('firstFrameLanded'),
  keyFrameLastAttemptAt: laterIfSet('keyFrameLastAttemptAt'),
  lifecycleUpdateMem: firstIfSet('lifecycleUpdateMem'),
  confirmed: either('confirmed'),
  debugMarked: either('debugMarked'),
  rasterFallback: winnerElseOther('rasterFallback'),
  previewCaptureMiss: summedMiss,
  bestShotRefusalLoggedAt: laterIfSet('bestShotRefusalLoggedAt'),
}

/** Every `TrackResident` key, in the order the merge runs them. */
export const RESIDENT_MERGE_KEYS = [
  'deviceId',
  'keyFrameMediaId',
  'keyFrameLanded',
  'keyFrameRetries',
  'thumbnailLanded',
  'bestBbox',
  'lastFrameAt',
  'firstFramePending',
  'firstFrameLanded',
  'keyFrameLastAttemptAt',
  'lifecycleUpdateMem',
  'confirmed',
  'debugMarked',
  'rasterFallback',
  'previewCaptureMiss',
  'bestShotRefusalLoggedAt',
] as const satisfies readonly (keyof TrackResident)[]
type MissingResidentMergeKey = Exclude<keyof TrackResident, (typeof RESIDENT_MERGE_KEYS)[number]>
const allResidentKeysListed: [MissingResidentMergeKey] extends [never] ? true : false = true
void allResidentKeysListed

/** `TrackResident` with its one readonly field writable — only while building a merge. */
type ResidentDraft = { -readonly [K in keyof TrackResident]: TrackResident[K] }

function setResidentField<K extends keyof TrackResident>(
  row: ResidentDraft,
  k: K,
  v: TrackResident[K],
): void {
  if (v === undefined) delete row[k]
  else row[k] = v
}

/** A NEW resident folding `b` (absorbed) into `a` (survivor): every rule, run once. */
function mergeResidents(
  a: TrackResident,
  b: TrackResident,
  ctx: ResidentMergeContext,
): TrackResident {
  const out: ResidentDraft = { ...a }
  for (const k of RESIDENT_MERGE_KEYS) setResidentField(out, k, RESIDENT_MERGE_RULES[k](a, b, ctx))
  return out
}

/** A resident with nothing recorded — the side of a fusion that never opened one. */
function emptyResident(deviceId: number): TrackResident {
  return {
    deviceId,
    firstFramePending: false,
    firstFrameLanded: false,
    thumbnailLanded: false,
    keyFrameLanded: false,
    keyFrameRetries: 0,
    confirmed: false,
    debugMarked: false,
  }
}

/** A keyFrame key parked between `close` and the settled recognizer end. */
interface DeferredKeyFrameMediaId {
  readonly deviceId: number
  readonly mediaId: number
}

/** Hooks a `TrackResidentState` invokes around its lifecycle transitions. */
export interface TrackResidentStateHooks {
  /** S3: fired on EVERY `close` (all modes — `closeDevice` fans in here too,
   *  and a redundant double-close fires it again harmlessly) so the capture
   *  scheduler can cancel the track's still-QUEUED capture requests. Running
   *  execs are never interrupted. Fired unconditionally (even for a trackId
   *  with no resident record) because queued captures can outlive the record. */
  readonly onClose?: (trackId: string) => void
  /**
   * D683: fired on EVERY `adopt` — the absorbed piece's RAM state just folded
   * into the survivor's. Wired to `ParkedFrameClient.adopt` so the survivor's
   * parked-frame reads fall back to the absorbed piece's parcel when its best
   * shot won. Never fires `onClose` — adopting closes nothing (review H4).
   */
  readonly onAdopt?: (survivorId: string, absorbedId: string, bestShotFrom: BestShotSide) => void
  /**
   * D683 review M1: work arrived under an id this state no longer owns — an
   * absorbed piece whose survivor already CLOSED (`survivor-closed`), or a
   * late landing of the shot that LOST the fusion's ranking (`losing-shot`).
   * Refused, never resurrected as a ghost resident. Sampled here: at most one
   * call per device per {@link LATE_ABSORBED_WORK_SAMPLE_MS}, carrying how
   * many refusals the window swallowed. The host logs it with `tags: { deviceId }`.
   */
  readonly onLateAbsorbedWork?: (work: LateAbsorbedWork) => void
}

/** A resident whose last frame stamp is old — an orphan candidate. */
export interface IdleResident {
  readonly trackId: string
  readonly deviceId: number
  readonly lastFrameAt: number
}

/** One sampled refusal of late work under an absorbed id (review M1). */
export interface LateAbsorbedWork {
  readonly deviceId: number
  readonly trackId: string
  readonly survivorId: string
  readonly reason: 'survivor-closed' | 'losing-shot' | 'track-closed'
  /** Which write was refused (the mutator name), for the sampled line. */
  readonly write: string
  /** Refusals on this device since the previous sampled call (this one included). */
  readonly refused: number
}

/** One sampled late-work line per device per minute. */
const LATE_ABSORBED_WORK_SAMPLE_MS = 60_000

/** Absorbed ids remembered after their survivor closed, so late work for
 *  them is refused rather than resurrected (oldest forgotten first). */
const MAX_RETIRED_ABSORBED_IDS = 4096

/** Closed track ids remembered (oldest forgotten first) so an async completion
 *  settling AFTER `close` is refused instead of re-creating a resident nothing
 *  would ever close. Track ids are unique per birth; 16384 covers hours of
 *  settling at the busiest observed birth rate. */
const MAX_CLOSED_TRACK_IDS = 16_384

/** Which writes a late call under an absorbed id may make (review M1). */
type ResidentWriteKind = 'general' | 'bestShot'

export class TrackResidentState {
  private readonly residents = new Map<string, TrackResident>()
  /** Best (highest-confidence) frame per track — drives the single overwrite
   *  `thumbnail` (§5 best-frame) + the native keyFrame re-shot signal. Policy
   *  declared in `best-selection-policies.ts` (edge/size-aware, hysteresis,
   *  rate-limited with the decisive bypass). */
  private readonly bestFrameTracker = new BestDetectionTracker(BEST_FRAME_POLICY)
  /** Best CLIP-object detection per track — drives ONE tight object-crop
   *  capture written onto the embedding row. Confidence-only in-memory policy
   *  (declared in `best-selection-policies.ts`); the durable cross-restart gate
   *  stays in `ObjectEmbeddingStore.upsertIfBetter`. */
  /**
   * ONE selector PER CLIP MODEL (D649). Each model's vector lands in its own
   * index, so "the track's best" is a per-index question: ranked across models,
   * a track whose MobileCLIP peak was 0.9 would not write its first SigLIP2
   * vector after a flip until a detection beat 0.9 — possibly never.
   */
  private readonly objectEmbeddingBestSelectors = new Map<string, TrackBestSelector>()
  /** keyFrame keys of CLOSED tracks still readable until the recognizer-end
   *  deferred drop settles (see module docstring). */
  private readonly deferredKeyFrameKeys = new Map<string, DeferredKeyFrameMediaId>()
  /** D683: every id a LIVE survivor has absorbed, so `close(survivorId, …)`
   *  can fan its `onClose` out to all of them (adopting itself closes
   *  nothing — review H4). Flattened on a chained fusion: absorbing B into A
   *  after A already absorbed C records both B and C under A. */
  private readonly absorbedBy = new Map<string, readonly string[]>()
  /** D683 review M1: absorbed id → the LIVE survivor it now belongs to
   *  (flattened across chained fusions). Late work under the absorbed id is
   *  routed there instead of re-creating a resident nothing would close. */
  private readonly aliases = new Map<string, string>()
  /**
   * Survivor id → the id whose captured best shot is the CURRENT one (absent =
   * the survivor's own). Set by an adoption the absorbed piece won; cleared by
   * the survivor's own next new best. Only that id's late best-shot media
   * (keyFrame landed / media id / thumbnail landed) is applied to the
   * survivor — a landing of the LOSING shot must never say "landed" (H4).
   */
  private readonly bestShotHolder = new Map<string, string>()
  /** Absorbed id → survivor id, for survivors that already closed (bounded). */
  private readonly retired = new Map<string, string>()
  /** Ids closed by `close` (bounded FIFO). Only `open` — a birth — clears one. */
  private readonly closedIds = new Set<string>()
  /** Per device: start of the current late-work sample window, and how many
   *  refusals it has swallowed since the last sampled call. */
  private readonly lateWorkSample = new Map<number, { at: number; refused: number }>()

  constructor(private readonly hooks: TrackResidentStateHooks = {}) {}

  /** The id that OWNS `trackId`'s state now: its survivor when it was absorbed. */
  private canonical(trackId: string): string {
    return this.aliases.get(trackId) ?? trackId
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Idempotently create the track's resident record (deviceId travels with
   *  it so device teardown can enumerate its tracks). */
  open(deviceId: number, trackId: string): void {
    this.closedIds.delete(trackId)
    this.ensure(deviceId, trackId, 'general', 'open')
  }

  /** True while the track owns a live resident (its survivor's, when absorbed).
   *  Async completions check this before doing work for a track. */
  isLive(trackId: string): boolean {
    return this.residents.has(this.canonical(trackId))
  }

  /**
   * Get-or-create the resident record (every mutator routes through this so
   * the deviceId index can never be missing for a written track).
   *
   * D683 review M1: an absorbed id is routed to its survivor — and a
   * `bestShot` write only when the absorbed piece holds the CURRENT best shot.
   * An absorbed id whose survivor already closed is refused. `undefined` =
   * refused (sampled through `onLateAbsorbedWork`); nothing is created.
   */
  private ensure(
    deviceId: number,
    trackId: string,
    kind: ResidentWriteKind = 'general',
    write = 'ensure',
  ): TrackResident | undefined {
    const retiredInto = this.retired.get(trackId)
    if (retiredInto !== undefined) {
      this.refuseLateWork(deviceId, trackId, retiredInto, 'survivor-closed', write)
      return undefined
    }
    if (this.closedIds.has(trackId)) {
      this.refuseLateWork(deviceId, trackId, trackId, 'track-closed', write)
      return undefined
    }
    const survivorId = this.aliases.get(trackId)
    if (
      survivorId !== undefined &&
      kind === 'bestShot' &&
      (this.bestShotHolder.get(survivorId) ?? survivorId) !== trackId
    ) {
      this.refuseLateWork(deviceId, trackId, survivorId, 'losing-shot', write)
      return undefined
    }
    const id = survivorId ?? trackId
    const existing = this.residents.get(id)
    if (existing) return existing
    const created = emptyResident(deviceId)
    this.residents.set(id, created)
    return created
  }

  /** The id a frame-path call for `trackId` works on — its survivor when it
   *  was absorbed — or `undefined` (refused, sampled) once that survivor closed. */
  private liveId(deviceId: number, trackId: string): string | undefined {
    const retiredInto = this.retired.get(trackId)
    if (retiredInto === undefined) return this.canonical(trackId)
    this.refuseLateWork(deviceId, trackId, retiredInto, 'survivor-closed', 'liveId')
    return undefined
  }

  /** Count a refused late write; hand the host one sampled line per window. */
  private refuseLateWork(
    deviceId: number,
    trackId: string,
    survivorId: string,
    reason: LateAbsorbedWork['reason'],
    write: string,
  ): void {
    const now = Date.now()
    const sample = this.lateWorkSample.get(deviceId)
    if (sample !== undefined && now - sample.at < LATE_ABSORBED_WORK_SAMPLE_MS) {
      sample.refused += 1
      return
    }
    const refused = (sample?.refused ?? 0) + 1
    this.lateWorkSample.set(deviceId, { at: now, refused: 0 })
    this.hooks.onLateAbsorbedWork?.({ deviceId, trackId, survivorId, reason, refused, write })
  }

  /**
   * The ONE per-track teardown: empties EVERY container for the track, every
   * mode. Safe to call twice (no-op on an unknown track). Modes `end` /
   * `suppress` / `stationary` park the keyFrame key for the caller's deferred
   * `dropKeyFrameKey` (it stays readable while the recognizers' `onTrackEnd`
   * settles); `prune` drops it immediately.
   */
  close(trackId: string, mode: TrackCloseMode): void {
    const resident = this.residents.get(trackId)
    this.residents.delete(trackId)
    this.bestFrameTracker.delete(trackId)
    for (const selector of this.objectEmbeddingBestSelectors.values()) selector.delete(trackId)
    if (resident?.keyFrameMediaId !== undefined && mode !== 'prune') {
      this.deferredKeyFrameKeys.set(trackId, {
        deviceId: resident.deviceId,
        mediaId: resident.keyFrameMediaId,
      })
    }
    // S3: orphan the closed track's still-queued capture requests (the
    // scheduler owns in-flight state now; see module docstring).
    this.hooks.onClose?.(trackId)
    this.closedIds.add(trackId)
    while (this.closedIds.size > MAX_CLOSED_TRACK_IDS) {
      const oldest = this.closedIds.values().next().value
      if (oldest === undefined) break
      this.closedIds.delete(oldest)
    }
    // D683 review H4: the survivor's close is the ONLY close any piece it
    // absorbed ever gets — adopt() itself never closes anything, so this is
    // where their queued captures + parked parcels finally leave.
    const absorbed = this.absorbedBy.get(trackId)
    this.bestShotHolder.delete(trackId)
    if (absorbed !== undefined) {
      this.absorbedBy.delete(trackId)
      for (const absorbedId of absorbed) {
        this.hooks.onClose?.(absorbedId)
        // M1: from here on, late work under the absorbed id is refused —
        // its survivor is gone, and a fresh resident would never close.
        this.aliases.delete(absorbedId)
        this.retired.set(absorbedId, trackId)
      }
      while (this.retired.size > MAX_RETIRED_ABSORBED_IDS) {
        const oldest = this.retired.keys().next().value
        if (oldest === undefined) break
        this.retired.delete(oldest)
      }
    }
  }

  /**
   * D683 §6.2: fold the absorbed piece's containers into the survivor's, by
   * {@link RESIDENT_MERGE_RULES}. Closes NOTHING (review H4): the absorbed
   * piece's queued captures and parked parcels are still wanted — they are
   * released when the survivor closes (see {@link close}'s fan-out).
   */
  adopt(survivorIdIn: string, absorbedIdIn: string): AdoptOutcome {
    // A chained fusion may name a piece by an id it was already absorbed under.
    const survivorId = this.canonical(survivorIdIn)
    const absorbedId = this.canonical(absorbedIdIn)
    const a = this.residents.get(survivorId)
    const b = this.residents.get(absorbedId)
    const bestShotFrom = this.bestFrameTracker.adopt(survivorId, absorbedId)
    for (const selector of this.objectEmbeddingBestSelectors.values())
      selector.adopt(survivorId, absorbedId)
    // Whose CAPTURED shot is current now: the absorbed piece's own holder when
    // it won (itself, or a piece IT had absorbed), else the survivor's.
    const holder =
      bestShotFrom === 'absorbed'
        ? (this.bestShotHolder.get(absorbedId) ?? absorbedId)
        : (this.bestShotHolder.get(survivorId) ?? survivorId)
    if (holder === survivorId) this.bestShotHolder.delete(survivorId)
    else this.bestShotHolder.set(survivorId, holder)
    this.bestShotHolder.delete(absorbedId)
    const chained = this.absorbedBy.get(absorbedId) ?? []
    this.absorbedBy.set(survivorId, [
      ...(this.absorbedBy.get(survivorId) ?? []),
      absorbedId,
      ...chained,
    ])
    this.absorbedBy.delete(absorbedId)
    for (const id of [absorbedId, ...chained]) this.aliases.set(id, survivorId)
    if (a !== undefined || b !== undefined) {
      const deviceId = a?.deviceId ?? b?.deviceId ?? 0
      this.residents.set(
        survivorId,
        mergeResidents(a ?? emptyResident(deviceId), b ?? emptyResident(deviceId), {
          bestShotFrom,
        }),
      )
      this.residents.delete(absorbedId)
    }
    this.hooks.onAdopt?.(survivorId, absorbedId, bestShotFrom)
    return { bestShotFrom }
  }

  /** Close EVERY resident track of a device (returns the closed trackIds) and
   *  purge any of its keyFrame keys still parked for a deferred drop. */
  closeDevice(deviceId: number): string[] {
    const closed = this.trackIdsForDevice(deviceId)
    for (const trackId of closed) this.close(trackId, 'prune')
    for (const [trackId, deferred] of this.deferredKeyFrameKeys) {
      if (deferred.deviceId === deviceId) this.deferredKeyFrameKeys.delete(trackId)
    }
    return closed
  }

  /** Drop everything (addon dispose). */
  clearAll(): void {
    this.residents.clear()
    this.bestFrameTracker.clear()
    this.objectEmbeddingBestSelectors.clear()
    this.deferredKeyFrameKeys.clear()
    this.absorbedBy.clear()
    this.aliases.clear()
    this.bestShotHolder.clear()
    this.retired.clear()
    this.closedIds.clear()
    this.lateWorkSample.clear()
  }

  size(): number {
    return this.residents.size
  }

  /** Residents whose last frame stamp is older than `olderThanMs` (a resident
   *  never stamped is not listed: it carries no clock to judge). The host
   *  subtracts the ids a live tracker still carries — what remains is a record
   *  nothing will ever close. */
  idleResidents(olderThanMs: number): IdleResident[] {
    const idle: IdleResident[] = []
    for (const [trackId, resident] of this.residents) {
      const at = resident.lastFrameAt
      if (at !== undefined && at < olderThanMs) {
        idle.push({ trackId, deviceId: resident.deviceId, lastFrameAt: at })
      }
    }
    return idle
  }

  trackIdsForDevice(deviceId: number): string[] {
    const ids: string[] = []
    for (const [trackId, resident] of this.residents) {
      if (resident.deviceId === deviceId) ids.push(trackId)
    }
    return ids
  }

  // ── Best frame (§5 thumbnail + keyFrame signal) ──────────────────────

  /** Record a detection for the track's best-FRAME ranking (edge-aware §5
   *  policy). Returns true when it becomes the track's new best. */
  observeBestFrame(
    deviceId: number,
    trackId: string,
    confidence: number,
    timestamp: number,
    edgeClear: boolean,
    centerScore: number,
    containment: number,
    sizeScore: number,
    squareFraction: number,
    semantic: boolean,
    canvasFill: number,
  ): boolean {
    const id = this.liveId(deviceId, trackId)
    if (id === undefined) return false
    // Only the real birth (`open`) may clear a tombstone: a retracted id the
    // tracker still carries must be refused here, not re-created.
    if (this.ensure(deviceId, id, 'bestShot', 'observeBestFrame') === undefined) return false
    const isNewBest = this.bestFrameTracker.observe(
      id,
      confidence,
      timestamp,
      edgeClear,
      centerScore,
      containment,
      sizeScore,
      squareFraction,
      semantic,
      canvasFill,
    )
    // The survivor's OWN new best supersedes whatever shot an adoption handed
    // it: a late landing of the absorbed piece's capture is no longer current.
    if (isNewBest) this.bestShotHolder.delete(id)
    return isNewBest
  }

  /** D400: frame instant of the track's last logged promotion REFUSAL
   *  (undefined = none yet). */
  bestShotRefusalLoggedAt(trackId: string): number | undefined {
    return this.residents.get(this.canonical(trackId))?.bestShotRefusalLoggedAt
  }

  /** Stamp the track's last promotion-refusal log instant. */
  noteBestShotRefusalLogged(deviceId: number, trackId: string, timestamp: number): void {
    const resident = this.ensure(deviceId, trackId)
    if (resident !== undefined) resident.bestShotRefusalLoggedAt = timestamp
  }

  /** The FULL held best-frame candidate (everything the ranking saw). Read
   *  BEFORE `observeBestFrame` to log a promotion attempt against the peak it
   *  competed with (D400). */
  bestFrameHeld(trackId: string): BestFrameCandidate | undefined {
    return this.bestFrameTracker.heldCandidate(this.canonical(trackId))
  }

  /** Which term decided the LAST best-frame comparison for the track (D400).
   *  Undefined on a first sighting. */
  bestFrameLastComparison(trackId: string): BestFrameComparison | undefined {
    return this.bestFrameTracker.lastComparisonFor(this.canonical(trackId))
  }

  /**
   * D683 Task 18: the id whose CAPTURED best shot is current for this
   * survivor — a piece it absorbed whose shot won (or one that piece had
   * absorbed), else the survivor itself. Read by the fusion sweep-up at close
   * to rank every single-instance media kind by the shot that is current NOW.
   */
  currentBestShotHolder(survivorId: string): string {
    const id = this.canonical(survivorId)
    return this.bestShotHolder.get(id) ?? id
  }

  /** The held best-frame peak for a track (undefined if never observed). */
  bestFramePeak(trackId: string): BestDetection | undefined {
    return this.bestFrameTracker.peak(this.canonical(trackId))
  }

  /** Stamp the HELD best-frame peak as SEMANTIC (attribution-time re-score for
   *  a recognition whose source frame IS the held peak — see
   *  `semantic-promotion.ts`). False = no peak held (no-op). */
  markBestFrameSemantic(trackId: string): boolean {
    return this.bestFrameTracker.markSemantic(this.canonical(trackId))
  }

  /** #27-A: record the track's best-seen subject bbox. Called by the frame
   *  loop on every ACCEPTED (new-best AND plausible-box) observe, so the value
   *  always mirrors the frame the latest keyFrame re-shot was seeded from. */
  recordBestSeenBbox(deviceId: number, trackId: string, bbox: BestSeenBbox): void {
    const resident = this.ensure(deviceId, trackId)
    if (resident !== undefined) resident.bestBbox = bbox
  }

  /** The track's best-seen subject bbox (undefined until a plausible new-best
   *  was observed). Backs the retry gate + the close-time keyFrame crop. */
  bestSeenBbox(trackId: string): BestSeenBbox | undefined {
    return this.residents.get(this.canonical(trackId))?.bestBbox
  }

  // ── Best CLIP-object embedding ───────────────────────────────────────

  /** Record a CLIP-object observation for the track's best-EMBEDDING ranking
   *  IN ITS MODEL'S SPACE (confidence-only policy). Returns true on a new best. */
  observeObjectEmbeddingBest(deviceId: number, observed: TrackBestObservation): boolean {
    const id = this.liveId(deviceId, observed.trackId)
    if (id === undefined) return false
    const obs = id === observed.trackId ? observed : { ...observed, trackId: id }
    // An embedding result can settle after the track closed: never reopen it.
    if (this.ensure(deviceId, id, 'general', 'observeObjectEmbeddingBest') === undefined) {
      return false
    }
    const modelId = obs.embeddingModelId ?? ''
    let selector = this.objectEmbeddingBestSelectors.get(modelId)
    if (selector === undefined) {
      selector = new TrackBestSelector(BEST_OBJECT_EMBED_POLICY)
      this.objectEmbeddingBestSelectors.set(modelId, selector)
    }
    return selector.observe(obs)
  }

  // ── Shared native keyFrame media id (Design B) ───────────────────────

  /** The track's shared native keyFrame media ROW id (D482) — served for LIVE
   *  tracks and for closed tracks whose deferred drop has not settled yet.
   *  `undefined` means no key frame was captured; never `0`, which would name
   *  a row that cannot exist. */
  keyFrameMediaId(trackId: string): number | undefined {
    return (
      this.residents.get(this.canonical(trackId))?.keyFrameMediaId ??
      this.deferredKeyFrameKeys.get(trackId)?.mediaId
    )
  }

  setKeyFrameMediaId(deviceId: number, trackId: string, mediaId: number): void {
    const resident = this.ensure(deviceId, trackId, 'bestShot', 'setKeyFrameMediaId')
    if (resident !== undefined) resident.keyFrameMediaId = mediaId
  }

  /** Settle the keyFrame-id drop (called once the face recognizer's
   *  `onTrackEnd` promise settles — or immediately when there is none). Handles
   *  both orders: id still live (recognizer settled before `close`) or already
   *  parked in the deferred area. */
  dropKeyFrameMediaId(trackId: string): void {
    // Raw id, never routed: this settles the CLOSED track's own key.
    const resident = this.residents.get(trackId)
    if (resident) resident.keyFrameMediaId = undefined
    this.deferredKeyFrameKeys.delete(trackId)
  }

  // ── Rolling lastFrame clock (DEFECT B) ───────────────────────────────

  lastFrameAt(trackId: string): number | undefined {
    return this.residents.get(this.canonical(trackId))?.lastFrameAt
  }

  setLastFrameAt(deviceId: number, trackId: string, atMs: number): void {
    const resident = this.ensure(deviceId, trackId, 'general', 'setLastFrameAt')
    if (resident !== undefined) resident.lastFrameAt = atMs
  }

  // ── firstFrame pending (DEFECT A) ────────────────────────────────────

  anyFirstFramePending(): boolean {
    for (const resident of this.residents.values()) {
      if (resident.firstFramePending) return true
    }
    return false
  }

  isFirstFramePending(trackId: string): boolean {
    return this.residents.get(this.canonical(trackId))?.firstFramePending ?? false
  }

  markFirstFramePending(deviceId: number, trackId: string): void {
    const resident = this.ensure(deviceId, trackId)
    if (resident !== undefined) resident.firstFramePending = true
  }

  clearFirstFramePending(trackId: string): void {
    const resident = this.residents.get(this.canonical(trackId))
    if (resident) resident.firstFramePending = false
  }

  /** A `firstFrame` write landed for this track (see {@link TrackResident.firstFrameLanded}). */
  markFirstFrameLanded(deviceId: number, trackId: string): void {
    const resident = this.ensure(deviceId, trackId, 'general', 'markFirstFrameLanded')
    if (resident !== undefined) resident.firstFrameLanded = true
  }

  isFirstFrameLanded(trackId: string): boolean {
    return this.residents.get(this.canonical(trackId))?.firstFrameLanded ?? false
  }

  // ── Best thumbnail landed (#27-A) ────────────────────────────────────

  isThumbnailLanded(trackId: string): boolean {
    return this.residents.get(this.canonical(trackId))?.thumbnailLanded ?? false
  }

  markThumbnailLanded(deviceId: number, trackId: string): void {
    const resident = this.ensure(deviceId, trackId, 'bestShot', 'markThumbnailLanded')
    if (resident !== undefined) resident.thumbnailLanded = true
  }

  // ── Preview capture-miss note (D276/B2) ──────────────────────────────

  /**
   * Note a preview-capture failure (`<kind>:<cause>`, e.g. `keyframe:native-miss`,
   * `thumbnail:overflow`). Deliberately NON-creating (`get`, never `ensure`):
   * the failure paths keep firing from queued execs AFTER a track closes, and
   * resurrecting a closed record here would leak it forever. The last reason
   * wins (it is the one the close will report); the count accumulates across
   * reasons so the persisted line says how starved the track was overall.
   */
  notePreviewCaptureMiss(deviceId: number, trackId: string, reason: string): void {
    const resident = this.residents.get(this.canonical(trackId))
    if (resident === undefined || resident.deviceId !== deviceId) return
    const held = resident.previewCaptureMiss
    resident.previewCaptureMiss = { reason, count: (held?.count ?? 0) + 1 }
  }

  /** The track's accumulated capture-miss note (undefined = no failure seen). */
  previewCaptureMiss(trackId: string): PreviewCaptureMiss | undefined {
    return this.residents.get(this.canonical(trackId))?.previewCaptureMiss
  }

  // ── keyFrame capture bookkeeping (bounded retry, 2026-08-06) ─────────

  /** The track's key-frame history, in the shape `decideKeyFrameCapture` reads.
   *  An unknown track answers "never attempted", which is what makes the first
   *  retry fire for a track whose only new-best frame had an implausible box. */
  keyFrameCapture(trackId: string): KeyFrameCaptureState {
    const resident = this.residents.get(this.canonical(trackId))
    if (resident === undefined) return { landed: false, retries: 0, lastAttemptAt: undefined }
    return {
      landed: resident.keyFrameLanded,
      retries: resident.keyFrameRetries,
      lastAttemptAt: resident.keyFrameLastAttemptAt,
    }
  }

  /**
   * Record that a key-frame capture EXEC actually started.
   *
   * Called from inside the scheduler exec, never at target-build time: a
   * re-fire that coalesces onto an in-flight capture runs no exec and must not
   * spend one of the track's three retries.
   */
  noteKeyFrameAttempt(deviceId: number, trackId: string, atMs: number, retry: boolean): void {
    // The retry budget belongs to the shot being retried: a late attempt of
    // the shot that LOST the fusion spends nothing of the survivor's (H4).
    const resident = this.ensure(deviceId, trackId, 'bestShot', 'noteKeyFrameAttempt')
    if (resident === undefined) return
    resident.keyFrameLastAttemptAt = atMs
    if (retry) resident.keyFrameRetries += 1
  }

  /** A `keyFrame` write landed — sticky, and the end of the retry path. */
  markKeyFrameLanded(deviceId: number, trackId: string): void {
    const resident = this.ensure(deviceId, trackId, 'bestShot', 'markKeyFrameLanded')
    if (resident !== undefined) resident.keyFrameLanded = true
  }

  // ── Lifecycle update-gate memory ─────────────────────────────────────

  lifecycleUpdateMem(trackId: string): TrackLifecycleUpdateMemory | undefined {
    return this.residents.get(this.canonical(trackId))?.lifecycleUpdateMem
  }

  setLifecycleUpdateMem(
    deviceId: number,
    trackId: string,
    memory: TrackLifecycleUpdateMemory,
  ): void {
    const resident = this.ensure(deviceId, trackId)
    if (resident !== undefined) resident.lifecycleUpdateMem = memory
  }

  // ── Close-policy state (zero-media policy) ───────────────────────────

  /** Read-only close-policy view — undefined until the track ever recorded a
   *  confirmation or raster fallback (mirrors the legacy lazily-created map). */
  closure(trackId: string): TrackClosureView | undefined {
    const resident = this.residents.get(this.canonical(trackId))
    if (!resident) return undefined
    if (!resident.confirmed && resident.rasterFallback === undefined) return undefined
    return {
      confirmed: resident.confirmed,
      ...(resident.rasterFallback !== undefined ? { rasterFallback: resident.rasterFallback } : {}),
    }
  }

  /** Sticky-mark a track as confirmed once it reaches the tracker's hit gate. */
  markConfirmed(deviceId: number, trackId: string): void {
    const resident = this.ensure(deviceId, trackId)
    if (resident !== undefined) resident.confirmed = true
  }

  /**
   * Is this track the one the operator is asking about?
   *
   * THE gate for every debug crop, and it must stay this cheap: one map lookup,
   * no store read, no allocation. An unknown track is not marked — a lookup
   * that finds nothing is the common case on every camera in the fleet.
   */
  isDebugMarked(trackId: string): boolean {
    return this.residents.get(this.canonical(trackId))?.debugMarked ?? false
  }

  /**
   * Record the operator's `debug` flag for a LIVE track.
   *
   * Called from the `setTrackFlags` cap mutation, which is the only thing that
   * can turn the flag on — so this runs once per press, not per frame.
   * `ensure` rather than a lookup: the button can be pressed on a track whose
   * first frame is still in flight, and a mark that silently missed would be
   * the operator clicking and getting nothing, which is the whole complaint.
   */
  setDebugMarked(deviceId: number, trackId: string, marked: boolean): void {
    const resident = this.ensure(deviceId, trackId)
    if (resident === undefined || resident.debugMarked === marked) return
    resident.debugMarked = marked
  }

  /** Retain the FIRST detection-raster crop per track (zero-media fallback);
   *  a later frame never overwrites an existing one. */
  retainRasterFallback(deviceId: number, trackId: string, fallback: RetainedRasterFallback): void {
    const resident = this.ensure(deviceId, trackId, 'general', 'retainRasterFallback')
    if (resident !== undefined && resident.rasterFallback === undefined)
      resident.rasterFallback = fallback
  }
}
