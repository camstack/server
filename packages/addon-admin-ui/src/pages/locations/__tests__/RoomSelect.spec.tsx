/**
 * The room selector replaces a tab strip that scrolled sideways without end.
 * What matters: with many rooms it is ONE control (not one trigger per room),
 * it names each room with its device count, it narrows by search, and the
 * choice it reports is what the page writes to `?room=`.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '../../../i18n'
import { RoomSelect, roomOptions } from '../RoomSelect'

const UNASSIGNED = '__unassigned__'
const ROOMS = Array.from({ length: 30 }, (_, i) => ({ name: `Room ${String(i + 1)}`, count: i }))

function mount(onChange = vi.fn(), value = 'Room 1', unassignedCount: number | undefined = 4) {
  render(
    <RoomSelect
      rooms={ROOMS}
      {...(unassignedCount === undefined ? {} : { unassignedCount })}
      value={value}
      unassignedValue={UNASSIGNED}
      onChange={onChange}
    />,
  )
  return onChange
}

describe('roomOptions', () => {
  it('names every room with its device count and ends with Unassigned', () => {
    const options = roomOptions(ROOMS, 4, UNASSIGNED, 'Unassigned')
    expect(options).toHaveLength(31)
    expect(options[2]).toEqual({ value: 'Room 3', label: 'Room 3 · 2' })
    expect(options.at(-1)).toEqual({ value: UNASSIGNED, label: 'Unassigned · 4' })
  })

  it('has no Unassigned entry when the caller does not offer one', () => {
    expect(roomOptions(ROOMS, undefined, UNASSIGNED, 'Unassigned')).toHaveLength(30)
  })
})

describe('RoomSelect', () => {
  it('is a single searchable control, however many rooms there are', () => {
    mount()
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })

  it('narrows by search and reports the picked room', () => {
    const onChange = mount()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'room 27' } })
    expect(screen.queryByTestId('room-option-Room 3')).toBeNull()
    fireEvent.click(screen.getByTestId('room-option-Room 27'))
    expect(onChange).toHaveBeenCalledWith('Room 27')
  })

  it('shows the current room IN the field — no chip, no clear', () => {
    mount()
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Room 1 · 0')
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  })

  it('reports the Unassigned entry under the page-chosen value', () => {
    const onChange = mount()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'unassigned' } })
    fireEvent.click(screen.getByTestId(`room-option-${UNASSIGNED}`))
    expect(onChange).toHaveBeenCalledWith(UNASSIGNED)
  })
})
