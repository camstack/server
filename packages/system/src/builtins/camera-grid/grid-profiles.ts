/**
 * A grid publishes one composition PER PROFILE, each made of the matching
 * profile of every source, on the canvas that profile implies.
 *
 * ## The shape, and the two wrong ones before it
 *
 * D519 shipped a single `high` stream. Then came one composition per profile,
 * on a SCALED copy of a canvas the operator typed in — and the operator's
 * adaptive tore one down and built another at every rung, because each was a
 * whole separate composition with its own decodes and its own key-frame waits
 * (hub log, 2026-09-18: `mid` at 13:03:18, `low` at 13:03:28). D528 then
 * collapsed it to ONE output to stop the rebuilds, and that lost the adaptive
 * a rung to stand on.
 *
 * The rebuild was never the profiles' fault. It was that a rebuild used to mean
 * a blank screen for as long as the slowest source took to produce a key frame.
 * With the composition driven by an output clock (D530) a rebuild shows the
 * picture at once and fills the cells in, so three matched profiles cost what
 * they are worth and nothing more.
 *
 * ## 1:1, and the canvas follows
 *
 * A grid's `low` composes its sources' `low`; its `high` their `high`. Nothing
 * is chosen and nothing is mapped — which is what lets a viewer's adaptive do
 * its ordinary job without knowing a grid is a grid.
 *
 * The canvas is not typed in either: each profile derives its own from the
 * cells and the sources' size AT THAT PROFILE (`grid-canvas-derivation.ts`).
 * So the three outputs are each 1:1 with what they are made of, and the cost of
 * a rung is the cost of the pictures in it.
 *
 * ## What is refused
 *
 * A profile is offered only when EVERY source serves it. Not "at least one": a
 * cell whose source has no `low` cannot be filled, and a composition with a
 * hole reads to an operator as a broken camera, not as an unassigned profile
 * three cameras away. An UNKNOWN answer is a refusal, never an offer (D315).
 * The refusal names the sources, because "the grid has no low" is not a finding
 * — "101 has no low" is.
 */
import type { CamProfile } from '@camstack/types'
import { deriveGridCanvas } from './grid-canvas-derivation.js'
import type { PixelSize } from './grid-canvas.js'
import type { NormalizedRect } from './grid-filter-graph.js'

/**
 * One id per profile, for every grid, forever.
 *
 * D519's reason is what keeps `high`'s id bare: a newly-spelled id mints a
 * second cam-stream and orphans whatever profile assignment the operator had
 * made. `grid` was `high` on the live hub before any of this and still is.
 */
export const GRID_CAM_STREAM_ID = 'grid'

/** Every profile a grid can compose, in descending quality. */
export const GRID_PROFILES: readonly CamProfile[] = ['high', 'mid', 'low']

/** The cam-stream id a grid publishes for one profile. */
export function gridCamStreamId(profile: CamProfile): string {
  return profile === 'high' ? GRID_CAM_STREAM_ID : `${GRID_CAM_STREAM_ID}-${profile}`
}

/** One stream a camera serves, with the size the canvas is derived from. */
export interface ServedProfile {
  readonly profile: CamProfile
  readonly width: number
  readonly height: number
}

/** One cell: which part of which source, and where it lands. */
export interface GridSourceCell {
  readonly deviceId: number
  readonly source: NormalizedRect
  readonly cell: NormalizedRect
}

export interface GridProfilePlansInput {
  readonly cells: readonly GridSourceCell[]
  /**
   * Which profiles the operator wants published. A profile that is not in here
   * is still SIZED and reported — the editor shows what it would come out as,
   * so turning it on is a decision made with the number in view — but it is not
   * offered to the broker.
   */
  readonly publishedProfiles: readonly CamProfile[]
  /**
   * Which streams this source serves, or `null` when nobody could say. `null`
   * is not an empty list: an unanswerable question is a refusal, and saying so
   * separately keeps "we did not ask" out of the catalog.
   */
  readonly profilesServedBy: (deviceId: number) => readonly ServedProfile[] | null
}

export type GridProfilePlan =
  | {
      readonly profile: CamProfile
      readonly offered: true
      readonly canvas: PixelSize
      /** False ⇒ serviceable, sized, and deliberately not published. */
      readonly published: boolean
    }
  | {
      readonly profile: CamProfile
      readonly offered: false
      /** The sources that cannot serve it. Empty only when there are none at all. */
      readonly missingSources: readonly number[]
    }

/**
 * What this grid can honestly publish, per profile, with the canvas or the
 * refusal.
 *
 * Every profile gets a row whether it is offered or not: an absent row says
 * nothing, and the caller logging a refusal needs the reason more than the
 * caller publishing an offer needs the offer.
 */
export function gridProfilePlans(input: GridProfilePlansInput): readonly GridProfilePlan[] {
  const sourceDeviceIds = [...new Set(input.cells.map((cell) => cell.deviceId))]
  const servedBy = new Map<number, readonly ServedProfile[] | null>()
  for (const deviceId of sourceDeviceIds) servedBy.set(deviceId, input.profilesServedBy(deviceId))

  return GRID_PROFILES.map((profile): GridProfilePlan => {
    if (sourceDeviceIds.length === 0) return { profile, offered: false, missingSources: [] }
    const sizeBySource = new Map<number, PixelSize>()
    const missingSources: number[] = []
    for (const deviceId of sourceDeviceIds) {
      const served = servedBy.get(deviceId) ?? null
      const match = served?.find((entry) => entry.profile === profile)
      // A stream the broker lists with no size cannot size a canvas, and a
      // canvas guessed from one number and defaulted for the other is a picture
      // nobody drew. Treated as not served, and named.
      if (match === undefined || match.width <= 0 || match.height <= 0) {
        missingSources.push(deviceId)
        continue
      }
      sizeBySource.set(deviceId, { width: match.width, height: match.height })
    }
    if (missingSources.length > 0) return { profile, offered: false, missingSources }

    const canvas = deriveGridCanvas(
      input.cells.map((cell) => ({
        source: cell.source,
        cell: cell.cell,
        sourceSize: sizeBySource.get(cell.deviceId) ?? { width: 0, height: 0 },
      })),
    )
    // Every source serves the profile and still nothing could be sized: every
    // rectangle is degenerate. Not a missing source — a layout with no picture
    // in it.
    if (canvas === null) return { profile, offered: false, missingSources: [] }
    return { profile, offered: true, canvas, published: input.publishedProfiles.includes(profile) }
  })
}
