// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ViewSwitch } from '../view-switch'

afterEach(cleanup)

describe('ViewSwitch', () => {
  it('marks the chosen option and reports a click', () => {
    const onChange = vi.fn<(id: 'table' | 'grid') => void>()
    render(
      <ViewSwitch
        ariaLabel="Layout"
        value="table"
        onChange={onChange}
        options={[
          { id: 'table', label: 'Table' },
          { id: 'grid', label: 'Grid' },
        ]}
        testId="layout"
      />,
    )
    const table = screen.getByRole('radio', { name: 'Table' })
    const grid = screen.getByRole('radio', { name: 'Grid' })
    expect(table.getAttribute('aria-checked')).toBe('true')
    expect(grid.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(grid)
    expect(onChange).toHaveBeenCalledWith('grid')
    expect(screen.getByTestId('layout-grid')).toBe(grid)
  })

  it('renders nothing when there is only one option', () => {
    const { container } = render(
      <ViewSwitch
        ariaLabel="Layout"
        value="table"
        onChange={() => undefined}
        options={[{ id: 'table', label: 'Table' }]}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
