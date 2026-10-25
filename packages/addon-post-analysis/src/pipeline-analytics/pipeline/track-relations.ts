/**
 * The ONE body behind `setTrackRelation` & co. (cap, viewer) and
 * `debug.gt.*` (custom actions, admin) — D681, spec §4.3. Extracted like
 * `track-flags.ts`, so it is testable from the store contract alone.
 *
 * Contradictions are refused at write time and NAMED: a `different-subjects`
 * between two tracks a chain of `same-subject` marks already joins is either a
 * mistake now or a mistake then, and the operator is the only one who knows
 * which. The same holds in the other direction.
 *
 * A mark on a mixed track may name its side; the side is part of the node the
 * contradiction check walks (`A#before` and `A#after` are two subjects).
 */
import {
  type ClearTrackRelationInput,
  type ClearTrackRelationResult,
  type ListTrackRelationsInput,
  type ListTrackRelationsResult,
  MAX_TRACK_PURITIES,
  MAX_TRACK_RELATIONS,
  type SetTrackPurityInput,
  type SetTrackPurityResult,
  type SetTrackRelationInput,
  TRACK_RELATIONS_DEFAULT_LIMIT,
  type TrackPurity,
  type TrackRelation,
  type TrackRelationKind,
  type TrackRelationRefusal,
  type TrackSide,
} from '@camstack/types'
import { relationRowId, type TrackRelationsStore } from '../store/track-relations-store.js'

export interface TrackFacts {
  readonly trackId: string
  readonly deviceId: number
  readonly firstSeen: number
  readonly lastSeen: number
}

export type TrackRelationsPort = Pick<
  TrackRelationsStore,
  | 'getRelation'
  | 'putRelation'
  | 'deleteRelation'
  | 'relationsForDevice'
  | 'getPurity'
  | 'putPurity'
  | 'deletePurity'
  | 'puritiesForDevice'
>

export interface TrackRelationsDeps {
  readonly store: TrackRelationsPort
  /** Live track, stored track, or a promoted tape of the camera that names it. */
  readonly resolveTrack: (trackId: string) => Promise<TrackFacts | null>
  /** Sets `debug: true` through `applyTrackFlags`; a track only a tape knows is skipped and logged by the caller. */
  readonly markDebug: (deviceId: number, trackId: string) => Promise<void>
  readonly now: () => number
  readonly author: string | null
}

export class TrackRelationRefusedError extends Error {
  constructor(
    readonly code: TrackRelationRefusal,
    detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'TrackRelationRefusedError'
  }
}

export type TrackFactsSource = (trackId: string) => Promise<TrackFacts | null>

/** The first source that knows the track — live, then stored, then a tape. */
export async function firstTrackFacts(
  trackId: string,
  sources: readonly TrackFactsSource[],
): Promise<TrackFacts | null> {
  for (const source of sources) {
    const facts = await source(trackId)
    if (facts !== null) return facts
  }
  return null
}

async function knownOnDevice(
  deps: TrackRelationsDeps,
  deviceId: number,
  trackId: string,
): Promise<TrackFacts> {
  const facts = await deps.resolveTrack(trackId)
  if (facts === null)
    throw new TrackRelationRefusedError('unknown-track', `track ${trackId} is not known`)
  if (facts.deviceId !== deviceId) {
    throw new TrackRelationRefusedError(
      'cross-device',
      `track ${trackId} belongs to camera ${String(facts.deviceId)}`,
    )
  }
  return facts
}

function node(trackId: string, side: TrackSide | null): string {
  return side === null ? trackId : `${trackId}#${side}`
}

/** Adjacency of `same-subject` marks. */
function sameSubjectGraph(
  relations: readonly TrackRelation[],
): ReadonlyMap<string, readonly string[]> {
  const g = new Map<string, string[]>()
  const link = (a: string, b: string): void => {
    g.set(a, [...(g.get(a) ?? []), b])
  }
  for (const r of relations) {
    if (r.relation !== 'same-subject') continue
    const a = node(r.leftTrackId, r.leftSide)
    const b = node(r.rightTrackId, r.rightSide)
    link(a, b)
    link(b, a)
  }
  return g
}

