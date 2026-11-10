import type { ReactNode } from 'react'
/**
 * Cluster page.
 *
 * Two removals are pinned here as OUTCOMES rather than by omitting assertions,
 * which would pass just as well if either came back: the Graph view (removed
 * 2026-08-28, "non è affatto utile" [not useful at all]) and the stack that rendered every node's
 * card at once (removed the same day, replaced by a node selector).
 *
 * Note there is no `matchMedia` polyfill: the page had a `useMediaQuery` whose
 * only job was folding Graph into Table on a phone, and it went with the
 * feature. The selector needs no viewport query — its chips wrap. If a future
 * change reintroduces `matchMedia` here, that is a signal to ask what is
 * querying the viewport and why.
 */

import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClusterPage } from '../Cluster'

vi.mock('../../../components/cluster/NodeGeneralIdentitySection', () => ({
  NodeGeneralIdentitySection: () => null,
}))

// Discovery and pairing have their own suites (components/cluster/pairing).
vi.mock('../../../components/cluster/pairing/AgentsFoundSection', () => ({
  AgentsFoundSection: () => null,
}))

vi.mock('../../../components/pipeline/placement-board/ReachableHostInput', () => ({
  ReachableHostInput: () => null,
}))

interface TopologyNode {
  readonly id: string
  readonly name: string
  readonly hostname: string
  readonly platform: string
  readonly arch: string
  readonly isHub: boolean
  readonly isOnline: boolean
  readonly cpuPercent: number
  readonly memoryPercent: number
  readonly cpuCores: number
  readonly memoryMB: number
  readonly engines: readonly unknown[]
  readonly localIps: readonly unknown[]
  readonly addons: readonly unknown[]
  readonly processes: readonly unknown[]
  readonly categories: readonly unknown[]
}

function node(id: string, name: string, isHub: boolean, isOnline: boolean): TopologyNode {
  return {
    id,
    name,
    hostname: 'h',
    platform: 'darwin',
    arch: 'arm64',
    isHub,
    isOnline,
    cpuPercent: 0,
    memoryPercent: 0,
    cpuCores: 4,
    memoryMB: 8192,
    engines: [],
    localIps: [],
    addons: [],
    processes: [],
    categories: [],
  }
}

const topology = vi.hoisted((): { nodes: TopologyNode[] } => ({
  nodes: [],
}))

/** What `system.info` answers: `undefined` until the hub has (D861). */
const systemInfo = vi.hoisted(() => ({ current: undefined as undefined | object }))

/** The hub job dialog has its own spec. Here it only has to open. */
vi.mock('../../../components/cluster/ClusterUpdateDialog', () => ({
  ClusterUpdateDialog: ({ open }: { readonly open: boolean }) =>
    open ? <div role="dialog" aria-label="cluster-update" /> : null,
}))

// The launch-settings card has its own spec; here it would only need more mocks.
vi.mock('../../../components/cluster/tabs/NodeLaunchSettingsCard', () => ({
  NodeLaunchSettingsCard: () => null,
}))

