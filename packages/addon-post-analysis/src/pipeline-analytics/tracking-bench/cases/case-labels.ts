/**
 * The operator's labels on a committed case, judged on one replay (D681,
 * plan decision 16). Pure.
 *
 * A labelled track is a PIECE (a `mixed` track with a switch instant is two:
 * `<trk>#before` and `<trk>#after`). A piece's detections are the ones the
 * TAPE bound to it — the live run's `live[]` — and its final id in a replay
 * is the final id bound to most of them, ties going to the smallest id
 * LEXICOGRAPHICALLY (`t10` < `t9`) — deterministic, and what `ProcessorTracker`
 * mints (`t<n>`) needs no numeric compare to resolve. Then: same-subject ⇒
 * one final id; different-subjects ⇒ two; a piece the replay never bound is
 * `unbound`.
 *
 * A case asserts only what the operator LABELLED — same-subject,
 * different-subjects, `mixed`'s switch — never anything a label did not say;
 * everything else about a tracker's behaviour is measured by the Task 23 CLI's
 * metrics (IDF1, CLEAR, HOTA), not by a case (D681 fix round 1, M2).
 */
import type { GroundTruthFile } from '../ground-truth.js'
import { finalIdResolver, type ReplayResult } from '../replay.js'
import type { Tape } from '../tape-codec.js'
import type { TapePlane } from '../tape-schema.js'
import type { CaseContent } from './case-fixture.js'

export interface SameSubjectSplit {
  readonly kind: 'same-subject-split'
  readonly a: string
  readonly b: string
  readonly finalA: string
  readonly finalB: string
}

export interface DifferentSubjectsMerged {
  readonly kind: 'different-subjects-merged'
  readonly a: string
  readonly b: string
  readonly finalId: string
}

export interface UnboundPiece {
  readonly kind: 'unbound'
  readonly piece: string
}

export type CaseViolation = SameSubjectSplit | DifferentSubjectsMerged | UnboundPiece

export interface CaseReport {
  readonly slug: string
  readonly tracker: string
  readonly checked: number
  readonly skipped: number
  readonly violations: readonly CaseViolation[]
}

type GtPurity = GroundTruthFile['purities'][number]
type PurityByTrack = ReadonlyMap<string, GtPurity>
type TrackSide = 'before' | 'after'

function detectionKey(t: number, detectionId: string): string {
  return `${String(t)}|${detectionId}`
}

/** A relation end → its piece, or null when the relation cannot be judged. */
function pieceOf(trk: string, side: TrackSide | undefined, purity: PurityByTrack): string | null {
  const p = purity.get(trk)
  if (p?.purity === 'not-a-subject') return null
  if (p?.purity === 'mixed')
    return p.switchT === undefined || side === undefined ? null : `${trk}#${side}`
  return trk
}

function pieceAt(trk: string, t: number, purity: PurityByTrack): string {
  const p = purity.get(trk)
  if (p?.purity === 'mixed' && p.switchT !== undefined)
    return `${trk}#${t < p.switchT ? 'before' : 'after'}`
  return trk
}

/**
 * The Map is private to this call — a local `push` on the accumulator is not
 * a mutation anyone outside this function can observe, and it keeps a
 * ~30-minute stationary piece (about 14 k detections at 8 fps) linear rather
 * than the ~1e8-copy quadratic blow-up spreading a growing array on every
 * detection produced (D681 fix round 1, L2).
 */
function detectionsByPiece(
  tape: Tape,
  plane: TapePlane,
  purity: PurityByTrack,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>()
  for (const r of tape.body) {
    if (r.kind !== 'frame' || r.plane !== plane) continue
    for (const l of r.live) {
      if (l.det === undefined) continue
      const piece = pieceAt(l.trk, r.t, purity)
      const key = detectionKey(r.t, l.det)
      const list = out.get(piece)
      if (list === undefined) out.set(piece, [key])
      else list.push(key)
    }
  }
  return out
}

function finalIdsByDetection(replay: ReplayResult): ReadonlyMap<string, string> {
  const finalOf = finalIdResolver(replay)
  const out = new Map<string, string>()
  for (const f of replay.frames) {
    for (const o of f.outputs)
      if (o.detectionId !== undefined) out.set(detectionKey(f.t, o.detectionId), finalOf(o.liveId))
  }
  return out
}

function majority(keys: readonly string[], finals: ReadonlyMap<string, string>): string | null {
  const counts = new Map<string, number>()
  for (const k of keys) {
    const f = finals.get(k)
    if (f !== undefined) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const id of [...counts.keys()].sort()) {
    const n = counts.get(id) ?? 0
    if (n > bestCount) {
      best = id
      bestCount = n
    }
  }
  return best
}

