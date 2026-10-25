/**
 * `<IntegrationHub>` — the base every integration page is built on.
 *
 * Pinned, in the operator's words: the usual page header; the integrations as
 * pills showing each one's ICON next to its NAME; the body switching with the
 * pill; the choice in the URL so a link can open an integration (and a
 * section), a reload keeps it and back/forward walks it; and every
 * integration's settings drawn by the form builder by default (or a page
 * `settingsContent` override inside the same Settings section).
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Share2 } from 'lucide-react'
import type { ReactElement } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StaticAddonIconsProvider } from '../../../contexts/addon-icons-context'

/** What `addons.list` would declare for the pills under test. */
const DECLARED_ICONS: ReadonlyMap<string, string> = new Map([
  ['export-alexa', 'assets/icon.svg'],
  ['export-hap', 'assets/icon.svg'],
  ['mqtt-broker', 'assets/icon.svg'],
])

const settingsMounts: Array<Record<string, unknown>> = []

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }
})

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useAddonsRestartAddon: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useAddonsSetCapabilityProviderEnabled: () => ({ mutate: vi.fn(), isPending: false }),
    LogStream: ({ addonId }: { readonly addonId: string }) => <div>logs of {addonId}</div>,
    EventStream: ({ addonId }: { readonly addonId: string }) => <div>events of {addonId}</div>,
  }
})

// The form builder path: what matters is that the integration's settings are
// THIS panel, for THIS addon, scoped to THIS capability.
vi.mock('../../settings/NodeAddonsSettingsPanel', () => ({
  NodeAddonsSettingsPanel: (props: Record<string, unknown>) => {
    settingsMounts.push(props)
    return <div data-testid="schema-settings">settings form</div>
  },
}))

import { AddonIntegrationBody } from '../AddonIntegrationBody'
import { IntegrationHub } from '../IntegrationHub'
import type { IntegrationEntry, IntegrationGroup } from '../types'

function entry(id: string, name: string, extra: Partial<IntegrationEntry> = {}): IntegrationEntry {
  return {
    id,
    name,
    fallbackIcon: Share2,
    state: 'ok',
    stateLabel: 'running',
    render: () => (
      <AddonIntegrationBody
        addonId={id}
        displayName={name}
        capName="device-export"
        isActive
        panels={[{ id: 'devices', title: 'Devices', content: <div>devices of {id}</div> }]}
      />
    ),
    ...extra,
  }
}

const GROUPS: readonly IntegrationGroup[] = [
  {
    id: 'device-export',
    label: 'Device export',
    entries: [entry('export-alexa', 'Alexa'), entry('export-hap', 'HomeKit')],
    install: { capability: 'device-export', label: 'Add export' },
  },
  {
    id: 'broker',
    label: 'Message brokers',
    entries: [entry('mqtt-broker', 'MQTT', { state: 'off', stateLabel: 'disabled' })],
  },
]

function Probe(): ReactElement {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <div data-testid="location">{location.pathname + location.search}</div>
      <button type="button" onClick={() => navigate(-1)}>
        history back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        history forward
      </button>
    </>
  )
}

function renderHub(url: string, props: Partial<Parameters<typeof IntegrationHub>[0]> = {}): void {
  render(
    <StaticAddonIconsProvider icons={DECLARED_ICONS}>
      <MemoryRouter initialEntries={[url]}>
        <IntegrationHub
          icon={Share2}
          title="Connectivity"
          subtitle="External systems."
          groups={GROUPS}
          isLoading={false}
          emptyTitle="Nothing installed"
          emptyDescription="Install one."
          legacyGroupParam="tab"
          {...props}
        />
        <Probe />
      </MemoryRouter>
    </StaticAddonIconsProvider>,
  )
}

const location = (): string => screen.getByTestId('location').textContent ?? ''
const pills = (): HTMLElement =>
  screen.getByRole('navigation', { name: 'Connectivity integrations' })
const body = (): HTMLElement => screen.getByTestId('integration-body')

beforeEach(() => {
  settingsMounts.length = 0
})

