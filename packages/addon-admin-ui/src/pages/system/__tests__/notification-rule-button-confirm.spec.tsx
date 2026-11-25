// @vitest-environment jsdom
/**
 * A rule button's "Ask for confirmation" switch (planning#669): off → on writes
 * `confirm: true` on the button, on → off CLEARS the field (never `false`).
 */
import type { NcRuleNotificationButton } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { NotificationRuleActions } from '../NotificationRuleActions'
import {
  EMPTY_RULE_ACTIONS,
  type NcRuleActionsFormState,
  setButtonConfirm,
} from '../notification-rule-actions'

const OPEN: NcRuleNotificationButton = { id: 'open', label: 'Open door', actionId: 'internal:door' }

function renderWith(button: NcRuleNotificationButton) {
  const onChange = vi.fn<(next: NcRuleActionsFormState) => void>()
  render(
    <MemoryRouter>
      <NotificationRuleActions
        value={{ ...EMPTY_RULE_ACTIONS, buttons: [button] }}
        onChange={onChange}
        actions={[]}
      />
    </MemoryRouter>,
  )
  return onChange
}

const lastButton = (onChange: ReturnType<typeof renderWith>): NcRuleNotificationButton => {
  const form = onChange.mock.calls.at(-1)?.[0]
  const button = form?.buttons[0]
  if (button === undefined) throw new Error('onChange was not called with a button')
  return button
}

describe('the button confirmation switch', () => {
  it('off → on writes confirm: true', () => {
    const onChange = renderWith(OPEN)
    const toggle = screen.getByRole('switch', { name: 'Ask for confirmation' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(lastButton(onChange)).toEqual({ ...OPEN, confirm: true })
  })

  it('on → off clears the field instead of writing false', () => {
    const onChange = renderWith({ ...OPEN, confirm: true })
    const toggle = screen.getByRole('switch', { name: 'Ask for confirmation' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(lastButton(onChange)).toEqual(OPEN)
    expect('confirm' in lastButton(onChange)).toBe(false)
  })
})

describe('setButtonConfirm', () => {
  it('keeps every other field and never mutates its input', () => {
    const withIcon: NcRuleNotificationButton = { ...OPEN, icon: 'unlock', destructive: true }
    const on = setButtonConfirm(withIcon, true)
    expect(on).toEqual({ ...withIcon, confirm: true })
    expect(withIcon).not.toHaveProperty('confirm')
    expect(setButtonConfirm(on, false)).toEqual(withIcon)
  })
})
