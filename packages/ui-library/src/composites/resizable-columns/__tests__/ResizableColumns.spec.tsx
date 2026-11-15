import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ResizableColumns } from '../ResizableColumns'

afterEach(() => window.localStorage.clear())

const COLUMNS = [
  { id: 'a', content: <p>A</p> },
  { id: 'b', content: <p>B</p> },
  { id: 'c', content: <p>C</p> },
]

function basis(id: string): string {
  return screen.getByTestId(`resizable-columns-${id}`).style.flexBasis
}

describe('ResizableColumns', () => {
  it('starts at the default split', () => {
    render(<ResizableColumns columns={COLUMNS} defaultSizes={[15, 65, 20]} storageKey="t" />)
    expect([basis('a'), basis('b'), basis('c')]).toEqual(['15%', '65%', '20%'])
    expect(screen.getAllByRole('separator')).toHaveLength(2)
  })

  it('moves a boundary with the arrow keys and remembers it', () => {
    const { unmount } = render(
      <ResizableColumns columns={COLUMNS} defaultSizes={[15, 65, 20]} storageKey="t" />,
    )
    fireEvent.keyDown(screen.getByTestId('resizable-columns-handle-0'), { key: 'ArrowRight' })
    expect([basis('a'), basis('b')]).toEqual(['17%', '63%'])
    unmount()
    render(<ResizableColumns columns={COLUMNS} defaultSizes={[15, 65, 20]} storageKey="t" />)
    expect([basis('a'), basis('b'), basis('c')]).toEqual(['17%', '63%', '20%'])
  })

  it('does not let a key press take a column under the minimum', () => {
    render(<ResizableColumns columns={COLUMNS} defaultSizes={[15, 65, 20]} storageKey="t" />)
    const handle = screen.getByTestId('resizable-columns-handle-1')
    for (let i = 0; i < 20; i += 1) fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(basis('c')).toBe('10%')
  })
})
