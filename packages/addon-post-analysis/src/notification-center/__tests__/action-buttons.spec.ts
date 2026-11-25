import type { NcRuleActions } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildActionButtons, unresolvableButtons } from '../action-buttons.js'

const mintUrl = (i: { runActionId: string; actionId: string }): string =>
  `url://${i.actionId}/${i.runActionId}`

const known = new Set(['open-gate-id'])

function actions(over: Partial<NcRuleActions> = {}): NcRuleActions {
  return {
    onTrigger: ['open-gate-id'],
    ...over,
  }
}

describe('buildActionButtons', () => {
  it('mints a button whose actionId is known', () => {
    const out = buildActionButtons({
      actions: actions({
        buttons: [{ id: 'open', label: 'Open', actionId: 'open-gate-id', icon: 'unlock' }],
      }),
      knownActionIds: known,
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

  it('a confirm button is navigate mode and tells the minter to ask first', () => {
    const asked: (string | undefined)[] = []
    const out = buildActionButtons({
      actions: actions({
        buttons: [
          { id: 'open', label: 'Unlock', actionId: 'open-gate-id', confirm: true },
          { id: 'plain', label: 'Plain', actionId: 'open-gate-id' },
        ],
      }),
      knownActionIds: known,
      mintUrl: (i) => {
        asked.push(i.confirm?.label)
        return `url://${i.actionId}`
      },
    })
    expect(out.map((b) => b.mode)).toEqual(['navigate', 'background'])
    expect(asked).toEqual(['Unlock', undefined])
  })

  it('drops a button whose actionId is unknown', () => {
    const out = buildActionButtons({
      actions: actions({ buttons: [{ id: 'x', label: 'X', actionId: 'typo' }] }),
      knownActionIds: known,
      mintUrl,
    })
    expect(out).toEqual([])
    expect(
      unresolvableButtons(actions({ buttons: [{ id: 'x', label: 'X', actionId: 'typo' }] }), known),
    ).toEqual(['x→typo'])
  })

  it('collapses duplicate button ids', () => {
    const out = buildActionButtons({
      actions: actions({
        buttons: [
          { id: 'open', label: 'Open', actionId: 'open-gate-id' },
          { id: 'open', label: 'Open again', actionId: 'open-gate-id' },
        ],
      }),
      knownActionIds: known,
      mintUrl,
    })
    expect(out).toHaveLength(1)
  })

  it('returns [] when there are no buttons', () => {
    expect(buildActionButtons({ actions: undefined, knownActionIds: known, mintUrl })).toEqual([])
    expect(buildActionButtons({ actions: actions(), knownActionIds: known, mintUrl })).toEqual([])
  })
})
