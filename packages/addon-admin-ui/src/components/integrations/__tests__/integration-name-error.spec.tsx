// @vitest-environment jsdom
/**
 * The integration name is required on every provider. An empty name shows a
 * field error and a submit-time reason; a filled name shows neither.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigUISchema } from '../../../types/config-ui'
import { ProviderConfigForm } from '../ProviderConfigForm'

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useIntegrationsTestConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useAddonsCustom: () => ({ mutateAsync: vi.fn() }),
}))

function schema(id: string, hostLabel: string): ConfigUISchema {
  return {
    sections: [
      {
        id,
        title: id,
        fields: [{ type: 'text', key: 'host', label: hostLabel }],
      },
    ],
  }
}

function renderForm(addonId: string, configSchema: ConfigUISchema): void {
  render(
    <ConfirmDialogProvider>
      <ProviderConfigForm
        addonId={addonId}
        canTest={false}
        configSchema={configSchema}
        onSave={vi.fn()}
        onBack={() => {}}
      />
    </ConfirmDialogProvider>,
  )
}

describe('ProviderConfigForm — integration name', () => {
  it('shows the field error and the submit reason for two providers when the name is empty', () => {
    const { unmount } = render(
      <ConfirmDialogProvider>
        <ProviderConfigForm
          addonId="provider-rtsp"
          canTest={false}
          configSchema={schema('rtsp', 'Host')}
          onSave={vi.fn()}
          onBack={() => {}}
        />
      </ConfirmDialogProvider>,
    )
    expect(screen.getByLabelText('Integration name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('integration-name-error').textContent).toMatch(/required/i)
    expect(screen.getByTestId('integration-name-submit-error').textContent).toMatch(/name/i)
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    unmount()

    renderForm('provider-wyze', schema('wyze', 'Email'))
    expect(screen.getByLabelText('Integration name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('integration-name-error')).toBeTruthy()
    expect(screen.getByTestId('integration-name-submit-error')).toBeTruthy()
  })

  it('shows no name error once the name is filled', () => {
    renderForm('provider-onvif', schema('onvif', 'Address'))
    fireEvent.change(screen.getByLabelText('Integration name'), { target: { value: 'Garage' } })
    expect(screen.getByLabelText('Integration name')).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByTestId('integration-name-error')).toBeNull()
    expect(screen.queryByTestId('integration-name-submit-error')).toBeNull()
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
  })
})