export interface CaseLabelAssessment {
  /** Relations whose both ends resolve to a piece (Task 22 fix round 1, H2):
   *  a relation touching a `not-a-subject` track, or a `mixed` track with no
   *  switch or no side, does not count. Zero means the case asserts nothing,
   *  whatever a tracker does — `caseFromBundle` refuses `no-labels` on it. */
  readonly judgeableRelations: number
  /** A judgeable piece the TAPE's own `live[]` never bound a single detection
   *  to, on the case's plane (fix round 1, M1) — a track seen only on the
   *  OTHER plane, a `switchT` outside the track's span leaving one side
   *  empty, or a plane with no frames at all. Every tracker reports such a
   *  piece `unbound` forever, so an `open` case built on one can never flip
   *  to `held`; `caseFromBundle` refuses it as `incomplete`, naming the piece. */
  readonly unjudgeablePieces: readonly string[]
}

/**
 * What `caseFromBundle` needs to know BEFORE any replay exists: whether the
 * label set can assert anything at all, and whether every piece it names has
 * at least one detection on the tape to be judged from. Shares `pieceOf` and
 * `detectionsByPiece` with `checkCaseLabels` so the refusal and the
 * judgement never drift apart (fix round 1, H2/M1).
 */
export function assessCaseLabels(
  tape: Tape,
  gt: GroundTruthFile,
  plane: TapePlane,
): CaseLabelAssessment {
  const purity: PurityByTrack = new Map(gt.purities.map((p) => [p.trk, p]))
  const detections = detectionsByPiece(tape, plane, purity)
  const pieces = new Set<string>()
  let judgeableRelations = 0
  for (const r of gt.relations) {
    const a = pieceOf(r.a, r.aSide, purity)
    const b = pieceOf(r.b, r.bSide, purity)
    if (a === null || b === null) continue
    judgeableRelations += 1
    pieces.add(a)
    pieces.add(b)
  }
  const unjudgeablePieces = [...pieces].filter((p) => (detections.get(p) ?? []).length === 0).sort()
  return { judgeableRelations, unjudgeablePieces }
}

export function checkCaseLabels(content: CaseContent, replay: ReplayResult): CaseReport {
  const { tape, gt, manifest } = content
  const purity: PurityByTrack = new Map(gt.purities.map((p) => [p.trk, p]))
  const detections = detectionsByPiece(tape, manifest.plane, purity)
  const finals = finalIdsByDetection(replay)
  const finalOf = (piece: string): string | null => majority(detections.get(piece) ?? [], finals)
  const judged: CaseViolation[] = []
  const unbound = new Set<string>()
  let checked = 0
  let skipped = 0
  for (const r of gt.relations) {
    const a = pieceOf(r.a, r.aSide, purity)
    const b = pieceOf(r.b, r.bSide, purity)
    if (a === null || b === null) {
      skipped += 1
      continue
    }
    checked += 1
    const fa = finalOf(a)
    const fb = finalOf(b)
    if (fa === null) unbound.add(a)
    if (fb === null) unbound.add(b)
    if (fa === null || fb === null) continue
    if (r.relation === 'same-subject' && fa !== fb)
      judged.push({ kind: 'same-subject-split', a, b, finalA: fa, finalB: fb })
    if (r.relation === 'different-subjects' && fa === fb)
      judged.push({ kind: 'different-subjects-merged', a, b, finalId: fa })
  }
  const unboundViolations: CaseViolation[] = [...unbound]
    .sort()
    .map((piece) => ({ kind: 'unbound', piece }))
  return {
    slug: manifest.slug,
    tracker: replay.tracker,
    checked,
    skipped,
    violations: [...judged, ...unboundViolations],
  }
}

function describeViolation(v: CaseViolation): string {
  switch (v.kind) {
    case 'same-subject-split':
      return `  same subject, split: ${v.a} → ${v.finalA}, ${v.b} → ${v.finalB}`
    case 'different-subjects-merged':
      return `  different subjects, merged: ${v.a} and ${v.b} → ${v.finalId}`
    case 'unbound':
      return `  unbound: the replay bound none of ${v.piece}'s detections`
  }
}

export function formatCaseReport(report: CaseReport): readonly string[] {
  const head =
    `${report.slug} via ${report.tracker}: ${String(report.checked)} relation(s) checked, ` +
    `${String(report.skipped)} skipped, ${String(report.violations.length)} violation(s)`
  return [head, ...report.violations.map(describeViolation)]
}
