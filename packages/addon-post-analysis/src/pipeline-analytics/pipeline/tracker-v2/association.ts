/**
 * L1 association (D683 §3.2): one cost, one assignment, audited by three
 * doubt tests. Pure: indices in, indices out.
 *
 *  - swap: two assigned pairs whose crossed pairing is nearly as cheap — a
 *    forbidden crossed edge priced at the gate ceiling `1 − iouThreshold`, or
 *    at that tracklet's cheapest unassigned box when lower (the free-box
 *    price);
 *  - rival: an unassigned box nearly as good for an assigned tracklet (a box
 *    overlapping the chosen one at ≥ dedupSpawnIou is a double fire instead,
 *    refused at spawn — review M1);
 *  - competitor: an unassigned tracklet nearly as good for an assigned box.
 *
 * The one-sided crossing (fix round 1 H1, fix round 2 M-A). The solver prices
 * a forbidden edge as a large finite cost, so it maximises the match count
 * before the cost: it will move a tracklet off the box it sits on to give a
 * second tracklet a box. When that second tracklet cannot reach the first
 * one's box the swap test used to have nothing to sum, and the move was
 * silent. It now sums it, pricing the forbidden edge at the gate ceiling
 * `1 − iouThreshold` — the most any gated edge can cost — or at that
 * tracklet's cheapest UNASSIGNED box when that is lower (fix round 3, M-D: the
 * tracklet is not stranded, it has somewhere to go). More reach can only lower
 * the price, so a doubt is never removed by it (monotonic); a negative sum is
 * doubt too.
 *
 * A coasting re-bind uses the normal gate on the last box, plus D678's size
 * bar (review M12). There is no identity gate here: a detection carries no
 * name (the runner's face label is `embedding:512d`); identity is a per-track
 * verdict and is L2's question.
 */
import type { AppearanceDescriptor, BoundingBox } from '@camstack/types'
import { type AppearanceAggregate, distanceToAggregate } from './appearance.js'
import { type AssignedPair, FORBIDDEN, minCostAssignment } from './assignment.js'
import {
  APPEARANCE_COST_WEIGHT,
  APPEARANCE_SEPARATES,
  COAST_MAX_AREA_RATIO,
  RIVAL_MARGIN,
  SWAP_MARGIN,
} from './constants.js'
import { areaRatio, iou } from './geometry.js'
import type { TrackerV2Config, TrackletMode } from './types.js'

export interface AssocTracklet {
  readonly id: string
  readonly klass: string
  readonly mode: TrackletMode
  readonly confirmed: boolean
  /** Still in the doubt of the split it was born in (Task 3, `Tracklet.inDoubt`). */
  readonly inDoubt: boolean
  readonly cohort: string | null
  readonly lastBox: BoundingBox
  readonly predicted: BoundingBox
  readonly appearance: AppearanceAggregate | null
}

export interface AssocDetection {
  readonly klass: string
  readonly score: number
  readonly bbox: BoundingBox
  readonly nativeRecovery: boolean
  readonly continuationOnly: boolean
  readonly appearance?: AppearanceDescriptor
}

export type AssocConfig = Pick<
  TrackerV2Config,
  | 'iouThreshold'
  | 'classGating'
  | 'classGroupAssoc'
  | 'animalOverPersonMaxScore'
  | 'dedupSpawnIou'
  | 'appearanceResolvesAmbiguity'
>

export interface AssocPair {
  readonly tracklet: number
  readonly detection: number
  readonly geometric: number
  readonly contested: boolean
}

export type AmbiguityTest = 'swap' | 'rival' | 'competitor'

export interface AmbiguousGroup {
  readonly tracklets: readonly number[]
  readonly detections: readonly number[]
  readonly tests: readonly AmbiguityTest[]
}

export interface DoubleFire {
  readonly detection: number
  readonly tracklet: number
  /** The box `detection` duplicates (the tracklet's chosen one): if the tracklet
   *  is split this frame, whoever took `chosen` is what the fire is refused against. */
  readonly chosen: number
}

interface DoubleFireDraft {
  readonly row: number
  readonly col: number
}

