// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DeviceList, deviceIntegrationResolver, type DeviceIntegrationLink } from '../index'
import { ConfirmDialogProvider } from '../../confirm-dialog'
import { allDeviceTypeFilterOptions } from '../../device-meta'
import type { DeviceItemDevice } from '../../device-item/helpers'
import type { UseDeviceProxyTrpc } from '../../../hooks/use-device-proxy'

beforeAll(() => {
  // jsdom lacks ResizeObserver — the responsive type filter degrades to its
  // dropdown default when absent, but stub it so the component mounts cleanly.
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { writable: true, value: RO })
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

beforeEach(() => {
  window.history.replaceState(null, '', '/devices')
  localStorage.clear()
})

const mockTrpc = {
  deviceManager: { getBindings: { query: async () => ({ deviceId: 0, entries: [] }) } },
} as unknown as UseDeviceProxyTrpc

const dev = (id: number, overrides: Partial<DeviceItemDevice> = {}): DeviceItemDevice => ({
  id,
  stableId: `s-${id}`,
  addonId: overrides.addonId ?? 'rtsp',
  type: overrides.type ?? 'camera',
  name: overrides.name ?? `Cam ${id}`,
  online: true,
  disabled: false,
  parentDeviceId: null,
  role: null,
  ...overrides,
})

function withQuery(node: React.ReactNode): React.ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return (
    <QueryClientProvider client={qc}>
      <ConfirmDialogProvider>{node}</ConfirmDialogProvider>
    </QueryClientProvider>
  )
}

