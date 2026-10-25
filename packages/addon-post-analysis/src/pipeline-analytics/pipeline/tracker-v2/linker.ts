/**
 * L2 of tracker v2 (D683 §4): the deferred linker.
 *
 * An arc "B continues A" joins a piece whose last sighting precedes B's start
 * — A ended, or A still coasting — to B. Every relaxation the old tracker made
 * online (D665's reach, D678's size bar and flat vehicle reach) is a
 * feasibility bound or a cost term of ONE function, decided with the future in
 * hand: an arc commits only when A has ended, B is confirmed, and every piece
 * that could compete for A is known. Fusion is final (O3); the survivor is the
 * chain's earliest id.
 *
 * The cannot-links are absolute, and are judged on the CHAINS as they stand at
 * the moment of the commit — not as they stood when the step began: two
 * commits of one sparse step (the 5 s sweep, `finish`) may otherwise each pass
 * alone and together join two recognised people through a faceless piece.
 * A competitor that was refused keeps competing: a predecessor two pieces could
 * have continued never goes to the second after the first is refused.
 *
 * Contract: `step` receives every piece whose state changed since the previous
 * step — a live piece's `lastSeenAt` must be current, since concurrency and a
 * coasting predecessor's re-bind are read from it.
 */
import type { BoundingBox } from '@camstack/types'
import { type AppearanceAggregate, aggregateDistance } from './appearance.js'
import { minCostAssignment } from './assignment.js'
import {
  FACE_SETTLE_HOLD_MS,
  LINK_AMBIGUITY_MARGIN,
  LINK_APPEARANCE_REJECT,
  LINK_DECIDE_MARGIN_MS,
  LINK_DECIDE_MAX_MS,
  LINK_EVIDENCE_MS,
  LINK_MAX_AREA_RATIO,
  LINK_MAX_COST,
  LINK_MAX_GAP_MS,
  LINK_NO_APPEARANCE_COST,
  LINK_REACH_DIAGONALS_PER_SEC,
  LINK_REACH_MAX_DIAGONALS,
  LINK_REACH_MIN_DIAGONALS,
  LINK_VEHICLE_REACH_DIAGONALS,
  LINK_WEIGHT_GAP,
  LINK_WEIGHT_REACH,
  LINK_WEIGHT_SIZE,
  LINK_WINDOW_MS,
} from './constants.js'
import { areaRatio, centreDistance, diagonal } from './geometry.js'
import type {
  Lineage,
  LinkCandidateFacts,
  LinkDecisionFacts,
  LinkRecognition,
  LinkRejection,
  TrackFusion,
  TrackletEndReason,
} from './types.js'

export interface LinkPiece {
  readonly id: string
  readonly klass: string
  readonly startedAt: number
  /** Last confident sighting: where a gap is measured from. */
  readonly lastSeenAt: number
  readonly endedAt: number | null
  readonly endReason: TrackletEndReason | null
  /** Confirmed and not refused by the confirmation gate: only such pieces link. */
  readonly confirmed: boolean
  /** Took hits while contested in a split cohort: links on appearance only, either side. */
  readonly contested: boolean
  /** A face detail sat inside one of its boxes: recognition may still name it. */
  readonly faceBearing: boolean
  /** When it first carried a face — the start of the recognition wait. */
  readonly firstFaceAt: number | null
  /** The FaceRecognizer's settled verdict (a pseudonym in replay); `null` = not settled. */
  readonly identity: string | null
  readonly firstBox: BoundingBox
  readonly lastBox: BoundingBox
  readonly appearance: AppearanceAggregate | null
  readonly lineage: Lineage
}

export interface LinkerConfig {
  readonly maxMissedMs: number
  readonly appearanceResolvesAmbiguity: boolean
}

export type LinkOutcome = 'pending' | 'fused' | 'new' | 'ambiguous'

export type LinkObserver = (facts: LinkDecisionFacts) => void

interface Arc {
  readonly from: LinkPiece
  readonly to: LinkPiece
  readonly cost: number
  readonly gapMs: number
}

interface Rejected {
  readonly from: LinkPiece
  readonly to: LinkPiece
  readonly gapMs: number
  readonly rejected: LinkRejection
}

