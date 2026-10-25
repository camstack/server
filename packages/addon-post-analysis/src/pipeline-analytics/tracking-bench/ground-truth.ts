/**
 * Ground truth for one tape (D681, spec §4.4).
 *
 * `gt.json` holds the operator's MARKS rebased onto the tape (relative time,
 * tape track ids) — never derived boxes. The truth the metrics read is derived
 * here from the tape's own `live[]` bindings, so a change to this derivation is
 * a code change with a spec, not a rewrite of committed fixtures.
 *
 * **Cannot-links across a boot boundary** (amended 2026-09-29, Task 12 fix
 * round; applies to D683 as well). Face pseudonyms (`fid`) are keyed per
 * recorder SESSION — one per boot, because the HMAC key is per boot — and
 * every session change on a promoted tape is written as a `restart` gap. Two
 * tracks the recognizer settled with DIFFERENT `fid`s are strong evidence of
 * different subjects, but ONLY inside one restart-free span: the same face is
 * legitimately `p1` before a restart and `p2` after it, because the key
 * rotated, not because the person changed. `trackFidEpochs` therefore
 * partitions the tape into epochs at each `restart` gap (never at a
 * `backpressure` gap, which loses records but does not reboot anything), and
 * `deriveTruth` never compares a `fid` across that partition.
 *
 * **The operator's marks always win** (fix round 1, review H1). The auto fid
 * cannot-link above is an automated signal, and it can only ever collide with
 * a pair the OPERATOR has already unioned same-subject (directly, or
 * transitively through their own chain of marks) — the union-find never
 * merges anything from fid data, only from `gt.relations`. So a collision
 * there is never "two automated signals disagree", it is always "the
 * recognizer disagrees with an explicit human assertion", and the human wins:
 * the pair is NOT refused. It is recorded in `Truth.suppressedAuto` (both
 * `fid`s, `reason: 'operator-same-subject'`) and logged at `info` as
 * "recognizer disagreed with the operator" — visible, not silently dropped,
 * but never a whole-tape failure the operator cannot resolve. An explicit
 * operator SELF-contradiction (a same-subject chain crossed by an explicit
 * `different-subjects` mark) is a different thing entirely — a mistake only
 * the operator can fix — and is the only remaining source of failure:
 * `{ ok: false, reason: 'operator-contradiction' }`. The reason is named
 * distinctly from anything automatic on purpose — nothing automatic can ever
 * produce `ok: false` any more, but the name should say so on its own.
 */
import {
  type IScopedLogger,
  type TrackPurity,
  type TrackRelation,
  TrackRelationKindSchema,
  TrackSideSchema,
} from '@camstack/types'
import { z } from 'zod'
import type { Tape } from './tape-codec.js'
import type { TapeBox, TapePlane } from './tape-schema.js'

const GT_WINDOW_MARGIN_MS = 10 * 60_000

export const GroundTruthFileSchema = z.strictObject({
  version: z.literal(1),
  reviewed: z.boolean(),
  relations: z.array(
    z.strictObject({
      a: z.string(),
      b: z.string(),
      relation: TrackRelationKindSchema,
      presence: z.literal('continuous').optional(),
      aSide: TrackSideSchema.optional(),
      bSide: TrackSideSchema.optional(),
    }),
  ),
  purities: z.array(
    z.strictObject({
      trk: z.string(),
      purity: z.enum(['mixed', 'not-a-subject']),
      switchT: z.number().optional(),
    }),
  ),
  external: z.array(z.strictObject({ inside: z.string(), relation: TrackRelationKindSchema })),
  /**
   * Auto-derived fid cannot-links the OPERATOR's own same-subject mark
   * outranked (see `deriveTruth`'s module comment) — never populated by
   * `exportGroundTruth` (it has no tape to derive one from), only by
   * `caseFromBundle` at case-creation time (D681 fix round 1, M4), so a case
   * carries what the recognizer disagreed with the operator about, for the
   * Task 23 CLI to print before the case is committed. Optional: absent on
   * every `gt.json` written before this field existed.
   */
  suppressedAuto: z
    .array(
      z.strictObject({
        a: z.string(),
        b: z.string(),
        aFid: z.string(),
        bFid: z.string(),
        reason: z.literal('operator-same-subject'),
      }),
    )
    .optional(),
})
export type GroundTruthFile = z.infer<typeof GroundTruthFileSchema>

