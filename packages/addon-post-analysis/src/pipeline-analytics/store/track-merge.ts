/**
 * How two ACTIVE rows of one subject become one (D683 §6.2 step 3).
 *
 * One function per field of `MutableTrackState`; `mergeActiveTracks` runs
 * every one of them and nothing else, so the table and the behaviour cannot
 * diverge (review M7). `a` is the survivor (earliest piece), `b` the absorbed
 * piece (it started later: it is the live continuation).
 */
import {
  downsampleTrail,
  type MutableAudioLabelAgg,
  type MutableTrackState,
} from './track-store.js'
import {
  type LabelCandidate,
  resolveTieredLabelWrite,
  type TieredLabelState,
} from '../pipeline/label-tier.js'
import { type MovedProbe, probeMoved } from '../pipeline/stationary/promotion-plan.js'

export interface TrackMergeContext {
  readonly maxPositionHistory: number
}

export type TrackMergeFn<K extends keyof MutableTrackState> = (
  a: MutableTrackState,
  b: MutableTrackState,
  ctx: TrackMergeContext,
) => MutableTrackState[K]

const survivor =
  <K extends keyof MutableTrackState>(k: K): TrackMergeFn<K> =>
  (a) =>
    a[k]
const laterIfSet =
  <K extends keyof MutableTrackState>(k: K): TrackMergeFn<K> =>
  (a, b) =>
    b[k] ?? a[k]
const either =
  <K extends 'debug' | 'favourited' | 'benchPinned' | 'hasFace' | 'hasEmbeddedFace' | 'hasRider'>(
    k: K,
  ): TrackMergeFn<K> =>
  (a, b) =>
    a[k] === true || b[k] === true ? true : (a[k] ?? b[k])
/** The piece whose importance is higher (ties: the survivor) supplies the fields that describe it. */
const moreImportant = (a: MutableTrackState, b: MutableTrackState): MutableTrackState =>
  (b.importance ?? -Infinity) > (a.importance ?? -Infinity) ? b : a
const byTime = <T extends { readonly timestamp: number }>(x: readonly T[], y: readonly T[]): T[] =>
  [...x, ...y].sort((p, q) => p.timestamp - q.timestamp)

/**
 * `a`'s tiers, with `b`'s label candidate (then its sub-label candidate)
 * OFFERED to the one write rule (`resolveTieredLabelWrite`) — the same rule
 * every other writer goes through. A candidate that loses (lower score, no
 * declared tier, equals the class) is simply refused, exactly as it would be
 * from any other caller; a higher tier is structurally never touched by a
 * lower one, because the two live in different columns.
 */
function mergedLabelTiers(a: MutableTrackState, b: MutableTrackState): TieredLabelState {
  let state: TieredLabelState = {
    className: a.className,
    label: a.label,
    labelScore: a.labelScore,
    labelMeta: a.labelMeta,
    subLabel: a.subLabel,
    subLabelScore: a.subLabelScore,
    subLabelMeta: a.subLabelMeta,
  }
  if (b.label !== undefined && b.labelMeta !== undefined) {
    const candidate: LabelCandidate = {
      text: b.label,
      tier: 1,
      score: b.labelScore ?? 0,
      stepId: b.labelMeta.stepId,
      decidedAt: b.labelMeta.decidedAt,
      ...(b.labelMeta.modelId !== undefined ? { modelId: b.labelMeta.modelId } : {}),
      ...(b.labelMeta.identityId !== undefined ? { identityId: b.labelMeta.identityId } : {}),
    }
    const decision = resolveTieredLabelWrite(state, candidate)
    if (decision.kind === 'write') state = { ...state, ...decision.patch }
  }
  if (b.subLabel !== undefined && b.subLabelMeta !== undefined) {
    const candidate: LabelCandidate = {
      text: b.subLabel,
      tier: 2,
      score: b.subLabelScore ?? 0,
      stepId: b.subLabelMeta.stepId,
      decidedAt: b.subLabelMeta.decidedAt,
      ...(b.subLabelMeta.modelId !== undefined ? { modelId: b.subLabelMeta.modelId } : {}),
      ...(b.subLabelMeta.identityId !== undefined ? { identityId: b.subLabelMeta.identityId } : {}),
    }
    const decision = resolveTieredLabelWrite(state, candidate)
    if (decision.kind === 'write') state = { ...state, ...decision.patch }
  }
  return state
}

