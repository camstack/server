/**
 * The banner follows the persisted proposals: no proposal, no banner; N
 * proposals, "N new devices found"; Adopt and Dismiss go through the existing
 * adoption mutation and the dismiss mutation.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

interface FakeProposal {
  readonly id: string
  readonly addonId: string
  readonly candidate: {
    readonly stableId: string
    readonly suggestedName: string
    readonly type: string
    readonly prefilledConfig: Record<string, unknown>
    readonly setupIntegration?: boolean
  }
}

const state: { proposals: FakeProposal[] | undefined } = { proposals: undefined }
const adoptMutate = vi.fn(async (_input: unknown) => ({}))
const dismissMutate = vi.fn(async (_input: unknown) => ({ dismissed: true }))
const refetch = vi.fn()

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useDeviceManagerListDiscoveryProposals: () => ({
      data: state.proposals === undefined ? undefined : { proposals: state.proposals },
      refetch,
    }),
    useDeviceManagerAdoptDevice: () => ({ mutateAsync: adoptMutate }),
    useDeviceManagerDismissDiscoveryProposal: () => ({ mutateAsync: dismissMutate }),
  }
})

import { DiscoveryProposalsBanner } from '../DiscoveryProposalsBanner'

function proposal(n: number, over: Partial<FakeProposal['candidate']> = {}): FakeProposal {
  return {
    id: `provider-esphome::esp-${n}`,
    addonId: 'provider-esphome',
    candidate: {
      stableId: `esp-${n}`,
      suggestedName: `Board ${n}`,
      type: 'container',
      prefilledConfig: {},
      ...over,
    },
  }
}

function at<T>(list: readonly T[], index: number): T {
  const item = list[index]
  if (item === undefined) throw new Error(`no item at ${index}`)
  return item
}

describe('DiscoveryProposalsBanner', () => {
  it('renders nothing while the query has not answered, and nothing for an empty answer', () => {
    state.proposals = undefined
    const { container, rerender } = render(
      <DiscoveryProposalsBanner onSetupIntegration={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
    state.proposals = []
    rerender(<DiscoveryProposalsBanner onSetupIntegration={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('the count follows the proposals', () => {
    state.proposals = [proposal(1)]
    const { rerender } = render(<DiscoveryProposalsBanner onSetupIntegration={vi.fn()} />)
    expect(screen.getByTestId('discovery-banner').textContent).toContain('1 new device found')
    state.proposals = [proposal(1), proposal(2), proposal(3)]
    rerender(<DiscoveryProposalsBanner onSetupIntegration={vi.fn()} />)
    expect(screen.getByTestId('discovery-banner').textContent).toContain('3 new devices found')
  })

  it('Adopt goes through adoptDevice and Dismiss through dismissDiscoveryProposal', async () => {
    state.proposals = [proposal(1), proposal(2)]
    render(<DiscoveryProposalsBanner onSetupIntegration={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const rows = screen.getAllByTestId('discovery-proposal')
    expect(rows).toHaveLength(2)

    fireEvent.click(at(screen.getAllByRole('button', { name: 'Adopt' }), 0))
    await vi.waitFor(() => expect(adoptMutate).toHaveBeenCalledTimes(1))
    expect(adoptMutate).toHaveBeenCalledWith({
      addonId: 'provider-esphome',
      candidate: state.proposals[0]?.candidate,
    })

    fireEvent.click(within(at(rows, 1)).getByRole('button', { name: 'Dismiss' }))
    await vi.waitFor(() =>
      expect(dismissMutate).toHaveBeenCalledWith({ id: 'provider-esphome::esp-2' }),
    )
  })

  it('a proposal that is an integration opens the setup form instead of adopting', () => {
    adoptMutate.mockClear()
    const onSetup = vi.fn()
    state.proposals = [
      proposal(9, { setupIntegration: true, prefilledConfig: { host: '192.0.2.9' } }),
    ]
    render(<DiscoveryProposalsBanner onSetupIntegration={onSetup} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }))
    expect(adoptMutate).not.toHaveBeenCalled()
    expect(onSetup).toHaveBeenCalledWith(
      expect.objectContaining({ addonId: 'provider-esphome', originStableId: 'esp-9' }),
    )
  })
})