export interface Association {
  readonly pairs: readonly AssocPair[]
  readonly ambiguous: readonly AmbiguousGroup[]
  readonly doubleFires: readonly DoubleFire[]
}

type ClassRelation = 'same' | 'flip' | 'none'

function classRelation(t: AssocTracklet, d: AssocDetection, cfg: AssocConfig): ClassRelation {
  if (!cfg.classGating || t.klass === d.klass) return 'same'
  const personAnimal =
    (t.klass === 'person' && d.klass === 'animal') || (t.klass === 'animal' && d.klass === 'person')
  if (
    cfg.classGroupAssoc &&
    personAnimal &&
    d.score < cfg.animalOverPersonMaxScore &&
    !d.nativeRecovery
  )
    return 'flip'
  return 'none'
}

/** `1 − IoU` on the gate that applies, or `FORBIDDEN`. */
export function geometricCost(t: AssocTracklet, d: AssocDetection, cfg: AssocConfig): number {
  const rel = classRelation(t, d, cfg)
  if (rel === 'none') return FORBIDDEN
  const onPrediction = iou(t.predicted, d.bbox)
  if (d.continuationOnly || rel === 'flip') {
    if (d.continuationOnly && !t.confirmed) return FORBIDDEN
    return onPrediction >= cfg.iouThreshold ? 1 - onPrediction : FORBIDDEN
  }
  if (t.mode === 'active') {
    const best = Math.max(onPrediction, iou(t.lastBox, d.bbox))
    return best >= cfg.iouThreshold ? 1 - best : FORBIDDEN
  }
  // Coasting: the NORMAL overlap against the LAST BOX only (review 2 M3 — the
  // prediction runs up to 1 s ahead at the last velocity and reaches a
  // different subject in front of the tracklet), and only for a box of the
  // subject's size (review M12). No rescue overlap (fix round 1, M1): a 0.1
  // gate bound the next person through a door to the one who had just left,
  // and L2 never splits. A return under the gate is a new piece for L2.
  const onLast = iou(t.lastBox, d.bbox)
  if (onLast < cfg.iouThreshold) return FORBIDDEN
  if (areaRatio(t.lastBox, d.bbox) > COAST_MAX_AREA_RATIO) return FORBIDDEN
  return 1 - onLast
}

/**
 * A box that could never be a subject of its own is not a rival (fix round 1,
 * L3): a continuation-only hold never spawns (D410), and a weak animal read
 * the flip lets a person bind is that person read coarsely (D439) — spawn
 * refuses it `animal-over-person`. Doubt over either could only end a
 * tracklet and put nothing in the box's place. Once such a box is ASSIGNED to
 * another tracklet it is that tracklet's, and the swap sum still judges
 * it: the doubt is then about two tracklets, not about the box.
 */
function canRival(t: AssocTracklet, d: AssocDetection, cfg: AssocConfig): boolean {
  return !d.continuationOnly && classRelation(t, d, cfg) !== 'flip'
}

function appearanceOf(t: AssocTracklet, d: AssocDetection, cfg: AssocConfig): number | undefined {
  if (!cfg.appearanceResolvesAmbiguity || t.appearance === null || d.appearance === undefined)
    return undefined
  return distanceToAggregate(t.appearance, d.appearance)
}

class UnionFind {
  private readonly parent = new Map<number, number>()
  find(x: number): number {
    const p = this.parent.get(x)
    if (p === undefined || p === x) return x
    const r = this.find(p)
    this.parent.set(x, r)
    return r
  }
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb))
  }
}

type CostMatrix = readonly (readonly number[])[]
type AppearanceMatrix = readonly (readonly (number | undefined)[])[]

interface Costs {
  readonly geometric: CostMatrix
  readonly appearance: AppearanceMatrix
  readonly total: CostMatrix
}

function totalCost(geometric: number, appearance: number | undefined): number {
  if (!Number.isFinite(geometric)) return FORBIDDEN
  return appearance === undefined ? geometric : geometric + APPEARANCE_COST_WEIGHT * appearance
}

