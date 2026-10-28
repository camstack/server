// @vitest-environment jsdom
/**
 * "Agents found on the network": the discovery table states (an unanswered
 * list is not an empty one), add-by-address with the server's validation, and
 * the unpair confirmation.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiscoveredAgent } from '../pairing-model'

interface ListState {
  data?: { agents: DiscoveredAgent[]; scannedAt: number | null }
  isLoading: boolean
  isError: boolean
  error?: { message: string }
}

let list: ListState
let confirmAnswer = true
const confirmSpy = vi.fn()
const addMutate = vi.fn()
const unpairMutate = vi.fn()
let addOptions: { onError: (e: { message: string }) => void } | undefined

function agent(over: Partial<DiscoveredAgent> & { nodeId: string }): DiscoveredAgent {
  return {
    host: '192.0.2.20',
    port: 4444,
    version: '1.2.421',
    state: 'unpaired',
    fingerprint: null,
    source: 'mdns',
    connected: false,
    pairing: null,
    ...over,
  }
}

vi.mock('../PairingDialog', () => ({
  PairingDialog: ({ target }: { target: { nodeId: string; pairingId?: string } | null }) =>
    target === null ? null : (
      <div data-testid="pairing-dialog" data-pairing-id={target.pairingId ?? ''}>
        {target.nodeId}
      </div>
    ),
}))

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useConfirm: () => async (options: unknown) => {
    confirmSpy(options)
    return confirmAnswer
  },
  trpc: {
    useUtils: () => ({
      agentPairing: {
        listDiscoveredAgents: { invalidate: vi.fn(), fetch: vi.fn() },
      },
    }),
    agentPairing: {
      listDiscoveredAgents: { useQuery: () => list },
      addAgentByAddress: {
        useMutation: (options: { onError: (e: { message: string }) => void }) => {
          addOptions = options
          return { mutate: addMutate, isPending: false }
        },
      },
      unpairAgent: {
        useMutation: () => ({ mutate: unpairMutate, isPending: false }),
      },
    },
  },
}))

import { AgentsFoundSection } from '../AgentsFoundSection'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  confirmSpy.mockReset()
  addMutate.mockReset()
  unpairMutate.mockReset()
  confirmAnswer = true
  list = {
    isLoading: false,
    isError: false,
    data: { agents: [], scannedAt: 1 },
  }
})

afterEach(cleanup)

const mount = (): void => void render(<AgentsFoundSection onOpenNode={vi.fn()} />)

describe('AgentsFoundSection discovery states', () => {
  it('says it is looking while the list is unanswered, never "no agents"', () => {
    list = { isLoading: true, isError: false }
    mount()
    expect(screen.getByText('Looking for agents…')).toBeTruthy()
    expect(screen.queryByText('No agents found')).toBeNull()
  })

  it('reports a failed scan as an error, not as an empty network', () => {
    list = {
      isLoading: false,
      isError: true,
      error: { message: 'mDNS browse failed' },
    }
    mount()
    expect(screen.getByText('mDNS browse failed')).toBeTruthy()
    expect(screen.queryByText('No agents found')).toBeNull()
  })

  it('shows the empty state only for an answered, empty list', () => {
    mount()
    expect(screen.getByText('No agents found')).toBeTruthy()
  })

  it('offers Pair on unpaired, Unpair on paired, nothing on pending', () => {
    list = {
      isLoading: false,
      isError: false,
      data: {
        scannedAt: 1,
        agents: [
          agent({ nodeId: 'a-unpaired' }),
          agent({ nodeId: 'a-pending', state: 'pending' }),
          agent({
            nodeId: 'a-paired',
            state: 'paired',
            connected: true,
            fingerprint: 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
          }),
        ],
      },
    }
    mount()
    expect(screen.getAllByRole('button', { name: 'Pair' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Unpair' })).toHaveLength(1)
    expect(screen.getByText('connected')).toBeTruthy()
    expect(screen.getByTitle('AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89')).toBeTruthy()
  })

  it('opens the pairing dialog for the chosen agent', () => {
    list = {
      isLoading: false,
      isError: false,
      data: { scannedAt: 1, agents: [agent({ nodeId: 'a-unpaired' })] },
    }
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))
    expect(screen.getByTestId('pairing-dialog').textContent).toBe('a-unpaired')
  })
})

describe('AgentsFoundSection resume', () => {
  const pendingAgent = (): DiscoveredAgent =>
    agent({
      nodeId: 'a-pending',
      state: 'pending',
      pairing: {
        pairingId: 'p-open',
        code: '123456',
        state: 'awaiting-confirmation',
        expiresAt: Date.now() + 60_000,
      } as DiscoveredAgent['pairing'],
    })

  it('offers Resume on a pending agent with an open pairing and reattaches to it', () => {
    list = {
      isLoading: false,
      isError: false,
      data: { scannedAt: 1, agents: [pendingAgent()] },
    }
    mount()
    expect(screen.queryByRole('button', { name: 'Pair' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    const dialog = screen.getByTestId('pairing-dialog')
    expect(dialog.textContent).toBe('a-pending')
    expect(dialog.getAttribute('data-pairing-id')).toBe('p-open')
  })
})

describe('AgentsFoundSection add by address', () => {
  it('sends the trimmed address and the optional port', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /Add by address/ }))
    fireEvent.change(screen.getByLabelText('Agent address'), {
      target: { value: ' 192.0.2.50 ' },
    })
    fireEvent.change(screen.getByLabelText('Agent port'), {
      target: { value: '4455' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addMutate).toHaveBeenCalledWith({ host: '192.0.2.50', port: 4455 })
  })

  it('refuses a bad port locally and shows the server message for a public address', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /Add by address/ }))
    fireEvent.change(screen.getByLabelText('Agent address'), {
      target: { value: '8.8.8.8' },
    })
    fireEvent.change(screen.getByLabelText('Agent port'), {
      target: { value: '99999' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/between 1 and 65535/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Agent port'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addMutate).toHaveBeenCalledWith({ host: '8.8.8.8' })
    await act(async () =>
      addOptions?.onError({
        message: 'Only private or local addresses can be added.',
      }),
    )
    expect(screen.getByText('Only private or local addresses can be added.')).toBeTruthy()
  })
})

describe('AgentsFoundSection unpair', () => {
  beforeEach(() => {
    list = {
      isLoading: false,
      isError: false,
      data: {
        scannedAt: 1,
        agents: [agent({ nodeId: 'a-paired', state: 'paired', fingerprint: 'AB:CD' })],
      },
    }
  })

  it('asks a danger confirmation naming the revocation, then unpairs', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Unpair' }))
    await waitFor(() => expect(unpairMutate).toHaveBeenCalledWith({ nodeId: 'a-paired' }))
    const asked = confirmSpy.mock.calls[0]?.[0] as {
      variant: string
      message: string
      title: string
    }
    expect(asked.variant).toBe('danger')
    expect(asked.message).toMatch(/certificates are revoked/)
    expect(asked.message).toMatch(/paired again/)
  })

  it('does nothing when the operator declines', async () => {
    confirmAnswer = false
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Unpair' }))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(unpairMutate).not.toHaveBeenCalled()
  })
})
