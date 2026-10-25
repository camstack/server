/**
 * Operator metrics (D681, spec §5.4) — defined on ground-truth identities, in
 * the operator's own terms: how many ids one arrival costs, swaps, merges,
 * broken stationary presences, duplicate notifications, and how late the
 * final id arrives. Every definition is in the plan's Task 21 header; the
 * constants below are the spec's numbers.
 *
 * `duplicateNotifications` counts BIRTH-GATE emissions (`TapeTrackOutput`,
 * `confirmed: true` = past the tracker's own `minHits`/confidence-bypass
 * gate), never the live crop-confirmation gate or the notification emitter's
 * age/cooldown gates — a tape carries neither, so this metric is a proxy: an
 * upper bound on live duplicate notifications, not the count a viewer saw.
 */
import type { PresenceGap, Truth } from '../ground-truth.js'
import { finalIdResolver, type ReplayResult } from '../replay.js'
import type { TapeBox } from '../tape-schema.js'
import { iou } from './matching.js'

const PRESENCE_GAP_MS = 15_000
const MERGE_WINDOW_MS = 2_000
const STATIONARY_MIN_MS = 10_000
const ANCHOR_IOU = 0.5
const DUPLICATE_WINDOW_MS = 60_000

export interface OperatorMetrics {
  readonly idsPerPresence: number
  readonly resplitShare: number
  readonly swapsPer100: number
  readonly mergesPer100: number
  readonly stationaryBreaks: number
  readonly duplicateNotifications: number
  readonly finalIdLatencyP50: number
  readonly finalIdLatencyP95: number
  readonly tracksPerIdentityHour: number
  readonly unscorableTracks: number
}

interface Hit {
  readonly t: number
  readonly identity: string
  readonly liveId: string
  readonly finalId: string
  readonly confirmed: boolean
  readonly bound: boolean
}

interface BoxAt {
  readonly t: number
  readonly box: TapeBox
}

interface Presence {
  readonly identity: string
  readonly fromT: number
  readonly toT: number
  readonly boxes: readonly BoxAt[]
}

function collectHits(
  truth: Truth,
  replay: ReplayResult,
  finalIdOf: (liveId: string) => string,
): readonly Hit[] {
  if (truth.frames.length !== replay.frames.length) {
    throw new Error(
      `truth has ${String(truth.frames.length)} frames, the replay ${String(replay.frames.length)}`,
    )
  }
  const hits: Hit[] = []
  truth.frames.forEach((tf, k) => {
    const identityByDet = new Map(tf.boxes.map((b) => [b.detectionId, b.identity]))
    for (const o of replay.frames[k]?.outputs ?? []) {
      let identity: string | undefined
      if (o.kind === 'bound' && o.detectionId !== undefined) {
        identity = identityByDet.get(o.detectionId)
      } else {
        let best = ANCHOR_IOU
        for (const b of tf.boxes) {
          const v = iou(b.box, o.box)
          if (v >= best) {
            best = v
            identity = b.identity
          }
        }
      }
      if (identity === undefined) continue
      hits.push({
        t: tf.t,
        identity,
        liveId: o.liveId,
        finalId: finalIdOf(o.liveId),
        confirmed: o.confirmed,
        bound: o.kind === 'bound',
      })
    }
  })
  return hits
}

function joinedByGap(
  gaps: readonly PresenceGap[],
  identity: string,
  fromT: number,
  toT: number,
): boolean {
  return gaps.some((g) => g.identity === identity && g.fromT <= fromT && g.toT >= toT)
}

function presencesOf(truth: Truth): readonly Presence[] {
  const byIdentity = new Map<string, BoxAt[]>()
  for (const f of truth.frames) {
    for (const b of f.boxes) {
      const list = byIdentity.get(b.identity) ?? []
      list.push({ t: f.t, box: b.box })
      byIdentity.set(b.identity, list)
    }
  }
  const out: Presence[] = []
  for (const [identity, boxes] of byIdentity) {
    let run: BoxAt[] = []
    const flush = (): void => {
      const first = run[0]
      const last = run[run.length - 1]
      if (first !== undefined && last !== undefined)
        out.push({ identity, fromT: first.t, toT: last.t, boxes: run })
      run = []
    }
    for (const b of boxes) {
      const prev = run[run.length - 1]
      if (
        prev !== undefined &&
        b.t - prev.t > PRESENCE_GAP_MS &&
        !joinedByGap(truth.presenceGaps, identity, prev.t, b.t)
      )
        flush()
      run.push(b)
    }
    flush()
  }
  return out
}

function hitsIn(hits: readonly Hit[], p: Presence): readonly Hit[] {
  return hits.filter((h) => h.identity === p.identity && h.t >= p.fromT && h.t <= p.toT)
}

function presenceOf(
  presences: readonly Presence[],
  identity: string,
  t: number,
): Presence | undefined {
  return presences.find((p) => p.identity === identity && t >= p.fromT && t <= p.toT)
}

function byFinalId(hits: readonly Hit[]): ReadonlyMap<string, readonly Hit[]> {
  const map = new Map<string, Hit[]>()
  for (const h of hits) map.set(h.finalId, [...(map.get(h.finalId) ?? []), h])
  for (const list of map.values()) list.sort((a, b) => a.t - b.t)
  return map
}

/** A single A→B hand-over while A's presence continues. Callers must check
 *  `isMerge` first — an alternating A→B→A final id is a merge, not a swap,
 *  even though its first leg alone would satisfy this check (plan decision
 *  8: one event is never counted as both). */