describe('<DeviceList>', () => {
  it('renders empty state when no devices', () => {
    render(withQuery(<DeviceList devices={[]} trpc={mockTrpc} />))
    expect(screen.getByText(/no devices yet/i)).toBeDefined()
  })

  it('renders 50 devices in table view (default)', () => {
    const devices = Array.from({ length: 50 }, (_, i) => dev(i + 1))
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expect(container.querySelectorAll('tbody tr').length).toBe(50)
  })

  it('paginates 100 devices into 2 pages of 50', () => {
    const devices = Array.from({ length: 100 }, (_, i) => dev(i + 1))
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expect(container.querySelectorAll('tbody tr').length).toBe(50)
    expect(screen.getByText(/Showing 1–50 of 100/i)).toBeDefined()
  })

  // The integration filter matches a row by its RESOLVED integration
  // (`integrationOf`), never by its `addonId`. Chip ids are integration ids.
  const INTEGRATIONS = [
    { id: 'int_rtsp', addonId: 'rtsp', name: 'RTSP' },
    { id: 'int_reolink', addonId: 'reolink', name: 'Reolink' },
    // D659: the "Blocks" integration creates composed devices; the addon that
    // SERVES them is `composer`, which is not this integration's addonId.
    { id: 'int_0024', addonId: 'core-blocks', name: 'Blocks' },
  ]
  const integrationOf = deviceIntegrationResolver(INTEGRATIONS)
  const chips = INTEGRATIONS.map((i) => ({ id: i.id, name: i.name }))

  it('filters by integration (legacy rows resolve through their addonId)', () => {
    const devices = [
      dev(1, { addonId: 'rtsp', name: 'A' }),
      dev(2, { addonId: 'reolink', name: 'B' }),
      dev(3, { addonId: 'reolink', name: 'C' }),
    ]
    window.history.replaceState(null, '', '/devices?addon=int_reolink')
    const { container } = render(
      withQuery(
        <DeviceList
          devices={devices}
          trpc={mockTrpc}
          integrationOf={integrationOf}
          filters={{ integrations: chips }}
        />,
      ),
    )
    expect(container.querySelectorAll('tbody tr').length).toBe(2)
    expect(screen.getByText('B')).toBeDefined()
    expect(screen.getByText('C')).toBeDefined()
    expect(screen.queryByText('A')).toBeNull()
  })

  it('a composer-served device created by "Blocks" is listed under the Blocks filter', () => {
    const devices = [
      dev(4603, { addonId: 'composer', integrationId: 'int_0024', name: 'Porch (composto)' }),
      dev(2, { addonId: 'reolink', name: 'B' }),
    ]
    window.history.replaceState(null, '', '/devices?addon=int_0024')
    const { container } = render(
      withQuery(
        <DeviceList
          devices={devices}
          trpc={mockTrpc}
          integrationOf={integrationOf}
          filters={{ integrations: chips }}
        />,
      ),
    )
    expect(container.querySelectorAll('tbody tr').length).toBe(1)
    expect(screen.getByText('Porch (composto)')).toBeDefined()
  })

  it('a list forced to the Blocks integration lists the composer-served device', () => {
    const devices = [
      dev(4603, { addonId: 'composer', integrationId: 'int_0024', name: 'Porch (composto)' }),
      dev(2, { addonId: 'reolink', name: 'B' }),
    ]
    const { container } = render(
      withQuery(
        <DeviceList
          devices={devices}
          trpc={mockTrpc}
          integrationOf={integrationOf}
          forceIntegrationId="int_0024"
        />,
      ),
    )
    expect(container.querySelectorAll('tbody tr').length).toBe(1)
    expect(screen.getByText('Porch (composto)')).toBeDefined()
    expect(screen.queryByText('B')).toBeNull()
  })

  it('an integration filter over NOT-YET-KNOWN integrations says so, never "no devices match"', () => {
    render(
      withQuery(
        <DeviceList
          devices={[dev(4603, { addonId: 'composer', integrationId: 'int_0024' })]}
          trpc={mockTrpc}
          integrationOf={deviceIntegrationResolver(undefined)}
          forceIntegrationId="int_0024"
        />,
      ),
    )
    expect(screen.getByText('Loading integrations…')).toBeDefined()
    expect(screen.queryByText(/no devices match/i)).toBeNull()
  })

  it('the row badge is asked with the RESOLVED integration, not the serving addon', () => {
    const asked: string[] = []
    render(
      withQuery(
        <DeviceList
          devices={[dev(4603, { addonId: 'composer', integrationId: 'int_0024' })]}
          trpc={mockTrpc}
          context="devices"
          integrationOf={integrationOf}
          resolveIntegrationIcon={(_d, integration) => {
            asked.push(
              integration.kind === 'resolved' ? integration.integration.addonId : integration.kind,
            )
            return null
          }}
        />,
      ),
    )
    expect(asked.length).toBeGreaterThan(0)
    expect(new Set(asked)).toEqual(new Set(['core-blocks']))
  })

  it('groups accessories under their parent (only top-level rows shown by default)', () => {
    const devices = [
      dev(1, { name: 'Cam' }),
      dev(2, { name: 'Floodlight', role: 'floodlight', parentDeviceId: 1, type: 'light' }),
      dev(3, { name: 'Siren', role: 'siren', parentDeviceId: 1, type: 'siren' }),
    ]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    const rows = container.querySelectorAll('tbody tr')
    expect(rows.length).toBe(1)
    expect(screen.getByText('Cam')).toBeDefined()
  })

  it('selectable mode toggles selection and reports it', () => {
    const onSelectionChange = vi.fn()
    const devices = [dev(1, { name: 'Cam One' }), dev(2, { name: 'Cam Two' })]
    render(
      withQuery(
        <DeviceList
          devices={devices}
          trpc={mockTrpc}
          selectable
          onSelectionChange={onSelectionChange}
        />,
      ),
    )
    const checkboxes = screen.getAllByRole('checkbox')
    // Two top-level rows → two checkboxes
    expect(checkboxes.length).toBe(2)
    fireEvent.click(checkboxes[0]!)
    expect(onSelectionChange).toHaveBeenCalledWith(new Set([1]))
  })

  it('selectable: accessory sub-rows do NOT get a checkbox', () => {
    const onSelectionChange = vi.fn()
    const devices = [
      dev(1, { name: 'Cam' }),
      dev(2, { name: 'Floodlight', role: 'floodlight', parentDeviceId: 1, type: 'light' }),
    ]
    // Expand the parent first to surface accessory rows, then verify
    // that only one checkbox exists (for the top-level row).
    const { container } = render(
      withQuery(
        <DeviceList
          devices={devices}
          trpc={mockTrpc}
          selectable
          onSelectionChange={onSelectionChange}
        />,
      ),
    )
    // Expand the parent row so the accessory <tr> renders
    const chevron = container.querySelector('[data-testid="toggle-expand"]')
    if (chevron) fireEvent.click(chevron)
    const checkboxes = screen.getAllByRole('checkbox')
    // Exactly one checkbox — the top-level parent only
    expect(checkboxes.length).toBe(1)
  })
})

