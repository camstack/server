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
  'follow-switch': ['linkedSide:3'],
  'keyed-items': ['linkedSide:3'],
  event: ['linkedSide:3'],
  'config-extension': ['linkedSide:3'],
  'cap-link': ['linkedSide:3'],
  'linked-devices': [],
  'linked-actions': ['linkedSide:3'],
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

/** A piece the spec says a kind does not have must say why: an empty reason is a gap in disguise. */
function reasonsOf(spec: CustomizeKindSpec): readonly string[] {
  const slots = [
    spec.storage.discriminant,
    spec.owner.dialog,
    spec.owner.remove,
    spec.owner.enabled,
  ]
  return slots.flatMap((piece) => {
    if ('notNeeded' in piece) return [piece.notNeeded]
    if ('notTogglable' in piece) return [piece.notTogglable]
    return []
  })
}

describe('Customize registry (D1098 phase 2b): one owner shape for every kind', () => {
  it.each(CUSTOMIZE_KINDS)('%s: a missing piece names its reason', (kind) => {
    for (const reason of reasonsOf(CUSTOMIZE_REGISTRY[kind])) {
      expect(reason.trim().length).toBeGreaterThan(20)
    }
  })

  it.each(
    CUSTOMIZE_KINDS,
  )('%s: its stamp is read, sent and chained as expectedUpdatedAt', (kind) => {
    const { stamp } = CUSTOMIZE_REGISTRY[kind]
    if ('gap' in stamp) throw new Error(`${kind} lacks a stamp`)
    expect(stamp.present.field).toBe('expectedUpdatedAt')
  })

  it('only follow-switch and config-extension may skip the dialog or the remove', () => {
    const skipping = CUSTOMIZE_KINDS.filter((kind) => {
      const { owner } = CUSTOMIZE_REGISTRY[kind]
      return 'notNeeded' in owner.dialog || 'notNeeded' in owner.remove
    })
    expect(skipping).toEqual(['follow-switch', 'config-extension'])
  })
})