function buildCosts(
  tracklets: readonly AssocTracklet[],
  detections: readonly AssocDetection[],
  cfg: AssocConfig,
): Costs {
  const geometric = tracklets.map((t) => detections.map((d) => geometricCost(t, d, cfg)))
  const appearance = tracklets.map((t) => detections.map((d) => appearanceOf(t, d, cfg)))
  const total = tracklets.map((_, i) =>
    detections.map((_, j) => totalCost(geometric[i]?.[j] ?? FORBIDDEN, appearance[i]?.[j])),
  )
  return { geometric, appearance, total }
}

interface GroupDraft {
  readonly tracklets: number[]
  readonly detections: number[]
  readonly tests: Set<AmbiguityTest>
}

/** The doubt found on one frame: union-find over tracklet and detection nodes. */
class DoubtLedger {
  private readonly uf = new UnionFind()
  private readonly touched = new Map<number, Set<AmbiguityTest>>()
  readonly contestedRows = new Set<number>()
  readonly doubleFireDets = new Map<number, DoubleFireDraft>()
  constructor(private readonly trackletCount: number) {}

  mark(rows: readonly number[], cols: readonly number[], test: AmbiguityTest): void {
    const nodes = [...rows, ...cols.map((c) => this.trackletCount + c)]
    const first = nodes[0]
    if (first === undefined) return
    for (const n of nodes) {
      this.uf.union(first, n)
      this.touched.set(n, (this.touched.get(n) ?? new Set<AmbiguityTest>()).add(test))
    }
  }

  hasTracklet(row: number): boolean {
    return this.touched.has(row)
  }

  hasDetection(col: number): boolean {
    return this.touched.has(this.trackletCount + col)
  }

  groups(): AmbiguousGroup[] {
    const drafts = new Map<number, GroupDraft>()
    for (const [node, tests] of [...this.touched].sort((x, y) => x[0] - y[0])) {
      const root = this.uf.find(node)
      const draft = drafts.get(root) ?? { tracklets: [], detections: [], tests: new Set() }
      if (node < this.trackletCount) draft.tracklets.push(node)
      else draft.detections.push(node - this.trackletCount)
      for (const t of tests) draft.tests.add(t)
      drafts.set(root, draft)
    }
    return [...drafts.values()].map((d) => ({
      tracklets: d.tracklets,
      detections: d.detections,
      tests: (['swap', 'rival', 'competitor'] as const).filter((t) => d.tests.has(t)),
    }))
  }
}

interface Audit {
  readonly tracklets: readonly AssocTracklet[]
  readonly detections: readonly AssocDetection[]
  readonly cfg: AssocConfig
  readonly g: (i: number, j: number) => number
  readonly a: (i: number, j: number) => number | undefined
  /** A tracklet's cheapest gated UNASSIGNED box (FORBIDDEN if none). */
  readonly free: (i: number) => number
  readonly ledger: DoubtLedger
}

function resolvesSwap(au: Audit, p: AssignedPair, q: AssignedPair): boolean {
  const x1 = au.a(p.row, p.col)
  const x2 = au.a(q.row, q.col)
  const y1 = au.a(p.row, q.col)
  const y2 = au.a(q.row, p.col)
  if (x1 === undefined || x2 === undefined || y1 === undefined || y2 === undefined) return false
  return x1 + x2 + APPEARANCE_SEPARATES <= y1 + y2
}

/** Appearance says tracklet `r` is its chosen box `c`, not box `other`. */
function resolvesRival(au: Audit, r: number, c: number, other: number): boolean {
  const chosen = au.a(r, c)
  const alt = au.a(r, other)
  return chosen !== undefined && alt !== undefined && chosen + APPEARANCE_SEPARATES <= alt
}

/** Appearance says box `c` is its tracklet `r`'s, not tracklet `other`'s. */
function resolvesCompetitor(au: Audit, r: number, c: number, other: number): boolean {
  const chosen = au.a(r, c)
  const alt = au.a(other, c)
  return chosen !== undefined && alt !== undefined && chosen + APPEARANCE_SEPARATES <= alt
}