/** An arc, a candidate that could not be one (and why), or `null` = not a candidate at all. */
type Weighed =
  | { readonly ok: true; readonly arc: Arc }
  | { readonly ok: false; readonly why: Rejected }

type RefusalReason =
  | 'ambiguous'
  | 'predecessor-live'
  | 'not-ready'
  | 'face-unmatched'
  | 'faceless-live'

/** Why an arc may not commit yet — or ever, for the two face rules. */
type Readiness =
  | 'ready'
  | 'predecessor-live'
  | 'successor-unconfirmed'
  | 'gap-open'
  | 'no-evidence'
  | 'faceless-live'
  | 'face-hold'
  | 'face-unmatched'

/** The commit that brought a piece into its chain. */
interface Join {
  readonly from: string
  readonly recognition: LinkRecognition
}

export function linkReach(from: LinkPiece, gapMs: number): number {
  const diag = diagonal(from.lastBox)
  if (from.klass === 'vehicle') return diag * LINK_VEHICLE_REACH_DIAGONALS
  const k = Math.min(
    LINK_REACH_MAX_DIAGONALS,
    Math.max(LINK_REACH_MIN_DIAGONALS, (LINK_REACH_DIAGONALS_PER_SEC * gapMs) / 1000),
  )
  return diag * k
}

const arcKey = (from: string, to: string): string => `${from}\u0000${to}`

/** A CONFIRMED predecessor whose link into a piece was rejected, and why. */
export interface RejectedPredecessor {
  readonly from: string
  readonly rejected: LinkRejection
  readonly gapMs: number
}

/**
 * The rejections that mean "geometry or appearance said no to a plausible
 * continuation" of a confirmed predecessor — a track the operator sees break
 * (follow-up 102, F5). Every one of them is past `hardRejection`, so the
 * predecessor is confirmed. NOT here (fix round 1): `unconfirmed`;
 * `has-successor` (continued elsewhere); `concurrent` and `identity-conflict`
 * (two subjects — the normal case, and the most frequent); `dropped` (an
 * operator delete or a refused chain).
 */
const BREAK_REJECTIONS: ReadonlySet<LinkRejection> = new Set<LinkRejection>([
  'reach',
  'area',
  'appearance',
  'contested',
  'cost',
])

/** The confirmed predecessors whose link a decision rejected as a break (F5). */
export function confirmedPredecessorRejections(
  candidates: readonly LinkCandidateFacts[] | undefined,
): readonly RejectedPredecessor[] {
  const out: RejectedPredecessor[] = []
  for (const c of candidates ?? []) {
    if (c.rejected === undefined || !BREAK_REJECTIONS.has(c.rejected)) continue
    out.push({ from: c.from, rejected: c.rejected, gapMs: c.gapMs })
  }
  return out
}

function arcFacts(a: Arc): LinkCandidateFacts {
  return { from: a.from.id, to: a.to.id, gapMs: a.gapMs, cost: a.cost }
}

function rejectedFacts(r: Rejected): LinkCandidateFacts {
  return { from: r.from.id, to: r.to.id, gapMs: r.gapMs, rejected: r.rejected }
}

/** Another arc into the same piece, or out of the same predecessor, within the margin. */
function isAmbiguous(chosen: Arc, rivals: readonly Arc[]): boolean {
  return rivals.some((a) => {
    const sameTo = a.to.id === chosen.to.id
    const sameFrom = a.from.id === chosen.from.id
    if (sameTo === sameFrom) return false
    return a.cost < chosen.cost + LINK_AMBIGUITY_MARGIN
  })
}

export class DeferredLinker {
  private readonly pieces = new Map<string, LinkPiece>()
  private readonly roots = new Map<string, string>()
  private readonly chains = new Map<string, string[]>()
  private readonly successor = new Map<string, string>()
  private readonly outcomes = new Map<string, Exclude<LinkOutcome, 'pending'>>()
  /** Every name a piece was ever given — a retraction leaves a tombstone (review L1). */
  private readonly names = new Map<string, Set<string>>()
  private readonly joins = new Map<string, Join>()
  /** Per root, the names a `disagreed` fact has already reported. */
  private readonly reported = new Map<string, ReadonlySet<string>>()