describe('<DeviceList> context-configured columns (device mode)', () => {
  const integrationIcon = <span data-testid="integ-icon">HA</span>

  it('default (no context) = all columns (current behavior)', () => {
    // Phase 2 merged Preview + Actions into ONE trailing `previewActions`
    // column (header label "Preview"), so the device table now carries 4
    // headers rather than 5.
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(headers).toEqual(['Name', 'Type', 'Hardware', 'Features', 'Preview'])
  })

  it('context="devices" renders Type header + the integration icon', () => {
    const { container } = render(
      withQuery(
        <DeviceList
          devices={[dev(1)]}
          trpc={mockTrpc}
          context="devices"
          resolveIntegrationIcon={() => integrationIcon}
        />,
      ),
    )
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(headers).toContain('Type')
    expect(screen.queryByTestId('integ-icon')).not.toBeNull()
  })

  it('context="integration-detail" renders NO Type header and NO integration icon', () => {
    const { container } = render(
      withQuery(
        <DeviceList
          devices={[dev(1)]}
          trpc={mockTrpc}
          context="integration-detail"
          resolveIntegrationIcon={() => integrationIcon}
        />,
      ),
    )
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(headers).not.toContain('Type')
    // integration-detail keeps Hardware (wide-screen-only) but drops Type/icon.
    expect(headers).toEqual(['Name', 'Integration', 'Hardware', 'Features', 'Preview'])
    expect(screen.queryByTestId('integ-icon')).toBeNull()
  })

  it('context="integration-detail" row has no Type cell', () => {
    const { container } = render(
      withQuery(
        <DeviceList
          devices={[dev(1, { type: 'camera' })]}
          trpc={mockTrpc}
          context="integration-detail"
        />,
      ),
    )
    // Name + Integration + Hardware + Features + merged previewActions = 5 cells per row (no Type td).
    const cells = container.querySelectorAll('tbody tr:first-child td')
    expect(cells.length).toBe(5)
  })

  it('context="integration-detail" shows the integration name from resolveIntegrationName', () => {
    const { container } = render(
      withQuery(
        <DeviceList
          devices={[dev(1)]}
          trpc={mockTrpc}
          context="integration-detail"
          resolveIntegrationName={() => 'Casa'}
        />,
      ),
    )
    const cells = [...container.querySelectorAll('tbody tr:first-child td')].map((td) =>
      td.textContent?.trim(),
    )
    expect(cells).toContain('Casa')
  })

  it('forceIntegrationIds filters to several integrations', () => {
    const resolver = (d: DeviceIntegrationLink) => ({
      kind: 'resolved' as const,
      integration: { id: d.integrationId ?? '', addonId: d.addonId ?? '' },
    })
    render(
      withQuery(
        <DeviceList
          devices={[
            dev(1, { name: 'Alpha', integrationId: 'i1' }),
            dev(2, { name: 'Beta', integrationId: 'i2' }),
            dev(3, { name: 'Gamma', integrationId: 'i3' }),
          ]}
          trpc={mockTrpc}
          context="integration-detail"
          integrationOf={resolver}
          forceIntegrationIds={['i1', 'i3']}
        />,
      ),
    )
    expect(screen.queryByText('Alpha')).not.toBeNull()
    expect(screen.queryByText('Beta')).toBeNull()
    expect(screen.queryByText('Gamma')).not.toBeNull()
  })
})