describe('the header', () => {
  it('is the usual page header: title + subtitle', () => {
    renderHub('/system/integrations')
    expect(screen.getByRole('heading', { level: 1, name: 'Connectivity' })).toBeTruthy()
    expect(screen.getByText('External systems.')).toBeTruthy()
  })

  it('a pill whose addon declares no icon draws its glyph and requests nothing', () => {
    render(
      <StaticAddonIconsProvider icons={new Map()}>
        <MemoryRouter initialEntries={['/system/integrations']}>
          <IntegrationHub
            icon={Share2}
            title="Connectivity"
            subtitle="External systems."
            groups={GROUPS}
            isLoading={false}
            emptyTitle="Nothing installed"
            emptyDescription="Install one."
          />
        </MemoryRouter>
      </StaticAddonIconsProvider>,
    )
    expect(screen.getByTestId('integration-pill-export-alexa').querySelector('img')).toBeNull()
  })

  it('shows one pill per integration with its icon next to its name', () => {
    renderHub('/system/integrations')
    for (const [id, name] of [
      ['export-alexa', 'Alexa'],
      ['export-hap', 'HomeKit'],
      ['mqtt-broker', 'MQTT'],
    ] as const) {
      const pill = screen.getByTestId(`integration-pill-${id}`)
      expect(within(pill).getByText(name)).toBeTruthy()
      const icon = pill.querySelector('img')
      expect(icon?.getAttribute('src')).toContain(`/api/addon-assets/${id}/assets/icon.svg`)
    }
  })

  it('labels the groups and writes a non-healthy state in words', () => {
    renderHub('/system/integrations')
    expect(within(pills()).getByText('Device export')).toBeTruthy()
    expect(within(pills()).getByText('Message brokers')).toBeTruthy()
    expect(
      within(screen.getByTestId('integration-pill-mqtt-broker')).getByText('disabled'),
    ).toBeTruthy()
  })

  it('offers the install pill linking the filtered catalog', () => {
    renderHub('/system/integrations')
    const install = within(pills()).getByRole('link', { name: 'Add export' })
    expect(install.getAttribute('href')).toBe('/system/addons?capability=device-export')
  })
})

describe('the selection lives in the URL', () => {
  it('opens the first integration when the URL names none', () => {
    renderHub('/system/integrations')
    expect(body().getAttribute('aria-label')).toBe('Alexa')
    expect(screen.getByTestId('integration-pill-export-alexa').getAttribute('aria-current')).toBe(
      'true',
    )
  })

  it('restores a deep link to an integration', () => {
    renderHub('/system/integrations?integration=export-hap')
    expect(body().getAttribute('aria-label')).toBe('HomeKit')
    expect(screen.getByText('devices of export-hap')).toBeTruthy()
  })

  it('switches the body with the pill and writes the choice to the URL', () => {
    renderHub('/system/integrations')
    fireEvent.click(screen.getByTestId('integration-pill-mqtt-broker'))
    expect(location()).toBe('/system/integrations?integration=mqtt-broker')
    expect(body().getAttribute('aria-label')).toBe('MQTT')
  })

  it('walks the integrations with back and forward', () => {
    renderHub('/system/integrations?integration=export-alexa')
    fireEvent.click(screen.getByTestId('integration-pill-export-hap'))
    expect(body().getAttribute('aria-label')).toBe('HomeKit')
    fireEvent.click(screen.getByRole('button', { name: 'history back' }))
    expect(body().getAttribute('aria-label')).toBe('Alexa')
    fireEvent.click(screen.getByRole('button', { name: 'history forward' }))
    expect(body().getAttribute('aria-label')).toBe('HomeKit')
  })

  it('keeps the params it does not own (the hosting tab strip’s ?tab=)', () => {
    renderHub('/system/network?tab=remote-access', { legacyGroupParam: undefined })
    fireEvent.click(screen.getByTestId('integration-pill-export-hap'))
    expect(location()).toBe('/system/network?tab=remote-access&integration=export-hap')
  })

  it('honours a legacy ?tab=<kind> link and drops it once an integration is chosen', () => {
    renderHub('/system/integrations?tab=broker')
    expect(body().getAttribute('aria-label')).toBe('MQTT')
    fireEvent.click(screen.getByTestId('integration-pill-export-hap'))
    expect(location()).toBe('/system/integrations?integration=export-hap')
  })

  it('falls back AND says so when the link names something not installed', () => {
    renderHub('/system/integrations?integration=export-google')
    expect(body().getAttribute('aria-label')).toBe('Alexa')
    expect(screen.getByRole('status').textContent).toContain('export-google')
  })

  it('does not call anything stale, or empty, before the list has answered', () => {
    renderHub('/system/integrations?integration=export-google', { isLoading: true, groups: [] })
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('Nothing installed')).toBeNull()
  })

  it('shows the empty state with the install action on an answered empty page', () => {
    renderHub('/system/integrations', {
      groups: [{ ...GROUPS[0]!, entries: [] }],
    })
    expect(screen.getByText('Nothing installed')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: /Add export/ }).length).toBeGreaterThan(0)
  })
})