  constructor(
    private readonly config: LinkerConfig,
    private readonly observer?: LinkObserver,
  ) {}

  outcome(id: string): LinkOutcome {
    return this.outcomes.get(id) ?? 'pending'
  }

  rootOf(id: string): string {
    return this.roots.get(id) ?? id
  }

  membersOf(root: string): readonly string[] {
    return this.chains.get(root) ?? [root]
  }

  step(now: number, pieces: readonly LinkPiece[]): readonly TrackFusion[] {
    for (const p of pieces) this.accept(p, now)
    // 1. Commits first: a ready arc is never lost to a sparse step's refusal (review H1).
    const fusions = this.commitReady(now)
    // 2. A committed chain that a later verdict named twice (review H2).
    this.reportDisagreements(now)
    // 3. Then the pieces that can no longer be linked.
    this.decideStale(now)
    return fusions
  }

  /**
   * A piece this linker does not hold, ended longer ago than the window, is
   * one whose chain was pruned: re-sent, it would be linked again from nothing
   * (review M3). It is refused, and said so.
   */
  private accept(p: LinkPiece, now: number): void {
    if (!this.pieces.has(p.id) && p.endedAt !== null && now - p.endedAt > LINK_WINDOW_MS) {
      this.observer?.({ t: now, kind: 'ignored', to: p.id, reason: 'pruned' })
      return
    }
    this.pieces.set(p.id, p)
    if (p.identity === null) return
    const seen = this.names.get(p.id)
    if (seen === undefined) this.names.set(p.id, new Set([p.identity]))
    else seen.add(p.identity)
  }

  /**
   * A clock step (follow-up 102, fix round 2): every piece still undecided is
   * decided `new`, so nothing that existed before the step can be absorbed
   * across it — whatever was ready was committed just before. The facade
   * rebases its clock past `LINK_MAX_GAP_MS`, so no later piece can continue
   * one of these either. An extra id, never a mix-up.
   */
  closeUndecided(now: number, pieces: readonly LinkPiece[]): void {
    for (const p of pieces) this.accept(p, now)
    for (const p of this.pieces.values()) {
      if (this.outcomes.has(p.id)) continue
      this.decide(p.id, 'new')
      this.observer?.({ t: now, kind: 'new', to: p.id, reason: 'clock-step' })
    }
  }

  isTailFinal(id: string, now: number, isLive: (id: string) => boolean): boolean {
    const root = this.rootOf(id)
    // The chain may itself still be absorbed: a fusion never touches a closed track.
    if (this.pieces.has(root) && !this.outcomes.has(root)) return false
    const members = this.membersOf(root)
    if (members.some((m) => isLive(m))) return false
    let tail: LinkPiece | undefined
    for (const m of members) {
      const p = this.pieces.get(m)
      if (p !== undefined && (tail === undefined || p.startedAt > tail.startedAt)) tail = p
    }
    if (tail === undefined) return true
    if (tail.endedAt === null || now < tail.lastSeenAt + LINK_MAX_GAP_MS) return false
    const since = tail.lastSeenAt
    const klass = tail.klass
    return ![...this.pieces.values()].some(
      (p) =>
        !this.outcomes.has(p.id) &&
        p.klass === klass &&
        p.startedAt > since &&
        p.startedAt - since <= LINK_MAX_GAP_MS,
    )
  }

  /**
   * Forgets a CHAIN once every member ended more than `LINK_WINDOW_MS` ago —
   * never one member on its own: a pruned member would take its identity, and
   * so the chain's identity cannot-link, with it.
   */
  prune(now: number): void {
    const roots = new Set([...this.pieces.keys()].map((id) => this.rootOf(id)))
    for (const root of roots) {
      const members = this.membersOf(root)
      const stale = members.every((m) => {
        const p = this.pieces.get(m)
        return p === undefined || (p.endedAt !== null && now - p.endedAt > LINK_WINDOW_MS)
      })
      if (!stale) continue
      for (const m of members) {
        this.pieces.delete(m)
        this.outcomes.delete(m)
        this.successor.delete(m)
        this.roots.delete(m)
        this.names.delete(m)
        this.joins.delete(m)
      }
      this.chains.delete(root)
      this.reported.delete(root)
    }
  }