describe('<DeviceList> batch mode (off by default + activation)', () => {
  const batchActions = () => ({ remove: vi.fn(), disable: vi.fn(), enable: vi.fn() })

  it('batch mode is OFF by default — no checkboxes and no bulk toolbar on initial render', () => {
    const devices = [dev(1, { name: 'Cam One' }), dev(2, { name: 'Cam Two' })]
    render(
      withQuery(<DeviceList devices={devices} trpc={mockTrpc} batchActions={batchActions()} />),
    )
    // No selection UI initially.
    expect(screen.queryAllByRole('checkbox').length).toBe(0)
    // No bulk-action buttons initially.
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('exposes an activation button that turns batch mode ON and reveals selection UI + bulk actions', () => {
    const devices = [dev(1, { name: 'Cam One' }), dev(2, { name: 'Cam Two' })]
    render(
      withQuery(<DeviceList devices={devices} trpc={mockTrpc} batchActions={batchActions()} />),
    )
    const activate = screen.getByRole('button', { name: /select/i })
    expect(activate).toBeDefined()

    fireEvent.click(activate)

    // Selection checkboxes appear (one per top-level row).
    expect(screen.getAllByRole('checkbox').length).toBe(2)

    // The available bulk actions are surfaced once a device is selected.
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(screen.getByRole('button', { name: /disable/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /enable/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /delete/i })).toBeDefined()
  })

  it('wires the bulk actions to the provided callbacks', () => {
    const actions = batchActions()
    const devices = [dev(1, { name: 'Cam One' }), dev(2, { name: 'Cam Two' })]
    render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} batchActions={actions} />))
    fireEvent.click(screen.getByRole('button', { name: /select/i }))
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    fireEvent.click(screen.getByRole('button', { name: /disable/i }))
    expect(actions.disable).toHaveBeenCalledWith({ deviceId: 1 })
  })

  it('can exit batch mode, returning to OFF (no checkboxes)', () => {
    const devices = [dev(1, { name: 'Cam One' }), dev(2, { name: 'Cam Two' })]
    render(
      withQuery(<DeviceList devices={devices} trpc={mockTrpc} batchActions={batchActions()} />),
    )
    fireEvent.click(screen.getByRole('button', { name: /select/i }))
    expect(screen.getAllByRole('checkbox').length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: /done|exit|cancel/i }))
    expect(screen.queryAllByRole('checkbox').length).toBe(0)
  })

  it('renders a compact bulk-actions menu on small (L1) screens', () => {
    const devices = [dev(1, { name: 'Cam One' })]
    const { container } = render(
      withQuery(<DeviceList devices={devices} trpc={mockTrpc} batchActions={batchActions()} />),
    )
    fireEvent.click(screen.getByRole('button', { name: /select/i }))
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    // The full action row is desktop-only (hidden below sm); a compact
    // menu trigger covers the L1 tier. Its container carries the
    // small-screen-only class so it folds away at sm+.
    const compact = container.querySelector('[data-testid="batch-actions-compact"]')
    expect(compact).not.toBeNull()
    expect(compact?.className ?? '').toMatch(/sm:hidden/)
  })

  it('batch mode ON: clicking a row toggles its selection and does NOT navigate', () => {
    const onNavigate = vi.fn()
    const devices = [dev(1, { name: 'Cam One' }), dev(2, { name: 'Cam Two' })]
    const { container } = render(
      withQuery(
        <DeviceList
          devices={devices}
          trpc={mockTrpc}
          batchActions={batchActions()}
          onNavigate={onNavigate}
        />,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: /select/i }))
    // Click the row body (the cell text), not the checkbox.
    const row = screen.getByText('Cam One').closest('tr')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    // Selection toggled → the row's bulk actions become available.
    expect(screen.getByRole('button', { name: /disable/i })).toBeDefined()
    // The row checkbox now reflects the selection.
    const checkbox = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]
    expect(checkbox?.checked).toBe(true)
    // Navigation suppressed in batch mode.
    expect(onNavigate).not.toHaveBeenCalled()
    // The selected row reads as visibly selected (not just aria-pressed):
    // the <tr> and its sticky NAME cell both carry the selected background.
    expect(row!.className).toContain('bg-primary/10')
    const nameCell = row!.querySelector('td')
    expect(nameCell?.className).toContain('bg-primary/10')
  })

  it('batch mode OFF: clicking a row navigates and does NOT change selection', () => {
    const onNavigate = vi.fn()
    const devices = [dev(1, { name: 'Cam One' }), dev(2, { name: 'Cam Two' })]
    render(
      withQuery(
        <DeviceList
          devices={devices}
          trpc={mockTrpc}
          batchActions={batchActions()}
          onNavigate={onNavigate}
        />,
      ),
    )
    const row = screen.getByText('Cam One').closest('tr')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    expect(onNavigate).toHaveBeenCalledWith(1)
    // No selection UI surfaced — batch mode never activated.
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull()
  })

  it('opens the compact popover to reveal the bulk actions on small screens', () => {
    const devices = [dev(1, { name: 'Cam One' })]
    const { container } = render(
      withQuery(<DeviceList devices={devices} trpc={mockTrpc} batchActions={batchActions()} />),
    )
    fireEvent.click(screen.getByRole('button', { name: /select/i }))
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)

    const compact = container.querySelector('[data-testid="batch-actions-compact"]')
    expect(compact).not.toBeNull()
    // Popover closed initially — no menu, and the compact trigger reports it.
    const trigger = compact!.querySelector('button[aria-haspopup="menu"]')
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute('aria-expanded')).toBe('false')
    expect(compact!.querySelector('[role="menu"]')).toBeNull()

    // Click the compact trigger → popover opens hosting the bulk actions.
    fireEvent.click(trigger!)
    expect(trigger!.getAttribute('aria-expanded')).toBe('true')
    const menu = compact!.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const menuText = menu!.textContent ?? ''
    expect(menuText).toMatch(/Disable/)
    expect(menuText).toMatch(/Enable/)
    expect(menuText).toMatch(/Delete/)
  })
})

