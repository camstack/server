/**
 * Archive Review filters — zone, face / plate and debug — over the camera's
 * events in the timeline window. The class filter is the event list's own
 * kind menu; these three are the page's, because a key event row carries no
 * zone and no face flag: those come from the window's tracks
 * (`listTracks`, slim), matched to the row by `trackId`.
 *
 * The same predicate narrows the list AND feeds the density bar, so the two
 * can never disagree. A row whose track is not in the answer cannot be judged:
 * it is KEPT, never silently dropped, and the bar says how many such rows the
 * zone or identity filter did not check (`uncheckedRows`).
 */
import type { DensityPoint } from '@camstack/ui-library'
import type { KeyEventRow } from '../detection-intelligence/key-events-merge'

export type IdentityFilter = 'any' | 'face' | 'plate'

export interface ReviewFilters {
  /** A zone NAME, or null for every zone. */
  readonly zone: string | null
  readonly identity: IdentityFilter
  /** Only tracks an operator marked `debug`. */
  readonly debug: boolean
}

export const NO_REVIEW_FILTERS: ReviewFilters = { zone: null, identity: 'any', debug: false }

/** The track facts the filters read — a subset of the slim `Track`. */
export interface TrackFacts {
  readonly trackId: string
  readonly zoneNames?: readonly string[]
  readonly classes?: readonly string[]
  readonly hasFace?: boolean
}

export function factsByTrack(tracks: readonly TrackFacts[]): ReadonlyMap<string, TrackFacts> {
  return new Map(tracks.map((t) => [t.trackId, t]))
}

/** Every zone name the window's tracks visited, sorted. */
export function zonesVisited(tracks: readonly TrackFacts[]): readonly string[] {
  const names = new Set<string>()
  for (const track of tracks) for (const name of track.zoneNames ?? []) names.add(name)
  return [...names].sort((a, b) => a.localeCompare(b))
}

function matchesIdentity(facts: TrackFacts, identity: IdentityFilter): boolean {
  if (identity === 'any') return true
  const classes = facts.classes ?? []
  if (identity === 'face') return facts.hasFace === true || classes.includes('face')
  return classes.includes('plate')
}

/** The predicate the list and the density bar both apply. */
export function reviewRowFilter(
  filters: ReviewFilters,
  facts: ReadonlyMap<string, TrackFacts>,
): (row: KeyEventRow) => boolean {
  return (row) => {
    if (filters.debug && row.debug !== true) return false
    if (filters.zone === null && filters.identity === 'any') return true
    const track = facts.get(row.trackId)
    if (track === undefined) return true
    if (filters.zone !== null && !(track.zoneNames ?? []).includes(filters.zone)) return false
    return matchesIdentity(track, filters.identity)
  }
}

/** The page narrows by zone or identity: the filters that need a track's facts. */
export function needsTrackFacts(filters: ReviewFilters): boolean {
  return filters.zone !== null || filters.identity !== 'any'
}

/** Rows the zone / identity filter could not check: their track is not in the answer. */
export function uncheckedRows(
  rows: readonly KeyEventRow[],
  filters: ReviewFilters,
  facts: ReadonlyMap<string, TrackFacts>,
): number {
  if (!needsTrackFacts(filters)) return 0
  return rows.filter((row) => !facts.has(row.trackId)).length
}

/** The filtered rows as density points: an audio track is audio, the rest objects. */
export function densityPointsOf(rows: readonly KeyEventRow[]): readonly DensityPoint[] {
  return rows.map((row) => ({
    atMs: row.timestamp,
    kind: row.className === 'audio' ? 'audio' : 'object',
  }))
}
