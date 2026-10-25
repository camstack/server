/**
 * The 4g migration of pre-tier `label` values.
 *
 * The discriminating question is not "did the value move" — a copy that lands
 * in either column reads the same through `subLabel ?? label`. It is "which
 * column did it land in, and can a later declared write still correct it".
 */

import { describe, expect, it } from 'vitest'
import { MIGRATION_STEP_ID, resolveTieredLabelWrite } from '../../pipeline/label-tier.js'
import { decideRowMigration } from '../label-tier-migration.js'

const NOW = 1_700_000_000_000

describe('decideRowMigration', () => {
  it('CLEARS a macro class — the 592 regression, proven wrong at write time', () => {
    const patch = decideRowMigration({ className: 'person', label: 'animal' }, NOW)
    expect(patch).not.toBeNull()
    expect(patch?.['label']).toBeNull()
    expect(patch?.['subLabel']).toBeUndefined()
  })

  it('moves a species DOWN into tier 2, never up into tier 1', () => {
    const patch = decideRowMigration({ className: 'animal', label: 'Turdus migratorius' }, NOW)
    expect(patch?.['subLabel']).toBe('Turdus migratorius')
    // Tier 1 is cleared and left EMPTY: parking a species in the coarse slot
    // would block the `bird` that belongs there — the 636 defect, made permanent.
    expect(patch?.['label']).toBeNull()
  })

  it('attributes the moved value to the migration, with no invented score', () => {
    const patch = decideRowMigration({ className: 'animal', label: 'dog' }, NOW)
    expect(patch?.['subLabelMeta']).toEqual({ stepId: MIGRATION_STEP_ID, decidedAt: NOW })
    expect(patch?.['subLabelScore']).toBeNull()
  })

  it('leaves an already-tiered row alone — a resumed run does not re-decide', () => {
    expect(
      decideRowMigration(
        { className: 'animal', label: 'bird', labelMeta: { stepId: 'animal-classifier' } },
        NOW,
      ),
    ).toBeNull()
    expect(
      decideRowMigration({ className: 'animal', label: 'bird', subLabel: 'Turdus' }, NOW),
    ).toBeNull()
  })

  it('leaves a row with no label alone', () => {
    expect(decideRowMigration({ className: 'person' }, NOW)).toBeNull()
    expect(decideRowMigration({ className: 'person', label: '' }, NOW)).toBeNull()
  })
})

describe('a migrated row is CORRECTABLE — the property that makes the guess safe', () => {
  it('any declared write of its tier replaces it, score comparison skipped', () => {
    const patch = decideRowMigration({ className: 'animal', label: 'dog' }, NOW)
    const row = {
      className: 'animal',
      subLabel: patch?.['subLabel'] as string,
      subLabelMeta: patch?.['subLabelMeta'] as { stepId: string; decidedAt: number },
    }
    const d = resolveTieredLabelWrite(row, {
      text: 'Canis lupus familiaris',
      tier: 2,
      // ZERO, deliberately: a migrated slot carries no score, so `?? 0` would
      // make any positive candidate win on the ordinary comparison alone. Only
      // the migration sentinel can let a 0 through — which is what this asserts.
      score: 0,
      stepId: 'bird-classifier',
      decidedAt: NOW + 1,
    })
    expect(d.kind).toBe('write')
    expect(d.kind === 'write' && d.patch.subLabel).toBe('Canis lupus familiaris')
  })

  it('the same value with a REAL attribution is not replaceable by a weaker write', () => {
    // The discriminating half: it is the migration sentinel that unlocks the
    // slot, not the absence of a score.
    const d = resolveTieredLabelWrite(
      {
        className: 'animal',
        subLabel: 'dog',
        subLabelScore: 0.9,
        subLabelMeta: { stepId: 'animal-classifier', decidedAt: NOW },
      },
      {
        text: 'Canis lupus familiaris',
        tier: 2,
        score: 0.01,
        stepId: 'bird-classifier',
        decidedAt: NOW + 1,
      },
    )
    expect(d.kind).toBe('refused')
  })
})