/**
 * Two pieces of one split that are still unconfirmed, or still in the doubt
 * they were born in, are already "either subject": they do not split again
 * (no id per frame); their frames are contested (Task 6 bounds how long that
 * withholds them).
 */
function sameCohortInDoubt(tp: AssocTracklet | undefined, tq: AssocTracklet | undefined): boolean {
  if (tp === undefined || tq === undefined || tp.cohort === null || tp.cohort !== tq.cohort)
    return false
  return (!tp.confirmed && !tq.confirmed) || (tp.inDoubt && tq.inDoubt)
}

/** Review 2 M1: a piece still in the doubt it was born in. */
function inCohortDoubt(t: AssocTracklet | undefined): boolean {
  return t !== undefined && t.cohort !== null && (!t.confirmed || t.inDoubt)
}

/** Doubt between two ASSIGNED pairs: split them, or contest a cohort. */
function settlePair(au: Audit, p: AssignedPair, q: AssignedPair, test: AmbiguityTest): void {
  if (sameCohortInDoubt(au.tracklets[p.row], au.tracklets[q.row])) {
    au.ledger.contestedRows.add(p.row)
    au.ledger.contestedRows.add(q.row)
    return
  }
  au.ledger.mark([p.row, q.row], [p.col, q.col], test)
}

/**
 * Swap test on two assigned pairs (fix round 2, M-A). A forbidden crossed
 * edge is priced at the gate ceiling `1 − iouThreshold`, or at that
 * tracklet's cheapest unassigned box when lower (fix round 3, M-D): a
 * one-sided crossing (one tracklet reaches the other's box, the reverse edge
 * is forbidden) is summed like any other, and giving a tracklet more reach can
 * only lower the sum — never remove a doubt. Both edges forbidden: nothing to
 * cross.
 */
function auditAssignedPair(au: Audit, p: AssignedPair, q: AssignedPair): void {
  const crossedP = au.g(p.row, q.col)
  const crossedQ = au.g(q.row, p.col)
  if (!Number.isFinite(crossedP) && !Number.isFinite(crossedQ)) return
  const ceiling = 1 - au.cfg.iouThreshold
  const priced = (c: number, row: number): number =>
    Number.isFinite(c) ? c : Math.min(ceiling, au.free(row))
  const crossed = priced(crossedP, p.row) + priced(crossedQ, q.row)
  if (crossed - (au.g(p.row, p.col) + au.g(q.row, q.col)) >= SWAP_MARGIN) return
  if (resolvesSwap(au, p, q)) return
  settlePair(au, p, q, 'swap')
}

/**
 * Unassigned boxes nearly as good for `p`'s tracklet. A COASTING owner wins by
 * no margin here either (task-6 re-review, Variant A — the mirror of H2 in
 * `auditCompetitors`): a newcomer standing on its stale box costs it 0 while
 * its own subject, moved on, costs more than `RIVAL_MARGIN` more, and the id
 * went to the newcomer. Any gated second box is doubt (or, at ≥ dedupSpawnIou
 * with the chosen box, a double fire, whatever the cost gap).
 */
function auditRivalBoxes(au: Audit, p: AssignedPair, assignedDets: ReadonlySet<number>): void {
  const tp = au.tracklets[p.row]
  const chosen = au.detections[p.col]
  if (tp === undefined || chosen === undefined) return
  const margin = tp.mode === 'coasting' ? Number.POSITIVE_INFINITY : RIVAL_MARGIN
  for (let j = 0; j < au.detections.length; j++) {
    const other = au.detections[j]
    if (assignedDets.has(j) || other === undefined) continue
    const rivalCost = au.g(p.row, j)
    if (!Number.isFinite(rivalCost) || rivalCost - au.g(p.row, p.col) >= margin) continue
    if (iou(chosen.bbox, other.bbox) >= au.cfg.dedupSpawnIou) {
      au.ledger.doubleFireDets.set(j, { row: p.row, col: p.col })
      continue
    }
    if (!canRival(tp, other, au.cfg) || resolvesRival(au, p.row, p.col, j)) continue
    // Review 2 M1: the H9 bound holds for every doubt test. A cohort piece
    // still in its birth doubt is contested, never re-split (a re-split would
    // restart its CONTESTED_MAX_MS clock, and the bound could be postponed).
    if (inCohortDoubt(tp)) {
      au.ledger.contestedRows.add(p.row)
      continue
    }
    au.ledger.mark([p.row], [p.col, j], 'rival')
  }
}

