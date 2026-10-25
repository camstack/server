/**
 * Three compositions, each 1:1 with the profile it is made of.
 *
 * A grid's `low` composes its sources' `low`, on the canvas their `low`
 * implies. Nothing is chosen and nothing is mapped, which is what lets a
 * viewer's adaptive do its ordinary job without knowing a grid is a grid.
 *
 * Two earlier shapes are the reason this one is written down. One composition
 * per profile over a canvas the operator TYPED made every adaptive rung a full
 * rebuild; collapsing to a single output stopped the rebuilds and took away the
 * rung. The rebuild was never the profiles' fault — it was that a rebuild meant
 * a blank screen until the slowest source produced a key frame, and an output
 * clock (D530) removed that.
 */
import { describe, expect, it } from 'vitest'
import {
  GRID_CAM_STREAM_ID,
  GRID_PROFILES,
  gridCamStreamId,
  gridProfilePlans,
} from '../grid-profiles.js'
import type { GridProfilePlan, ServedProfile } from '../grid-profiles.js'

/** What the live cameras actually serve. */
const REAL: readonly ServedProfile[] = [
  { profile: 'low', width: 640, height: 360 },
  { profile: 'mid', width: 896, height: 512 },
  { profile: 'high', width: 3840, height: 2160 },
]

function served(map: Readonly<Record<number, readonly ServedProfile[] | null>>) {
  return (deviceId: number): readonly ServedProfile[] | null => map[deviceId] ?? null
}

function plan(plans: readonly GridProfilePlan[], profile: string): GridProfilePlan {
  const found = plans.find((p) => p.profile === profile)
  if (!found) throw new Error(`no row for ${profile}`)
  return found
}

/** The live grid: two cells, each half the canvas, each showing half its source. */
const LIVE_CELLS = [
  {
    deviceId: 107,
    source: { x: 0, y: 0, width: 0.5, height: 1 },
    cell: { x: 0, y: 0, width: 0.5, height: 1 },
  },
  {
    deviceId: 108,
    source: { x: 0.5, y: 0, width: 0.5, height: 1 },
    cell: { x: 0.5, y: 0, width: 0.5, height: 1 },
  },
]

describe('ids', () => {
  it('keeps the bare id for HIGH — an operator assignment must not be orphaned', () => {
    expect(gridCamStreamId('high')).toBe(GRID_CAM_STREAM_ID)
  })

  it('gives each profile its OWN id — two streams under one id is one stream', () => {
    const ids = GRID_PROFILES.map((p) => gridCamStreamId(p))
    expect(new Set(ids).size).toBe(GRID_PROFILES.length)
  })
})

describe('gridProfilePlans', () => {
  it('sizes each profile from the sources AT THAT PROFILE', () => {
    const plans = gridProfilePlans({
      publishedProfiles: GRID_PROFILES,
      cells: LIVE_CELLS,
      profilesServedBy: served({ 107: REAL, 108: REAL }),
    })
    expect(plan(plans, 'high')).toEqual({
      profile: 'high',
      offered: true,
      canvas: { width: 3840, height: 2160 },
      published: true,
    })
    expect(plan(plans, 'mid')).toEqual({
      profile: 'mid',
      offered: true,
      canvas: { width: 896, height: 512 },
      published: true,
    })
    expect(plan(plans, 'low')).toEqual({
      profile: 'low',
      offered: true,
      canvas: { width: 640, height: 360 },
      published: true,
    })
  })

  it('offers a profile only when EVERY source serves it, and NAMES who cannot', () => {
    const plans = gridProfilePlans({
      publishedProfiles: GRID_PROFILES,
      cells: LIVE_CELLS,
      profilesServedBy: served({
        107: REAL,
        108: [{ profile: 'high', width: 3840, height: 2160 }],
      }),
    })
    expect(plan(plans, 'high').offered).toBe(true)
    const low = plan(plans, 'low')
    expect(low.offered).toBe(false)
    expect(low.offered === false && low.missingSources).toEqual([108])
  })

  it('treats an UNKNOWN source as a refusal on every profile (D315)', () => {
    const plans = gridProfilePlans({
      publishedProfiles: GRID_PROFILES,
      cells: LIVE_CELLS,
      profilesServedBy: served({ 107: REAL, 108: null }),
    })
    for (const p of plans) expect(p.offered).toBe(false)
  })

  it("refuses a stream the broker lists with NO size — a half-guessed canvas is nobody's picture", () => {
    const plans = gridProfilePlans({
      publishedProfiles: GRID_PROFILES,
      cells: LIVE_CELLS,
      profilesServedBy: served({
        107: REAL,
        108: [{ profile: 'low', width: 0, height: 0 }],
      }),
    })
    const low = plan(plans, 'low')
    expect(low.offered).toBe(false)
    expect(low.offered === false && low.missingSources).toEqual([108])
  })

  it('answers about EVERY profile, offered or not — a missing row says nothing', () => {
    const plans = gridProfilePlans({
      publishedProfiles: GRID_PROFILES,
      cells: [],
      profilesServedBy: () => null,
    })
    expect(plans.map((p) => p.profile)).toEqual([...GRID_PROFILES])
    for (const p of plans) expect(p.offered).toBe(false)
  })

  it('offers nothing for a grid with no cells, and blames no source for it', () => {
    const plans = gridProfilePlans({
      publishedProfiles: GRID_PROFILES,
      cells: [],
      profilesServedBy: () => null,
    })
    for (const p of plans) expect(p.offered === false && p.missingSources).toEqual([])
  })
})