export interface ExportGroundTruthInput {
  readonly liveTrackIds: readonly string[]
  readonly fromMs: number
  readonly toMs: number
  readonly reviewed: boolean
  readonly relations: readonly TrackRelation[]
  readonly purities: readonly TrackPurity[]
}

/**
 * Operator marks reference tracks by PROVENANCE (`leftTrackId`/`rightTrackId`)
 * and outlive them; a promoted window's `gt.json` keeps only what is inside
 * ITS liveTrackIds — both ends inside, rebased to relative `switchT` — and
 * names a one-sided reference `external` rather than dropping it silently.
 */
export function exportGroundTruth(input: ExportGroundTruthInput): GroundTruthFile {
  const inside = new Set(input.liveTrackIds)
  const near = (at: number | null): boolean =>
    at === null ||
    (at >= input.fromMs - GT_WINDOW_MARGIN_MS && at <= input.toMs + GT_WINDOW_MARGIN_MS)
  const relations: GroundTruthFile['relations'] = []
  const external: GroundTruthFile['external'] = []
  for (const r of input.relations) {
    if (!near(r.leftStartedAt) && !near(r.rightStartedAt)) continue
    const leftInside = inside.has(r.leftTrackId)
    const rightInside = inside.has(r.rightTrackId)
    if (leftInside && rightInside) {
      relations.push({
        a: r.leftTrackId,
        b: r.rightTrackId,
        relation: r.relation,
        ...(r.presence !== null ? { presence: r.presence } : {}),
        ...(r.leftSide !== null ? { aSide: r.leftSide } : {}),
        ...(r.rightSide !== null ? { bSide: r.rightSide } : {}),
      })
    } else if (leftInside || rightInside) {
      external.push({ inside: leftInside ? r.leftTrackId : r.rightTrackId, relation: r.relation })
    }
  }
  const purities: GroundTruthFile['purities'] = input.purities
    .filter((p) => inside.has(p.sourceTrackId))
    .map((p) => ({
      trk: p.sourceTrackId,
      purity: p.purity,
      ...(p.switchAtMs !== null ? { switchT: p.switchAtMs - input.fromMs } : {}),
    }))
  return { version: 1, reviewed: input.reviewed, relations, purities, external }
}

export interface TruthBox {
  readonly detectionId: string
  readonly identity: string
  readonly box: TapeBox
}

export interface TruthFrame {
  readonly t: number
  readonly boxes: readonly TruthBox[]
  readonly ignoreDetections: readonly string[]
  readonly ignoreBoxes: readonly TapeBox[]
  readonly detectionBoxes: ReadonlyMap<string, TapeBox>
}

export interface PresenceGap {
  readonly identity: string
  readonly fromT: number
  readonly toT: number
}

/**
 * An auto fid-derived cannot-link the operator's own same-subject mark
 * outranked (see the module comment): not a failure, a disagreement worth
 * surfacing to review.
 */
export interface SuppressedAutoCannotLink {
  readonly a: string
  readonly b: string
  readonly aFid: string
  readonly bFid: string
  readonly reason: 'operator-same-subject'
}

export interface Truth {
  readonly frames: readonly TruthFrame[]
  readonly presenceGaps: readonly PresenceGap[]
  readonly unscorableTracks: number
  readonly ambiguousRelations: number
  readonly suppressedAuto: readonly SuppressedAutoCannotLink[]
}