// ── Characterization suite ──────────────────────────────────────────
// Pins the CURRENT TableLayout/CardsLayout/expansion/pagination behavior so
// the upcoming Phase-0 decomposition (verbatim file split) can be verified
// to introduce no behavior change. These intentionally assert concrete
// markup (column headers, breakpoint visibility classes, view toggle,
// chevron expansion, pagination) rather than just counts.
describe('<DeviceList> characterization — table columns + breakpoints', () => {
  it('table view renders the 5 column headers in order (Hardware added; Preview + Actions merged)', () => {
    const devices = [dev(1)]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(headers).toEqual(['Name', 'Type', 'Hardware', 'Features', 'Preview'])
  })

  it('Type header is hidden below lg (drops FIRST — least important)', () => {
    // Phase 3.2 reconciled the priority inversion: `type` is the least
    // important optional column, so it folds away at a WIDER width (below lg)
    // than `features` (below md), i.e. it drops first as the viewport narrows.
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const type = [...container.querySelectorAll('thead th')].find(
      (th) => th.textContent?.trim() === 'Type',
    )
    expect(type?.className).toContain('hidden')
    expect(type?.className).toContain('lg:table-cell')
  })

  it('Features header is hidden below md (kept longer than type)', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const features = [...container.querySelectorAll('thead th')].find(
      (th) => th.textContent?.trim() === 'Features',
    )
    expect(features?.className).toContain('hidden')
    expect(features?.className).toContain('md:table-cell')
  })

  it('merged Preview header is always visible (no breakpoint-hide) and right-aligned', () => {
    // Phase 2: the merged previewActions column carries the always-on,
    // right-aligned trailing affordances, so its header never folds away.
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const preview = [...container.querySelectorAll('thead th')].find(
      (th) => th.textContent?.trim() === 'Preview',
    )
    expect(preview?.className).not.toContain('hidden')
    expect(preview?.className).toContain('text-right')
  })

  it('Name and the merged Preview headers have no breakpoint-hide class (always visible)', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const ths = [...container.querySelectorAll('thead th')]
    const name = ths.find((th) => th.textContent?.trim() === 'Name')
    const preview = ths.find((th) => th.textContent?.trim() === 'Preview')
    expect(name?.className).not.toContain('hidden')
    expect(preview?.className).not.toContain('hidden')
    // The merged previewActions column is right-aligned (trailing affordances).
    expect(preview?.className).toContain('text-right')
  })

  it('wraps the table in a bordered, x-scroll surface', () => {
    const { container } = render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    const table = container.querySelector('table')
    const wrapper = table?.parentElement
    expect(wrapper?.className).toContain('overflow-x-auto')
    expect(wrapper?.className).toContain('border')
  })
})

