/** D692: the ONE projection from a track's tiers to a subject label, shared by the
 *  subject builders and the grouped window's promotion hook. */
import { describe, expect, it } from 'vitest'
import { subjectLabelFromTiers } from '../rule-engine.js'

describe('subjectLabelFromTiers', () => {
  it('a face-attributed subLabel is an identity, with its gallery id', () => {
    expect(
      subjectLabelFromTiers({
        label: 'person',
        subLabel: 'Person A',
        subLabelMeta: { stepId: 'face-recognizer', decidedAt: 1, identityId: 'id-a' },
      }),
    ).toEqual({ label: 'Person A', identityId: 'id-a', labelKind: 'identity' })
  })
  it('an unattributed label carries no kind', () => {
    expect(subjectLabelFromTiers({ label: 'courier' })).toEqual({ label: 'courier' })
  })
  it('no tiers → no label at all (a cleared tier reads as absent)', () => {
    expect(subjectLabelFromTiers({})).toEqual({})
  })
})