/**
 * Unassigned tracklets nearly as good for `p`'s box. A COASTING owner wins by
 * no margin (task-6 review H2): its cost is measured on a box that is stale by
 * however long it missed, so "clearly cheaper" is not evidence it is the
 * subject — in a double crossing with a turn-back it took the other subject's
 * box from that subject's own active tracklet, 0.16 cheaper, and two
 * confirmed ids swapped with no doubt raised. Any gated competitor is doubt.
 */
function auditCompetitors(au: Audit, p: AssignedPair, assignedRows: ReadonlySet<number>): void {
  const tp = au.tracklets[p.row]
  const margin = tp?.mode === 'coasting' ? Number.POSITIVE_INFINITY : RIVAL_MARGIN
  for (let i = 0; i < au.tracklets.length; i++) {
    if (assignedRows.has(i)) continue
    const competitorCost = au.g(i, p.col)
    if (!Number.isFinite(competitorCost) || competitorCost - au.g(p.row, p.col) >= margin) continue
    if (resolvesCompetitor(au, p.row, p.col, i)) continue
    const ti = au.tracklets[i]
    if (inCohortDoubt(tp) && inCohortDoubt(ti) && tp?.cohort === ti?.cohort) {
      au.ledger.contestedRows.add(p.row)
      continue
    }
    au.ledger.mark([p.row, i], [p.col], 'competitor')
  }
}

/** The audit: geometry, the free-box price, a fresh ledger. */
function buildAudit(
  tracklets: readonly AssocTracklet[],
  detections: readonly AssocDetection[],
  cfg: AssocConfig,
  costs: Costs,
  assignedDets: ReadonlySet<number>,
): Audit {
  const g = (i: number, j: number): number => costs.geometric[i]?.[j] ?? FORBIDDEN
  return {
    tracklets,
    detections,
    cfg,
    g,
    a: (i, j) => costs.appearance[i]?.[j],
    free: (i) =>
      detections.reduce(
        (best, _, j) => (assignedDets.has(j) ? best : Math.min(best, g(i, j))),
        FORBIDDEN,
      ),
    ledger: new DoubtLedger(tracklets.length),
  }
}

/** Every doubt test over the stage-1 assignment. */
function runAudit(au: Audit, assigned: readonly AssignedPair[]): void {
  const assignedDets = new Set(assigned.map((p) => p.col))
  const assignedRows = new Set(assigned.map((p) => p.row))
  for (const p of assigned) for (const q of assigned) if (q.row > p.row) auditAssignedPair(au, p, q)
  for (const p of assigned) {
    auditRivalBoxes(au, p, assignedDets)
    auditCompetitors(au, p, assignedRows)
  }
}

export function associate(
  tracklets: readonly AssocTracklet[],
  detections: readonly AssocDetection[],
  cfg: AssocConfig,
): Association {
  const costs = buildCosts(tracklets, detections, cfg)
  const assigned = minCostAssignment(costs.total)
  const assignedDets = new Set(assigned.map((p) => p.col))
  const au = buildAudit(tracklets, detections, cfg, costs, assignedDets)
  runAudit(au, assigned)
  const { ledger } = au
  const ambiguous = ledger.groups()
  const doubleFires = [...ledger.doubleFireDets]
    .filter(([j]) => !ledger.hasDetection(j))
    .map(([detection, { row, col }]) => ({ detection, tracklet: row, chosen: col }))
  const kept = (p: AssignedPair): boolean =>
    !ledger.hasTracklet(p.row) && !ledger.hasDetection(p.col)
  return {
    pairs: assigned.filter(kept).map((p) => ({
      tracklet: p.row,
      detection: p.col,
      geometric: au.g(p.row, p.col),
      contested: ledger.contestedRows.has(p.row),
    })),
    ambiguous,
    doubleFires,
  }
}
