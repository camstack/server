// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const testMutate = vi.hoisted(() => vi.fn())
const customMutate = vi.hoisted(() => vi.fn())

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useIntegrationsTestConnection: (opts: {
    onSuccess?: (r: { success: boolean; status: string }) => void
  }) => ({
    mutate: (input: { addonId: string; settings: Record<string, unknown> }) => {
      testMutate(input)
      opts.onSuccess?.({ success: true, status: 'validated' })
    },
    isPending: false,
  }),
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

describe('ProviderConfigForm Next gate', () => {
  beforeEach(() => {
    testMutate.mockClear()
    customMutate.mockReset()
    customMutate.mockResolvedValue({
      sslCertificate: 'CERT',
      sslKey: 'KEY',
      token: 'tok',
      summary: 'ok',
    })
  })

  it('keeps Next disabled until the connection test validates when canTest', () => {
    renderForm(
      <ProviderConfigForm
        addonId="bosch-shc"
        canTest
        configSchema={{
          sections: [
            {
              id: 'c',
              title: 'C',
              fields: [{ type: 'text', key: 'host', label: 'Host', required: true }],
            },
          ],
        }}
        onSave={vi.fn()}
        onBack={() => {}}
      />,
    )
    fireEvent.change(nameInput(), { target: { value: 'Home' } })
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(next).not.toBeDisabled()
  })

  it('re-disables Next when the form changes after a validated test', () => {
    renderForm(
      <ProviderConfigForm
        addonId="bosch-shc"
        canTest
        configSchema={{
          sections: [
            {
              id: 'c',
              title: 'C',
              fields: [{ type: 'text', key: 'host', label: 'Host', required: true }],
            },
          ],
        }}
        onSave={vi.fn()}
        onBack={() => {}}
      />,
    )
    fireEvent.change(nameInput(), { target: { value: 'Home' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next).not.toBeDisabled()
    fireEvent.change(hostInput(), { target: { value: '192.168.1.1' } })
    expect(next).toBeDisabled()
  })

  it('auto-runs the connection test after a successful registerClient', async () => {
    renderForm(
      <ProviderConfigForm
        addonId="bosch-shc"
        canTest
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
        onSave={vi.fn()}
        onBack={() => {}}
      />,
    )
    fireEvent.change(hostInput(), { target: { value: '192.168.1.59' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register on controller' }))
    await waitFor(() => expect(customMutate).toHaveBeenCalled())
    await waitFor(() =>
      expect(testMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          addonId: 'bosch-shc',
          settings: expect.objectContaining({
            host: '192.168.1.59',
            sslCertificate: 'CERT',
            sslKey: 'KEY',
            token: 'tok',
          }),
        }),
      ),
    )
  })
})