export interface TruthOk {
  readonly ok: true
  readonly truth: Truth
}

export interface TruthContradiction {
  readonly ok: false
  readonly reason: 'operator-contradiction'
  readonly chain: readonly string[]
}

export type TruthResult = TruthOk | TruthContradiction

/** Union-find over identity nodes (a plain track id, or `trk#before`/`trk#after`
 *  for a mixed track once its switch splits it into two pieces). */
class UnionFind {
  private readonly parent = new Map<string, string>()
  find(x: string): string {
    const p = this.parent.get(x)
    if (p === undefined || p === x) {
      this.parent.set(x, x)
      return x
    }
    const root = this.find(p)
    this.parent.set(x, root)
    return root
  }
  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }
}

/** The shortest same-subject path from `from` to `to`, for naming a refusal. */
function bfsPath(
  edges: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): readonly string[] {
  const prev = new Map<string, string>([[from, from]])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === undefined) break
    if (cur === to) break
    for (const next of edges.get(cur) ?? []) {
      if (prev.has(next)) continue
      prev.set(next, cur)
      queue.push(next)
    }
  }
  const path = [to]
  let at = to
  while (at !== from && prev.has(at)) {
    at = prev.get(at) ?? from
    path.unshift(at)
  }
  return path
}

/**
 * Every `identity` verdict on the tape, keyed by track, with the RESTART
 * EPOCH it was settled in. Epoch advances at each `gap` record whose reason
 * is `restart` — never at `backpressure`, which loses records but never
 * rotates the per-boot HMAC key. A retracted verdict (`fid: null`) clears the
 * track: an un-settled track never participates in the auto cannot-link.
 */
function trackFidEpochs(
  tape: Tape,
): ReadonlyMap<string, { readonly fid: string; readonly epoch: number }> {
  const out = new Map<string, { fid: string; epoch: number }>()
  let epoch = 0
  for (const r of tape.body) {
    if (r.kind === 'gap') {
      if (r.reason === 'restart') epoch += 1
      continue
    }
    if (r.kind !== 'identity') continue
    if (r.fid === null) out.delete(r.trk)
    else out.set(r.trk, { fid: r.fid, epoch })
  }
  return out
}

