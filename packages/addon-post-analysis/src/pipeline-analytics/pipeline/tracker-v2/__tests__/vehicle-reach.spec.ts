/**
 * Follow-up 102, F2 WITHDRAWN (fix round 1): a vehicle's link reach stays
 * 0.75 × the PREDECESSOR's diagonal.
 *
 * Measured on the larger of the two boxes, it made a car turning in toward the
 * camera (550 px, area ×2.2) one track — and fused two different cars in
 * sequence 450–600 px apart (review H2). Narrowed to a vehicle approaching
 * along its own motion within half a second, it still fused a different car
 * appearing ahead of a vanished one, which is the turning car frame for frame.
 * Extra ids over mix-ups: the turning car is two ids, refused by `reach` —
 * and that refusal of a confirmed predecessor is logged unsampled (F5).
 *
 * Disarm: the larger box (either variant): "the car turning in is refused by
 * reach" goes RED here, and (S) in `followup-102-scenes.spec.ts`.
 */
import type { BoundingBox } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { LINK_VEHICLE_REACH_DIAGONALS } from '../constants.js'
import { diagonal } from '../geometry.js'
import {
  confirmedPredecessorRejections,
  DeferredLinker,
  type LinkerConfig,
  type LinkPiece,
  linkReach,
} from '../linker.js'
import type { LinkDecisionFacts } from '../types.js'

const CFG: LinkerConfig = { maxMissedMs: 4000, appearanceResolvesAmbiguity: false }

const FAR: BoundingBox = { x: 1000, y: 200, w: 480, h: 300 }
/** The same car ×2.2 in area, centred 550 px down-right of FAR (440, 330). */
const NEAR: BoundingBox = (() => {
  const w = 480 * Math.sqrt(2.2)
  const h = 300 * Math.sqrt(2.2)
  return { x: FAR.x + FAR.w / 2 + 440 - w / 2, y: FAR.y + FAR.h / 2 + 330 - h / 2, w, h }
})()

function car(id: string, over: Partial<LinkPiece>): LinkPiece {
  return {
    id,
    klass: 'vehicle',
    startedAt: 0,
    lastSeenAt: 0,
    endedAt: null,
    endReason: null,
    confirmed: true,
    contested: false,
    faceBearing: false,
    firstFaceAt: null,
    identity: null,
    firstBox: { ...FAR, x: FAR.x - 225 },
    lastBox: FAR,
    appearance: null,
    lineage: { kind: 'birth' },
    ...over,
  }
}

describe('vehicle reach stays on the predecessor (F2 withdrawn)', () => {
  it('linkReach is 0.75 × the predecessor’s diagonal, whatever the successor', () => {
    expect(linkReach(car('a', {}), 130)).toBeCloseTo(
      LINK_VEHICLE_REACH_DIAGONALS * diagonal(FAR),
      6,
    )
  })

  it('the car turning in is refused by reach — an accepted extra id, logged as a confirmed rejection', () => {
    const facts: LinkDecisionFacts[] = []
    const far = car('far', { lastSeenAt: 1000, endedAt: 1000, endReason: 'missed' })
    const near = car('near', {
      startedAt: 1130,
      lastSeenAt: 6000,
      firstBox: NEAR,
      lastBox: { ...NEAR, x: NEAR.x + 140, y: NEAR.y + 84 },
    })
    expect(new DeferredLinker(CFG, (f) => facts.push(f)).step(30_000, [far, near])).toEqual([])
    const decided = facts.find((f) => f.kind === 'new' && f.to === 'near')
    expect(confirmedPredecessorRejections(decided?.candidates)).toEqual([
      { from: 'far', rejected: 'reach', gapMs: 130 },
    ])
  })
})
