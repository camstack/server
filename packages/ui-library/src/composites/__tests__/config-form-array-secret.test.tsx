// @vitest-environment jsdom
/**
 * A `password` item inside an `editable-array` row (the OIDC client secret).
 *
 * D789 (amends D780): the admin form no longer carries the stored secret. It
 * carries the keychain VIEW — `{ $secret, v, set: true }` — and the row
 * round-trips that view, never a value and never a mask. What is pinned:
 *
 *  - a stored secret draws as an empty masked password input (one eye, no
 *    Change / Clear / Reveal), and no input in the DOM holds any value of it;
 *  - editing ANOTHER field of the row writes the row back with the view
 *    exactly as hydrated — which the owner's save path reads as KEEP;
 *  - typing sends the typed string; emptying a box the operator typed into or
 *    revealed sends the explicit `{ $secretClear: true }` (an empty string
 *    never means "remove");
 *  - the eye shows the value only through the host's audited reveal.
 */
import { type ConfigField, SECRET_CLEAR } from '@camstack/types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FormField } from '../config-form-field'
import { SecretRevealProvider } from '../config-secret-field'

const PROVIDERS: ConfigField = {
  type: 'editable-array',
  key: 'providers',
  label: 'Providers',
  itemFields: [
    { type: 'text', key: 'displayName', label: 'Display name' },
    { type: 'password', key: 'clientSecret', label: 'Client Secret' },
  ],
}

const AUTHENTIK = {
  $secret: 'secret://auth-oidc/global/providers[authentik].clientSecret',
  v: 1,
  set: true,
}
const GOOGLE = {
  $secret: 'secret://auth-oidc/global/providers[google].clientSecret',
  v: 1,
  set: true,
}

const HYDRATED = [
  { id: 'authentik', displayName: 'Authentik', clientSecret: AUTHENTIK },
  { id: 'google', displayName: 'Google', clientSecret: GOOGLE },
]

describe('editable-array — a keychain secret round-trips its view, never a value', () => {
  it('draws a stored secret as an empty masked input with an eye, and no input holds it', () => {
    const { container } = render(
      <FormField field={PROVIDERS} values={{ providers: HYDRATED }} onChange={vi.fn()} />,
    )
    const inputs = screen.getAllByLabelText('Client Secret') as HTMLInputElement[]
    expect(inputs).toHaveLength(2)
    for (const input of inputs) {
      expect(input.type).toBe('password')
      expect(input.value).toBe('')
      expect(input.placeholder).toBe('••••••••')
    }
    expect(screen.queryByRole('button', { name: /^(Change|Clear|Reveal)$/ })).toBeNull()
    expect(container.textContent).not.toContain('set')
  })

  it('editing another field of the row writes the view back unchanged — the marker round-trips', () => {
    const onChange = vi.fn()
    render(<FormField field={PROVIDERS} values={{ providers: HYDRATED }} onChange={onChange} />)
    fireEvent.change(screen.getAllByDisplayValue('Authentik')[0] as HTMLElement, {
      target: { value: 'Authentik SSO' },
    })
    const lastCall = onChange.mock.calls.at(-1)
    expect(lastCall?.[0]).toBe('providers')
    expect(lastCall?.[1]).toEqual([
      { id: 'authentik', displayName: 'Authentik SSO', clientSecret: AUTHENTIK },
      { id: 'google', displayName: 'Google', clientSecret: GOOGLE },
    ])
    expect(JSON.stringify(lastCall?.[1])).not.toMatch(/\*\*\*|•|__camstack_redacted__/)
  })

  it('typing sends what is typed; emptying it again sends the explicit clear, never ""', () => {
    const onChange = vi.fn()
    render(<FormField field={PROVIDERS} values={{ providers: HYDRATED }} onChange={onChange} />)
    const input = screen.getAllByLabelText('Client Secret')[0] as HTMLElement
    fireEvent.change(input, { target: { value: 'new-client-secret' } })
    expect(onChange.mock.calls.at(-1)?.[1][0].clientSecret).toBe('new-client-secret')
    expect(onChange.mock.calls.at(-1)?.[1][1].clientSecret).toEqual(GOOGLE)
    fireEvent.change(input, { target: { value: '' } })
    expect(onChange.mock.calls.at(-1)?.[1][0].clientSecret).toEqual(SECRET_CLEAR)
  })

  it('the eye reveals one row through the host; emptying the revealed value clears that row only', async () => {
    const reveal = vi.fn(async () => 'the-revealed-value')
    const onChange = vi.fn()
    render(
      <SecretRevealProvider reveal={reveal}>
        <FormField field={PROVIDERS} values={{ providers: HYDRATED }} onChange={onChange} />
      </SecretRevealProvider>,
    )
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Show password' })[1] as HTMLElement)
    })
    expect(reveal).toHaveBeenCalledWith(GOOGLE.$secret)
    const input = screen.getAllByLabelText('Client Secret')[1] as HTMLInputElement
    expect(input.value).toBe('the-revealed-value')
    expect(input.type).toBe('text')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '' } })
    const rows = onChange.mock.calls.at(-1)?.[1]
    expect(rows[1].clientSecret).toEqual(SECRET_CLEAR)
    expect(rows[0].clientSecret).toEqual(AUTHENTIK)
  })

  it('a host without a reveal cannot reveal an untouched row', () => {
    render(<FormField field={PROVIDERS} values={{ providers: HYDRATED }} onChange={vi.fn()} />)
    for (const eye of screen.getAllByRole('button', { name: 'Show password' })) {
      expect((eye as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