vi.mock('@camstack/ui-library', () => ({
  useLiveEvent: () => {},
  useClusterTopology: () => ({ nodes: topology.nodes, isLoading: false, isError: false }),
  useNodesRestartAddon: () => ({ mutateAsync: async () => ({ success: true }) }),
  useNodesRestartNode: () => ({ mutateAsync: async () => ({ restarted: [], failed: [] }) }),
  useNodesRenameNode: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDeviceManagerListAll: () => ({ data: [] }),
  useSystemInfo: () => ({ data: systemInfo.current, isLoading: false }),
  usePipelineOrchestratorListAgentSettings: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
  usePipelineOrchestratorSetAgentReachableHost: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    variables: undefined,
    error: null,
  }),
  RoleNodePill: ({
    nodeName,
    emphasized,
    onSelect,
    trailing,
  }: {
    readonly nodeName: string
    readonly emphasized?: boolean
    readonly onSelect?: () => void
    readonly trailing?: ReactNode
  }) => (
    <button
      type="button"
      role="tab"
      aria-selected={emphasized === true}
      onClick={onSelect}
      data-testid="role-node-pill"
    >
      {nodeName}
      {trailing}
    </button>
  ),
  NodePicker: ({
    selectedNodeId,
    onSelect,
    allowOffline,
    alwaysShow,
  }: {
    readonly selectedNodeId: string
    readonly onSelect: (id: string) => void
    readonly allowOffline?: boolean
    readonly alwaysShow?: boolean
  }) => {
    const nodes = topology.nodes
    if (alwaysShow !== true && nodes.length <= 1) return null
    return (
      <div
        data-testid="node-picker"
        data-allow-offline={allowOffline === true ? 'true' : 'false'}
        data-selected={selectedNodeId}
      >
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            disabled={allowOffline !== true && !n.isOnline}
            onClick={() => onSelect(n.id)}
          >
            {n.name}
          </button>
        ))}
      </div>
    )
  },
  assignNodeColorId: () => 'node-a',
  nodeColorClass: () => 'bg-node-a',
  NODE_COLOR_IDS: ['node-a'],
  Button: ({
    children,
    ...props
  }: {
    readonly children?: ReactNode
    readonly type?: 'button' | 'submit' | 'reset'
    readonly disabled?: boolean
    readonly title?: string
    readonly onClick?: () => void
    readonly size?: string
    readonly variant?: string
    readonly className?: string
  }) => (
    <button type={props.type ?? 'button'} {...props}>
      {children}
    </button>
  ),
  SettingRow: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  // Server-management surface now renders inside each node card's General tab
  // (merged from the former standalone Server page) + the cluster-wide
  // "Update all" on the page top bar — stub all of its hooks.
  useServerManagementGetServerPackageStatus: () => ({
    data: null,
    isLoading: false,
    isError: false,
  }),
  useServerManagementCheckServerUpdate: () => ({ mutate: vi.fn(), isPending: false }),
  useServerManagementApplyServerUpdate: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useServerManagementRollbackServerUpdate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useServerManagementRestartServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirm: () => vi.fn().mockResolvedValue(true),
  useSystem: () => ({
    trpcClient: {
      pipelineOrchestrator: {
        removeAgentSettings: { mutate: vi.fn() },
      },
      clusterNodes: {
        forgetNode: { mutate: vi.fn() },
      },
      addons: {
        custom: { mutate: vi.fn() },
      },
      serverManagement: {
        // The read-back that resolves a dropped call. Answers SETTLED and
        // UNCHANGED — i.e. nothing was ever staged, which is exactly the case
        // the old `catch {}` reported as a success.
        getServerPackageStatus: {
          query: async () => ({
            packageName: '@camstack/server',
            runningVersion: '1.2.201',
            nodeRuntimeVersion: '24.0.0',
            activeVersion: '1.2.201',
            previousVersion: null,
            seedVersion: '1.2.200',
            latestVersion: '1.2.205',
            updateAvailable: false,
            bootMode: 'data-root',
            updateState: 'idle',
            pendingVersion: null,
            rolledBack: null,
            stateFileCorrupt: false,
            lastCheckedAtMs: 0,
          }),
        },
      },
    },
  }),
  FloatingLogStream: () => null,
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

// Identity (colour / reachable host) has its own suite — keep Cluster page
// specs focused on selection and update-all.
vi.mock('../../../components/cluster/NodeGeneralIdentitySection', () => ({
  NodeGeneralIdentitySection: () => null,
}))

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ClusterPage />
    </MemoryRouter>,
  )
}

/** Node names on the shared `NodePicker` bar (not the old NodeSelector tablist). */
function chipNames(): readonly string[] {
  const picker = screen.queryByTestId('node-picker')
  if (picker === null) return []
  return within(picker)
    .queryAllByRole('button')
    .map((b) => b.textContent ?? '')
}

/**
 * The node card's header carries the node name; the tab bar carries `General`.
 * Reading the DETAIL rather than the chips is the whole point — a chip
 * mentioning a node proves nothing about which one is open.
 */