  /**
   * Review H2: a verdict after a commit can name a fused chain twice. Fusion is
   * final (O3), so it is reported — once per new name — with the commit that
   * joined the two names; the recognizer must not silently flip the survivor.
   */
  private reportDisagreements(now: number): void {
    for (const [root, members] of this.chains) {
      if (members.length < 2) continue
      const ids = this.chainIdentities(root)
      if (ids.size < 2) continue
      const told = this.reported.get(root)
      if (told !== undefined && [...ids].every((i) => told.has(i))) continue
      this.reported.set(root, ids)
      const at = this.disagreeingJoin(members)
      this.observer?.({
        t: now,
        kind: 'disagreed',
        from: at.from,
        to: at.to,
        root,
        members: [...members],
        identities: [...ids].sort(),
        recognition: at.recognition,
      })
    }
  }

  /** The first commit whose later side carries a name its earlier side never had. */
  private disagreeingJoin(members: readonly string[]): Join & { readonly to: string } {
    const before = new Set<string>()
    let first: (Join & { readonly to: string }) | null = null
    for (const [i, m] of members.entries()) {
      const join = this.joins.get(m)
      if (join !== undefined) {
        const here = { ...join, to: m }
        first ??= here
        const after = members.slice(i).flatMap((x) => [...(this.names.get(x) ?? [])])
        if (before.size > 0 && after.some((n) => !before.has(n))) return here
      }
      for (const n of this.names.get(m) ?? []) before.add(n)
    }
    return first ?? { from: members[0] ?? '', to: members[1] ?? '', recognition: 'none' }
  }

  private commitReady(now: number): TrackFusion[] {
    const arcs = this.openArcs()
    const rivals = [...arcs, ...this.refusedArcsFrom(arcs)]
    const byKey = new Map(arcs.map((a) => [arcKey(a.from.id, a.to.id), a]))
    const froms = [...new Set(arcs.map((a) => a.from.id))]
    const tos = [...new Set(arcs.map((a) => a.to.id))]
    const matrix = froms.map((f) =>
      tos.map((t) => byKey.get(arcKey(f, t))?.cost ?? Number.POSITIVE_INFINITY),
    )
    const fusions: TrackFusion[] = []
    for (const pair of minCostAssignment(matrix)) {
      const chosen = byKey.get(arcKey(froms[pair.row] ?? '', tos[pair.col] ?? ''))
      if (chosen === undefined) continue
      // Re-weighed against the chains an earlier commit of THIS step built.
      const fresh = this.weigh(chosen.from, chosen.to)
      if (fresh === null || !fresh.ok) continue
      if (isAmbiguous(fresh.arc, rivals) || this.readiness(fresh.arc, now) !== 'ready') continue
      fusions.push(this.commit(fresh.arc, rivals, now))
    }
    return fusions
  }

  private decideStale(now: number): void {
    const arcs = this.openArcs()
    const rivals = [...arcs, ...this.refusedArcsFrom(arcs)]
    for (const to of [...this.pieces.values()]) {
      if (this.outcomes.has(to.id)) continue
      if (to.endReason === 'dropped') {
        // Dropped (a refused fusion's chain, the operator's delete): never absorbed (review M2).
        this.decide(to.id, 'new')
        this.observer?.({ t: now, kind: 'new', to: to.id, reason: 'dropped' })
        continue
      }
      if (to.endedAt !== null && !to.confirmed) {
        // Never emitted: nothing downstream knows it, and it never links.
        this.decide(to.id, 'new')
        this.observer?.({ t: now, kind: 'new', to: to.id, reason: 'unconfirmed' })
        continue
      }
      const into = arcs.filter((a) => a.to.id === to.id)
      if (into.length === 0) {
        // Every coasting predecessor has ended or re-bound by B.start + maxMissedMs (review C1, M15).
        if (now < to.startedAt + this.config.maxMissedMs) continue
        this.decide(to.id, 'new')
        const candidates = this.rejectionsInto(to).map(rejectedFacts)
        this.observer?.({ t: now, kind: 'new', to: to.id, reason: 'no-candidate', candidates })
        continue
      }
      if (now <= this.refusalDeadline(to, into)) continue
      this.decide(to.id, 'ambiguous')
      // Into the piece, what was rejected, and what its predecessors could have continued instead.
      const froms = new Set(into.map((a) => a.from.id))
      const elsewhere = rivals.filter((a) => a.to.id !== to.id && froms.has(a.from.id))
      const candidates = [
        ...into.map(arcFacts),
        ...elsewhere.map(arcFacts),
        ...this.rejectionsInto(to).map(rejectedFacts),
      ]
      const reason = this.refusalReason(into, rivals, now)
      this.observer?.({ t: now, kind: 'refused', to: to.id, reason, candidates })
    }
  }

