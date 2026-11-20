// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MultiSelectDropdown } from '../multi-select'

const OPTIONS = [
  { id: 'camera', label: 'Camera' },
  { id: 'sensor', label: 'Sensor' },
]

describe('MultiSelectDropdown — the open list escapes its scroll container', () => {
  it('mounts the list outside the component root, so no overflow ancestor grows a scrollbar', () => {
    const { container } = render(
      <div data-testid="scroll-area" className="overflow-y-auto">
        <MultiSelectDropdown label="Types" options={OPTIONS} selected={[]} onChange={() => {}} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Types/ }))
    const list = screen.getByRole('listbox')
    expect(container.contains(list)).toBe(false)
    expect(list.style.position).toBe('fixed')
  })

  it('keeps the list interactive: picking an option reports it and an outside press closes it', () => {
    const picked: string[][] = []
    render(
      <MultiSelectDropdown
        label="Types"
        options={OPTIONS}
        selected={[]}
        onChange={(next) => picked.push([...next])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Types/ }))
    fireEvent.mouseDown(screen.getByRole('option', { name: /Sensor/ }))
    fireEvent.click(screen.getByRole('option', { name: /Sensor/ }))
    expect(picked).toEqual([['sensor']])
    expect(screen.queryByRole('listbox')).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
