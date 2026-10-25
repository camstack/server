// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasUnconditionalClass, hasVariantClass } from '../../lib/tailwind-variants'
import { SETTING_ROW_STACK_BREAKPOINT } from '../../lib/responsive'
import { SettingRow } from '../setting-row'

/**
 * These assert the RESPONSIVE DECISION, not a class literal: below the stack
 * breakpoint the row must be one column and the value must be fully readable.
 * The layout this replaces put a fixed-width label beside a truncating value at
 * EVERY width, so on a phone the value — the only thing the operator opened the
 * page to copy — was the one part cut off.
 */
function rowOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-setting-row]')
  if (!(el instanceof HTMLElement)) throw new Error('row not rendered')
  return el
}

function labelOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-setting-row-label]')
  if (!(el instanceof HTMLElement)) throw new Error('label not rendered')
  return el
}

function valueOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-setting-row-value]')
  if (!(el instanceof HTMLElement)) throw new Error('value not rendered')
  return el
}

function valueTextOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-setting-row-value-text]')
  if (!(el instanceof HTMLElement)) throw new Error('value text not rendered')
  return el
}

describe('SettingRow', () => {
  it('renders the label, the value and the actions', () => {
    render(
      <SettingRow label="Ingress token" actions={<button type="button">Copy</button>}>
        abc123
      </SettingRow>,
    )
    expect(screen.getByText('Ingress token')).not.toBeNull()
    expect(screen.getByText('abc123')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).not.toBeNull()
  })

  it('stacks into ONE column below the breakpoint and goes side-by-side above it', () => {
    const { container } = render(<SettingRow label="Label">value</SettingRow>)
    const row = rowOf(container)
    expect(hasUnconditionalClass(row.className, 'flex-col')).toBe(true)
    expect(hasUnconditionalClass(row.className, 'flex-row')).toBe(false)
    expect(hasVariantClass(row.className, SETTING_ROW_STACK_BREAKPOINT, 'flex-row')).toBe(true)
  })

  it('never gives the label a fixed width below the breakpoint', () => {
    const { container } = render(<SettingRow label="Ingress token (long label)">value</SettingRow>)
    const label = labelOf(container)
    expect(hasUnconditionalClass(label.className, 'shrink-0')).toBe(false)
    expect(hasVariantClass(label.className, SETTING_ROW_STACK_BREAKPOINT, 'shrink-0')).toBe(true)
  })

  it('never truncates the value below the breakpoint', () => {
    const { container } = render(<SettingRow label="Label">a-very-long-opaque-token</SettingRow>)
    const text = valueTextOf(container)
    expect(hasUnconditionalClass(text.className, 'truncate')).toBe(false)
    expect(hasVariantClass(text.className, SETTING_ROW_STACK_BREAKPOINT, 'truncate')).toBe(true)
  })

  it('gives the value the full row width below the breakpoint', () => {
    const { container } = render(<SettingRow label="Label">value</SettingRow>)
    const value = valueOf(container)
    expect(hasUnconditionalClass(value.className, 'w-full')).toBe(true)
    expect(hasUnconditionalClass(value.className, 'min-w-0')).toBe(true)
  })

  it('emits description-list elements when asked, so a <dl> stays valid', () => {
    const { container } = render(
      <dl>
        <SettingRow elements="description" label="Label">
          value
        </SettingRow>
      </dl>,
    )
    expect(labelOf(container).tagName).toBe('DT')
    expect(valueOf(container).tagName).toBe('DD')
  })

  it('emits plain elements by default', () => {
    const { container } = render(<SettingRow label="Label">value</SettingRow>)
    expect(labelOf(container).tagName).not.toBe('DT')
    expect(valueOf(container).tagName).not.toBe('DD')
  })
})
