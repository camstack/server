/// <reference types="@testing-library/jest-dom" />

/**
 * The "Max concurrent sessions" caps are a draft: typing writes nothing, Save
 * sends one change per edited node, Discard drops the draft.
 */
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../i18n'

expect.extend(jestDomMatchers)

const mutateAsync = vi.hoisted(() => vi.fn((_input: unknown) => Promise.resolve(undefined)))

function query<T>(data: T) {
  return { data, isLoading: false, isError: false, error: null }
}

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false }
  return {
    ...real,
    useClusterNodes: () => ({
      nodes: [
        { id: 'hub', name: 'Hub', isOnline: true },
        { id: 'nuc', name: 'Garage NUC', isOnline: true },
      ],
    }),
    useDeviceManagerListAll: () => query([]),
    usePipelineOrchestratorListAgentSettings: () =>
      query([
        { nodeId: 'hub', settings: { maxCameras: 4 } },
        { nodeId: 'nuc', settings: {} },
      ]),
    usePipelineOrchestratorGetPlacementStats: () => query(undefined),
    usePipelineOrchestratorGetEffectiveShares: () => query(undefined),
    usePipelineOrchestratorSuggestShares: () => query(undefined),
    usePipelineOrchestratorSetLoadBalancingShares: () => mutation,
    usePipelineOrchestratorSetShareSource: () => mutation,
    usePipelineOrchestratorRebalance: () => mutation,
    usePipelineOrchestratorSetPipelineDevicePin: () => mutation,
    usePipelineOrchestratorSetAgentMaxCameras: () => ({ ...mutation, mutateAsync }),
  }
})
vi.mock('../../LiveLoadPanel', () => ({ LiveLoadPanel: () => null }))
vi.mock('../../NodeLoadOverview', () => ({ NodeLoadOverview: () => null }))
vi.mock('../../placement-board/NodeInferenceDevices', () => ({ NodeInferenceDevices: () => null }))
vi.mock('../../placement-board/WeightSliderStack', () => ({ WeightSliderStack: () => null }))

import { ClusterLoadBalancingTab } from '../ClusterLoadBalancingTab'

function renderTab(): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClusterLoadBalancingTab refreshToken={0} onOpenAutoTune={() => undefined} />
    </QueryClientProvider>,
  )
}

const capOf = (name: string): HTMLInputElement =>
  screen.getByLabelText(`Max concurrent sessions for ${name}`)

describe('ClusterLoadBalancingTab max concurrent sessions', () => {
  beforeEach(() => {
    mutateAsync.mockClear()
  })

  it('writes nothing while typing, and only the edited node on Save', async () => {
    renderTab()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()

    fireEvent.change(capOf('Garage NUC'), { target: { value: '6' } })
    expect(mutateAsync).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(mutateAsync).toHaveBeenCalledWith({ agentNodeId: 'nuc', maxCameras: 6 })
  })

  it('Discard drops the draft and writes nothing', () => {
    renderTab()
    fireEvent.change(capOf('Hub'), { target: { value: '9' } })
    expect(capOf('Hub').value).toBe('9')

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(capOf('Hub').value).toBe('4')
    expect(mutateAsync).not.toHaveBeenCalled()
  })
})
