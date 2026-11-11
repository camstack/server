import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { selectOption, waitForSelectRows } from '../../testing/select-option'
import { Select } from '../select'

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma', disabled: true },
]

describe('Select renders our list, not the native popup', () => {
  it('has no native <select> and opens a listbox of rows', () => {
    const { container } = render(<Select value="a" onChange={() => {}} options={OPTIONS} />)
    expect(container.querySelector('select')).toBeNull()
    const trigger = screen.getByRole('combobox')
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('option', { name: /Alpha/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('reports the change with target.value and a name', () => {
    const onChange = vi.fn()
    render(
      <Select
        value="a"
        name="f"
        onChange={(e) => onChange(e.target.value, e.target.name)}
        options={OPTIONS}
      />,
    )
    selectOption(screen.getByRole('combobox'), 'b')
    expect(onChange).toHaveBeenCalledWith('b', 'f')
  })

  it('parses <option> / <optgroup> children, disabled rows included', () => {
    const onChange = vi.fn()
    render(
      <Select value="" onChange={(e) => onChange(e.target.value)}>
        <option value="">None</option>
        <optgroup label="Group">
          <option value="x">Ex</option>
          <option value="y" disabled>
            Why
          </option>
        </optgroup>
      </Select>,
    )
    const trigger = screen.getByRole('combobox')
    selectOption(trigger, 'x')
    expect(onChange).toHaveBeenCalledWith('x')
    expect(() => selectOption(trigger, 'y')).toThrow(/disabled/)
  })

  it('works uncontrolled and submits through a hidden input', () => {
    const { container } = render(<Select name="n" defaultValue="b" options={OPTIONS} />)
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="n"]')
    expect(hidden?.value).toBe('b')
    selectOption(screen.getByRole('combobox'), 'a')
    expect(hidden?.value).toBe('a')
    expect(screen.getByRole('combobox').textContent).toBe('Alpha')
  })

  it('is keyboard operable: arrows skip disabled, Enter picks, Escape closes without bubbling', () => {
    const onChange = vi.fn()
    const outer = vi.fn()
    function Host() {
      const [v, setV] = useState('a')
      return (
        <div onKeyDown={outer}>
          <Select
            value={v}
            options={OPTIONS}
            onChange={(e) => {
              onChange(e.target.value)
              setV(e.target.value)
            }}
          />
        </div>
      )
    }
    render(<Host />)
    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }) // wraps over disabled Gamma back to Alpha
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('b')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    outer.mockClear()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(outer).not.toHaveBeenCalled()
  })

  it('type-ahead moves to the matching row', () => {
    const onChange = vi.fn()
    render(<Select value="a" onChange={(e) => onChange(e.target.value)} options={OPTIONS} />)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'b' })
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('a disabled select never opens', () => {
    render(<Select disabled value="a" onChange={() => {}} options={OPTIONS} />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('exposes the native select semantics to a screen reader', () => {
    render(<Select aria-label="Pick" value="b" onChange={() => {}} options={OPTIONS} required />)
    const trigger = screen.getByRole('combobox', { name: 'Pick' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-required')).toBe('true')
    expect(trigger.textContent).toBe('Beta')
    fireEvent.keyDown(trigger, { key: ' ' })
    const list = screen.getByRole('listbox')
    expect(trigger.getAttribute('aria-controls')).toBe(list.id)
    const rows = screen.getAllByRole('option')
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(rows[2]?.getAttribute('aria-disabled')).toBe('true')
    // the active row is announced through the trigger, focus never leaves it
    expect(trigger.getAttribute('aria-activedescendant')).toBe(rows[1]?.id)
    fireEvent.keyDown(trigger, { key: 'Home' })
    expect(trigger.getAttribute('aria-activedescendant')).toBe(rows[0]?.id)
    fireEvent.keyDown(trigger, { key: 'End' })
    expect(trigger.getAttribute('aria-activedescendant')).toBe(rows[1]?.id) // Gamma is disabled
  })

  it('Tab closes the list without picking; Space and Enter open a closed select', () => {
    const onChange = vi.fn()
    render(<Select value="a" onChange={(e) => onChange(e.target.value)} options={OPTIONS} />)
    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('opened inside a modal <dialog> the list mounts in that dialog, in the top layer', () => {
    const showPopover = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value: showPopover,
    })
    try {
      render(
        <dialog open>
          <Select value="a" onChange={() => {}} options={OPTIONS} />
        </dialog>,
      )
      fireEvent.click(screen.getByRole('combobox'))
      const list = screen.getByRole('listbox', { hidden: true })
      expect(list.closest('dialog')).not.toBeNull()
      expect(list.getAttribute('popover')).toBe('manual')
      expect(showPopover).toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
    }
  })

  it('waitForSelectRows resolves once rows arrive, without the waitFor observer loop', async () => {
    function Late() {
      const [rows, setRows] = useState<typeof OPTIONS>([])
      useEffect(() => {
        const id = setTimeout(() => setRows(OPTIONS), 60)
        return () => clearTimeout(id)
      }, [])
      return <Select value="a" onChange={() => {}} options={rows} placeholder="none" />
    }
    render(<Late />)
    await waitForSelectRows(screen.getByRole('combobox'), (r) => r.some((x) => x.label === 'Beta'))
    expect(screen.getByRole('combobox').textContent).toBe('Alpha')
  })
})
