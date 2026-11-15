// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ConsumableItem } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultUiText } from '../../../contexts/ui-text'
import { toCardConsumable } from '../connected/consumable-card-item'
import { ConsumablesButton } from '../shell/BottomLine'
import type { CardConsumable } from '../shell/model'

afterEach(cleanup)

const t = defaultUiText

const item = (over: Partial<ConsumableItem>): ConsumableItem => ({
  key: 'k',
  label: 'Item',
  level: null,
  status: null,
  lastResetAt: null,
  resettable: false,
  ...over,
})

const card = (over: Partial<ConsumableItem>, canReset = true): CardConsumable =>
  toCardConsumable(item(over), canReset, t)

describe('toCardConsumable', () => {
  it('a full dust bin is `full` (kind-aware), not ok', () => {
    const c = card({ kind: 'waste', level: 95 })
    expect(c.level).toBe('full')
    expect(c.levelWord).toBe('Full')
    expect(c.form).toBe('bin')
  })

  it('a reading nobody reported is unknown, never ok (D393)', () => {
    expect(card({}).level).toBeNull()
    expect(card({}).levelWord).toBe('Unknown')
  })

  it('carries the remaining time and the replaced date, and says Replace in words', () => {
    const c = card({
      status: 'replace',
      remaining: { kind: 'count', value: 3 },
      lastResetAt: Date.UTC(2026, 0, 5, 12),
    })
    expect(c.levelWord).toBe('Replace')
    expect(c.detail).toContain('3 cycles')
    expect(c.detail).toContain('Replaced')
  })

  it('offers Reset for a resettable item, disabled when the viewer may not actuate', () => {
    expect(card({ resettable: true }).resetLabel).toBe('Reset')
    expect(card({ resettable: true }).resetDisabled).toBeUndefined()
    expect(card({ resettable: true }, false).resetLabel).toBe('Reset')
    expect(card({ resettable: true }, false).resetDisabled).toBe(true)
    expect(card({ resettable: false }).resetLabel).toBeNull()
  })
})

describe('ConsumablesButton', () => {
  const render1 = (items: readonly CardConsumable[], loading = false) =>
    render(<ConsumablesButton items={items} loading={loading} onReset={vi.fn()} />)

  it('warns about a full bin that a low-percent rule would call fine', () => {
    render1([card({ key: 'bin', label: 'Dust bin', kind: 'waste', level: 95 })])
    const chip = screen.getByTestId('dc-consumables').querySelector('button')
    expect(chip?.getAttribute('data-low')).toBe('true')
    expect(chip?.textContent).toContain('Dust bin')
    expect(chip?.textContent).toContain('Full')
  })

  it('a part to replace with a known level says Replace in words, on the chip and in the popover', () => {
    render1([card({ key: 'brush', label: 'Brush', status: 'replace', level: 80 })])
    const chip = screen.getByTestId('dc-consumables').querySelector('button')
    expect(chip?.textContent).toContain('Replace')
    expect(chip?.textContent).not.toContain('80%')
    fireEvent.click(chip!)
    expect(screen.getByTestId('dc-consumables-pop').textContent).toContain('Replace')
  })

  it('the tone comes from the shared level map (low warns, empty is danger)', () => {
    render1([
      card({ key: 'a', label: 'Filter', level: 5 }),
      card({ key: 'b', label: 'Bag', level: 0 }),
    ])
    fireEvent.click(screen.getByTestId('dc-consumables').querySelector('button')!)
    const levels = [
      ...screen.getByTestId('dc-consumables-pop').querySelectorAll('[data-level]'),
    ].map((n) => n.getAttribute('data-level'))
    expect(levels).toEqual(expect.arrayContaining(['low', 'empty']))
  })

  it('a double click on Reset sends one reset while it is in flight', async () => {
    let done: () => void = () => undefined
    const onReset = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve
        }),
    )
    render(
      <ConsumablesButton
        onReset={onReset}
        items={[card({ key: 'brush', label: 'Brush', level: 10, resettable: true })]}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-consumables').querySelector('button')!)
    const btn = screen.getByText('Reset')
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(onReset).toHaveBeenCalledTimes(1)
    done()
    await vi.waitFor(() =>
      expect(screen.getByText('Reset').closest('button')?.disabled).toBe(false),
    )
  })

  it('a Reset the viewer may not actuate is disabled', () => {
    const onReset = vi.fn()
    render(
      <ConsumablesButton
        onReset={onReset}
        items={[card({ key: 'brush', label: 'Brush', level: 10, resettable: true }, false)]}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-consumables').querySelector('button')!)
    fireEvent.click(screen.getByText('Reset'))
    expect(onReset).not.toHaveBeenCalled()
  })

  it('unknown readings never read as ok', () => {
    render1([card({ key: 'a' }), card({ key: 'b', level: 80 })])
    const text = screen.getByTestId('dc-consumables').textContent ?? ''
    expect(text).toContain('1 OK · 1 unknown')
    expect(text).not.toContain('Consumables ok')
  })

  it('says ok only when every item is known to be ok', () => {
    render1([card({ level: 80 })])
    expect(screen.getByTestId('dc-consumables').textContent).toContain('Consumables ok')
  })

  it('an empty bound list says so, a pending slice says loading', () => {
    render1([])
    expect(screen.getByTestId('dc-consumables-empty').textContent).toContain('No consumables')
    cleanup()
    render1([], true)
    expect(screen.getByTestId('dc-consumables-loading')).toBeTruthy()
    expect(screen.queryByTestId('dc-consumables-empty')).toBeNull()
  })

  it('the list draws the form, the state word and the reset', () => {
    const onReset = vi.fn()
    render(
      <ConsumablesButton
        onReset={onReset}
        items={[
          card({ key: 'brush', label: 'Brush', level: 10, resettable: true }),
          card({ key: 'tank', label: 'Dirty water', kind: 'waste', level: 90, form: 'tank' }),
        ]}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-consumables').querySelector('button')!)
    const pop = screen.getByTestId('dc-consumables-pop')
    expect(pop.textContent).toContain('Low 10%')
    expect(pop.textContent).toContain('Full 90%')
    expect(screen.getByTestId('dc-consumable-gauge')).toBeTruthy()
    fireEvent.click(screen.getByText('Reset'))
    expect(onReset).toHaveBeenCalledWith('brush')
  })
})
