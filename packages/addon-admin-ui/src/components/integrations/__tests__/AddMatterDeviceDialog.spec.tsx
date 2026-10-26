/**
 * Add Matter device — the operator pastes a share code and sees named
 * commissioning failures. The broker hooks are stubbed; the dialog itself
 * decides what to show.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AddMatterDeviceDialog } from '../AddMatterDeviceDialog'

interface MutateOptions {
  readonly onSuccess?: () => void
  readonly onError?: (err: unknown) => void
}

interface ReportedPhase {
  readonly phase: string
  readonly failure: string | null
  readonly message: string | null
}

const harness = vi.hoisted(() => {
  const box: { state: ReportedPhase | null; brokers: { id: string }[] } = {
    state: null,
    brokers: [{ id: 'matter_001' }],
  }
  return { publish: vi.fn(), box }
})

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useBrokerList: () => ({
      data: harness.box.brokers,
      isSuccess: true,
      isPending: false,
    }),
    useBrokerPublish: () => ({ mutate: harness.publish, isPending: false }),
    useBrokerGetState: () => ({ data: harness.box.state }),
  }
})

function renderDialog(onCommissioned: () => void = vi.fn()): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <AddMatterDeviceDialog onClose={vi.fn()} onCommissioned={onCommissioned} />
    </QueryClientProvider>
  )
}

function pasteAndSubmit(code: string): void {
  fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: code } })
  fireEvent.click(screen.getByRole('button', { name: 'Add device' }))
}

describe('AddMatterDeviceDialog', () => {
  it('asks for a pairing code and refuses to submit an empty one', () => {
    render(renderDialog())
    expect(screen.getByText('Add Matter device')).toBeTruthy()
    expect(screen.getByLabelText('Pairing code')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add device' }).hasAttribute('disabled')).toBe(true)
  })

  it('publishes the pasted code to the matter broker', () => {
    harness.publish.mockReset()
    harness.publish.mockImplementation(() => undefined)
    render(renderDialog())
    pasteAndSubmit('34970112332')
    expect(harness.publish).toHaveBeenCalledWith(
      {
        brokerId: 'matter_001',
        target: { action: 'commissionNode' },
        payload: { pairingCode: '34970112332' },
      },
      expect.any(Object),
    )
  })

  it('names an expired code, a missing device and a rejected code', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['matter-commission:code-expired: window closed', 'The pairing code expired'],
      ['matter-commission:device-not-found: no device', 'No Matter device with that code'],
      ['matter-commission:wrong-code: PASE failed', 'The pairing code was rejected'],
      ['invalid pairing code', 'Enter an 11-digit or 21-digit manual code'],
    ]
    for (const [message, expected] of cases) {
      harness.publish.mockImplementation((_input: unknown, options: MutateOptions) => {
        options.onError?.(new Error(message))
      })
      const view = render(renderDialog())
      pasteAndSubmit('34970112332')
      expect(screen.getByRole('alert').textContent).toContain(expected)
      view.unmount()
    }
  })

  it('shows the phase the broker reports while commissioning', () => {
    harness.box.state = { phase: 'pase', failure: null, message: null }
    harness.publish.mockImplementation(() => undefined)
    render(renderDialog())
    pasteAndSubmit('MT:ABCD')
    expect(screen.getByText('Opening a secure session')).toBeTruthy()
    expect(screen.getByText('Looking for the device')).toBeTruthy()
  })

  it('offers adopt once commissioning finishes', () => {
    harness.box.state = null
    harness.publish.mockImplementation((_input: unknown, options: MutateOptions) => {
      options.onSuccess?.()
    })
    const onCommissioned = vi.fn()
    render(renderDialog(onCommissioned))
    pasteAndSubmit('34970112332')
    fireEvent.click(screen.getByRole('button', { name: 'Adopt devices' }))
    expect(onCommissioned).toHaveBeenCalledOnce()
  })
})
