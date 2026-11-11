// @vitest-environment jsdom
/**
 * Identity → Authentication renders the shared instances table from the
 * integration-instances answers: one row per OIDC connection, a fixed row for a
 * login-method provider that keeps no records, and the sign-in policy card.
 * No addon pill row and no addon-level enable toggle.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { ConfirmDialogProvider } from '@camstack/ui-library'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface ProviderRow {
  addonId: string
  isActive: boolean
}

const h = vi.hoisted(() => ({
  fn: { data: [] as ProviderRow[] | undefined, error: null as Error | null },
  holders: {
    data: [] as ProviderRow[] | undefined,
    error: null as Error | null,
  },
  records: {} as Record<string, unknown[]>,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const query = (slot: { data: ProviderRow[] | undefined; error: Error | null }) => ({
    data: slot.data,
    error: slot.error,
    isPending: slot.data === undefined && slot.error === null,
    isError: slot.error !== null,
    refetch: vi.fn(),
  })
  return {
    ...actual,
    useAddonsListCapabilityProviders: (input: { capName: string }) =>
      query(input.capName === 'integration-instances' ? h.holders : h.fn),
    useInstancesOfCap: () => ({ data: [], isLoading: false }),
    useAddonsList: () => ({
      data: [
        {
          manifest: {
            id: 'auth-oidc',
            name: 'OpenID Connect',
            description: 'Sign in through an identity provider.',
          },
        },
        {
          manifest: {
            id: 'auth-webauthn',
            name: 'Passkey',
            description: 'Passkeys enrolled on this hub.',
          },
        },
      ],
    }),
    useAddonsSetCapabilityProviderEnabled: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useAddonsRestartAddon: () => ({
      mutateAsync: vi.fn(async () => ({ ok: true as const })),
      mutate: vi.fn(),
      isPending: false,
    }),
    LogStream: () => <div data-testid="log-stream" />,
    EventStream: () => <div data-testid="event-stream" />,
    useSystem: () => ({
      trpcClient: {
        integrationInstances: {
          describe: {
            query: async () => ({
              role: 'services',
              instanceMode: 'multiple',
              kind: 'login-method',
              canTest: false,
              kinds: [
                {
                  id: 'oidc-provider',
                  label: 'OpenID Connect',
                  functionCap: 'login-method',
                },
              ],
            }),
          },
          listInstances: {
            query: async ({ addonId }: { addonId: string }) => h.records[addonId] ?? [],
          },
          instanceFormSchema: { query: async () => ({ sections: [] }) },
        },
      },
    }),
  }
})

vi.mock('../../../components/instances/use-set-instance-enabled', () => ({
  useSetInstanceEnabled: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('../../../components/system/BootstrapSettingsForm', () => ({
  BootstrapSettingsForm: ({ sectionIds }: { sectionIds?: readonly string[] }) => (
    <div data-testid="bootstrap-form" data-sections={sectionIds?.join(',')} />
  ),
}))

import { AuthenticationPage } from '../Authentication'

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ConfirmDialogProvider>
          <AuthenticationPage />
        </ConfirmDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  h.fn = {
    data: [
      { addonId: 'auth-oidc', isActive: true },
      { addonId: 'auth-webauthn', isActive: true },
    ],
    error: null,
  }
  h.holders = {
    data: [{ addonId: 'auth-oidc', isActive: true }],
    error: null,
  }
  h.records = {
    'auth-oidc': [
      {
        id: 'authentik',
        name: 'Authentik',
        configured: true,
        enabled: true,
        kind: 'oidc-provider',
        formValues: {},
        status: { state: 'ok', label: 'Ready' },
      },
    ],
  }
})

describe('AuthenticationPage', () => {
  it('lists each OIDC connection once, a fixed passkey row, and no addon toggle', async () => {
    renderPage()
    await waitFor(() => {
      expect(screen.getAllByText('Authentik')).toHaveLength(1)
    })
    expect(screen.getAllByText('OpenID Connect').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Passkey').length).toBeGreaterThan(0)
    expect(screen.getByRole('switch', { name: 'Enable Authentik' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Enable Passkey' })).toBeTruthy()
    expect(screen.queryByRole('switch', { name: 'Enable OpenID Connect' })).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.getByText('Sign-in policy')).toBeTruthy()
    expect(screen.getByTestId('bootstrap-form').dataset.sections).toBe('system-config-auth')
    expect(screen.getByText(/Username and password sign-in is always on/)).toBeTruthy()
  })
})