export function deriveTruth(
  tape: Tape,
  gt: GroundTruthFile,
  plane: TapePlane,
  logger: IScopedLogger,
): TruthResult {
  const purity = new Map(gt.purities.map((p) => [p.trk, p]))
  let ambiguous = 0
  const nodeOf = (trk: string, side: 'before' | 'after' | undefined): string | null => {
    const p = purity.get(trk)
    if (p?.purity !== 'mixed' || p.switchT === undefined) return trk
    if (side === undefined) return null
    return `${trk}#${side}`
  }
  const uf = new UnionFind()
  const edges = new Map<string, string[]>()
  const continuous: Array<[string, string]> = []
  for (const r of gt.relations) {
    const a = nodeOf(r.a, r.aSide)
    const b = nodeOf(r.b, r.bSide)
    if (a === null || b === null) {
      ambiguous += 1
      continue
    }
    if (r.relation !== 'same-subject') continue
    uf.union(a, b)
    edges.set(a, [...(edges.get(a) ?? []), b])
    edges.set(b, [...(edges.get(b) ?? []), a])
    if (r.presence === 'continuous') continuous.push([a, b])
  }
  for (const r of gt.relations) {
    if (r.relation !== 'different-subjects') continue
    const a = nodeOf(r.a, r.aSide)
    const b = nodeOf(r.b, r.bSide)
    if (a === null || b === null) continue
    if (uf.find(a) === uf.find(b))
      return { ok: false, reason: 'operator-contradiction', chain: bfsPath(edges, a, b) }
  }

  // Auto-derived cannot-link (see the module comment): two tracks the
  // recognizer settled with different `fid`s, in the SAME restart-free
  // epoch, are evidence of different subjects — but never across a
  // `restart` gap, and never for a track marked `not-a-subject` or an
  // unresolved mixed track (identity verdicts are per whole track, not per
  // piece). A collision here can only happen against a pair the OPERATOR has
  // already unioned same-subject (the union-find never merges from fid data),
  // so the operator's mark wins: it is suppressed and logged, never refused.
  const eligibleFidNode = (trk: string): string | null =>
    purity.get(trk)?.purity === 'not-a-subject' ? null : nodeOf(trk, undefined)
  const byEpoch = new Map<number, Array<{ readonly node: string; readonly fid: string }>>()
  for (const [trk, mark] of trackFidEpochs(tape)) {
    const node = eligibleFidNode(trk)
    if (node === null) continue
    const list = byEpoch.get(mark.epoch) ?? []
    list.push({ node, fid: mark.fid })
    byEpoch.set(mark.epoch, list)
  }
  const suppressedAuto: SuppressedAutoCannotLink[] = []
  for (const marked of byEpoch.values()) {
    for (let i = 0; i < marked.length; i += 1) {
      for (let j = i + 1; j < marked.length; j += 1) {
        const x = marked[i]
        const y = marked[j]
        if (x === undefined || y === undefined || x.fid === y.fid) continue
        if (uf.find(x.node) !== uf.find(y.node)) continue
        suppressedAuto.push({
          a: x.node,
          b: y.node,
          aFid: x.fid,
          bFid: y.fid,
          reason: 'operator-same-subject',
        })
        logger.info('recognizer disagreed with the operator', {
          tags: { deviceId: tape.header.deviceId },
          meta: { a: x.node, b: y.node, aFid: x.fid, bFid: y.fid },
        })
      }
    }
  }

  const unscorable = new Set<string>()
  const extent = new Map<string, { first: number; last: number }>()
  const frames: TruthFrame[] = []
  for (const r of tape.body) {
    if (r.kind !== 'frame' || r.plane !== plane) continue
    const boundBy = new Map<string, string>()
    for (const l of r.live) if (l.det !== undefined) boundBy.set(l.det, l.trk)
    const boxes: TruthBox[] = []
    const ignore: string[] = []
    const detectionBoxes = new Map<string, TapeBox>()
    for (const d of r.dets) {
      if (d.k !== 'first-level') continue
      detectionBoxes.set(d.id, d.b)
      const trk = boundBy.get(d.id)
      if (trk === undefined) {
        ignore.push(d.id)
        continue
      }
      const p = purity.get(trk)
      if (p?.purity === 'not-a-subject') continue
      let piece = trk
      if (p?.purity === 'mixed') {
        if (p.switchT === undefined) {
          unscorable.add(trk)
          ignore.push(d.id)
          continue
        }
        piece = `${trk}#${r.t < p.switchT ? 'before' : 'after'}`
      }
      const e = extent.get(piece)
      extent.set(piece, e === undefined ? { first: r.t, last: r.t } : { first: e.first, last: r.t })
      boxes.push({ detectionId: d.id, identity: uf.find(piece), box: d.b })
    }
    frames.push({
      t: r.t,
      boxes,
      ignoreDetections: ignore,
      ignoreBoxes: r.disc.map((x) => x.b),
      detectionBoxes,
    })
  }

  const presenceGaps: PresenceGap[] = []
  for (const [a, b] of continuous) {
    const ea = extent.get(a)
    const eb = extent.get(b)
    if (ea === undefined || eb === undefined) continue
    const [early, late] = ea.first <= eb.first ? [ea, eb] : [eb, ea]
    if (late.first > early.last)
      presenceGaps.push({ identity: uf.find(a), fromT: early.last, toT: late.first })
  }
  return {
    ok: true,
    truth: {
      frames,
      presenceGaps,
      unscorableTracks: unscorable.size,
      ambiguousRelations: ambiguous,
      suppressedAuto,
    },
  }
}
