/**
 * "Unpair" on an agent's NodeCard calls the same hub method the pairing list
 * uses (`agentPairing.unpairAgent`, D857) with the node id, behind a danger
 * confirm, and never exists on the hub's own card.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const unpairMutate = vi.fn()
const confirmFn = vi.fn()
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
  useSystemInfo: () => ({ data: undefined, isLoading: false }),
  useSystem: () => ({
    trpcClient: {
      pipelineOrchestrator: { removeAgentSettings: { mutate: removeAgentSettingsMutate } },
      clusterNodes: { forgetNode: { mutate: forgetNodeMutate } },
      agentPairing: { unpairAgent: { mutate: unpairMutate } },
      addons: { custom: { mutate: vi.fn() } },
    },
  }),
  usePipelineOrchestratorListAgentSettings: () => ({ data: [], isLoading: false }),
  useServerManagementGetServerPackageStatus: () => ({
    data: null,
    isLoading: false,
    isError: false,
  }),
  useServerManagementCheckServerUpdate: () => ({ mutate: vi.fn(), isPending: false }),
  useServerManagementApplyServerUpdate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useServerManagementRestartServer: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirm: () => confirmFn,
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

async function clickUnpair(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Unpair$/ }))
  })
}

describe('NodeCard — Unpair', () => {
  beforeEach(() => {
    unpairMutate.mockReset()
    confirmFn.mockReset().mockResolvedValue(true)
  })

  it('confirms (danger) then unpairs the node by id', async () => {
    unpairMutate.mockResolvedValue({
      nodeId: 'hub-test',
      agentNotified: true,
      revokedSerials: [],
      disconnected: 1,
      next: 'It must be paired again.',
    })
    render(<NodeCard node={OFFLINE} />)

    await clickUnpair()

    expect(confirmFn).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'danger',
        message: 'Unpair hub-test? It disconnects and must be paired again.',
      }),
    )
    expect(unpairMutate).toHaveBeenCalledWith({ nodeId: 'hub-test' })
    expect(screen.getByRole('status').textContent).toMatch(/paired again/)
  })

  it('does nothing when the confirm is declined', async () => {
    confirmFn.mockResolvedValue(false)
    render(<NodeCard node={OFFLINE} />)

    await clickUnpair()

    expect(unpairMutate).not.toHaveBeenCalled()
  })

  it('surfaces a rejected unpair', async () => {
    unpairMutate.mockRejectedValue(new Error('registry not loaded'))
    render(<NodeCard node={OFFLINE} />)

    await clickUnpair()

    expect(screen.getByRole('status').textContent).toMatch(/Unpair failed: registry not loaded/)
  })

  it('has no Unpair on the hub card', () => {
    render(<NodeCard node={{ ...OFFLINE, isHub: true }} />)

    expect(screen.queryByRole('button', { name: /^Unpair$/ })).toBeNull()
  })
})
