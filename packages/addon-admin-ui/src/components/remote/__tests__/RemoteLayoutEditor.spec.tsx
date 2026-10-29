import type { RemoteLayoutPayload } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import '../../../i18n'
import { RemoteLayoutEditor } from '../RemoteLayoutEditor'

const START: RemoteLayoutPayload = {
  columns: 2,
  rows: 2,
  buttons: [
    { id: 'b1', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'power' },
    { id: 'b2', row: 0, col: 1, rowSpan: 1, colSpan: 1, role: 'mute' },
  ],
}

function Harness({ onGrid }: { readonly onGrid: (g: RemoteLayoutPayload) => void }) {
  const [grid, setGrid] = useState(START)
  return (
    <RemoteLayoutEditor
      value={grid}
      onChange={(next) => {
        setGrid(next)
        onGrid(next)
      }}
    />
  )
}

describe('RemoteLayoutEditor', () => {
  it('adds a button on the first free cell and selects it', () => {
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-add-button'))
    expect(latest.buttons).toHaveLength(3)
    expect(latest.buttons[2]).toMatchObject({ row: 1, col: 0 })
    expect(screen.getByTestId('remote-inspector')).toBeTruthy()
    expect(screen.getByTestId('remote-position').textContent).toBe('Row 2, column 1')
  })

  it('refuses a move onto another button, says so, and leaves the grid as it was', () => {
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-grid-button-b1'))
    fireEvent.click(screen.getByLabelText('Move right'))
    expect(screen.getByTestId('remote-layout-refusal').textContent).toMatch(/overlap/i)
    expect(latest).toBe(START)
  })

  it('moves a button onto a free cell and clears an earlier refusal', () => {
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-grid-button-b1'))
    fireEvent.click(screen.getByLabelText('Move right'))
    fireEvent.click(screen.getByLabelText('Move down'))
    expect(screen.queryByTestId('remote-layout-refusal')).toBeNull()
    expect(latest.buttons[0]).toMatchObject({ row: 1, col: 0 })
  })

  it('refuses shrinking the grid under a button', () => {
    render(<Harness onGrid={() => undefined} />)
    const decrement = screen.getAllByLabelText('Decrement')
    fireEvent.click(decrement[0] as HTMLElement)
    expect(screen.getByTestId('remote-layout-refusal').textContent).toMatch(/Move or delete/)
  })

  it('removes the selected button', () => {
    let latest = START
    render(<Harness onGrid={(g) => (latest = g)} />)
    fireEvent.click(screen.getByTestId('remote-grid-button-b2'))
    fireEvent.click(screen.getByText('Remove button'))
    expect(latest.buttons.map((b) => b.id)).toEqual(['b1'])
    expect(screen.queryByTestId('remote-inspector')).toBeNull()
  })
})