  private refusalDeadline(to: LinkPiece, into: readonly Arc[]): number {
    const latestCandidate = Math.max(...into.map((a) => a.from.lastSeenAt))
    const faceHold = Math.max(...into.map((a) => this.faceHoldUntil(a) ?? Number.NEGATIVE_INFINITY))
    return (
      Math.max(to.startedAt + LINK_DECIDE_MAX_MS, latestCandidate + LINK_MAX_GAP_MS, faceHold) +
      LINK_DECIDE_MARGIN_MS
    )
  }

  private refusalReason(into: readonly Arc[], rivals: readonly Arc[], now: number): RefusalReason {
    if (into.some((a) => isAmbiguous(a, rivals))) return 'ambiguous'
    if (into.every((a) => a.from.endedAt === null)) return 'predecessor-live'
    const best = into.reduce((x, y) => (y.cost < x.cost ? y : x))
    const why = this.readiness(best, now)
    return why === 'face-unmatched' || why === 'faceless-live' ? why : 'not-ready'
  }

  /** Arcs into pieces still undecided: the ones that may commit. */
  private openArcs(): readonly Arc[] {
    const arcs: Arc[] = []
    for (const to of this.pieces.values()) {
      if (this.outcomes.has(to.id)) continue
      for (const from of this.pieces.values()) {
        const w = this.weigh(from, to)
        if (w?.ok === true) arcs.push(w.arc)
      }
    }
    return arcs
  }

  /**
   * Arcs into pieces decided WITHOUT a predecessor, out of the predecessors an
   * open arc still has (the only ones a rival can matter to). They never
   * commit, but they still compete: a predecessor's refused successor was as
   * good a continuation as the one still waiting, and the refusal did not
   * settle which it was.
   */
  private refusedArcsFrom(open: readonly Arc[]): readonly Arc[] {
    const froms = new Map(open.map((a) => [a.from.id, a.from]))
    const arcs: Arc[] = []
    for (const to of this.pieces.values()) {
      const o = this.outcomes.get(to.id)
      if (o !== 'ambiguous' && o !== 'new') continue
      for (const from of froms.values()) {
        const w = this.weigh(from, to)
        if (w?.ok === true) arcs.push(w.arc)
      }
    }
    return arcs
  }

  private rejectionsInto(to: LinkPiece): readonly Rejected[] {
    const out: Rejected[] = []
    for (const from of this.pieces.values()) {
      const w = this.weigh(from, to)
      if (w !== null && !w.ok) out.push(w.why)
    }
    return out
  }

  private readiness(arc: Arc, now: number): Readiness {
    if (arc.from.endedAt === null) return 'predecessor-live'
    if (!arc.to.confirmed) return 'successor-unconfirmed'
    if (now < arc.from.lastSeenAt + LINK_MAX_GAP_MS) return 'gap-open'
    if (!(now >= arc.to.startedAt + LINK_EVIDENCE_MS || arc.to.endedAt !== null))
      return 'no-evidence'
    if (this.facelessLive(arc)) return 'faceless-live'
    // Two face-bearing chains whose verdicts are not both in: wait for recognition (§4.4).
    const faceHold = this.faceHoldUntil(arc)
    if (faceHold === null) return 'ready'
    if (now <= faceHold) return 'face-hold'
    // Past the wait, a named side against a face recognition did not match to it
    // is evidence of a second person: refused, never committed (fix round 1, M1).
    // Neither side named — strangers — is decided on geometry.
    const named = [arc.from.id, arc.to.id].filter(
      (id) => this.chainIdentities(this.rootOf(id)).size > 0,
    )
    return named.length === 1 ? 'face-unmatched' : 'ready'
  }

