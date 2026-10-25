// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConsumableLevelSchema } from '@camstack/types'
import {
  ConsumableLevelBadge,
  consumableItemLevel,
  consumableLevelVariant,
  isConsumableLevelField,
  parseConsumableLevel,
} from '../consumable-level-badge'

describe('ConsumableLevelBadge', () => {
  it('maps every member of the cap level enum, and unknown, to its own tone', () => {
    const variants = [...ConsumableLevelSchema.options, null].map(consumableLevelVariant)
    expect(variants).toEqual(['success', 'warning', 'danger', 'warning', 'neutral'])
  })

  it('says the state in words, prefixed by the name when given', () => {
    render(<ConsumableLevelBadge level="low" name="Salt" />)
    const badge = screen.getByText('Salt · Low')
    expect(badge.getAttribute('data-level')).toBe('low')
    expect(badge.className).toContain('text-warning')
  })

  it('an unknown level is Unknown in the neutral tone, never OK', () => {
    render(<ConsumableLevelBadge level={null} />)
    const badge = screen.getByText('Unknown')
    expect(badge.getAttribute('data-level')).toBe('unknown')
    expect(badge.className).not.toContain('text-success')
  })

  it('a full level says Full in the warning tone', () => {
    render(<ConsumableLevelBadge level="full" />)
    expect(screen.getByText('Full').className).toContain('text-warning')
  })

  it('a label replaces the state word but keeps the tone of the level', () => {
    render(<ConsumableLevelBadge level="empty" label="Replace" />)
    expect(screen.getByText('Replace').className).toContain('text-danger')
  })
})

describe('consumableItemLevel', () => {
  it('a known percentage decides: 0 empty, at or below 15 low, above ok', () => {
    expect(consumableItemLevel({ level: 0, status: 'ok' })).toBe('empty')
    expect(consumableItemLevel({ level: 15, status: null })).toBe('low')
    expect(consumableItemLevel({ level: 16, status: null })).toBe('ok')
  })

  it('a replace status is never shown better than low, whatever the percentage', () => {
    expect(consumableItemLevel({ level: 60, status: 'replace' })).toBe('low')
  })

  it('without a percentage the discrete status decides, and nothing known is unknown', () => {
    expect(consumableItemLevel({ level: null, status: 'replace' })).toBe('low')
    expect(consumableItemLevel({ level: null, status: 'ok' })).toBe('ok')
    expect(consumableItemLevel({ level: null, status: null })).toBeNull()
  })

  it('a supply reads its own verdict: low, empty, and a full supply is fine (D915)', () => {
    expect(consumableItemLevel({ level: null, status: 'low', kind: 'supply' })).toBe('low')
    expect(consumableItemLevel({ level: null, status: 'empty', kind: 'supply' })).toBe('empty')
    expect(consumableItemLevel({ level: null, status: 'full', kind: 'supply' })).toBe('ok')
    expect(consumableItemLevel({ level: 10, status: null, kind: 'supply' })).toBe('low')
  })

  it('a waste item is bad when FULL, by verdict or by fill — never because it is low (D915)', () => {
    expect(consumableItemLevel({ level: null, status: 'full', kind: 'waste' })).toBe('full')
    expect(consumableItemLevel({ level: null, status: 'ok', kind: 'waste' })).toBe('ok')
    expect(consumableItemLevel({ level: null, status: 'low', kind: 'waste' })).toBe('ok')
    expect(consumableItemLevel({ level: 90, status: null, kind: 'waste' })).toBe('full')
    expect(consumableItemLevel({ level: 5, status: null, kind: 'waste' })).toBe('ok')
    expect(consumableItemLevel({ level: null, status: null, kind: 'waste' })).toBeNull()
  })

  it('a wear part reports low / empty verdicts as they are', () => {
    expect(consumableItemLevel({ level: null, status: 'low' })).toBe('low')
    expect(consumableItemLevel({ level: null, status: 'empty' })).toBe('empty')
  })
})

describe('isConsumableLevelField', () => {
  it('recognises a field typed by the consumable level enum, in any order', () => {
    expect(
      isConsumableLevelField({
        kind: 'enum',
        enumValues: ['ok', 'low', 'empty'],
      }),
    ).toBe(true)
    expect(
      isConsumableLevelField({
        kind: 'enum',
        enumValues: ['empty', 'ok', 'low'],
      }),
    ).toBe(true)
  })

  it('refuses any other enum, a partial one, or a non-enum', () => {
    expect(
      isConsumableLevelField({
        kind: 'enum',
        enumValues: ['ok', 'low', 'full'],
      }),
    ).toBe(false)
    expect(isConsumableLevelField({ kind: 'enum', enumValues: ['ok', 'low'] })).toBe(false)
    expect(
      isConsumableLevelField({
        kind: 'enum',
        enumValues: ['ok', 'low', 'empty', 'x'],
      }),
    ).toBe(false)
    expect(isConsumableLevelField({ kind: 'number' })).toBe(false)
  })
})

describe('parseConsumableLevel', () => {
  it('reads a member, and anything else as unknown', () => {
    expect(parseConsumableLevel('empty')).toBe('empty')
    expect(parseConsumableLevel(null)).toBeNull()
    expect(parseConsumableLevel('full')).toBe('full')
    expect(parseConsumableLevel('replace')).toBeNull()
    expect(parseConsumableLevel(3)).toBeNull()
  })
})
