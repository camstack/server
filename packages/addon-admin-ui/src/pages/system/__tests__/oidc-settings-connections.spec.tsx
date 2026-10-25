// @vitest-environment jsdom
/**
 * OIDC Settings — DataTable + ItemFormDialog; no editable-array FormBuilder.
 */
import type { OidcConnection } from '@camstack/types'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CONNECTIONS: readonly OidcConnection[] = [
  {
    id: 'authentik',
    displayName: 'Authentik',
    icon: 'shield-check',
    issuerUrl: 'https://idp.example',
    clientId: 'camstack',
    configured: true,
    formValues: {
      displayName: 'Authentik',
      icon: 'shield-check',
      issuerUrl: 'https://idp.example',
      clientId: 'camstack',
      clientSecret: '',
      redirectUri: '',
      scopes: 'openid profile email',
      usernameClaim: 'preferred_username',
    },
  },
]

const createConnection = vi.fn(async () => ({ id: 'google' }))
const updateConnection = vi.fn(async () => ({ ok: true as const }))
const deleteConnection = vi.fn(async () => ({ ok: true as const }))
const listConnections = vi.fn(async () => CONNECTIONS)

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: {
        oidcConnections: {
          listConnections: { query: listConnections },
          connectionFormSchema: {
            query: async () => ({
              sections: [
                {
                  id: 'identity',
                  title: 'Identity',
                  fields: [
                    {
                      type: 'text',
                      key: 'displayName',
                      label: 'Display name',
                      default: 'OpenID Connect',
                    },
                  ],
                },
              ],
            }),
          },
          createConnection: { mutate: createConnection },
          updateConnection: { mutate: updateConnection },
          deleteConnection: { mutate: deleteConnection },
        },
      },
    }),
  }
})

import { OidcSettingsConnections } from '../OidcSettingsConnections.js'

function installDialogPolyfill(): void {
  if (typeof HTMLDialogElement === 'undefined') return
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false
    }
  }
}

afterEach(cleanup)

beforeEach(() => {
  installDialogPolyfill()
  listConnections.mockClear()
  createConnection.mockClear()
  updateConnection.mockClear()
  deleteConnection.mockClear()
  window.history.replaceState({}, '', '/system/identity?tab=authentication&integration=auth-oidc')
})

function renderPanel(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ConfirmDialogProvider>
        <OidcSettingsConnections addonId="auth-oidc" />
      </ConfirmDialogProvider>
    </QueryClientProvider>,
  )
}

describe('OidcSettingsConnections', () => {
  it('lists connections in a table and opens Add dialog without an editable-array', async () => {
    renderPanel()
    expect(await screen.findByTestId('oidc-settings-connections')).toBeTruthy()
    expect(await screen.findByText('Authentik')).toBeTruthy()
    expect(screen.getByText('authentik')).toBeTruthy()
    expect(screen.queryByText(/Click \+ to add/i)).toBeNull()

    fireEvent.click(screen.getByTestId('oidc-connections-add'))
    const dialog = await screen.findByTestId('oidc-connection-editor')
    expect(within(dialog).getByLabelText(/Instance id/i)).toBeTruthy()
    expect(within(dialog).getByText(/Display name/i)).toBeTruthy()
  })

  it('Save on create calls createConnection then updateConnection', async () => {
    renderPanel()
    fireEvent.click(await screen.findByTestId('oidc-connections-add'))
    const dialog = await screen.findByTestId('oidc-connection-editor')
    fireEvent.change(within(dialog).getByLabelText(/Instance id/i), {
      target: { value: 'google' },
    })
    const nameInput = within(dialog).getByDisplayValue('OpenID Connect')
    fireEvent.change(nameInput, { target: { value: 'Google' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(createConnection).toHaveBeenCalledWith({ id: 'google', displayName: 'Google' })
      expect(updateConnection).toHaveBeenCalled()
    })
  })
})
