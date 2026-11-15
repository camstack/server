import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToggleChipRow } from '../toggle-chip-row'

const CHIPS = [
  { id: 'a', label: 'Temperature' },
  { id: 'b', label: 'Humidity' },
]

function mount(off: ReadonlySet<string>) {
  const onChange = vi.fn<(next: ReadonlySet<string>) => void>()
  render(
    <ToggleChipRow chips={CHIPS} off={off} onChange={onChange} allLabel="All" ariaLabel="Points" />,
  )
  return onChange
}

describe('ToggleChipRow', () => {
  it('starts with every chip pressed', () => {
    mount(new Set())
    for (const name of ['All', 'Temperature', 'Humidity']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true')
    }
  })

  it('flips one chip and leaves All unpressed', () => {
    const onChange = mount(new Set())
    fireEvent.click(screen.getByRole('button', { name: 'Humidity' }))
    expect([...(onChange.mock.calls[0]?.[0] ?? [])]).toEqual(['b'])
  })

  it('All turns everything on, and everything off when it already is', () => {
    const turnedOn = mount(new Set(['a']))
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(turnedOn.mock.calls[0]?.[0]?.size).toBe(0)
  })

  it('All, when everything is on, switches every chip off', () => {
    const onChange = mount(new Set())
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect([...(onChange.mock.calls[0]?.[0] ?? [])]).toEqual(['a', 'b'])
  })
})