/** Fold two per-label audio aggregates: count summed, peak maxed, span
 *  widened. `undefined` only when BOTH sides are. */
function mergedAudioLabels(
  x: MutableTrackState['audioLabels'],
  y: MutableTrackState['audioLabels'],
): MutableTrackState['audioLabels'] {
  if (x === undefined && y === undefined) return undefined
  const out = new Map<string, MutableAudioLabelAgg>()
  for (const [label, agg] of x ?? []) out.set(label, { ...agg })
  for (const [label, agg] of y ?? []) {
    const existing = out.get(label)
    out.set(
      label,
      existing === undefined
        ? { ...agg }
        : {
            count: existing.count + agg.count,
            peakScore: Math.max(existing.peakScore, agg.peakScore),
            firstAt: Math.min(existing.firstAt, agg.firstAt),
            lastAt: Math.max(existing.lastAt, agg.lastAt),
          },
    )
  }
  return out
}

/**
 * "Has this track moved?", folded from two probes (D683 round 4, Task 14):
 * the moved verdict WINS — if either piece ever moved, the merged subject is a
 * moving one and a later promotion must never park it. When neither has moved
 * yet, the live continuation's own probe carries forward (it holds the more
 * recent reference/run state to keep judging future boxes against).
 */
function mergedMovedProbe(a: MutableTrackState, b: MutableTrackState): MovedProbe {
  if (probeMoved(a.movedProbe))
    return a.movedProbe.moved ? a.movedProbe : { ...a.movedProbe, moved: true }
  if (probeMoved(b.movedProbe))
    return b.movedProbe.moved ? b.movedProbe : { ...b.movedProbe, moved: true }
  return b.movedProbe
}

/**
 * The ground the subject covered UNSEEN between the two pieces (T16 L5, D683
 * Task 18): from the survivor's last position to the absorbed piece's first.
 * L2 links a piece that started after the other ended — the gap is the very
 * reason there are two pieces, and summing their own distances alone reads a
 * walk across the frame as standing still. Pieces that overlap in time have
 * no gap (0). Same Euclidean step `TrackStore.upsert` accumulates.
 */
function gapDistance(a: MutableTrackState, b: MutableTrackState): number {
  const last = a.positions.at(-1)
  const first = b.positions[0]
  if (last === undefined || first === undefined || first.timestamp < last.timestamp) return 0
  return Math.sqrt((first.x - last.x) ** 2 + (first.y - last.y) ** 2)
}

/**
 * WHERE a fused track was detected (D683 L2 fusion): it OPENED where its
 * earliest-born piece opened and CLOSED where its latest-seen piece was last
 * sighted — the same span `firstSeen` / `lastSeen` take, decided by the times
 * rather than by which piece survived (an absorbed piece can overlap and end
 * first). The placements of the pieces in between are not kept: the row
 * answers "where did this subject start and end", and a hop in the middle is
 * the `inference device selection` log's to tell. A piece with no placement
 * never erases the other's.
 */
const earlierOpened: TrackMergeFn<'openedPlacement'> = (a, b) =>
  b.firstSeen < a.firstSeen
    ? (b.openedPlacement ?? a.openedPlacement)
    : (a.openedPlacement ?? b.openedPlacement)
const laterClosed: TrackMergeFn<'closedPlacement'> = (a, b) =>
  b.lastSeen >= a.lastSeen
    ? (b.closedPlacement ?? a.closedPlacement)
    : (a.closedPlacement ?? b.closedPlacement)

