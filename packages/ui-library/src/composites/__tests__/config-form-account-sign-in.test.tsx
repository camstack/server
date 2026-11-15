// @vitest-environment jsdom
/**
 * The account-sign-in field's buttons reach the addon only through the form's `onAction`.
 * `ConfigFormBuilder` must pass it (and write the field's result back into the values); a form
 * mounted without a handler shows the buttons disabled with a reason, never dead.
 */
import { SECRET_CLEAR, type ConfigUISchema } from '@camstack/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigFormBuilder } from '../config-form-builder.js'

afterEach(() => cleanup())

const SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'account',
      title: 'Account',
      fields: [
        {
          type: 'account-sign-in',
          addonId: 'bosch-homecom',
          key: '__sign-in',
          label: 'HomeCom',
          providerLabel: 'SingleKey ID',
          beginAction: 'beginSignIn',
          completeAction: 'finishSignIn',
          signOutAction: 'signOut',
          accountKey: 'accountLabel',
          secretKeys: ['token', 'refresh'],
        },
      ],
    },
  ],
}

const SIGNED_IN = { accountLabel: 'me@example.com', token: 'set', refresh: 'set' }

describe('ConfigFormBuilder — account-sign-in', () => {
  it('Sign out calls onAction and writes the cleared account back', async () => {
    const onAction = vi.fn(async () => ({ signedOut: true, summary: 'Signed out.' }))
    const onChange = vi.fn()
    render(
      <ConfigFormBuilder
        schema={SCHEMA}
        values={SIGNED_IN}
        onChange={onChange}
        onAction={onAction}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('signOut', '__sign-in', {}))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        accountLabel: '',
        token: SECRET_CLEAR,
        refresh: SECRET_CLEAR,
      }),
    )
  })

  it('Sign in again calls onAction with the begin action', async () => {
    const onAction = vi.fn(async () => ({}))
    render(
      <ConfigFormBuilder
        schema={SCHEMA}
        values={SIGNED_IN}
        onChange={() => undefined}
        onAction={onAction}
        bare
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('beginSignIn', '__sign-in', {}))
  })

  it('without a handler the buttons are disabled and say why', () => {
    render(<ConfigFormBuilder schema={SCHEMA} values={SIGNED_IN} onChange={() => undefined} />)
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Sign in again' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/sign-in is not available here/i)).toBeTruthy()
  })
})