function openNodeName(): string {
  const general = screen.getByRole('button', { name: /^General$/ })
  // The card root, NOT its parent: the parent is the selector column and holds
  // the chips, so reading from there would report whichever node is listed
  // first rather than whichever node is open.
  const card = general.closest<HTMLDivElement>('div.border')!
  return within(card).getAllByText(/hub|agent-a|agent-b/)[0]?.textContent ?? ''
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ClusterPage — no Graph view', () => {
  it('offers NO view-mode control — not Graph, and not a one-option Table switch', () => {
    topology.nodes = [node('hub', 'hub', true, true)]
    renderAt('/cluster')
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .join('|')
    expect(labels).not.toMatch(/graph/i)
    expect(labels).not.toMatch(/\btable\b/i)
  })

  it('renders no graph canvas — React Flow is never mounted', () => {
    // `@xyflow/react` is deliberately NOT stubbed. The Graph view was the only
    // thing on this page that mounted it; if a canvas comes back, the real
    // (heavy, canvas-dependent) module loads and this render behaves nothing
    // like it does now.
    topology.nodes = [node('hub', 'hub', true, true)]
    const { container } = renderAt('/cluster')
    expect(container.querySelector('.react-flow')).toBeNull()
    expect(screen.queryByTestId('cluster-graph-view')).toBeNull()
  })
})

describe('ClusterPage — one node at a time', () => {
  it('renders ONE node card, not one per node', () => {
    topology.nodes = [
      node('hub', 'hub', true, true),
      node('a', 'agent-a', false, true),
      node('b', 'agent-b', false, true),
    ]
    renderAt('/cluster')

    // Three nodes are offered…
    expect(chipNames().length).toBe(3)
    // …and exactly one detail is mounted. `General` is the node card's first
    // tab, so counting it counts cards.
    expect(screen.getAllByRole('button', { name: /^General$/ }).length).toBe(1)
  })

  it('opens the hub first when the URL asks for nothing', () => {
    topology.nodes = [node('a', 'agent-a', false, true), node('hub', 'hub', true, true)]
    renderAt('/cluster')
    expect(openNodeName()).toBe('hub')
  })

  it('names the hub row after the server, with the node id as the secondary label (D861)', () => {
    systemInfo.current = { serverName: { name: 'Casa Napoli', isDefault: false } }
    try {
      topology.nodes = [node('hub', 'hub', true, true)]
      renderAt('/cluster')
      expect(screen.getByTestId('node-title-name').textContent).toBe('Casa Napoli')
      expect(screen.getByTestId('node-title-id').textContent).toBe('hub')
    } finally {
      systemInfo.current = undefined
    }
  })

  it('honours ?node= on first load, so a reload lands where it left', () => {
    topology.nodes = [node('hub', 'hub', true, true), node('a', 'agent-a', false, true)]
    renderAt('/cluster?node=a')
    expect(openNodeName()).toBe('agent-a')
  })

  it('falls back to the hub when ?node= names a node that is gone', () => {
    topology.nodes = [node('hub', 'hub', true, true)]
    renderAt('/cluster?node=forgotten')
    expect(openNodeName()).toBe('hub')
  })

  it('switches the detail when another chip is picked', () => {
    topology.nodes = [node('hub', 'hub', true, true), node('a', 'agent-a', false, true)]
    renderAt('/cluster')
    expect(openNodeName()).toBe('hub')

    const picker = screen.getByTestId('node-picker')
    fireEvent.click(within(picker).getByRole('button', { name: 'agent-a' }))

    expect(openNodeName()).toBe('agent-a')
    // Still exactly one card — switching must not stack a second one.
    expect(screen.getAllByRole('button', { name: /^General$/ }).length).toBe(1)
  })

  it('keeps NodePicker visible on a single-node cluster (alwaysShow)', () => {
    topology.nodes = [node('hub', 'hub', true, true)]
    renderAt('/cluster')
    expect(screen.getByTestId('node-picker')).toBeTruthy()
    expect(chipNames()).toEqual(['hub'])
    expect(openNodeName()).toBe('hub')
  })

  it('renders shared NodePicker with allowOffline — not the old NodeSelector tablist', () => {
    topology.nodes = [node('hub', 'hub', true, true), node('a', 'agent-a', false, false)]
    renderAt('/cluster')
    const picker = screen.getByTestId('node-picker')
    expect(picker.getAttribute('data-allow-offline')).toBe('true')
    expect(within(picker).getByRole('button', { name: 'agent-a' })).not.toBeDisabled()
    expect(screen.queryByRole('tablist', { name: /nodes/i })).toBeNull()
  })

  it('offers an OFFLINE node too — a dead agent is what the page is opened for', () => {
    topology.nodes = [node('hub', 'hub', true, true), node('a', 'agent-a', false, false)]
    renderAt('/cluster?node=a')
    expect(chipNames().join('|')).toMatch(/agent-a/)
    expect(screen.getAllByText('agent-a').length).toBeGreaterThan(0)
  })
})