export const TRACK_MERGE_RULES: { readonly [K in keyof MutableTrackState]-?: TrackMergeFn<K> } = {
  trackId: survivor('trackId'),
  deviceId: survivor('deviceId'),
  className: survivor('className'),
  label: (a, b) => mergedLabelTiers(a, b).label,
  labelScore: (a, b) => mergedLabelTiers(a, b).labelScore,
  labelMeta: (a, b) => mergedLabelTiers(a, b).labelMeta,
  subLabel: (a, b) => mergedLabelTiers(a, b).subLabel,
  subLabelScore: (a, b) => mergedLabelTiers(a, b).subLabelScore,
  subLabelMeta: (a, b) => mergedLabelTiers(a, b).subLabelMeta,
  firstSeen: (a, b) => Math.min(a.firstSeen, b.firstSeen),
  lastSeen: (a, b) => Math.max(a.lastSeen, b.lastSeen),
  positions: (a, b, ctx) =>
    downsampleTrail(byTime(a.positions, b.positions), ctx.maxPositionHistory),
  snapshots: (a, b) => byTime(a.snapshots, b.snapshots),
  zonesVisited: (a, b) => [...new Set([...a.zonesVisited, ...b.zonesVisited])],
  classes: (a, b) => [...new Set([...a.classes, ...b.classes])],
  totalDistance: (a, b) => a.totalDistance + b.totalDistance + gapDistance(a, b),
  state: (_a, b) => b.state,
  active: survivor('active'),
  lastSnapshotAt: (a, b) => Math.max(a.lastSnapshotAt, b.lastSnapshotAt),
  lastSnapshotBbox: laterIfSet('lastSnapshotBbox'),
  snapshotPending: laterIfSet('snapshotPending'),
  snapshotRollbacks: (a, b) =>
    a.snapshotRollbacks === undefined && b.snapshotRollbacks === undefined
      ? undefined
      : (a.snapshotRollbacks ?? 0) + (b.snapshotRollbacks ?? 0),
  importance: (a, b) => moreImportant(a, b).importance,
  bestEventId: (a, b) => moreImportant(a, b).bestEventId,
  importanceReason: (a, b) => moreImportant(a, b).importanceReason,
  audioLabels: (a, b) => mergedAudioLabels(a.audioLabels, b.audioLabels),
  retrainStatus: survivor('retrainStatus'),
  debug: either('debug'),
  debugNote: (a, b) => {
    const notes = [
      ...new Set(
        [a.debugNote, b.debugNote].filter((n): n is string => n !== undefined && n !== ''),
      ),
    ]
    return notes.length === 0 ? undefined : notes.join(' · ')
  },
  favourited: either('favourited'),
  benchPinned: either('benchPinned'),
  hasFace: either('hasFace'),
  hasEmbeddedFace: either('hasEmbeddedFace'),
  hasRider: either('hasRider'),
  closedReason: survivor('closedReason'),
  provenance: survivor('provenance'),
  openedPlacement: earlierOpened,
  closedPlacement: laterClosed,
  movedProbe: mergedMovedProbe,
  keptAtPromotion: (a, b) =>
    a.keptAtPromotion === true || b.keptAtPromotion === true ? true : undefined,
}

/** Every key, checked at compile time against `MutableTrackState`. */
export const TRACK_MERGE_KEYS = [
  'trackId',
  'deviceId',
  'className',
  'label',
  'labelScore',
  'labelMeta',
  'subLabel',
  'subLabelScore',
  'subLabelMeta',
  'firstSeen',
  'lastSeen',
  'positions',
  'snapshots',
  'zonesVisited',
  'classes',
  'totalDistance',
  'state',
  'active',
  'lastSnapshotAt',
  'lastSnapshotBbox',
  'snapshotPending',
  'snapshotRollbacks',
  'importance',
  'bestEventId',
  'importanceReason',
  'audioLabels',
  'retrainStatus',
  'debug',
  'debugNote',
  'favourited',
  'benchPinned',
  'hasFace',
  'hasEmbeddedFace',
  'hasRider',
  'closedReason',
  'provenance',
  'openedPlacement',
  'closedPlacement',
  'movedProbe',
  'keptAtPromotion',
] as const satisfies readonly (keyof MutableTrackState)[]
type MissingMergeKey = Exclude<keyof MutableTrackState, (typeof TRACK_MERGE_KEYS)[number]>
const allKeysListed: [MissingMergeKey] extends [never] ? true : false = true
void allKeysListed

function setField<K extends keyof MutableTrackState>(
  row: MutableTrackState,
  k: K,
  v: MutableTrackState[K],
): void {
  row[k] = v
}

/** A NEW row: every rule, run once. */
export function mergeActiveTracks(
  a: MutableTrackState,
  b: MutableTrackState,
  ctx: TrackMergeContext,
): MutableTrackState {
  const out: MutableTrackState = { ...a }
  for (const k of TRACK_MERGE_KEYS) setField(out, k, TRACK_MERGE_RULES[k](a, b, ctx))
  return out
}
