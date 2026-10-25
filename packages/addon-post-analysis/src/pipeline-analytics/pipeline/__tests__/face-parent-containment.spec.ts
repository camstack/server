/**
 * A face is bound to the body that contains it — see the module docblock for
 * the measured episode this closes.
 */
import { describe, expect, it } from 'vitest'

import { faceIsInsideParent } from '../face-parent-containment.js'

/** The adult's body box on device 107, from the real frame. */
const ADULT = { x: 1564, y: 474, w: 730, h: 1009 }
/** The child's face, in frame space, at the same instant. */
const CHILD_FACE = { x: 1478, y: 323, w: 120, h: 133 }

describe('faceIsInsideParent', () => {
  it('REFUSES the measured case — the face the padding reached', () => {
    // Cut exactly on the padded crop's top edge (322.65 vs 322.62), entirely
    // above the adult's own box. This single assertion is the defect.
    expect(faceIsInsideParent(CHILD_FACE, ADULT)).toBe(false)
  })

  it('accepts a face where a face belongs — high in its own body', () => {
    expect(faceIsInsideParent({ x: 1750, y: 520, w: 120, h: 133 }, ADULT)).toBe(true)
  })

  it('accepts a face box that OVERHANGS the top, as long as its centre is in', () => {
    // A person box clipped at the crown is ordinary. An area threshold strict
    // enough to reject a neighbour would reject this too, which is why the rule
    // is the centre and not a fraction.
    expect(faceIsInsideParent({ x: 1750, y: 440, w: 120, h: 133 }, ADULT)).toBe(true)
  })

  it('refuses a face whose centre has left the body, even while it overlaps', () => {
    // Overlapping is not belonging: the neighbour's face can clip the edge of
    // this body and still be the neighbour's.
    expect(faceIsInsideParent({ x: 1500, y: 474, w: 120, h: 133 }, ADULT)).toBe(false)
  })

  it('refuses a degenerate box rather than binding it to whoever asked first', () => {
    expect(faceIsInsideParent({ x: 1750, y: 520, w: 0, h: 133 }, ADULT)).toBe(false)
    expect(faceIsInsideParent({ x: 1750, y: 520, w: 120, h: 133 }, { ...ADULT, h: 0 })).toBe(false)
  })

  it('does NOT pretend to settle a face inside two bodies at once', () => {
    // The second half of the defect: the child standing within the adult's
    // outstretched arms. Both contain it, and geometry has nothing left to say
    // — that one wants exclusivity between siblings.
    // The center of the face is (1538, 389.5): both boxes contain it.
    const wideAdult = { x: 1400, y: 300, w: 1100, h: 1300 }
    expect(faceIsInsideParent(CHILD_FACE, wideAdult)).toBe(true)
    expect(faceIsInsideParent(CHILD_FACE, { x: 1450, y: 300, w: 200, h: 400 })).toBe(true)
  })
})