function isSwap(list: readonly Hit[], presences: readonly Presence[]): boolean {
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]
    const b = list[i]
    if (a === undefined || b === undefined || a.identity === b.identity) continue
    const pa = presenceOf(presences, a.identity, a.t)
    if (pa !== undefined && pa.toT > b.t) return true
  }
  return false
}

/** Inside one window: A, then B, then A again — a track alternating. */
function isMerge(list: readonly Hit[]): boolean {
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (a === undefined) continue
    let other: string | null = null
    for (let j = i + 1; j < list.length; j += 1) {
      const h = list[j]
      if (h === undefined || h.t - a.t > MERGE_WINDOW_MS) break
      if (other === null && h.identity !== a.identity) other = h.identity
      else if (other !== null && h.identity === a.identity) return true
    }
  }
  return false
}

function isStill(p: Presence, gaps: readonly PresenceGap[]): boolean {
  if (
    gaps.some(
      (g) =>
        g.identity === p.identity &&
        g.fromT >= p.fromT &&
        g.toT <= p.toT &&
        g.toT - g.fromT >= STATIONARY_MIN_MS,
    )
  ) {
    return true
  }
  let anchor: BoxAt | undefined
  for (const b of p.boxes) {
    if (anchor === undefined || iou(anchor.box, b.box) < ANCHOR_IOU) anchor = b
    else if (b.t - anchor.t >= STATIONARY_MIN_MS) return true
  }
  return false
}

/**
 * A second CONFIRMED provisional id for one identity within the window is a
 * duplicate — unless a finalisation fused it onto the earlier id first. This
 * counts birth-gate emissions (see the module comment), not live
 * notifications: a proxy ceiling, named as such.
 */
function duplicates(
  hits: readonly Hit[],
  replay: ReplayResult,
  finalIdOf: (liveId: string) => string,
): number {
  const confirmedAt = new Map<string, Map<string, number>>()
  for (const h of hits) {
    if (!h.bound || !h.confirmed) continue
    const perIdentity = confirmedAt.get(h.identity) ?? new Map<string, number>()
    if (!perIdentity.has(h.liveId)) perIdentity.set(h.liveId, h.t)
    confirmedAt.set(h.identity, perIdentity)
  }
  let count = 0
  for (const perIdentity of confirmedAt.values()) {
    const order = [...perIdentity].sort((x, y) => x[1] - y[1])
    order.forEach(([live, at], j) => {
      const duplicate = order.slice(0, j).some(([earlier, earlierAt]) => {
        if (at - earlierAt > DUPLICATE_WINDOW_MS) return false
        const target = finalIdOf(earlier)
        const fused = replay.finalisations.some(
          (f) => f.provisionalId === live && f.finalId === target && f.t <= at,
        )
        return !fused
      })
      if (duplicate) count += 1
    })
  }
  return count
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0
}

function latencies(truth: Truth, hits: readonly Hit[], replay: ReplayResult): readonly number[] {
  const firstBox = new Map<string, number>()
  for (const f of truth.frames)
    for (const b of f.boxes) if (!firstBox.has(b.identity)) firstBox.set(b.identity, f.t)
  const out: number[] = []
  for (const [identity, firstT] of firstBox) {
    const first = hits.find((h) => h.bound && h.identity === identity)
    if (first === undefined) continue
    const fin = replay.finalisations.find((f) => f.provisionalId === first.liveId && f.t >= first.t)
    out.push(fin === undefined ? 0 : fin.t - firstT)
  }
  return out.sort((a, b) => a - b)
}

export function computeOperatorMetrics(truth: Truth, replay: ReplayResult): OperatorMetrics {
  const finalIdOf = finalIdResolver(replay)
  const hits = collectHits(truth, replay, finalIdOf)
  const boundHits = hits.filter((h) => h.bound)
  const presences = presencesOf(truth)

  const idsPer = presences.map((p) => new Set(hitsIn(boundHits, p).map((h) => h.finalId)).size)
  const perFinal = byFinalId(boundHits)
  const finals = Math.max(1, perFinal.size)
  let swaps = 0
  let merges = 0
  // Mutually exclusive per plan decision 8 ("one event is never counted as
  // both"): an alternating A→B→A final id is a merge, never also a swap for
  // its A→B leg, so `isMerge` is checked first and `isSwap` only when it's
  // false.
  for (const list of perFinal.values()) {
    if (isMerge(list)) merges += 1
    else if (isSwap(list, presences)) swaps += 1
  }

  let breaks = 0
  for (const p of presences) {
    if (!isStill(p, truth.presenceGaps)) continue
    breaks += Math.max(0, new Set(hitsIn(hits, p).map((h) => h.finalId)).size - 1)
  }

  const identities = new Set(presences.map((p) => p.identity))
  let idsTotal = 0
  for (const identity of identities) {
    idsTotal += new Set(boundHits.filter((h) => h.identity === identity).map((h) => h.finalId)).size
  }
  const hours = presences.reduce((s, p) => s + (p.toT - p.fromT), 0) / 3_600_000
  const lat = latencies(truth, boundHits, replay)

  return {
    idsPerPresence: idsPer.reduce((s, x) => s + x, 0) / Math.max(1, idsPer.length),
    resplitShare: idsPer.filter((x) => x > 1).length / Math.max(1, idsPer.length),
    swapsPer100: (100 * swaps) / finals,
    mergesPer100: (100 * merges) / finals,
    stationaryBreaks: breaks,
    duplicateNotifications: duplicates(hits, replay, finalIdOf),
    finalIdLatencyP50: percentile(lat, 0.5),
    finalIdLatencyP95: percentile(lat, 0.95),
    tracksPerIdentityHour: hours > 0 ? idsTotal / hours : 0,
    unscorableTracks: truth.unscorableTracks,
  }
}