  /**
   * Review H1: a chain that carries a face never absorbs a piece still live
   * that has shown no face yet — it may turn round and be named someone else.
   * Once it has ended faceless, it is complete evidence and links on geometry.
   */
  private facelessLive(arc: Arc): boolean {
    const toRoot = this.rootOf(arc.to.id)
    if (!this.chainFaceBearing(this.rootOf(arc.from.id)) || this.chainFaceBearing(toRoot))
      return false
    return this.membersOf(toRoot).some((m) => this.pieces.get(m)?.endedAt === null)
  }

  /**
   * Review 2 NH1: two face-bearing chains whose verdicts are not both in wait
   * for recognition — from the UNNAMED side's first face, for
   * `FACE_SETTLE_HOLD_MS`, and never less than the ordinary hold. `null` = no wait.
   */
  private faceHoldUntil(arc: Arc): number | null {
    const fromRoot = this.rootOf(arc.from.id)
    const toRoot = this.rootOf(arc.to.id)
    if (!this.chainFaceBearing(fromRoot) || !this.chainFaceBearing(toRoot)) return null
    const unnamed = [fromRoot, toRoot].filter((r) => this.chainIdentities(r).size === 0)
    if (unnamed.length === 0) return null
    const firstFace = Math.max(...unnamed.map((r) => this.chainFirstFaceAt(r)))
    return Math.max(
      arc.to.startedAt + LINK_DECIDE_MAX_MS,
      arc.from.lastSeenAt + LINK_MAX_GAP_MS,
      firstFace + FACE_SETTLE_HOLD_MS,
    )
  }

  private recognition(arc: Arc): LinkRecognition {
    const fromRoot = this.rootOf(arc.from.id)
    const toRoot = this.rootOf(arc.to.id)
    const a = this.chainIdentities(fromRoot)
    const b = this.chainIdentities(toRoot)
    if ([...a].some((i) => b.has(i))) return 'same-identity'
    return this.faceHoldUntil(arc) === null ? 'none' : 'waited-unsettled'
  }

  /** A face-bearing chain's first face; a chain flagged without a time waits from its start. */
  private chainFirstFaceAt(root: string): number {
    let first = Number.POSITIVE_INFINITY
    let start = Number.POSITIVE_INFINITY
    for (const m of this.membersOf(root)) {
      const p = this.pieces.get(m)
      if (p === undefined) continue
      start = Math.min(start, p.startedAt)
      if (p.firstFaceAt !== null) first = Math.min(first, p.firstFaceAt)
    }
    return Number.isFinite(first) ? first : start
  }

  private decide(id: string, outcome: Exclude<LinkOutcome, 'pending'>): void {
    this.outcomes.set(id, outcome)
  }

  private weigh(from: LinkPiece, to: LinkPiece): Weighed | null {
    if (from.id === to.id || from.klass !== to.klass) return null
    if (to.endedAt !== null && !to.confirmed) return null
    if (to.endReason === 'dropped') return null
    if (!(to.startedAt > from.lastSeenAt)) return null
    const gapMs = to.startedAt - from.lastSeenAt
    if (gapMs > LINK_MAX_GAP_MS) return null
    const fromRoot = this.rootOf(from.id)
    const toRoot = this.rootOf(to.id)
    if (fromRoot === toRoot) return null
    const reject = (rejected: LinkRejection): Weighed => ({
      ok: false,
      why: { from, to, gapMs, rejected },
    })
    const hard = this.hardRejection(from, fromRoot, toRoot)
    if (hard !== null) return reject(hard)
    const ratio = areaRatio(from.lastBox, to.firstBox)
    if (ratio > LINK_MAX_AREA_RATIO) return reject('area')
    const reach = linkReach(from, gapMs)
    const dist = centreDistance(from.lastBox, to.firstBox)
    if (dist > reach) return reject('reach')
    const app =
      this.config.appearanceResolvesAmbiguity && from.appearance !== null && to.appearance !== null
        ? aggregateDistance(from.appearance, to.appearance)
        : undefined
    if (app !== undefined && app > LINK_APPEARANCE_REJECT) return reject('appearance')
    // A contested piece's boxes may be the other subject's: appearance or nothing.
    if ((to.contested || from.contested) && app === undefined) return reject('contested')
    const cost =
      (LINK_WEIGHT_GAP * gapMs) / LINK_MAX_GAP_MS +
      (LINK_WEIGHT_REACH * dist) / reach +
      (LINK_WEIGHT_SIZE * Math.abs(Math.log(ratio))) / Math.log(LINK_MAX_AREA_RATIO) +
      (app ?? LINK_NO_APPEARANCE_COST)
    return cost <= LINK_MAX_COST ? { ok: true, arc: { from, to, cost, gapMs } } : reject('cost')
  }

