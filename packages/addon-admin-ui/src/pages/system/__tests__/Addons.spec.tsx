/**
 * Integration tests for the Addons page "Update all" + table layout.
 *
 * F3 Task 6: the in-memory bulk-update coordinator + live progress banner were
 * removed (degrade until F4). "Update all" now routes through the lifecycle
 * job engine via `addons.startJob`; the banner/cancel/live-event tests were
 * dropped along with the banner. The structural tests (system card layout,
 * no SystemPackagesSection, post-restart toast) remain.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Shared mock state — reset between tests via beforeEach
// ---------------------------------------------------------------------------

// `?node=` state for the router mock, plus what the page asked the update
// query for. Both drive the node-scoping tests at the bottom of this file.
let mockSearch = ''
let mockClusterNodes: Array<{
  id: string
  name: string
  shortName: string
  isHub: boolean
  isOnline: boolean
  localIps: string[]
  addons: []
}> = []
const listUpdatesNodeIds: Array<string | undefined> = []
const listNodeIds: Array<string | undefined> = []
const mountRefreshNodeIds: Array<string | undefined> = []

let mockUpdates: Array<{
  name: string
  currentVersion: string
  latestVersion: string
  isSystem: boolean
  category: string
  requiresRestart: boolean
}> = []
let mockLastRestart: { kind: string; requestedAt: number; packagesUpdated?: number } | null = null
let mockAddons: Array<{
  manifest: {
    id: string
    name: string
    packageName: string
    version: string
    packageVersion: string
    capabilities: []
  }
  declaration?: { execution?: { placement?: 'hub-only' | 'agent-only' | 'any-node' } }
  source: 'installed'
  installSource?: 'npm' | 'local' | 'upload'
  hasBackup: false
}> = []
let mockFrameworkPackages: Array<{
  packageName: string
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
}> = []

// What `addons.searchAvailable({ capability })` answers; the plain (dropdown)
// search is always empty here.
interface CapabilitySearchState {
  data:
    | Array<{
        name: string
        version: string
        description: string
        keywords: string[]
        publishedAt: string
        author: string
        installed: boolean
        capabilities: string[] | null
      }>
    | undefined
  isPending: boolean
  isError: boolean
  isFetching: boolean
}
let mockCapabilitySearch: CapabilitySearchState = {
  data: undefined,
  isPending: true,
  isError: false,
  isFetching: true,
}
const searchAvailableInputs: string[] = []
const mockInstall = vi.fn()

const mockStartJob = vi.fn().mockResolvedValue({ jobId: 'job-1' })

// Lifecycle job engine state (F4 per-addon progress)
let mockActiveJobs: unknown[] = []
let mockLiveJobMap: Map<string, { job: unknown }> = new Map()

// Captured options of the single-update mutation — lets tests drive
// onMutate / onSuccess / onError to simulate concurrent updates.
interface UpdateMutationOpts {
  onMutate?: (vars: { name: string }) => void
  onSuccess?: (result: unknown, vars: { name: string }) => void
  onError?: (err: unknown, vars: { name: string }) => void
}
let capturedUpdateOpts: UpdateMutationOpts | null = null

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the page
// ---------------------------------------------------------------------------

vi.mock('@camstack/ui-library', () => ({
  Input: ({ leftSlot: _l, rightSlot: _r, ...rest }: Record<string, unknown>) => <input {...rest} />,
  // Hooks used by InstalledTab
  useAddonsListUpdates: (input: { nodeId?: string } | undefined) => {
    listUpdatesNodeIds.push(input?.nodeId)
    return { data: mockUpdates, staleTime: 5 * 60_000 }
  },
  useAddonsStartJob: () => ({ mutateAsync: mockStartJob, isPending: false }),
  useAddonsGetLastRestart: () => ({ data: mockLastRestart }),
  // Hooks used by AddonsPage (outer) — nodeId keys the query (Task 7).
  useAddonsList: (input: { nodeId?: string } | undefined) => {
    listNodeIds.push(input?.nodeId)
    return { data: mockAddons, isLoading: false, isError: false }
  },
  useAddonsListFrameworkPackages: () => ({
    data: mockFrameworkPackages,
    isLoading: false,
    isError: false,
  }),
  useNodesClusterAddonStatus: () => ({ data: undefined }),
  useIntegrationsGetAvailableTypes: () => ({ data: [{ addonId: 'addon-a' }] }),
  // Uninstall controls + the "not on the hub" panel. `data: undefined` = the
  // installations query has not answered, so the panel renders nothing.
  useAddonsListInstallations: () => ({ data: undefined, refetch: vi.fn() }),
  useAlert: () => vi.fn().mockResolvedValue(undefined),
  useClusterNodes: () => ({ nodes: mockClusterNodes, isLoading: false }),
  useAddonsForceRefresh: () => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    mutate: (input: { nodeId?: string } | undefined) => {
      mountRefreshNodeIds.push(input?.nodeId)
    },
    isPending: false,
  }),
  useAddonsReloadPackages: () => ({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
  }),
  useAddonsUpdatePackage: (opts: UpdateMutationOpts | undefined) => {
    capturedUpdateOpts = opts ?? null
    return {
      // Real mutation fires onMutate synchronously — mirror that so the
      // per-package "updating" state is exercised by plain clicks.
      mutate: (vars: { name: string }) => opts?.onMutate?.(vars),
      mutateAsync: vi.fn().mockResolvedValue({ success: true }),
      isPending: false,
    }
  },
  // F4 job-engine surface (AddonsJobProgress hook)
  useAddonsListJobs: () => ({ data: mockActiveJobs }),
  useEventStreamMap: () => ({
    map: mockLiveJobMap,
    values: Array.from(mockLiveJobMap.values()),
  }),
  // VersionPicker (opened from the version selector)
  useAddonsGetVersions: () => ({ data: [], isLoading: false, isError: false }),
  useAddonsGetPackageDocs: () => ({
    data: {
      name: '@camstack/addon-tailscale',
      version: '1.2.3',
      readme: { status: 'ok', markdown: '# Tailscale\n\nConnects the hub.' },
      changelog: { status: 'missing' },
    },
    isPending: false,
    isError: false,
  }),
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Select: () => <select aria-label="Version" />,
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useAddonsUpdateFrameworkPackage: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ restartingAt: 0 }),
    isPending: false,
  }),
  useAddonsGetAutoUpdateSettings: () => ({
    data: { channel: 'off', intervalSeconds: 21600, updateCheckIntervalSeconds: 21600 },
  }),
  useAddonsApplyAutoUpdateToAll: () => ({ mutate: vi.fn(), isPending: false }),
  // Availability-poll cadence selector — runs even while the channel is 'off'.
  useAddonsSetAutoUpdateSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useAddonsSearchAvailable: (input: { capability?: string } | undefined) => {
    if (input?.capability === undefined) return { data: undefined, isFetching: false }
    searchAvailableInputs.push(input.capability)
    return mockCapabilitySearch
  },
  useAddonsInstallPackage: () => ({ mutate: mockInstall, isPending: false }),
  // AddonCard imports
  useAddonsGetAddonAutoUpdate: () => ({ data: undefined }),
  useAddonsSetAddonAutoUpdate: () => ({ mutate: vi.fn(), isPending: false }),
  useAddonsUninstallPackage: () => ({ mutate: vi.fn(), isPending: false }),
  useAddonsRestartAddon: () => ({ mutate: vi.fn(), isPending: false }),
  useAddonsRetryLoad: () => ({ mutate: vi.fn(), isPending: false }),
  useConfirm: () => vi.fn().mockResolvedValue(true),
  // AddonCard reads `system.trpcClient` (passed through to DeviceExportPanel,
  // which is mocked to null here) — the live hook must be stubbed so the card
  // renders when a regular addon is present.
  useSystem: () => ({ trpcClient: {} }),
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  LogStream: () => null,
  EventStream: () => null,
  DeviceExportPanel: () => null,
  NodePicker: ({
    selectedNodeId,
    onSelect,
  }: {
    selectedNodeId: string
    onSelect: (id: string) => void
  }) => (
    <div data-testid="node-picker">
      <button type="button" onClick={() => onSelect('hub')}>
        {selectedNodeId}
      </button>
    </div>
  ),
  // AdminPage wraps library PageShell after the composite-patterns migration.
  PageShell: ({
    children,
    title,
    actions,
    nav,
  }: {
    children: ReactNode
    title?: string
    actions?: ReactNode
    nav?: ReactNode
  }) => (
    <div>
      {title !== undefined && title !== '' ? <h1>{title}</h1> : null}
      {actions}
      {nav}
      {children}
    </div>
  ),
}))

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
    }),
  }
})

// ---------------------------------------------------------------------------
// Import page AFTER mocks
// ---------------------------------------------------------------------------

import { AddonsPage } from '../Addons'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Real router so `?updatable=` / `?source=` / `?node=` survive like production. */
function renderPage() {
  const path = `/system/addons${mockSearch}`
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/system/addons" element={<AddonsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Addons page — "Update all" engine job + layout', () => {
  beforeEach(() => {
    mockUpdates = []
    mockLastRestart = null
    mockAddons = []
    mockFrameworkPackages = []
    mockActiveJobs = []
    mockLiveJobMap = new Map()
    capturedUpdateOpts = null
    mockStartJob.mockClear()
    mockStartJob.mockResolvedValue({ jobId: 'job-1' })
    mockSearch = ''
    mockClusterNodes = []
    listUpdatesNodeIds.length = 0
    listNodeIds.length = 0
    mountRefreshNodeIds.length = 0
  })

  // 1. handleUpdateAll routes through addons.startJob with kind:'update' +
  //    {name, version} targets — framework/system packages are EXCLUDED
  //    (phase 4: they are managed from the Server-management surface).
  it('handleUpdateAll calls startJob with real-addon targets only (system excluded)', async () => {
    mockUpdates = [
      {
        name: '@camstack/addon-a',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        isSystem: false,
        category: 'addon',
        requiresRestart: false,
      },
      {
        name: '@camstack/types',
        currentVersion: '0.1.38',
        latestVersion: '0.1.40',
        isSystem: true,
        category: 'core',
        requiresRestart: true,
      },
    ]
    renderPage()

    const updateAllBtn = screen.getByRole('button', { name: /update all/i })
    expect((updateAllBtn as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      fireEvent.click(updateAllBtn)
    })

    // Only the real addon is batched; the system package (@camstack/types)
    // is filtered out of the bulk targets.
    expect(mockStartJob).toHaveBeenCalledWith({
      kind: 'update',
      targets: [{ name: '@camstack/addon-a', version: '1.0.1' }],
      nodeIds: ['hub'],
    })
  })

  // 2. Update All button absent when no updates available.
  it('does not render the Update All button when there are no updates', () => {
    mockUpdates = []
    renderPage()
    expect(screen.queryByRole('button', { name: /update all/i })).toBeNull()
  })

  // 3. Layout: framework/system packages (@camstack/system, types, sdk,
  //    shm-ring, ui-library) are HIDDEN from the Addons page (phase 4) — they
  //    ride inside the node root package and are managed from Server
  //    management. Real addons stay listed.
  it('?kind=integration keeps only integration addons and the chip is pressed', () => {
    const addon = (id: string) => ({
      manifest: {
        id,
        name: id,
        packageName: `@camstack/${id}`,
        version: '1.0.0',
        packageVersion: '1.0.0',
        capabilities: [],
      },
      source: 'installed',
      hasBackup: false,
    })
    mockAddons = [addon('addon-a'), addon('addon-b')]
    mockSearch = '?kind=integration'
    renderPage()
    expect(screen.getByText('addon-a')).toBeTruthy()
    expect(screen.queryByText('addon-b')).toBeNull()
    expect(screen.getByRole('button', { name: 'Integrations' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('hides framework/system packages from the installed list; real addons stay', () => {
    mockAddons = [
      {
        manifest: {
          id: 'addon-a',
          name: '@camstack/addon-a',
          packageName: '@camstack/addon-a',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        hasBackup: false,
      },
      {
        manifest: {
          id: 'system-builtin',
          name: 'System',
          packageName: '@camstack/system',
          version: '1.0.2',
          packageVersion: '1.0.2',
          capabilities: [],
        },
        source: 'installed',
        hasBackup: false,
      },
    ]
    renderPage()

    // Regular addon renders…
    expect(screen.getByText('@camstack/addon-a')).toBeTruthy()
    // …the framework package (@camstack/system) is filtered out entirely — no
    // card, and none of the old "System" badge / restart-on-update tooltip.
    expect(screen.queryByText((content) => content.includes('@camstack/system'))).toBeNull()
    expect(screen.queryByTitle(/updating restarts the hub/i)).toBeNull()
  })

  // 4. SystemPackagesSection is NOT rendered in the output.
  it('does not render SystemPackagesSection (replaced by inline rows)', () => {
    // SystemPackagesSection renders "System packages" in its SectionFrame header
    mockFrameworkPackages = [
      {
        packageName: '@camstack/types',
        currentVersion: '0.1.38',
        latestVersion: null,
        hasUpdate: false,
      },
    ]
    renderPage()

    // The SectionFrame-specific header text from SystemPackagesSection should be absent
    expect(screen.queryByText('System packages')).toBeNull()
  })

  // 5. Post-restart toast fires when getLastRestart.kind === 'framework-bulk-update'.
  it('shows post-restart toast when getLastRestart.kind is framework-bulk-update', () => {
    mockLastRestart = { kind: 'framework-bulk-update', requestedAt: 12345 }
    renderPage()

    // The toast text is rendered inside the local toast element
    expect(screen.getByText(/bulk update completed/i)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// F4 — concurrent per-addon update progress
// ---------------------------------------------------------------------------

function twoAddonsWithUpdates() {
  mockUpdates = [
    {
      name: '@camstack/addon-a',
      currentVersion: '1.0.0',
      latestVersion: '1.0.1',
      isSystem: false,
      category: 'addon',
      requiresRestart: false,
    },
    {
      name: '@camstack/addon-b',
      currentVersion: '2.0.0',
      latestVersion: '2.0.1',
      isSystem: false,
      category: 'addon',
      requiresRestart: false,
    },
  ]
  mockAddons = [
    {
      manifest: {
        id: 'addon-a',
        name: '@camstack/addon-a',
        packageName: '@camstack/addon-a',
        version: '1.0.0',
        packageVersion: '1.0.0',
        capabilities: [],
      },
      source: 'installed',
      hasBackup: false,
    },
    {
      manifest: {
        id: 'addon-b',
        name: '@camstack/addon-b',
        packageName: '@camstack/addon-b',
        version: '2.0.0',
        packageVersion: '2.0.0',
        capabilities: [],
      },
      source: 'installed',
      hasBackup: false,
    },
  ]
}

describe('Addons page — concurrent per-addon update progress (F4)', () => {
  beforeEach(() => {
    mockUpdates = []
    mockLastRestart = null
    mockAddons = []
    mockFrameworkPackages = []
    mockActiveJobs = []
    mockLiveJobMap = new Map()
    capturedUpdateOpts = null
    mockStartJob.mockClear()
  })

  it('two concurrent updates each keep their own state; one finishing does not clear the other', async () => {
    twoAddonsWithUpdates()
    renderPage()

    // Kick off BOTH updates (re-query after each click — the clicked row's
    // Update button is replaced by the Updating… pill).
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^update$/i })[0]!)
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^update$/i })[0]!)
    })

    // BOTH rows show their own in-flight state — the 2nd update must not
    // have overwritten the 1st (the old single-string `updatingPackage` bug).
    expect(screen.getAllByText('Updating…').length).toBe(2)

    // First addon finishes — the second keeps its progress.
    await act(async () => {
      capturedUpdateOpts?.onSuccess?.({ success: true }, { name: '@camstack/addon-a' })
    })
    expect(screen.getAllByText('Updating…').length).toBe(1)
  })

  it('a failed update surfaces a per-package error without clearing the other update', async () => {
    twoAddonsWithUpdates()
    renderPage()

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^update$/i })[0]!)
    })
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /^update$/i })[0]!)
    })

    // Addon B fails with a wrapped cap error.
    await act(async () => {
      capturedUpdateOpts?.onSuccess?.(
        { success: false, error: 'npm registry 404' },
        { name: '@camstack/addon-b' },
      )
    })

    expect(screen.getByText(/failed to update @camstack\/addon-b/i)).toBeTruthy()
    expect(screen.getByText(/npm registry 404/i)).toBeTruthy()
    // Addon A is still updating.
    expect(screen.getAllByText('Updating…').length).toBe(1)
  })

  it('renders independent job-engine progress badges for two concurrent jobs', () => {
    twoAddonsWithUpdates()
    const NOW = Date.now()
    const mkJob = (jobId: string, pkg: string, phase: string) => ({
      jobId,
      kind: 'update',
      createdAtMs: NOW,
      createdBy: 'tester',
      scope: 'single',
      state: 'running',
      schemaVersion: 1,
      tasks: [
        {
          taskId: `${jobId}-t`,
          nodeId: 'hub',
          packageName: pkg,
          fromVersion: '1.0.0',
          toVersion: '9.9.9',
          target: 'addon',
          phase,
          stagedPath: null,
          attempts: 1,
          steps: [],
          error: null,
          startedAtMs: NOW,
          finishedAtMs: null,
        },
      ],
    })
    mockLiveJobMap = new Map([
      ['job-a', { job: mkJob('job-a', '@camstack/addon-a', 'applying') }],
      ['job-b', { job: mkJob('job-b', '@camstack/addon-b', 'fetching') }],
    ])
    renderPage()

    const badges = screen.getAllByTestId('addon-job-progress')
    expect(badges.length).toBe(2)
    const texts = badges.map((b) => b.textContent ?? '')
    expect(texts.some((t) => t.includes('applying'))).toBe(true)
    expect(texts.some((t) => t.includes('fetching'))).toBe(true)
  })
})

