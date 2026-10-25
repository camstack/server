// @vitest-environment jsdom
/**
 * The pairing dialog (D857): each side types the OTHER side's code. The hub's
 * code is shown to be read out and is never offered to the input; the confirm
 * call carries only what the operator typed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairingView } from '../pairing-model'

const HUB_CODE = '482913'

let begin: () => Promise<PairingView>
let polled: PairingView | undefined
let topologyNodes: { id: string; isOnline: boolean }[] | undefined
let pollOptions: { enabled?: boolean; refetchInterval?: unknown } | undefined
const confirmMutate = vi.fn()
const rejectMutate = vi.fn()

function view(over: Partial<PairingView> = {}): PairingView {
  return {
    pairingId: 'p1',
    nodeId: 'agent-1',
    endpoint: { host: '192.0.2.10', port: 4444 },
    code: HUB_CODE,
    state: 'awaiting-confirmation',
    hubConfirmed: false,
    agentConfirmed: false,
    expiresAt: Date.now() + 90_000,
    failure: null,
    ...over,
  }
}

vi.mock('@camstack/ui-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@camstack/ui-library')>()),
  useClusterTopology: () => ({ nodes: topologyNodes, isLoading: false }),
  trpc: {
    agentPairing: {
      beginPairing: { useMutation: () => ({ mutateAsync: () => begin() }) },
      getPairing: {
        useQuery: (_input: unknown, options: { enabled?: boolean; refetchInterval?: unknown }) => {
          pollOptions = options
          return { data: options.enabled === true ? polled : undefined }
        },
      },
      confirmPairing: {
        useMutation: () => ({ mutate: confirmMutate, data: undefined, isPending: false }),
      },
      rejectPairing: {
        useMutation: () => ({ mutate: rejectMutate, data: undefined, isPending: false }),
      },
    },
  },
}))

import { PairingDialog } from '../PairingDialog'

const TARGET = { nodeId: 'agent-1', host: '192.0.2.10', port: 4444 }

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

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
  confirmMutate.mockReset()
  rejectMutate.mockReset()
  polled = view()
  begin = async () => view()
  topologyNodes = undefined
  pollOptions = undefined
})

afterEach(cleanup)

async function open(): Promise<{ onClose: () => void; onOpenNode: (id: string) => void }> {
  const onClose = vi.fn()
  const onOpenNode = vi.fn()
  await act(async () => {
    render(
      <PairingDialog
        target={TARGET}
        onClose={onClose}
        onSettled={vi.fn()}
        onOpenNode={onOpenNode}
      />,
    )
  })
  return { onClose, onOpenNode }
}

const codeInput = (): HTMLInputElement =>
  screen.getByRole('textbox', { name: 'Code shown on the agent' }) as HTMLInputElement

describe('PairingDialog', () => {
  it('says the offer is going out until the first answer, then shows the hub code', async () => {
    let release: (v: PairingView) => void = () => {}
    begin = () => new Promise<PairingView>((resolve) => (release = resolve))
    await open()
    expect(screen.getByText(/Sending the pairing offer/)).toBeTruthy()
    expect(screen.queryByTestId('hub-code')).toBeNull()
    await act(async () => release(view()))
    await waitFor(() => expect(screen.getByTestId('hub-code').textContent).toBe('482 913'))
  })

  it('never prefills the input with the hub code and cannot confirm an empty one', async () => {
    await open()
    await waitFor(() => expect(screen.getByTestId('hub-code')).toBeTruthy())
    expect(codeInput().value).toBe('')
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(screen.getByText(/local PIN/)).toBeTruthy()
  })

  it('confirms with exactly what was typed, digits only', async () => {
    await open()
    await waitFor(() => expect(screen.getByTestId('hub-code')).toBeTruthy())
    fireEvent.change(codeInput(), { target: { value: '12a3-456' } })
    expect(codeInput().value).toBe('123456')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(confirmMutate).toHaveBeenCalledTimes(1)
    expect(confirmMutate.mock.calls[0]?.[0]).toEqual({ pairingId: 'p1', code: '123456' })
  })

  it('shows the server message on a wrong code and clears the input', async () => {
    await open()
    await waitFor(() => expect(screen.getByTestId('hub-code')).toBeTruthy())
    fireEvent.change(codeInput(), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    const options = confirmMutate.mock.calls[0]?.[1] as {
      onError: (e: { message: string }) => void
    }
    await act(async () => options.onError({ message: 'Wrong code. 2 attempts left.' }))
    expect(screen.getByText('Wrong code. 2 attempts left.')).toBeTruthy()
    expect(codeInput().value).toBe('')
  })

  it('counts down to the expiry and keeps polling while it can change', async () => {
    await open()
    await waitFor(() => expect(screen.getByTestId('countdown').textContent).toMatch(/1:(29|30)/))
    expect(pollOptions?.enabled).toBe(true)
    const interval = pollOptions?.refetchInterval as (q: {
      state: { data?: PairingView }
    }) => unknown
    expect(interval({ state: { data: view() } })).toBe(2000)
    expect(interval({ state: { data: view({ state: 'paired' }) } })).toBe(false)
  })

  it('offers no input once this side has confirmed and only the agent is missing', async () => {
    polled = view({ hubConfirmed: true })
    await open()
    await waitFor(() => expect(screen.getByText(/waiting for the agent/i)).toBeTruthy())
    expect(screen.queryByRole('textbox', { name: 'Code shown on the agent' })).toBeNull()
  })

  it('shows the failure of an expired pairing and offers only Close', async () => {
    polled = view({ state: 'expired', failure: 'Pairing window elapsed.' })
    const { onClose } = await open()
    await waitFor(() => expect(screen.getByText('Pairing window elapsed.')).toBeTruthy())
    expect(screen.queryByRole('textbox', { name: 'Code shown on the agent' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement)
    expect(onClose).toHaveBeenCalled()
  })

  it('on success waits for the node to register, then links to it', async () => {
    polled = view({ state: 'paired', hubConfirmed: true, agentConfirmed: true })
    topologyNodes = []
    await open()
    await waitFor(() => expect(screen.getByText(/Waiting for it to connect/)).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Open node' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    cleanup()
    topologyNodes = [{ id: 'agent-1', isOnline: true }]
    const second = await open()
    await waitFor(() => expect(screen.getByText(/registered its capabilities/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Open node' }))
    expect(second.onOpenNode).toHaveBeenCalledWith('agent-1')
    expect(second.onClose).toHaveBeenCalled()
  })

  it('reports an unreachable agent from the begin call', async () => {
    begin = async () => {
      throw { message: 'Agent refused the offer' }
    }
    await open()
    await waitFor(() => expect(screen.getByText('Agent refused the offer')).toBeTruthy())
    expect(screen.getByText('The agent could not be reached')).toBeTruthy()
  })

  it('rejects through the hub', async () => {
    await open()
    await waitFor(() => expect(screen.getByTestId('hub-code')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(rejectMutate.mock.calls[0]?.[0]).toEqual({ pairingId: 'p1' })
  })
})