describe('<DeviceList> characterization — one rendering, no toggle', () => {
  /**
   * There used to be a cards view and a control to pick it. Both are gone: the
   * device list is a table on every surface. These tests asserted the toggle
   * worked; what has to hold now is that it is not there to be found — an
   * operator who learned the old control must not meet a dead button.
   *
   * The DataTable never swaps to cards on a phone either: it scrolls sideways
   * inside its own container.
   */
  it('renders the table, and offers no way to leave it', () => {
    const devices = [dev(1), dev(2)]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expect(container.querySelector('table')).not.toBeNull()
    expect(screen.queryByLabelText('Cards view')).toBeNull()
    expect(screen.queryByLabelText('Table view')).toBeNull()
  })
})

describe('<DeviceList> characterization — accessory expansion', () => {
  it('expands accessory sub-rows when the parent chevron is clicked', () => {
    const devices = [
      dev(1, { name: 'Cam' }),
      dev(2, { name: 'Floodlight', role: 'floodlight', parentDeviceId: 1, type: 'light' }),
      dev(3, { name: 'Siren', role: 'siren', parentDeviceId: 1, type: 'siren' }),
    ]
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    // Collapsed: only the parent row.
    expect(container.querySelectorAll('tbody tr').length).toBe(1)
    expect(screen.queryByText('Floodlight')).toBeNull()

    // Click the chevron to expand.
    const chevron = screen.getByLabelText('Expand children')
    fireEvent.click(chevron)

    // Accessory sub-rows now render.
    expect(container.querySelectorAll('tbody tr').length).toBe(3)
    expect(screen.getByText('Floodlight')).toBeDefined()
    expect(screen.getByText('Siren')).toBeDefined()

    // Click again to collapse.
    fireEvent.click(screen.getByLabelText('Collapse children'))
    expect(container.querySelectorAll('tbody tr').length).toBe(1)
  })
})

describe('<DeviceList> characterization — pagination navigation', () => {
  it('navigates to page 2 and shows the next slice of rows', () => {
    const devices = Array.from({ length: 75 }, (_, i) => dev(i + 1))
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    // Page 1: 50 rows.
    expect(container.querySelectorAll('tbody tr').length).toBe(50)
    expect(screen.getByText(/Showing 1–50 of 75/i)).toBeDefined()

    // Advance a page via the Next control.
    fireEvent.click(screen.getByLabelText(/next page/i))

    // Page 2: remaining 25 rows.
    expect(container.querySelectorAll('tbody tr').length).toBe(25)
    expect(screen.getByText(/Showing 51–75 of 75/i)).toBeDefined()
  })
})

