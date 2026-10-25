/**
 * "Forget node" must show what it removed.
 *
 * WHY THIS FILE EXISTS. On 2026-09-01 the operator forgot the offline node
 * `hub-test` repeatedly and it never left the Cluster page. Three layers each
 * threw away the evidence:
 *
 *  - the service returned `void`,
 *  - the router answered a hardcoded `{success: true}` that never looked at it,
 *  - and this component ran `Promise.allSettled([...])` and discarded the
 *    array — so even two REJECTIONS produced nothing on screen.
 *
 * The first two are fixed server-side (`forget-cluster-node.spec.ts`). This
 * pins the last one: the answer reaches the operator, and "still listed" is
 * said out loud rather than left to be discovered by staring at the page.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const forgetNodeMutate = vi.fn()
const removeAgentSettingsMutate = vi.fn()

vi.mock('@camstack/ui-library', () => ({
  Button: ({
    children,
    variant: _v,
    size: _s,
    ...rest
  }: Record<string, unknown> & { children?: React.ReactNode }) => (
    <button {...rest}>{children}</button>
  ),
  useSystem: () => ({
    trpcClient: {
      pipelineOrchestrator: { removeAgentSettings: { mutate: removeAgentSettingsMutate } },
      clusterNodes: { forgetNode: { mutate: forgetNodeMutate } },
      addons: { custom: { mutate: vi.fn() } },
    },
  }),
  usePipelineOrchestratorListAgentSettings: () => ({ data: [], isLoading: false }),
  useSystemInfo: () => ({ data: undefined, isLoading: false }),
  useServerManagementGetServerPackageStatus: () => ({
    data: null,
    isLoading: false,
    isError: false,
  }),
  useServerManagementCheckServerUpdate: () => ({ mutate: vi.fn(), isPending: false }),
  useServerManagementApplyServerUpdate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useServerManagementRestartServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirm: () => vi.fn().mockResolvedValue(true),
  useNodesRestartAddon: () => ({ mutateAsync: async () => ({ success: true }) }),
  useNodesRestartNode: () => ({ mutateAsync: async () => ({ restarted: [], failed: [] }) }),
  useNodesRenameNode: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDeviceManagerListAll: () => ({ data: [] }),
}))

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return { ...actual, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }
})

import { NodeCard, type NodeData } from '../NodeCard'

const OFFLINE: NodeData = {
  id: 'hub-test',
  name: 'hub-test',
  hostname: '192.168.10.192',
  platform: 'unknown',
  arch: 'unknown',
  cpuModel: null,
  cpuCores: 0,
  memoryMB: 0,
  engines: [],
  isHub: false,
  isOnline: false,
  cpuPercent: 0,
  memoryPercent: 0,
  addons: [],
  processes: [],
  categories: [],
}

async function clickForget(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Forget node/i }))
  })
}

describe('NodeCard — Forget node reports its outcome', () => {
  beforeEach(() => {
    forgetNodeMutate.mockReset()
    removeAgentSettingsMutate.mockReset().mockResolvedValue(undefined)
  })

  it('says the node is STILL listed instead of implying it is gone', async () => {
    forgetNodeMutate.mockResolvedValue({
      forgotten: true,
      historyRemoved: true,
      registryRemoved: false,
      stillListed: true,
      message:
        'hub-test: history row removed; no cluster registry entry — but the node is STILL in the cluster registry and will keep appearing.',
    })
    render(<NodeCard node={OFFLINE} />)

    await clickForget()

    expect(screen.getByRole('status').textContent).toMatch(/STILL in the cluster registry/i)
  })

  it('shows the confirmation when the node really was removed', async () => {
    forgetNodeMutate.mockResolvedValue({
      forgotten: true,
      historyRemoved: true,
      registryRemoved: true,
      stillListed: false,
      message: 'hub-test: history row removed; cluster registry entry removed.',
    })
    render(<NodeCard node={OFFLINE} />)

    await clickForget()

    expect(screen.getByRole('status').textContent).toMatch(/cluster registry entry removed/i)
  })

  it('surfaces a REJECTED forget instead of swallowing it', async () => {
    forgetNodeMutate.mockRejectedValue(new Error('PRECONDITION_FAILED'))
    render(<NodeCard node={OFFLINE} />)

    await clickForget()

    expect(screen.getByRole('status').textContent).toMatch(/PRECONDITION_FAILED/)
  })
})
