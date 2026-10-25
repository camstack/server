import type { NcRuleActions } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildActionButtons, unresolvableButtons } from '../action-buttons.js'

const mintUrl = (i: { sequenceId: string; actionId: string }): string =>
  `url://${i.actionId}/${i.sequenceId}`

const known = new Set(['open-gate-id'])

function actions(over: Partial<NcRuleActions> = {}): NcRuleActions {
  return {
    onTrigger: [{ kind: 'sequence', sequenceId: 'open-gate-id' }],
    ...over,
  }
}

describe('buildActionButtons', () => {
  it('mints a button whose sequenceId is known', () => {
    const out = buildActionButtons({
      actions: actions({
        buttons: [{ id: 'open', label: 'Open', sequenceId: 'open-gate-id', icon: 'unlock' }],
      }),
      knownSequenceIds: known,
      mintUrl,
    })
    expect(out).toEqual([
      {
        id: 'open',
        label: 'Open',
        url: 'url://open/open-gate-id',
        icon: 'unlock',
        mode: 'background',
      },
    ])
  })

  it('drops a button whose sequenceId is unknown', () => {
    const out = buildActionButtons({
      actions: actions({ buttons: [{ id: 'x', label: 'X', sequenceId: 'typo' }] }),
      knownSequenceIds: known,
      mintUrl,
    })
    expect(out).toEqual([])
    expect(
      unresolvableButtons(
        actions({ buttons: [{ id: 'x', label: 'X', sequenceId: 'typo' }] }),
        known,
      ),
    ).toEqual(['x→typo'])
  })

  it('collapses duplicate button ids', () => {
    const out = buildActionButtons({
      actions: actions({
        buttons: [
          { id: 'open', label: 'Open', sequenceId: 'open-gate-id' },
          { id: 'open', label: 'Open again', sequenceId: 'open-gate-id' },
        ],
      }),
      knownSequenceIds: known,
      mintUrl,
    })
    expect(out).toHaveLength(1)
  })

  it('returns [] when there are no buttons', () => {
    expect(buildActionButtons({ actions: undefined, knownSequenceIds: known, mintUrl })).toEqual([])
    expect(buildActionButtons({ actions: actions(), knownSequenceIds: known, mintUrl })).toEqual([])
  })
})
