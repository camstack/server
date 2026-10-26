// @vitest-environment jsdom
import { SECRET_CLEAR, type ConfigAccountSignInField } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FormField } from '../config-form-field'

const FIELD: ConfigAccountSignInField = {
  type: 'account-sign-in',
  key: '__homecom-sign-in',
  label: 'HomeCom',
  addonId: 'bosch-homecom',
  providerLabel: 'SingleKey ID',
  beginAction: 'beginSignIn',
  completeAction: 'finishSignIn',
  signOutAction: 'signOut',
  accountKey: 'accountLabel',
  countKey: 'gatewayCount',
  countNoun: 'gateway',
  choiceKey: 'gatewayId',
  secretKeys: ['token', 'refresh'],
  assignResult: {
    token: 'token',
    accountLabel: 'accountLabel',
    gatewayCount: 'gatewayCount',
    gatewayId: 'gatewayId',
  },
}

describe('account-sign-in field', () => {
  it('renders signed out, then the paste box, then signed in', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const onChangeMany = vi.fn()
    const onAction = vi.fn(async (action: string, _key: string, _value?: unknown) => {
      if (action === 'beginSignIn') {
        return { attemptId: 'attempt-1', authorizeUrl: 'https://singlekey-id.com/auth' }
      }
      if (action === 'finishSignIn') {
        return {
          token: 'access',
          accountLabel: 'me@example.com',
          gatewayCount: 1,
          gatewayId: 'gw-1',
        }
      }
      return { signedOut: true }
    })
    const { rerender } = render(
      <FormField
        field={FIELD}
        values={{}}
        onChange={vi.fn()}
        onChangeMany={onChangeMany}
        onAction={onAction}
      />,
    )
    expect(screen.getByRole('button', { name: 'Sign in with SingleKey ID' })).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with SingleKey ID' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(open).toHaveBeenCalledWith(
      'https://singlekey-id.com/auth',
      '_blank',
      'noopener,noreferrer',
    )
    expect(onAction).toHaveBeenCalledWith('beginSignIn', '__homecom-sign-in', {})

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'com.bosch.tt.dashtt.pointt://app/login?code=abc&state=st' },
    })
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith('finishSignIn', '__homecom-sign-in', {
        attemptId: 'attempt-1',
        callback: 'com.bosch.tt.dashtt.pointt://app/login?code=abc&state=st',
      }),
    )
    const complete = onAction.mock.calls.find((call) => call[0] === 'finishSignIn')
    expect(complete?.[2]).not.toHaveProperty('verifier')
    expect(onChangeMany).toHaveBeenCalledWith({
      token: 'access',
      accountLabel: 'me@example.com',
      gatewayCount: 1,
      gatewayId: 'gw-1',
    })

    rerender(
      <FormField
        field={FIELD}
        values={{ accountLabel: 'me@example.com', gatewayCount: 1, token: 'access' }}
        onChange={vi.fn()}
        onChangeMany={onChangeMany}
        onAction={onAction}
      />,
    )
    expect(screen.getByText('Signed in as me@example.com · 1 gateway')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() =>
      expect(onChangeMany).toHaveBeenCalledWith({
        accountLabel: '',
        gatewayCount: 0,
        gatewayId: '',
        token: SECRET_CLEAR,
        refresh: SECRET_CLEAR,
      }),
    )
    open.mockRestore()
  })

  it('shows the named message when the account has no gateway', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null)
    const onAction = vi.fn(async (action: string) => {
      if (action === 'beginSignIn') {
        return { attemptId: 'attempt-1', authorizeUrl: 'https://singlekey-id.com/auth' }
      }
      return {
        token: 'access',
        accountLabel: 'me@example.com',
        gatewayCount: 0,
        summary: 'This Bosch account has no HomeCom gateway.',
      }
    })
    render(
      <FormField
        field={FIELD}
        values={{}}
        onChange={vi.fn()}
        onChangeMany={vi.fn()}
        onAction={onAction}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with SingleKey ID' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'com.bosch.tt.dashtt.pointt://app/login?code=abc&state=st' },
    })
    await waitFor(() =>
      expect(screen.getByText('This Bosch account has no HomeCom gateway.')).toBeTruthy(),
    )
  })
})
