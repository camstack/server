/**
 * Follow-up 102, F3 withdrawn (fix round 1): an UNCONFIRMED competitor — a 1–2-hit
 * stub, active or coasting — still raises competitor doubt against a CONFIRMED
 * owner of the box.
 *
 * On the frame of the doubt a detector flicker beside a car (scene C) and a
 * real second car whose companion box was missed (scenes M1–M3) are the same
 * input. Handing the box to the confirmed id mixed the two cars of M1/M2; an
 * extra id is the operator's preferred failure (D683: in doubt it splits).
 *
 * Disarm: exempt an unconfirmed competitor of a confirmed active owner in
 * `auditCompetitors` (the reverted F3): both tests below go RED.
 */
import type { BoundingBox } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type AssocConfig,
  type AssocDetection,
  type AssocTracklet,
  associate,
} from '../association.js'

const CFG: AssocConfig = {
  iouThreshold: 0.3,
  classGating: true,
  classGroupAssoc: true,
  animalOverPersonMaxScore: 0.6,
  dedupSpawnIou: 0.6,
  appearanceResolvesAmbiguity: false,
}

const car = (x: number): BoundingBox => ({ x, y: 500, w: 400, h: 250 })

function trk(id: string, b: BoundingBox, over: Partial<AssocTracklet> = {}): AssocTracklet {
  return {
    id,
    klass: 'vehicle',
    mode: 'active',
    confirmed: true,
    inDoubt: false,
    cohort: null,
    lastBox: b,
    predicted: b,
    appearance: null,
    ...over,
  }
}

function det(b: BoundingBox): AssocDetection {
  return { klass: 'vehicle', score: 0.8, bbox: b, nativeRecovery: false, continuationOnly: false }
}

// The box at 1055 costs the car at 1000 0.242 and the stub at 1120 0.280: 0.038 apart.
const BOX = car(1055)
const CAR = car(1000)
const STUB = car(1120)

describe('an unconfirmed stub is still doubt against a confirmed owner (F3 withdrawn)', () => {
  it('an active stub competing for the confirmed car’s box: both end, the box becomes a piece', () => {
    const r = associate([trk('car', CAR), trk('stub', STUB, { confirmed: false })], [det(BOX)], CFG)
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tests).toEqual(['competitor'])
  })

  it('a coasting stub: the same', () => {
    const stub = trk('stub', STUB, { confirmed: false, mode: 'coasting' })
    const r = associate([trk('car', CAR), stub], [det(BOX)], CFG)
    expect(r.pairs).toEqual([])
    expect(r.ambiguous[0]?.tests).toEqual(['competitor'])
  })
})
