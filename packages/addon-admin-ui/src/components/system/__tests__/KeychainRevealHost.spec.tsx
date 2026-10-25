// @vitest-environment jsdom
/**
 * The admin host behind every secret field's eye (D789): an untouched stored
 * secret is revealed only through `keychain-admin.reveal` with the field's
 * ref, and a refusal (a non-admin) reaches the field as a readable sentence on
 * the eye — the field stays untouched, so the save still keeps the secret.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutateAsync = vi.fn<(input: { ref: string }) => Promise<{ value: string }>>()

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return { ...actual, useKeychainAdminReveal: () => ({ mutateAsync }) }
})

import { ConfigFormField as FormField } from '@camstack/ui-library'
import { KeychainRevealHost } from '../KeychainRevealHost'

const VIEW = { $secret: 'secret://provider-hikvision/device/7/password', v: 1, set: true }

function renderDeviceForm() {
  const onChange = vi.fn()
  render(
    <KeychainRevealHost>
      <FormField
        field={{ type: 'password', key: 'password', label: 'Password' }}
        values={{ password: VIEW }}
        onChange={onChange}
      />
    </KeychainRevealHost>,
  )
  return { onChange, input: screen.getByLabelText('Password') as HTMLInputElement }
}

describe('KeychainRevealHost — the eye of a stored secret', () => {
  beforeEach(() => {
    mutateAsync.mockReset()
  })

  it('reveals through keychain-admin.reveal with the field ref, without changing the field', async () => {
    mutateAsync.mockResolvedValue({ value: 'cam-secret' })
    const { onChange, input } = renderDeviceForm()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    })
    expect(mutateAsync).toHaveBeenCalledWith({ ref: VIEW.$secret })
    expect(input.value).toBe('cam-secret')
    expect(input.type).toBe('text')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a FORBIDDEN reveal shows the admin-only sentence on the eye; the field stays untouched', async () => {
    mutateAsync.mockRejectedValue(
      Object.assign(new Error('FORBIDDEN'), { data: { code: 'FORBIDDEN' } }),
    )
    const { onChange, input } = renderDeviceForm()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    })
    expect(screen.getByRole('alert').textContent).toBe('Only an admin can reveal a stored secret.')
    expect(input.value).toBe('')
    expect(onChange).not.toHaveBeenCalled()
  })
})
