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

  it('offers Reset only for a resettable item the viewer may actuate', () => {
    expect(card({ resettable: true }).resetLabel).toBe('Reset')
    expect(card({ resettable: true }, false).resetLabel).toBeNull()
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
