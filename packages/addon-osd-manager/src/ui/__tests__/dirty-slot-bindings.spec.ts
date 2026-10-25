import { describe, expect, it } from 'vitest'
import type { OsdSlotBinding } from '@camstack/types'
import { dirtySlotBindings, emptyBindingDraft } from '../osd-page-model.js'

describe('dirtySlotBindings', () => {
  it('does not persist untouched none-drafts for unbound slots (firmware text stay)', () => {
    const none = emptyBindingDraft()
    const recognition: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'latest-recognition', recognition: 'person' },
      template: '${value}',
      maxDecimals: 1,
    }
    const baseline = {
      'text-0': none,
      'text-1': none,
      'text-2': none,
      'text-3': none,
    }
    const drafts = {
      'text-0': none,
      'text-1': none,
      'text-2': recognition,
      'text-3': none,
    }
    expect(
      dirtySlotBindings(['text-0', 'text-1', 'text-2', 'text-3'], drafts, baseline).map(
        (d) => d.slotId,
      ),
    ).toEqual(['text-2'])
  })

  it('persists an explicit change of a previously-bound static slot to none', () => {
    const staticBound: OsdSlotBinding = {
      enabled: true,
      source: { kind: 'static', text: 'hello' },
      template: '${value}',
      maxDecimals: 1,
    }
    const none = emptyBindingDraft()
    expect(
      dirtySlotBindings(['text-0'], { 'text-0': none }, { 'text-0': staticBound }).map(
        (d) => d.slotId,
      ),
    ).toEqual(['text-0'])
  })
})
