import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RemoteLayoutPayload } from '@camstack/types'
import '../../../i18n'
import { RemoteGrid } from '../RemoteGrid'

const GRID: RemoteLayoutPayload = {
  columns: 3,
  rows: 2,
  buttons: [{ id: 'a', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'power' }],
  groups: [
    {
      id: 'g1',
      componentId: 'numbers',
      title: 'Numbers',
      frame: 'panel',
      row: 0,
      col: 0,
      rowSpan: 2,
      colSpan: 3,
    },
  ],
}

describe('RemoteGrid group titles', () => {
  it('draws no group label where the remote is used (display mode)', () => {
    render(<RemoteGrid grid={GRID} label="grid" />)
    expect(screen.getByTestId('remote-group-g1')).toBeTruthy()
    expect(screen.queryByText('Numbers')).toBeNull()
  })

  it('draws the group label in the layout editor (editable)', () => {
    render(<RemoteGrid grid={GRID} label="grid" onItemPointerDown={() => undefined} />)
    expect(screen.getByText('Numbers')).toBeTruthy()
  })
})
