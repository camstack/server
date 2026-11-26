/**
 * A Lists row's active Switch (D1098 2b): the stored list's `enabled`, edited in
 * the draft through `handle.save`; a list that is not stored has no switch.
 */
import type { Composition } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'
import { KeyedActionsCell } from '../KeyedActionsCell'
import type { CustomizeRowSpec } from '../customize-rows'

const HOST = { addonId: 'ha', stableId: 'feeder' }
const SPEC = {
  key: 'consumables',
  cap: 'consumables',
  kind: 'keyed',
} as unknown as CustomizeRowSpec
const STORED: Composition = {
  target: { kind: 'existing', device: HOST },
  features: [{ kind: 'fields', cap: 'consumables', fields: {}, items: {} }],
}

function handleOf(composition: Composition | null) {
  return {
    target: HOST,
    state:
      composition === null
        ? ({ kind: 'none' } as const)
        : ({ kind: 'present', composition, view: {} } as never),
    saving: false,
    save: vi.fn(async (_next: Composition | null) => ({ kind: 'saved' as const })),
  }
}

describe('a Lists row', () => {
  it('has a Switch once the list is stored, and it edits the draft', () => {
    const handle = handleOf(STORED)
    render(
      <KeyedActionsCell
        spec={SPEC}
        title="Consumables"
        handle={handle}
        onEdit={vi.fn()}
        onError={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('keyed-active-consumables'))
    expect(handle.save.mock.calls[0]?.[0]?.features[0]).toMatchObject({
      cap: 'consumables',
      enabled: false,
    })
  })

  it('has no Switch while only the native items are listed', () => {
    render(
      <KeyedActionsCell
        spec={SPEC}
        title="Consumables"
        handle={handleOf(null)}
        onEdit={vi.fn()}
        onError={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('keyed-active-consumables')).toBeNull()
    expect(screen.getByTestId('customize-manage-consumables')).toBeTruthy()
  })
})