describe('<DeviceList> page-size selector + total (Item D)', () => {
  it('renders the total count and the expected per-page options', () => {
    const devices = Array.from({ length: 30 }, (_, i) => dev(i + 1))
    render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expect(screen.getByText('30 devices')).toBeDefined()
    const select = screen.getByLabelText(/devices per page/i) as HTMLSelectElement
    const options = [...select.querySelectorAll('option')].map((o) => o.value)
    expect(options).toEqual(['25', '50', '100', '200'])
    // Default table page size is 50.
    expect(select.value).toBe('50')
  })

  it('shows the selector + total even on a single page (no pager)', () => {
    const devices = Array.from({ length: 10 }, (_, i) => dev(i + 1))
    render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    expect(screen.getByText('10 devices')).toBeDefined()
    expect(screen.getByLabelText(/devices per page/i)).toBeDefined()
    // Single page → the pager self-hides.
    expect(screen.queryByLabelText(/next page/i)).toBeNull()
  })

  it('uses the singular noun for a single device', () => {
    render(withQuery(<DeviceList devices={[dev(1)]} trpc={mockTrpc} />))
    expect(screen.getByText('1 device')).toBeDefined()
  })

  it('changing the page size re-slices and clamps the page', () => {
    const devices = Array.from({ length: 120 }, (_, i) => dev(i + 1))
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    // Default 50 → page 1 shows 50 rows across 3 pages.
    expect(container.querySelectorAll('tbody tr').length).toBe(50)

    // Jump to the last page (page 3).
    fireEvent.click(screen.getByText('3'))
    expect(screen.getByText(/Showing 101–120 of 120/i)).toBeDefined()

    // Shrink the page size to 25 → page 3 is out of range, so the clamp
    // effect drops the user to a valid page and re-slices to 25 rows.
    fireEvent.change(screen.getByLabelText(/devices per page/i), { target: { value: '25' } })
    expect(container.querySelectorAll('tbody tr').length).toBe(25)
    expect(screen.getByText(/Showing \d+–\d+ of 120/i)).toBeDefined()
    // The dropped page is still in range (≤ totalPages), not forced back to 1.
    expect(screen.queryByText(/Showing 1–25 of 120/i)).toBeNull()
  })

  it('keeps the current page when growing the size still fits it (no reset to 1)', () => {
    const devices = Array.from({ length: 90 }, (_, i) => dev(i + 1))
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))

    // Switch to size 25 → 4 pages (90 = 25·3 + 15). Go to page 2.
    fireEvent.change(screen.getByLabelText(/devices per page/i), { target: { value: '25' } })
    fireEvent.click(screen.getByText('2'))
    expect(screen.getByText(/Showing 26–50 of 90/i)).toBeDefined()

    // Grow to 50 → page 2 is still valid (2 pages: 50 + 40). The user must
    // STAY on page 2 (rows 51–90), NOT get bounced back to page 1.
    fireEvent.change(screen.getByLabelText(/devices per page/i), { target: { value: '50' } })
    expect(container.querySelectorAll('tbody tr').length).toBe(40)
    expect(screen.getByText(/Showing 51–90 of 90/i)).toBeDefined()
  })

  it('grows the page size to fit everything on one page (pager hides)', () => {
    const devices = Array.from({ length: 80 }, (_, i) => dev(i + 1))
    const { container } = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    // Default 50 → paginated.
    expect(container.querySelectorAll('tbody tr').length).toBe(50)
    expect(screen.getByLabelText(/next page/i)).toBeDefined()

    fireEvent.change(screen.getByLabelText(/devices per page/i), { target: { value: '100' } })
    // All 80 now fit; the pager self-hides but the selector + total remain.
    expect(container.querySelectorAll('tbody tr').length).toBe(80)
    expect(screen.queryByLabelText(/next page/i)).toBeNull()
    expect(screen.getByText('80 devices')).toBeDefined()
  })

  it('persists the preference globally across mounts (shared key)', () => {
    const devices = Array.from({ length: 120 }, (_, i) => dev(i + 1))
    const first = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    fireEvent.change(first.getByLabelText(/devices per page/i), { target: { value: '100' } })
    first.unmount()

    // A fresh device-list surface picks up the persisted global preference.
    const second = render(withQuery(<DeviceList devices={devices} trpc={mockTrpc} />))
    const select = second.getByLabelText(/devices per page/i) as HTMLSelectElement
    expect(select.value).toBe('100')
    expect(second.container.querySelectorAll('tbody tr').length).toBe(100)
  })
})

