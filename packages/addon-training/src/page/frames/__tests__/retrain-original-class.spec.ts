import { describe, expect, it } from 'vitest'
import type { BoxDiff } from '../lib/retrain-live-review.js'
import { originalClassText } from '../lib/retrain-original-class.js'
import { OFFERED_MACRO_CLASSES } from '../RetrainSubjectRow.js'

const diff = (over: Partial<BoxDiff>): BoxDiff => ({
  kind: 'reclassified',
  approximate: false,
  ...over,
})

describe('originalClassText', () => {
  it('same macro: original label to new label', () => {
    expect(
      originalClassText(diff({ originMacroClass: 'animal', originLabel: 'cat' }), 'animal', 'dog'),
    ).toEqual({ original: 'cat', current: 'dog' })
  })
  it('macro changed: prefixes the macro', () => {
    expect(
      originalClassText(
        diff({ originMacroClass: 'animal', originLabel: 'cat' }),
        'person',
        undefined,
      ),
    ).toEqual({ original: 'animal/cat', current: 'person' })
  })
  it('says nothing for another kind, an unknown original, or no change', () => {
    expect(
      originalClassText(diff({ kind: 'adjusted', originMacroClass: 'animal' }), 'animal', 'dog'),
    ).toBeNull()
    expect(originalClassText(diff({}), 'animal', 'dog')).toBeNull()
    expect(originalClassText(undefined, 'animal', 'dog')).toBeNull()
    expect(
      originalClassText(diff({ originMacroClass: 'animal', originLabel: 'dog' }), 'animal', 'dog'),
    ).toBeNull()
  })
})

describe('offered macros', () => {
  it('never offers face or plate', () => {
    expect(OFFERED_MACRO_CLASSES).toEqual(['person', 'vehicle', 'animal', 'package'])
  })
})
