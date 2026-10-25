/**
 * Component tests for the per-node server-management section (runtime-
 * updatable node root package + lifecycle actions). This surface was
 * extracted from the former standalone Server-management page and now renders
 * inside each Cluster node card's General tab. Covers:
 *   - the Node.js-runtime version row,
 *   - the per-node Restart action (server-management.restartServer),
 *   - hub = unpinned default routing (no nodeId),
 *   - which image-contract verdicts reach the screen (2026-08-27).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { ImageContract } from '@camstack/types'

const applySpy = vi.fn().mockResolvedValue({ accepted: true, restarting: true })
const restartSpy = vi.fn().mockResolvedValue({ accepted: true, restarting: true })
const rollbackSpy = vi.fn().mockResolvedValue({ accepted: true, restarting: true })
const checkSpy = vi.fn()

/** Mutable across tests — read inside the hoisted `vi.mock` factory. */
const contractHolder = vi.hoisted(() => ({ current: null as ImageContract | null }))

function statusFor(_isHub: boolean) {
  return {
    // Both roles run the single @camstack/server root (hub vs agent = CAMSTACK_ROLE).
    packageName: '@camstack/server',
    runningVersion: '1.1.41',
    nodeRuntimeVersion: 'v22.11.0',
    activeVersion: '1.1.41',
    previousVersion: null,
    seedVersion: '1.1.40',
    latestVersion: null,
    updateAvailable: false,
    bootMode: 'data-root' as const,
    updateState: 'idle' as const,
    pendingVersion: null,
    rolledBack: null,
    stateFileCorrupt: false,
    lastCheckedAtMs: null,
    imageContract: contractHolder.current ?? undefined,
  }
}

vi.mock('@camstack/ui-library', () => ({
  useServerManagementGetServerPackageStatus: (input: { nodeId?: string } | undefined) => ({
    data: statusFor(input?.nodeId == null),
    isLoading: false,
    isError: false,
  }),
  useServerManagementCheckServerUpdate: () => ({ mutate: checkSpy, isPending: false }),
  useServerManagementApplyServerUpdate: () => ({ mutateAsync: applySpy, isPending: false }),
  useServerManagementRollbackServerUpdate: () => ({ mutateAsync: rollbackSpy, isPending: false }),
  useServerManagementRestartServer: () => ({ mutateAsync: restartSpy, isPending: false }),
  useConfirm: () => vi.fn().mockResolvedValue(true),
}))

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  }
})

import { NodeServerManagementSection } from '../NodeServerManagementSection'

const HUB = {
  id: 'hub',
  name: 'Hub',
  isHub: true,
  isOnline: true,
  rootPackage: { name: '@camstack/server', version: '1.1.41' },
}

describe('NodeServerManagementSection', () => {
  beforeEach(() => {
    applySpy.mockClear()
    restartSpy.mockClear()
    rollbackSpy.mockClear()
    checkSpy.mockClear()
    contractHolder.current = null
  })

  it('shows versions in one compact prospectus (no standalone Image seed row)', () => {
    render(<NodeServerManagementSection node={HUB} />)
    expect(screen.queryByText('Image seed (baked)')).toBeNull()
    expect(screen.getByText('v22.11.0')).toBeTruthy()
    expect(screen.getByText('1.1.40')).toBeTruthy()
    expect(screen.getByText('1.1.41')).toBeTruthy()
  })

  it('Restart action calls server-management restartServer (hub = unpinned)', async () => {
    render(<NodeServerManagementSection node={HUB} />)
    const restartBtn = screen.getByRole('button', { name: /^restart$/i })
    await act(async () => {
      fireEvent.click(restartBtn)
    })
    expect(restartSpy).toHaveBeenCalledTimes(1)
    expect(restartSpy).toHaveBeenCalledWith(undefined)
  })

  it('renders the last-reported version for an offline node', () => {
    render(
      <NodeServerManagementSection
        node={{
          id: 'agent-1',
          name: 'Agent One',
          isHub: false,
          isOnline: false,
          rootPackage: { name: '@camstack/server', version: '1.1.40' },
        }}
      />,
    )
    expect(screen.getByText('Last reported version')).toBeTruthy()
    expect(screen.getByText('1.1.40')).toBeTruthy()
  })
})

/**
 * The image-contract banner gate.
 *
 * `behind-patch` says the baked image seed is older than the release the
 * contract delivers, WITHIN the same series. That is what every node looks like
 * the moment it takes a runtime update — applyServerUpdate installs into the
 * data root and never rewrites the image — so the hub sat in that state
 * continuously (seed 1.2.175 vs contract 1.2.179 on 2026-08-27) and the banner
 * was permanent furniture. It is not shown.
 *
 * `behind-series` is a whole major.minor behind: a pinned tag or an image
 * repository that no longer receives builds, where a docker pull fixes nothing.
 * That is the 2026-08-02 failure. It stays.
 *
 * Only the RENDER is gated. `assessImageContract` still computes both,
 * `RootUpdateService` still WARNs on both, and the Home Assistant export still
 * publishes the state as a sensor.
 */
describe('NodeServerManagementSection — image-contract banner', () => {
  const BANNER = /Container image diverges from the deployment contract/i

  beforeEach(() => {
    contractHolder.current = null
  })

  it('says nothing when the seed is merely behind the contract by a patch', () => {
    contractHolder.current = {
      state: 'behind-patch',
      seedVersion: '1.2.175',
      contractVersion: '1.2.179',
      contractSource: 'registry',
      message: 'Image seed is behind the contract image.',
    }
    render(<NodeServerManagementSection node={HUB} />)
    expect(screen.queryByText(BANNER)).toBeNull()
    expect(screen.queryByText('Image seed is behind the contract image.')).toBeNull()
  })

  it('still shouts when the seed is a whole release series behind', () => {
    contractHolder.current = {
      state: 'behind-series',
      seedVersion: '1.1.74',
      contractVersion: '1.2.179',
      contractSource: 'registry',
      message: 'The seed is a full release series behind.',
    }
    render(<NodeServerManagementSection node={HUB} />)
    expect(screen.getByText(BANNER)).toBeTruthy()
    expect(screen.getByText('The seed is a full release series behind.')).toBeTruthy()
  })

  it('says nothing for in-sync, ahead or unknown', () => {
    for (const state of ['in-sync', 'ahead', 'unknown'] as const) {
      contractHolder.current = {
        state,
        seedVersion: '1.2.179',
        contractVersion: '1.2.179',
        contractSource: 'registry',
        message: `verdict ${state}`,
      }
      const { unmount } = render(<NodeServerManagementSection node={HUB} />)
      expect(screen.queryByText(BANNER)).toBeNull()
      unmount()
    }
  })
})
