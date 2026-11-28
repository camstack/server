// @vitest-environment jsdom
import { EventCategory } from '@dominevo/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EventCategoryPicker } from '../event-category-picker'

function setup(value: readonly string[] = []) {
  const onChange = vi.fn()
  render(<EventCategoryPicker value={value} onChange={onChange} defaults={['a.b']} lang="en" />)
  return onChange
}

describe('EventCategoryPicker', () => {
  it('lists catalogued categories with their raw ids and toggles one', () => {
    const onChange = setup()
    const raw = screen.getByText(EventCategory.AddonStarted)
    fireEvent.click(raw)
    expect(onChange).toHaveBeenCalledWith([EventCategory.AddonStarted])
  })

  it('unchecks a selected category', () => {
    const onChange = setup([EventCategory.AddonStarted, EventCategory.AddonStopped])
    fireEvent.click(screen.getByText(EventCategory.AddonStarted))
    expect(onChange).toHaveBeenCalledWith([EventCategory.AddonStopped])
  })

  it('narrows the list by the search text', () => {
    setup()
    fireEvent.change(screen.getByLabelText('Find a category…'), {
      target: { value: EventCategory.AddonStarted },
    })
    expect(screen.queryByText(EventCategory.AddonStopped)).toBeNull()
    expect(screen.getByText(EventCategory.AddonStarted)).toBeTruthy()
  })

  it('adds a valid custom pattern and refuses an invalid one', () => {
    const onChange = setup()
    const input = screen.getByLabelText('Custom pattern')
    const add = screen.getByLabelText('Add pattern')
    fireEvent.change(input, { target: { value: 'not valid' } })
    expect((add as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'homematic.*' } })
    fireEvent.click(add)
    expect(onChange).toHaveBeenCalledWith(['homematic.*'])
  })

  it('shows a custom entry as removable and restores defaults', () => {
    const onChange = setup(['homematic.*'])
    fireEvent.click(screen.getByLabelText('Remove homematic.*'))
    expect(onChange).toHaveBeenCalledWith([])
    fireEvent.click(screen.getByText('Defaults'))
    expect(onChange).toHaveBeenCalledWith(['a.b'])
  })
})