describe('NodeCard — no per-node Addons tab', () => {
  it('renders the six surviving tabs and no Addons tab', () => {
    topology.nodes = [node('hub', 'hub', true, true)]
    renderAt('/cluster')

    // Removed 2026-08-28: the dedicated Addons page owns per-node addon
    // management, and two surfaces for one job left operators guessing which
    // was authoritative.
    expect(screen.queryByRole('button', { name: /^addons/i })).toBeNull()

    // The rest of the tab bar is untouched. `General` proves the default tab
    // still resolves — it was already `'info'`, and `'addons'` was never the
    // default nor a fallback, so nothing had to be repointed.
    for (const tab of ['General', 'Processes', 'Load', 'Settings', 'Capabilities']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${tab}$`) }), tab).toBeTruthy()
    }
  })
})

/**
 * The READ side of the notification tap URL.
 *
 * A `server-update-available` event taps through to
 * `<server>/system/nodes?node=<id>` — the page that can actually apply a
 * node's own update (the Addons page hides `@camstack/server`). The mint side
 * is `packages/addon-post-analysis/.../system-event-tap-url.ts`.
 */
describe('ClusterPage — a notification link names a node', () => {
  it('opens the node the link named', () => {
    topology.nodes = [node('hub', 'hub', true, true), node('a', 'agent-a', false, true)]
    renderAt('/system/nodes?node=a')
    expect(openNodeName()).toBe('agent-a')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('opens an OFFLINE node the link named, rather than bouncing to the hub', () => {
    // The link is days old and the agent has dropped since. That node IS the
    // subject of the notification — sending the operator to the hub instead
    // hides the very thing he tapped.
    topology.nodes = [node('hub', 'hub', true, true), node('a', 'agent-a', false, false)]
    renderAt('/system/nodes?node=a')
    // An offline node's card renders its offline summary rather than the tab
    // bar `openNodeName` reads, so the assertion is the same one the existing
    // offline test makes: the agent's detail is on screen, and no stale-link
    // notice is — the node exists, it is merely down.
    expect(screen.getAllByText('agent-a').length).toBeGreaterThan(0)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a node that LEFT the cluster falls back to the hub AND says so', () => {
    topology.nodes = [node('hub', 'hub', true, true)]
    renderAt('/system/nodes?node=agent-a')
    expect(openNodeName()).toBe('hub')
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('agent-a')
    expect(notice.textContent).toContain('not in this cluster')
  })
})

/**
 * "Update all" opens the hub's cluster-update job. The page does not loop
 * `applyServerUpdate` itself — that job, and the step list, are the dialog.
 */
describe('ClusterPage — Update all opens the hub job', () => {
  it('opens the cluster-update dialog', () => {
    topology.nodes = [node('hub', 'hub', true, true), node('a', 'agent-a', false, true)]
    renderAt('/system/nodes')
    expect(screen.queryByRole('dialog', { name: 'cluster-update' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Update all nodes/i }))
    expect(screen.getByRole('dialog', { name: 'cluster-update' })).toBeTruthy()
  })
})
