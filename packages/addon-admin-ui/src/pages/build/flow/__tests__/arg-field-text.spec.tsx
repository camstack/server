/**
 * A free-text action argument takes device values (`{{ alias.field }}`, rendered
 * by the hub when the step runs); the stored arg keeps its shape.
 */
import type { LooseVocabOpenArg } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTemplateHub } from '../../../../test-setup/device-template-hub'
import { ArgField } from '../ArgField'

const TEXT: LooseVocabOpenArg = {
  key: 'message',
  label: { en: 'Message', it: 'Messaggio' },
  offer: { kind: 'text' },
}
const SECRET: LooseVocabOpenArg = {
  key: 'pin',
  label: { en: 'PIN', it: 'PIN' },
  offer: { kind: 'text', secret: true },
}
const base = { locale: 'en' as const, variables: [] }

describe('ArgField on a text arg', () => {
  it('stores what was typed as a fixed string, braces included, without opening the variable list', () => {
    const onChange = vi.fn()
    render(
      renderWithTemplateHub(
        <ArgField {...base} arg={TEXT} value={{ kind: 'fixed', value: '' }} onChange={onChange} />,
      ),
    )
    fireEvent.change(screen.getByLabelText('Message', { selector: 'input' }), {
      target: { value: 'Now {{ stufa.temperature }}' },
    })
    expect(onChange).toHaveBeenCalledWith({ kind: 'fixed', value: 'Now {{ stufa.temperature }}' })
  })

  it('shows a stored device reference as a chip', () => {
    render(
      renderWithTemplateHub(
        <ArgField
          {...base}
          arg={TEXT}
          value={{ kind: 'fixed', value: '{{ stufa.temperature }}' }}
          onChange={vi.fn()}
        />,
      ),
    )
    expect(screen.getByTestId('arg-text-message-chips').textContent).toContain('stufa.temperature')
  })

  it('a secret text arg stays a password input with no device values', () => {
    render(
      renderWithTemplateHub(
        <ArgField
          {...base}
          arg={SECRET}
          value={{ kind: 'fixed', value: 'x' }}
          onChange={vi.fn()}
        />,
      ),
    )
    expect(screen.getByLabelText('PIN').getAttribute('type')).toBe('password')
    expect(screen.queryByTestId('arg-text-pin-insert')).toBeNull()
  })
})