/**
 * The READ side of the notification tap URL.
 *
 * `<server>/system/addons?node=agent-a` is minted by
 * `packages/addon-post-analysis/src/notification-center/system-event-tap-url.ts`
 * for an `addon-update-available` event. Until 2026-08-30 this page held its
 * node in `useState`, so that link opened the HUB's addon list and said
 * nothing — the exact "a `?node=` nobody parses" failure. These tests assert
 * the parameter reaches the two places that matter: the picker's selection and
 * the per-node update query.
 */
describe('Addons page — the node in the URL is the node on screen', () => {
  beforeEach(() => {
    mockUpdates = []
    mockLastRestart = null
    mockAddons = []
    mockFrameworkPackages = []
    mockActiveJobs = []
    mockLiveJobMap = new Map()
    capturedUpdateOpts = null
    mockStartJob.mockClear()
    mockSearch = ''
    mockClusterNodes = []
    listUpdatesNodeIds.length = 0
    listNodeIds.length = 0
    mountRefreshNodeIds.length = 0
  })

  function cluster() {
    mockClusterNodes = [
      {
        id: 'hub',
        name: 'hub',
        shortName: 'HUB',
        isHub: true,
        isOnline: true,
        localIps: [],
        addons: [],
      },
      {
        id: 'agent-a',
        name: 'agent-a',
        shortName: 'agent-a',
        isHub: false,
        isOnline: true,
        localIps: [],
        addons: [],
      },
    ]
  }

  it('?node= selects that node in the picker', () => {
    cluster()
    mockSearch = '?node=agent-a'
    renderPage()
    expect(screen.getByTestId('node-picker').textContent).toBe('agent-a')
  })

  it('?node= scopes the per-node update query, not just the pill', () => {
    // The pill agreeing while the query still asks the hub is the failure
    // that would make the link LOOK right and show the wrong roster.
    cluster()
    mockSearch = '?node=agent-a'
    renderPage()
    expect(listUpdatesNodeIds).toContain('agent-a')
    expect(listUpdatesNodeIds).not.toContain('hub')
  })

  it('?node= scopes addons.list (query key includes nodeId)', () => {
    // Same failure mode as listUpdates: picker on the agent while list still
    // paints hub installedVersion. Passing nodeId makes React Query cache
    // per node.
    cluster()
    mockSearch = '?node=agent-a'
    renderPage()
    expect(listNodeIds).toContain('agent-a')
    expect(listNodeIds).not.toContain('hub')
  })

  it('after selecting an agent, the card version comes from the agent list mock', () => {
    cluster()
    mockSearch = '?node=agent-a'
    mockAddons = [
      {
        manifest: {
          id: 'stream-broker',
          name: 'Stream broker',
          packageName: '@camstack/addon-stream-broker',
          version: '2.3.4',
          packageVersion: '2.3.4',
          capabilities: [],
        },
        declaration: { execution: { placement: 'any-node' } },
        source: 'installed',
        hasBackup: false,
      },
    ]
    renderPage()
    expect(listNodeIds).toContain('agent-a')
    // VersionPill shows the installed packageVersion from the list response.
    expect(screen.getByText('2.3.4')).toBeTruthy()
  })

  it('the on-mount update check asks the node the LINK named', () => {
    // Read from the URL rather than the resolved selection: at mount the
    // topology has not arrived, so the resolution is still the hub.
    mockSearch = '?node=agent-a'
    renderPage()
    expect(mountRefreshNodeIds).toEqual(['agent-a'])
  })

  it('no ?node= still opens the hub, and says nothing about a stale link', () => {
    cluster()
    renderPage()
    expect(screen.getByTestId('node-picker').textContent).toBe('hub')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a node that LEFT the cluster falls back to the hub AND says so', () => {
    // The week-old-notification case. Falling back silently is what makes an
    // operator read the hub's list believing it is the agent's.
    cluster()
    mockSearch = '?node=gone-agent'
    renderPage()
    expect(screen.getByTestId('node-picker').textContent).toBe('hub')
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('gone-agent')
    expect(notice.textContent).toContain('not in this cluster')
  })

  it('does not cry "stale" before the topology has arrived', () => {
    // No cluster nodes yet — unknown is the truth, not "gone".
    mockSearch = '?node=agent-a'
    renderPage()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('Addons page — placement banner + list filters (task 8)', () => {
  beforeEach(() => {
    mockUpdates = []
    mockLastRestart = null
    mockAddons = []
    mockFrameworkPackages = []
    mockActiveJobs = []
    mockLiveJobMap = new Map()
    capturedUpdateOpts = null
    mockStartJob.mockClear()
    mockSearch = ''
    mockClusterNodes = [
      {
        id: 'hub',
        name: 'hub',
        shortName: 'HUB',
        isHub: true,
        isOnline: true,
        localIps: [],
        addons: [],
      },
      {
        id: 'agent-1',
        name: 'agent-1',
        shortName: 'agent-1',
        isHub: false,
        isOnline: true,
        localIps: [],
        addons: [],
      },
    ]
    listUpdatesNodeIds.length = 0
    listNodeIds.length = 0
    mountRefreshNodeIds.length = 0
  })

  it('does not show the agent placement explanatory banner', () => {
    mockSearch = '?node=agent-1'
    mockAddons = [
      {
        manifest: {
          id: 'stream-broker',
          name: 'Stream broker',
          packageName: '@camstack/addon-stream-broker',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        declaration: { execution: { placement: 'any-node' } },
        source: 'installed',
        hasBackup: false,
      },
    ]
    renderPage()
    expect(screen.queryByText(/showing only addons compatible with/i)).toBeNull()
  })

  it('Updatable filter hides packages without an available update', async () => {
    mockUpdates = [
      {
        name: '@camstack/addon-a',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        isSystem: false,
        category: 'addon',
        requiresRestart: false,
      },
    ]
    mockAddons = [
      {
        manifest: {
          id: 'addon-a',
          name: '@camstack/addon-a',
          packageName: '@camstack/addon-a',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'npm',
        hasBackup: false,
      },
      {
        manifest: {
          id: 'addon-b',
          name: '@camstack/addon-b',
          packageName: '@camstack/addon-b',
          version: '2.0.0',
          packageVersion: '2.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'npm',
        hasBackup: false,
      },
    ]
    renderPage()
    expect(screen.getByText('@camstack/addon-a')).toBeTruthy()
    expect(screen.getByText('@camstack/addon-b')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^updatable$/i }))
    })

    expect(screen.getByText('@camstack/addon-a')).toBeTruthy()
    expect(screen.queryByText('@camstack/addon-b')).toBeNull()
  })

  it('source dev filter shows only installSource local packages', async () => {
    mockAddons = [
      {
        manifest: {
          id: 'npm-pkg',
          name: 'Npm addon',
          packageName: '@camstack/addon-npm',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'npm',
        hasBackup: false,
      },
      {
        manifest: {
          id: 'dev-pkg',
          name: 'Dev addon',
          packageName: '@camstack/addon-dev',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'local',
        hasBackup: false,
      },
    ]
    renderPage()
    expect(screen.getByText('@camstack/addon-npm')).toBeTruthy()
    expect(screen.getByText('@camstack/addon-dev')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^dev$/i }))
    })

    expect(screen.queryByText('@camstack/addon-npm')).toBeNull()
    expect(screen.getByText('@camstack/addon-dev')).toBeTruthy()
  })

  it('source npm filter shows only non-local packages', async () => {
    mockAddons = [
      {
        manifest: {
          id: 'npm-pkg',
          name: 'Npm addon',
          packageName: '@camstack/addon-npm',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'npm',
        hasBackup: false,
      },
      {
        manifest: {
          id: 'dev-pkg',
          name: 'Dev addon',
          packageName: '@camstack/addon-dev',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'local',
        hasBackup: false,
      },
    ]
    renderPage()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^npm$/i }))
    })

    expect(screen.getByText('@camstack/addon-npm')).toBeTruthy()
    expect(screen.queryByText('@camstack/addon-dev')).toBeNull()
  })

  it('source filter is exclusive — npm and Dev cannot both stay pressed', async () => {
    mockAddons = [
      {
        manifest: {
          id: 'npm-pkg',
          name: 'Npm addon',
          packageName: '@camstack/addon-npm',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'npm',
        hasBackup: false,
      },
      {
        manifest: {
          id: 'dev-pkg',
          name: 'Dev addon',
          packageName: '@camstack/addon-dev',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'local',
        hasBackup: false,
      },
    ]
    renderPage()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^npm$/i }))
    })
    expect(screen.getByRole('button', { name: /^npm$/i })).toHaveAttribute('aria-pressed', 'true')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^dev$/i }))
    })
    expect(screen.getByRole('button', { name: /^npm$/i })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /^dev$/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('@camstack/addon-npm')).toBeNull()
    expect(screen.getByText('@camstack/addon-dev')).toBeTruthy()
  })

  it('filters stay applied after switching node (URL-backed)', () => {
    mockClusterNodes = [
      {
        id: 'hub',
        name: 'Hub',
        shortName: 'hub',
        isHub: true,
        isOnline: true,
        localIps: [],
        addons: [],
      },
      {
        id: 'agent-1',
        name: 'Agent One',
        shortName: 'agent-1',
        isHub: false,
        isOnline: true,
        localIps: [],
        addons: [],
      },
    ]
    mockAddons = [
      {
        manifest: {
          id: 'npm-pkg',
          name: 'Npm addon',
          packageName: '@camstack/addon-npm',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'npm',
        hasBackup: false,
        declaration: { execution: { placement: 'any-node' } },
      },
      {
        manifest: {
          id: 'dev-pkg',
          name: 'Dev addon',
          packageName: '@camstack/addon-dev',
          version: '1.0.0',
          packageVersion: '1.0.0',
          capabilities: [],
        },
        source: 'installed',
        installSource: 'local',
        hasBackup: false,
        declaration: { execution: { placement: 'any-node' } },
      },
    ]
    mockUpdates = [
      {
        name: '@camstack/addon-npm',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        isSystem: false,
        category: 'addon',
        requiresRestart: false,
      },
    ]
    // Same filters, different node — what selectNode leaves in the bar after
    // InstalledTab remounts for the agent list refetch.
    mockSearch = '?node=agent-1&updatable=1&source=npm'
    renderPage()

    expect(screen.getByTestId('node-picker').textContent).toBe('agent-1')
    expect(screen.getByRole('button', { name: /^updatable$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: /^npm$/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('@camstack/addon-npm')).toBeTruthy()
    expect(screen.queryByText('@camstack/addon-dev')).toBeNull()
  })
})

describe('Addons page — ?capability= offers uninstalled addons (D860)', () => {
  const tailscale = {
    name: '@camstack/addon-tailscale',
    version: '1.2.3',
    description: 'Tailnet client',
    keywords: [],
    publishedAt: '',
    author: '',
    installed: false,
    capabilities: ['mesh-network', 'network-access'],
  }

  beforeEach(() => {
    mockUpdates = []
    mockLastRestart = null
    mockAddons = []
    mockFrameworkPackages = []
    mockActiveJobs = []
    mockLiveJobMap = new Map()
    mockSearch = '?capability=mesh-network'
    mockClusterNodes = []
    searchAvailableInputs.length = 0
    mockCapabilitySearch = {
      data: [tailscale],
      isPending: false,
      isError: false,
      isFetching: false,
    }
  })

  it('shows the uninstalled addon under "Available to install" with an Install action', () => {
    renderPage()
    expect(searchAvailableInputs).toContain('mesh-network')
    expect(screen.getByText('Available to install')).toBeTruthy()
    expect(screen.getByText('addon-tailscale'.replace('addon-', ''))).toBeTruthy()
    expect(screen.getByRole('button', { name: /install/i })).toBeTruthy()
  })

  it('opens the install dialog and does not install until that dialog confirms', () => {
    mockInstall.mockClear()
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
    expect(mockInstall).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: /install tailscale/i })).toBeTruthy()
    expect(screen.getByText('Connects the hub.')).toBeTruthy()
    expect(screen.getByText('This package has no CHANGELOG.')).toBeTruthy()
    const installs = screen.getAllByRole('button', { name: /^install$/i })
    const confirm = installs[installs.length - 1]
    if (confirm === undefined) throw new Error('install confirm missing')
    fireEvent.click(confirm)
    expect(mockInstall).toHaveBeenCalledWith({
      packageName: '@camstack/addon-tailscale',
      version: '1.2.3',
    })
  })

  it('a query that has not answered is "searching", never "no addon exists"', () => {
    mockCapabilitySearch = { data: undefined, isPending: true, isError: false, isFetching: true }
    renderPage()
    expect(screen.getByText(/searching the npm catalog/i)).toBeTruthy()
    expect(screen.queryByText(/no published addon declares/i)).toBeNull()
  })

  it('a failed query says it could not search, not "none"', () => {
    mockCapabilitySearch = { data: undefined, isPending: false, isError: true, isFetching: false }
    renderPage()
    expect(screen.getByText(/could not search the npm catalog/i)).toBeTruthy()
    expect(screen.queryByText(/no published addon declares/i)).toBeNull()
  })

  it('an answered, empty query says no published addon declares it', () => {
    mockCapabilitySearch = { data: [], isPending: false, isError: false, isFetching: false }
    renderPage()
    expect(screen.getByText(/no published addon declares the "mesh-network"/i)).toBeTruthy()
  })

  it('an installed addon is not offered again', () => {
    mockCapabilitySearch = {
      data: [{ ...tailscale, installed: true }],
      isPending: false,
      isError: false,
      isFetching: false,
    }
    renderPage()
    expect(screen.getByText(/already installed/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /install/i })).toBeNull()
  })

  it('without ?capability= there is no catalog group', () => {
    mockSearch = ''
    renderPage()
    expect(screen.queryByText('Available to install')).toBeNull()
  })
})
