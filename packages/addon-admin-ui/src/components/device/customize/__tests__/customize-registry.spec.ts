import { describe, expect, it } from 'vitest'
import { CUSTOMIZE_REGISTRY, customizeSpecs } from '../customize-registry'
import {
  CUSTOMIZE_KINDS,
  CUSTOMIZE_PIECES,
  type CustomizeKind,
  type CustomizeKindSpec,
  type CustomizePiece,
  gapsOf,
  implsOf,
} from '../customize-spec'

/** The piece each declared gap sits in, by the spec slot it is read from. */
function gapSlots(spec: CustomizeKindSpec): readonly (readonly [CustomizePiece, unknown])[] {
  return [
    ['discriminant', spec.storage.discriminant],
    ['ownerRow', spec.owner.row],
    ['dialog', spec.owner.dialog],
    ['remove', spec.owner.remove],
    ['enabled', spec.owner.enabled],
    ['linkedSide', spec.linkedSide],
    ['stamp', spec.stamp],
  ]
}

/** What phase 2 and 3 remove: each change to this list is a deliberate diff. */
const EXPECTED_GAPS: Readonly<Record<CustomizeKind, readonly string[]>> = {
  'field-override': ['linkedSide:3'],
  'power-source': ['linkedSide:3'],
  'lock-door-sensor': ['linkedSide:3'],
  'follow-switch': ['dialog:2', 'remove:2', 'linkedSide:3'],
  'keyed-items': ['enabled:2', 'linkedSide:3'],
  event: ['linkedSide:3'],
  'config-extension': ['dialog:2', 'remove:2', 'enabled:2', 'linkedSide:3'],
  'cap-link': ['dialog:2', 'remove:2', 'enabled:2', 'linkedSide:3'],
  'linked-devices': [],
  'linked-actions': ['discriminant:2', 'dialog:2', 'remove:2', 'enabled:2', 'linkedSide:3'],
  'triggered-by': ['linkedSide:3'],
}

describe('Customize registry (D1098 phase 1)', () => {
  it('has exactly one entry per listed kind, under its own name', () => {
    expect(Object.keys(CUSTOMIZE_REGISTRY).toSorted()).toEqual([...CUSTOMIZE_KINDS].toSorted())
    for (const kind of CUSTOMIZE_KINDS) {
      expect(CUSTOMIZE_REGISTRY[kind]?.kind).toBe(kind)
    }
  })

  it.each(CUSTOMIZE_KINDS)('%s: every wired piece resolves to an implementation', (kind) => {
    const spec = CUSTOMIZE_REGISTRY[kind]
    expect(spec).toBeDefined()
    for (const impl of implsOf(spec)) {
      expect(impl).toBeDefined()
      expect(impl).not.toBeNull()
    }
    expect(spec.storage.shape).toBeTruthy()
  })

  it('declares each gap in the slot it names, in phase 2 or 3', () => {
    for (const spec of customizeSpecs()) {
      for (const [slot, piece] of gapSlots(spec)) {
        if (typeof piece !== 'object' || piece === null || !('gap' in piece)) continue
        const g = piece.gap
        expect(g).toMatchObject({ piece: slot })
      }
      for (const g of gapsOf(spec)) {
        expect(CUSTOMIZE_PIECES).toContain(g.piece)
        expect([2, 3]).toContain(g.phase)
      }
    }
  })

  it.each(CUSTOMIZE_KINDS)('%s: declares exactly the expected gaps', (kind) => {
    const got = gapsOf(CUSTOMIZE_REGISTRY[kind]).map((g) => `${g.piece}:${g.phase}`)
    expect(got.toSorted()).toEqual([...EXPECTED_GAPS[kind]].toSorted())
  })
})
