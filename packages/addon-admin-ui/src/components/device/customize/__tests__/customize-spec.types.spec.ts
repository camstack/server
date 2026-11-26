import { describe, expect, it } from 'vitest'
import { CUSTOMIZE_REGISTRY } from '../customize-registry'
import type { CustomizeKindSpec } from '../customize-spec'

const base = CUSTOMIZE_REGISTRY['field-override']

describe('CustomizeKindSpec requires every piece', () => {
  it('compiles a spec that declares a gap with the named piece', () => {
    const ok: CustomizeKindSpec = { ...base, stamp: { gap: { piece: 'stamp', phase: 2 } } }
    expect(ok.kind).toBe('field-override')
  })

  it('refuses a spec missing a piece, a gap for another piece and an unknown phase', () => {
    // @ts-expect-error the stamp piece is missing and no gap declares it
    const missing: CustomizeKindSpec = {
      kind: base.kind,
      storage: base.storage,
      owner: base.owner,
      linkedSide: base.linkedSide,
    }
    const wrongPiece: CustomizeKindSpec = {
      ...base,
      // @ts-expect-error a gap on the stamp must name the stamp piece
      stamp: { gap: { piece: 'linkedSide', phase: 2 } },
    }
    const wrongPhase: CustomizeKindSpec = {
      ...base,
      // @ts-expect-error a gap is removed in phase 2 or 3 only
      stamp: { gap: { piece: 'stamp', phase: 4 } },
    }
    const noDiscriminant: CustomizeKindSpec = {
      ...base,
      // @ts-expect-error the discriminant is required, as a value or a gap
      storage: { shape: 'composition-feature' },
    }
    expect([missing, wrongPiece, wrongPhase, noDiscriminant]).toHaveLength(4)
  })
})
