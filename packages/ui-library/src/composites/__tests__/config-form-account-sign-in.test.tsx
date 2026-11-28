// @vitest-environment jsdom
/**
 * The account-sign-in field's buttons reach the addon only through the form's `onAction`.
 * `ConfigFormBuilder` must pass it (and write the field's result back into the values); a form
 * mounted without a handler shows the buttons disabled with a reason, never dead.
 */
import { SECRET_CLEAR, type ConfigUISchema, type SecretFieldView } from '@dominevo/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
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

const EDITABLE: ConfigUISchema = {
  sections: [
    {
      id: 'account',
      title: 'Account',
      fields: [
        { type: 'text', key: 'note', label: 'Note' },
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
          secretKeys: ['token'],
          assignResult: { token: 'token', accountLabel: 'accountLabel' },
        },
      ],
    },
  ],
}

function Host(props: {
  readonly initial: Record<string, unknown>
  readonly onAction: (action: string, key: string, value?: unknown) => Promise<unknown>
  readonly seen: (values: Record<string, unknown>) => void
}) {
  const [values, setValues] = useState<Record<string, unknown>>(props.initial)
  return (
    <ConfigFormBuilder
      schema={EDITABLE}
      values={values}
      onChange={(next) => {
        props.seen(next)
        setValues(next)
      }}
      onAction={props.onAction}
    />
  )
}

describe('ConfigFormBuilder — a field action resolving later', () => {
  it('merges into the CURRENT values: an edit made while it was in flight survives', async () => {
    let release: (value: unknown) => void = () => undefined
    const onAction = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve
        }),
    )
    const seen = vi.fn()
    render(
      <Host
        initial={{ note: '', accountLabel: 'me', token: 'set' }}
        onAction={onAction}
        seen={seen}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(onAction).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typed meanwhile' } })
    release({ signedOut: true, summary: 'ok' })
    await waitFor(() =>
      expect(seen).toHaveBeenLastCalledWith({
        note: 'typed meanwhile',
        accountLabel: '',
        token: SECRET_CLEAR,
      }),
    )
  })

  it("a stored secret's set view from a sign-in result is written into the form", async () => {
    vi.stubGlobal('open', vi.fn())
    const view: SecretFieldView = { $secret: 'secret://x', v: 1, set: true }
    const onAction = vi.fn(async (action: string) =>
      action === 'beginSignIn'
        ? { authorizeUrl: 'https://example.com/a', attemptId: 'att-1' }
        : { token: view, accountLabel: 'me@example.com', summary: 'ok' },
    )
    const seen = vi.fn()
    render(<Host initial={{ note: '' }} onAction={onAction} seen={seen} />)
    fireEvent.click(screen.getByRole('button', { name: /sign in with/i }))
    const paste = await screen.findByLabelText(/redirect address or code/i)
    fireEvent.change(paste, { target: { value: 'app://cb?code=abcdefgh' } })
    await waitFor(() =>
      expect(seen).toHaveBeenLastCalledWith({
        note: '',
        token: view,
        accountLabel: 'me@example.com',
      }),
    )
    vi.unstubAllGlobals()
  })
})
