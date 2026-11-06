// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const customMutate = vi.hoisted(() => vi.fn())

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useAddonsCustom: () => ({
    mutateAsync: customMutate,
  }),
}))

import { ProviderConfigForm } from '../ProviderConfigForm'

function renderForm(ui: React.ReactElement): void {
  render(<ConfirmDialogProvider>{ui}</ConfirmDialogProvider>)
}

function nameInput(): HTMLElement {
  return screen.getByPlaceholderText('e.g. Garage Server')
}

function hostInput(): HTMLElement {
  const inputs = screen.getAllByRole('textbox')
  const host = inputs.find((el) => el !== nameInput())
  if (!host) throw new Error('host input missing')
  return host
}

const HOST_SCHEMA = {
  sections: [
    {
      id: 'c',
      title: 'C',
      fields: [{ type: 'text' as const, key: 'host', label: 'Host', required: true }],
    },
  ],
}

describe('ProviderConfigForm Next gate', () => {
  beforeEach(() => {
    customMutate.mockReset()
    customMutate.mockResolvedValue({
      sslCertificate: 'CERT',
      sslKey: 'KEY',
      token: 'tok',
      summary: 'ok',
    })
  })

  it('has no Test button: the connection is tested by integrations.create, and Next waits only for the name', () => {
    renderForm(
      <ProviderConfigForm
        addonId="bosch-shc"
        configSchema={HOST_SCHEMA}
        onSave={vi.fn()}
        onBack={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull()
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next).toBeDisabled()
    fireEvent.change(nameInput(), { target: { value: 'Home' } })
    expect(next).not.toBeDisabled()
  })

  it('keeps the credentials a registerClient action returned, and hands them to onSave', async () => {
    const onSave = vi.fn()
    renderForm(
      <ProviderConfigForm
        addonId="bosch-shc"
        configSchema={{
          sections: [
            {
              id: 'c',
              title: 'C',
              fields: [
                { type: 'text', key: 'host', label: 'Host', required: true },
                {
                  type: 'addon-action-button',
                  addonId: 'bosch-shc',
                  key: '__reg',
                  label: 'Reg',
                  buttonLabel: 'Register on controller',
                  action: 'registerClient',
                  paramsFromForm: { host: 'host' },
                  assignResult: {
                    sslCertificate: 'sslCertificate',
                    sslKey: 'sslKey',
                    token: 'token',
                  },
                },
              ],
            },
          ],
        }}
        onSave={onSave}
        onBack={() => {}}
      />,
    )
    fireEvent.change(nameInput(), { target: { value: 'Home' } })
    fireEvent.change(hostInput(), { target: { value: '192.168.1.59' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register on controller' }))
    await waitFor(() => expect(customMutate).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      name: 'Home',
      config: expect.objectContaining({ host: '192.168.1.59', token: 'tok' }),
    })
  })
})
