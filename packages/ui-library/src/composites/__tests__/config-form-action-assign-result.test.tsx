// @vitest-environment jsdom
import type { ConfigField } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialogProvider } from '../confirm-dialog'
import { FormField } from '../config-form-field'

const REGISTER: ConfigField = {
  type: 'addon-action-button',
  key: '__register',
  label: 'Register',
  addonId: 'bosch-shc',
  action: 'registerClient',
  buttonLabel: 'Register on controller',
  assignResult: { sslCertificate: 'sslCertificate', sslKey: 'sslKey' },
  successMessage: 'Registered.',
}

describe('addon-action-button — assignResult', () => {
  it('writes string result fields into the form', async () => {
    const onChange = vi.fn()
    const onChangeMany = vi.fn()
    const onAction = vi.fn(async () => ({
      sslCertificate: 'CERT',
      sslKey: 'KEY',
    }))
    render(
      <ConfirmDialogProvider>
        <FormField
          field={REGISTER}
          values={{ host: '192.0.2.20' }}
          onChange={onChange}
          onChangeMany={onChangeMany}
          onAction={onAction}
        />
      </ConfirmDialogProvider>,
    )
    fireEvent.click(screen.getByText('Register on controller'))
    await waitFor(() => expect(onAction).toHaveBeenCalled())
    await waitFor(() =>
      expect(onChangeMany).toHaveBeenCalledWith({
        sslCertificate: 'CERT',
        sslKey: 'KEY',
      }),
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('falls back to per-key onChange when onChangeMany is absent', async () => {
    const onChange = vi.fn()
    const onAction = vi.fn(async () => ({
      sslCertificate: 'CERT',
      sslKey: 'KEY',
    }))
    render(
      <ConfirmDialogProvider>
        <FormField
          field={REGISTER}
          values={{ host: '192.0.2.20' }}
          onChange={onChange}
          onAction={onAction}
        />
      </ConfirmDialogProvider>,
    )
    fireEvent.click(screen.getByText('Register on controller'))
    await waitFor(() => expect(onAction).toHaveBeenCalled())
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('sslCertificate', 'CERT'))
    expect(onChange).toHaveBeenCalledWith('sslKey', 'KEY')
  })
})