/** Shortest same-subject path from → to, or null. */
function chain(
  g: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): readonly string[] | null {
  const prev = new Map<string, string>([[from, from]])
  const queue = [from]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === undefined) break
    if (cur === to) {
      const path = [to]
      let at = to
      while (at !== from) {
        at = prev.get(at) ?? from
        path.unshift(at)
      }
      return path
    }
    for (const next of g.get(cur) ?? []) {
      if (prev.has(next)) continue
      prev.set(next, cur)
      queue.push(next)
    }
  }
  return null
}

function component(g: ReadonlyMap<string, readonly string[]>, start: string): ReadonlySet<string> {
  const seen = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    const cur = queue.shift()
    if (cur === undefined) break
    for (const next of g.get(cur) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

/**
 * Refuse a mark that contradicts what `others` (every OTHER stored relation on
 * the device) already says — in either direction:
 *
 *  - `different-subjects` between two nodes a chain of `same-subject` marks
 *    already joins (the chain is named in the error);
 *  - `same-subject` between two nodes whose components a `different-subjects`
 *    row already keeps apart (the mirror).
 */
function checkContradiction(
  others: readonly TrackRelation[],
  relation: TrackRelationKind,
  a: string,
  b: string,
): void {
  const g = sameSubjectGraph(others)
  if (relation === 'different-subjects') {
    const path = chain(g, a, b)
    if (path !== null) {
      throw new TrackRelationRefusedError(
        'contradiction',
        `${path.join(' → ')} are marked the same subject`,
      )
    }
    return
  }
  const left = component(g, a)
  const right = component(g, b)
  const apart = others.find((r) => {
    if (r.relation !== 'different-subjects') return false
    const x = node(r.leftTrackId, r.leftSide)
    const y = node(r.rightTrackId, r.rightSide)
    return (left.has(x) && right.has(y)) || (left.has(y) && right.has(x))
  })
  if (apart !== undefined) {
    throw new TrackRelationRefusedError(
      'contradiction',
      `${apart.leftTrackId} and ${apart.rightTrackId} are marked different subjects`,
    )
  }
}

/** Canonical left/right assembly — the row is keyed by the unordered pair, so
 *  which side is "mine" in the input must not affect which side is `left`. */
function buildRelationRow(
  input: SetTrackRelationInput,
  mine: TrackFacts,
  other: TrackFacts,
  id: string,
  existing: TrackRelation | null,
  now: number,
  author: string | null,
): TrackRelation {
  const mineIsLeft = input.trackId < input.otherTrackId
  const [l, r] = mineIsLeft ? [mine, other] : [other, mine]
  const [lSide, rSide] = mineIsLeft
    ? [input.trackSide ?? null, input.otherSide ?? null]
    : [input.otherSide ?? null, input.trackSide ?? null]
  return {
    id,
    deviceId: input.deviceId,
    leftTrackId: l.trackId,
    rightTrackId: r.trackId,
    leftSide: lSide,
    rightSide: rSide,
    relation: input.relation,
    presence: input.presence ?? null,
    leftStartedAt: l.firstSeen,
    rightStartedAt: r.firstSeen,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    author,
  }
}

export async function setTrackRelation(
  deps: TrackRelationsDeps,
  input: SetTrackRelationInput,
): Promise<TrackRelation> {
  if (input.trackId === input.otherTrackId) {
    throw new TrackRelationRefusedError('self-relation', 'a track cannot be related to itself')
  }
  const mine = await knownOnDevice(deps, input.deviceId, input.trackId)
  const other = await knownOnDevice(deps, input.deviceId, input.otherTrackId)
  const id = relationRowId(input.trackId, input.otherTrackId)
  const others = (await deps.store.relationsForDevice(input.deviceId, MAX_TRACK_RELATIONS)).filter(
    (r) => r.id !== id,
  )
  const a = node(input.trackId, input.trackSide ?? null)
  const b = node(input.otherTrackId, input.otherSide ?? null)
  checkContradiction(others, input.relation, a, b)
  const existing = await deps.store.getRelation(id)
  const row = buildRelationRow(input, mine, other, id, existing, deps.now(), deps.author)
  await deps.store.putRelation(row)
  await deps.markDebug(input.deviceId, input.trackId)
  await deps.markDebug(input.deviceId, input.otherTrackId)
  return row
}

/**
 * Refuses `cross-device`: a relation row carries its own `deviceId` from when
 * it was written, and a device that doesn't own it must not be able to clear
 * it purely by guessing the two track ids (`relationRowId` is device-blind).
 * Checked against the STORED row's device, never `resolveTrack` — the tracks a
 * relation names may already be long gone by the time it is cleared, and this
 * must keep working then.
 */
export async function clearTrackRelation(
  deps: TrackRelationsDeps,
  input: ClearTrackRelationInput,
): Promise<ClearTrackRelationResult> {
  const id = relationRowId(input.trackId, input.otherTrackId)
  const existing = await deps.store.getRelation(id)
  if (existing === null) return { cleared: false }
  if (existing.deviceId !== input.deviceId) {
    throw new TrackRelationRefusedError(
      'cross-device',
      `relation ${id} belongs to camera ${String(existing.deviceId)}`,
    )
  }
  return { cleared: await deps.store.deleteRelation(id) }
}

export async function setTrackPurity(
  deps: TrackRelationsDeps,
  input: SetTrackPurityInput,
): Promise<SetTrackPurityResult> {
  if (input.purity !== 'mixed' && input.switchAtMs !== undefined) {
    throw new TrackRelationRefusedError(
      'switch-needs-mixed',
      `switchAtMs only applies to purity "mixed", not "${input.purity}"`,
    )
  }
  const facts = await knownOnDevice(deps, input.deviceId, input.trackId)
  if (input.purity === 'pure') {
    await deps.store.deletePurity(input.trackId)
    return { purity: null }
  }
  const switchAtMs = input.switchAtMs ?? null
  if (switchAtMs !== null && (switchAtMs < facts.firstSeen || switchAtMs > facts.lastSeen)) {
    throw new TrackRelationRefusedError(
      'switch-outside-track',
      `the switch must lie inside ${String(facts.firstSeen)}–${String(facts.lastSeen)}`,
    )
  }
  const existing = await deps.store.getPurity(input.trackId)
  const now = deps.now()
  const row: TrackPurity = {
    id: input.trackId,
    deviceId: input.deviceId,
    sourceTrackId: input.trackId,
    purity: input.purity,
    switchAtMs,
    startedAt: facts.firstSeen,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    author: deps.author,
  }
  await deps.store.putPurity(row)
  await deps.markDebug(input.deviceId, input.trackId)
  return { purity: row }
}

export async function listTrackRelations(
  deps: TrackRelationsDeps,
  input: ListTrackRelationsInput,
): Promise<ListTrackRelationsResult> {
  const limit = input.limit ?? TRACK_RELATIONS_DEFAULT_LIMIT
  const inWindow = (at: number | null): boolean =>
    at === null ||
    ((input.since === undefined || at >= input.since) &&
      (input.until === undefined || at <= input.until))
  const names = (trackA: string, trackB: string): boolean =>
    input.trackId === undefined || input.trackId === trackA || input.trackId === trackB
  const relations = (
    await deps.store.relationsForDevice(input.deviceId, MAX_TRACK_RELATIONS)
  ).filter(
    (r) =>
      names(r.leftTrackId, r.rightTrackId) &&
      (inWindow(r.leftStartedAt) || inWindow(r.rightStartedAt)),
  )
  const purities = (await deps.store.puritiesForDevice(input.deviceId, MAX_TRACK_PURITIES)).filter(
    (p) =>
      (input.trackId === undefined || input.trackId === p.sourceTrackId) && inWindow(p.startedAt),
  )
  return {
    relations: relations.slice(0, limit),
    purities: purities.slice(0, limit),
    truncated: relations.length > limit || purities.length > limit,
  }
}