  /** The predecessor's own state, then the absolute cannot-links between the two chains. */
  private hardRejection(from: LinkPiece, fromRoot: string, toRoot: string): LinkRejection | null {
    if (!from.confirmed) return 'unconfirmed'
    if (from.endReason === 'dropped') return 'dropped'
    if (this.successor.has(from.id)) return 'has-successor'
    if (this.chainsOverlap(fromRoot, toRoot)) return 'concurrent'
    if (this.identitiesConflict(fromRoot, toRoot)) return 'identity-conflict'
    return null
  }

  /** Confident spans overlap anywhere: two chains that were seen at once are two subjects. */
  private chainsOverlap(rootA: string, rootB: string): boolean {
    for (const x of this.membersOf(rootA)) {
      const px = this.pieces.get(x)
      if (px === undefined) continue
      for (const y of this.membersOf(rootB)) {
        const py = this.pieces.get(y)
        if (py === undefined) continue
        if (px.startedAt <= py.lastSeenAt && py.startedAt <= px.lastSeenAt) return true
      }
    }
    return false
  }

  /** Every name any member was ever given, retracted ones included (review L1). */
  private chainIdentities(root: string): ReadonlySet<string> {
    const out = new Set<string>()
    for (const m of this.membersOf(root)) for (const n of this.names.get(m) ?? []) out.add(n)
    return out
  }

  private chainFaceBearing(root: string): boolean {
    return this.membersOf(root).some((m) => this.pieces.get(m)?.faceBearing === true)
  }

  /** Both chains recognised, and never as the same person: two people (C3). */
  private identitiesConflict(rootA: string, rootB: string): boolean {
    const a = this.chainIdentities(rootA)
    const b = this.chainIdentities(rootB)
    if (a.size === 0 || b.size === 0) return false
    for (const i of a) if (b.has(i)) return false
    return true
  }

  private commit(arc: Arc, rivals: readonly Arc[], now: number): TrackFusion {
    const recognition = this.recognition(arc)
    const survivor = this.rootOf(arc.from.id)
    const absorbed = this.rootOf(arc.to.id)
    const moving = [...this.membersOf(absorbed)]
    for (const m of moving) this.roots.set(m, survivor)
    this.chains.set(survivor, [...this.membersOf(survivor), ...moving])
    this.chains.delete(absorbed)
    this.successor.set(arc.from.id, arc.to.id)
    this.joins.set(arc.to.id, { from: arc.from.id, recognition })
    const already = [...(this.reported.get(survivor) ?? []), ...(this.reported.get(absorbed) ?? [])]
    if (already.length > 0) this.reported.set(survivor, new Set(already))
    this.reported.delete(absorbed)
    this.decide(arc.to.id, 'fused')
    const competing = rivals.filter((a) => (a.to.id === arc.to.id) !== (a.from.id === arc.from.id))
    this.observer?.({
      t: now,
      kind: 'committed',
      from: arc.from.id,
      to: arc.to.id,
      cost: arc.cost,
      gapMs: arc.gapMs,
      recognition,
      candidates: competing.map(arcFacts),
    })
    return {
      survivorId: survivor,
      absorbedId: absorbed,
      members: moving,
      t: now,
      cost: arc.cost,
      gapMs: arc.gapMs,
    }
  }
}