interface GItem {
  readonly id: string
  readonly label: string
}

describe('<DeviceList mode="generic">', () => {
  const items: readonly GItem[] = Array.from({ length: 150 }, (_, i) => ({
    id: `i${i}`,
    label: `Item ${i}`,
  }))
  const renderGeneric = (extra: Record<string, unknown> = {}) =>
    render(
      <DeviceList
        mode="generic"
        items={items}
        pageSize={100}
        getKey={(item: GItem) => item.id}
        getSearchText={(item: GItem) => item.label}
        renderItem={(item: GItem) => <div data-testid="grow">{item.label}</div>}
        {...extra}
      />,
    )

  it('paginates client-side at the given page size', () => {
    const { container } = renderGeneric()
    expect(container.querySelectorAll('[data-testid="grow"]').length).toBe(100)
  })

  it('renders the empty label when there are no items', () => {
    render(
      <DeviceList
        mode="generic"
        items={[] as readonly GItem[]}
        getKey={(item: GItem) => item.id}
        getSearchText={(item: GItem) => item.label}
        renderItem={(item: GItem) => <div>{item.label}</div>}
        emptyLabel="Nothing here"
      />,
    )
    expect(screen.getByText('Nothing here')).toBeDefined()
  })

  it('renders the provided toolbar', () => {
    renderGeneric({ toolbar: <button>Refresh</button> })
    expect(screen.getByText('Refresh')).toBeDefined()
  })

  it('renders a bordered table with headers when columns are provided', () => {
    const { container } = render(
      <DeviceList
        mode="generic"
        items={items}
        pageSize={100}
        getKey={(item: GItem) => item.id}
        getSearchText={(item: GItem) => item.label}
        columns={[
          { key: 'label', header: 'Label', cell: (item: GItem) => <span>{item.label}</span> },
        ]}
      />,
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(screen.getByText('Label')).toBeDefined()
    expect(container.querySelectorAll('tbody tr').length).toBe(100)
  })

  it('renders a multi-select type filter that opens to reveal distinct values', () => {
    const typed: readonly GItem[] = [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ]
    render(
      <DeviceList
        mode="generic"
        items={typed}
        getKey={(item: GItem) => item.id}
        getSearchText={(item: GItem) => item.label}
        getFilterType={(item: GItem) => (item.id === 'a' ? 'light' : 'switch')}
        renderItem={(item: GItem) => <div>{item.label}</div>}
      />,
    )
    // Compact trigger renders; options are revealed only on open.
    const trigger = screen.getByText('Type')
    expect(trigger).toBeDefined()
    expect(screen.queryByText('light')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByText('light')).toBeDefined()
    expect(screen.getByText('switch')).toBeDefined()
  })

  it('shows a COMPLETE filterOptions set even when no item carries that type', () => {
    // Only "light" items present, but a complete option set is supplied — a
    // recently-added type (Vacuum) must still appear in the dropdown so it is
    // never missing, mirroring the adoption modal's exhaustive type filter.
    const lightsOnly: readonly GItem[] = [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ]
    render(
      <DeviceList
        mode="generic"
        items={lightsOnly}
        getKey={(item: GItem) => item.id}
        getSearchText={(item: GItem) => item.label}
        getFilterType={() => 'light'}
        filterOptions={allDeviceTypeFilterOptions()}
        renderItem={(item: GItem) => <div>{item.label}</div>}
      />,
    )
    fireEvent.click(screen.getByText('Type'))
    expect(screen.getByText('Vacuum')).toBeDefined()
    expect(screen.getByText('Lawn mower')).toBeDefined()
    expect(screen.getByText('Light')).toBeDefined()
  })
})
