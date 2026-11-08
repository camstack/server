// @vitest-environment jsdom
/**
 * Connectivity — SectionedPage with one embedded IntegrationHub per kind
 * (Exporters / Email / Brokers / Calendars).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StaticAddonIconsProvider } from '../../../contexts/addon-icons-context'

const fixtures = vi.hoisted(() => ({
  holders: [] as string[],
  addons: [] as Array<{
    manifest: {
      id: string
      name: string
      packageDisplayName?: string
      capabilities: Array<{ name: string } | string>
    }
    process: { state: string }
  }>,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const real = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...real,
    useAddonsList: () => ({ data: fixtures.addons, isLoading: false }),
    useAddonsListCapabilityProviders: () => ({
      data: fixtures.holders.map((addonId) => ({ addonId })),
    }),
    useBrokerGetStatus: () => ({ data: undefined }),
    useDeviceExportGetStatus: () => ({ data: undefined }),
    useAddonsRestartAddon: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useAddonsSetCapabilityProviderEnabled: () => ({ mutate: vi.fn(), isPending: false }),
    DeviceExportPanel: () => <div>devices</div>,
    DeviceExportSetup: () => <div>setup</div>,
    LogStream: () => null,
    EventStream: () => null,
  }
})

vi.mock('../../../components/settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: () => <div data-testid="schema-settings">settings</div>,
}))

vi.mock('../../../components/instances/InstancesTable', () => ({
  InstancesTable: ({ functionCap }: { functionCap: string }) => (
    <div data-testid="provider-instances" data-cap={functionCap} />
  ),
}))

vi.mock('../../../components/integration-hub/AddonIntegrationBody', () => ({
  AddonIntegrationBody: ({ addonId }: { addonId: string }) => <div>{`body ${addonId}`}</div>,
}))

vi.mock('../../../components/brokers/BrokerManager', () => ({
  BrokerManager: () => <div>broker connections</div>,
}))

vi.mock('../../../lib/nav-items', () => ({
  navChromeForPath: () => null,
}))

import { IntegrationsPage } from '../Integrations'

function Where() {
  const loc = useLocation()
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>
}

function renderAt(url: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <StaticAddonIconsProvider icons={new Map()}>
        <MemoryRouter initialEntries={[url]}>
          <IntegrationsPage />
          <Where />
        </MemoryRouter>
      </StaticAddonIconsProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  fixtures.holders = []
  fixtures.addons = [
    {
      manifest: {
        id: 'export-alexa',
        name: 'Alexa',
        capabilities: [{ name: 'device-export' }],
      },
      process: { state: 'running' },
    },
    {
      manifest: {
        id: 'smtp-nodemailer',
        name: 'SMTP',
        capabilities: [{ name: 'smtp-provider' }],
      },
      process: { state: 'running' },
    },
    {
      manifest: {
        id: 'mqtt-broker',
        name: 'MQTT',
        capabilities: [{ name: 'broker' }],
      },
      process: { state: 'running' },
    },
    {
      manifest: {
        id: 'google-services',
        name: 'Google',
        packageDisplayName: 'Google',
        capabilities: [{ name: 'calendar-source' }, { name: 'smtp-provider' }],
      },
      process: { state: 'running' },
    },
    {
      manifest: {
        id: 'waste-collections',
        name: 'Waste',
        capabilities: [{ name: 'calendar-source' }],
      },
      process: { state: 'running' },
    },
  ]
})

describe('Connectivity SectionedPage', () => {
  it('renders four kind sections', () => {
    renderAt('/system/integrations')
    expect(screen.getByRole('heading', { level: 1, name: 'Connectivity' })).toBeTruthy()
    const tabs = screen.getByRole('tablist', { name: 'Connectivity sections' })
    for (const label of ['Exporters', 'Email', 'Brokers', 'Calendars']) {
      expect(within(tabs).getByRole('tab', { name: label })).toBeTruthy()
    }
  })

  it('calendars section is the calendar-source instances list plus the pill of every provider without an instance model', () => {
    fixtures.holders = ['google-services']
    renderAt('/system/integrations?tab=calendars')
    expect(screen.getByTestId('provider-instances').getAttribute('data-cap')).toBe(
      'calendar-source',
    )
    const pills = screen.getByRole('navigation', { name: /Calendars integrations/i })
    expect(within(pills).getByText('Waste')).toBeTruthy()
    expect(within(pills).queryByText('Google')).toBeNull()
  })

  it('calendars section draws no "nothing installed" state under a populated list', () => {
    // Every calendar provider keeps instance records, so the hub has no pill. The other
    // connectivity addons (email, broker) are no calendar provider and must not become one.
    fixtures.holders = ['google-services', 'waste-collections']
    renderAt('/system/integrations?tab=calendars')
    expect(screen.getByTestId('provider-instances').getAttribute('data-cap')).toBe(
      'calendar-source',
    )
    expect(screen.queryByText(/No calendar sources/i)).toBeNull()
    expect(screen.queryByRole('navigation', { name: /Calendars integrations/i })).toBeNull()
  })

  it('email section is the provider-instances list of smtp-provider, not a pill hub', () => {
    renderAt('/system/integrations?tab=email')
    expect(screen.getByTestId('provider-instances').getAttribute('data-cap')).toBe('smtp-provider')
    expect(screen.queryByRole('navigation', { name: /Email integrations/i })).toBeNull()
  })

  it('brokers section is one instances list of the broker cap: a single pill row, no hub pills, no All', () => {
    renderAt('/system/integrations?tab=brokers')
    expect(screen.getByTestId('provider-instances').getAttribute('data-cap')).toBe('broker')
    expect(screen.queryByRole('navigation', { name: /Brokers integrations/i })).toBeNull()
    expect(screen.queryByTestId('instance-pill-all')).toBeNull()
    expect(screen.queryByRole('button', { name: /^All\b/ })).toBeNull()
  })

  it('remaps legacy ?tab=device-export to exporters', async () => {
    renderAt('/system/integrations?tab=device-export')
    // replace effect runs after paint
    await vi.waitFor(() => {
      expect(screen.getByTestId('where').textContent).toContain('tab=exporters')
    })
  })

  it('keeps integration param when opening a calendars deep-link', () => {
    renderAt('/system/integrations?tab=calendars&integration=google-services&section=settings')
    expect(screen.getByTestId('where').textContent).toContain('integration=google-services')
    expect(screen.getByTestId('where').textContent).toContain('section=settings')
    expect(screen.getByTestId('where').textContent).toContain('tab=calendars')
  })
})