describe('sections are deep-link targets', () => {
  it('scrolls the requested section into view', () => {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.querySelector('h2')?.textContent ?? '')
    }
    try {
      vi.useFakeTimers()
      renderHub('/system/integrations?integration=export-hap&section=settings')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(scrolled).toEqual(['Settings', 'Settings'])
    } finally {
      vi.useRealTimers()
      Element.prototype.scrollIntoView = original
    }
  })

  it('gives every section a link to its own address', () => {
    renderHub('/system/integrations?integration=export-hap')
    const link = screen.getByRole('link', { name: 'Link to Settings' })
    expect(link.getAttribute('href')).toBe(
      '/system/integrations?integration=export-hap&section=settings',
    )
  })
})

describe('settings come from the form builder', () => {
  it('renders the selected addon’s schema settings, scoped to the page capability', () => {
    renderHub('/system/integrations?integration=export-hap')
    expect(screen.getByTestId('schema-settings')).toBeTruthy()
    expect(settingsMounts.at(-1)).toMatchObject({
      nodeId: 'hub',
      addonIds: ['export-hap'],
      level: 'global',
      capability: 'device-export',
    })
  })

  it('docks the activity stream under the settings, on the same scroll', () => {
    renderHub('/system/integrations?integration=export-hap')
    expect(screen.getByText('logs of export-hap')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Events' }))
    expect(screen.getByText('events of export-hap')).toBeTruthy()
  })

  it('keeps the common controls on every integration', () => {
    renderHub('/system/integrations?integration=export-hap')
    const strip = screen.getByTestId('integration-status-strip')
    expect(within(strip).getByRole('button', { name: /Disable/ })).toBeTruthy()
    expect(within(strip).getByRole('button', { name: /Restart/ })).toBeTruthy()
    expect(within(strip).getByText('Enabled')).toBeTruthy()
  })
})

describe('a panel can sit at the end of the body', () => {
  function renderBody(): void {
    render(
      <MemoryRouter>
        <AddonIntegrationBody
          addonId="export-alexa"
          displayName="Alexa"
          capName="device-export"
          isActive
          lead={<div>pairing block</div>}
          panels={[
            { id: 'peers', title: 'Peers', content: <div>peers</div> },
            { id: 'devices', title: 'Devices', placement: 'end', content: <div>table</div> },
          ]}
        />
      </MemoryRouter>,
    )
  }

  const follows = (later: HTMLElement, earlier: HTMLElement): boolean =>
    (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

  it('renders status, lead, top panels, settings, activity — then the end panels', () => {
    renderBody()
    const heading = (name: string): HTMLElement => screen.getByRole('heading', { name })
    const strip = screen.getByTestId('integration-status-strip')
    const lead = screen.getByText('pairing block')
    expect(follows(lead, strip)).toBe(true)
    expect(follows(heading('Peers'), lead)).toBe(true)
    expect(follows(heading('Settings'), heading('Peers'))).toBe(true)
    expect(follows(heading('Activity'), heading('Settings'))).toBe(true)
    expect(follows(heading('Devices'), heading('Activity'))).toBe(true)
  })

  it('still scrolls ?section= to an end panel', () => {
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.querySelector('h2')?.textContent ?? '')
    }
    try {
      renderHub('/system/integrations?integration=export-hap&section=devices')
      expect(scrolled[0]).toBe('Devices')
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })
})

describe('settingsContent replaces the schema form in Settings', () => {
  it('renders custom content and does not mount NodeAddonsSettingsPanel', () => {
    settingsMounts.length = 0
    render(
      <MemoryRouter>
        <AddonIntegrationBody
          addonId="auth-oidc"
          displayName="OpenID Connect"
          capName="auth-provider"
          isActive
          settingsContent={<div data-testid="oidc-custom-settings">oidc table</div>}
        />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('oidc-custom-settings')).toBeTruthy()
    expect(screen.queryByTestId('schema-settings')).toBeNull()
    expect(settingsMounts).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()
  })
})
