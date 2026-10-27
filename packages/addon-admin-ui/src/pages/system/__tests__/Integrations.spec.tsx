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

  it('calendars section lists google-services and waste-collections', () => {
    renderAt('/system/integrations?tab=calendars')
    const pills = screen.getByRole('navigation', { name: /Calendars integrations/i })
    expect(within(pills).getByText('Google')).toBeTruthy()
    expect(within(pills).getByText('Waste')).toBeTruthy()
    expect(within(pills).queryByText('Alexa')).toBeNull()
  })

  it('email section lists google-services and smtp-nodemailer', () => {
    renderAt('/system/integrations?tab=email')
    const pills = screen.getByRole('navigation', { name: /Email integrations/i })
    expect(within(pills).getByText('Google')).toBeTruthy()
    expect(within(pills).getByText('SMTP')).toBeTruthy()
    expect(within(pills).queryByText('Waste')).toBeNull()
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
