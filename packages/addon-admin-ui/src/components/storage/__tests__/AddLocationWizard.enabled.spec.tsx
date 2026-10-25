/**
 * "Enable immediately" on the Add-Location wizard.
 *
 * DEFAULT OFF, deliberately, and it matches what the orchestrator already does
 * on its own: a newly created sibling is born inert because creating a disk must
 * not silently start writing to it. The checkbox makes that visible instead of
 * leaving the operator to discover it later from a disk that stayed empty, and
 * it says what the off state costs.
 *
 * The one exception is the server's, not the UI's: the first location of a
 * type is forced enabled, because nothing else could serve (there is no
 * `isDefault` any more — D383). The wizard does not duplicate that rule; it
 * sends what the operator chose and lets the single authority resolve it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const upsertMutate = vi.fn()

vi.mock('../../form-builder/FormBuilder', () => ({
  FormBuilder: () => <div data-testid="form-builder" />,
}))
vi.mock('../PathBrowser', () => ({
  PathBrowser: () => <div data-testid="path-browser" />,
}))

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    NodePicker: () => <div data-testid="node-picker" />,
    useSystem: () => ({ trpcClient: { storage: { testConfig: { query: vi.fn() } } } }),
    useStorageListProviders: () => ({
      data: [
        {
          providerId: 'filesystem',
          displayName: 'Local filesystem',
          configSchema: { sections: [] },
          nodeLocal: false,
        },
      ],
      isLoading: false,
    }),
    useStorageUpsertLocation: () => ({
      mutate: upsertMutate,
      isPending: false,
      isError: false,
      error: null,
    }),
  }
})

import { AddLocationWizard } from '../AddLocationWizard'

afterEach(() => {
  cleanup()
})
beforeEach(() => {
  upsertMutate.mockClear()
})

/** Walk the wizard to its naming step and name the location. */
function reachNamingStep(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AddLocationWizard initialType="recordings" onClose={vi.fn()} onCreated={vi.fn()} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByText('Local filesystem'))
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  fireEvent.change(screen.getByPlaceholderText(/recordings on Local filesystem/i), {
    target: { value: 'NVMe' },
  })
}

describe('AddLocationWizard — enable immediately', () => {
  it('offers the choice, DEFAULT OFF, and says what off means', () => {
    reachNamingStep()
    const box = screen.getByRole('checkbox', { name: /enable immediately/i })
    expect(box).toBeTruthy()
    expect((box as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText(/receives no writes until enabled/i)).toBeTruthy()
  })

  it('creates the location INERT when the box is left alone', () => {
    reachNamingStep()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(upsertMutate).toHaveBeenCalledTimes(1)
    expect(upsertMutate.mock.calls[0]?.[0]).toMatchObject({ enabled: false })
  })

  it('passes the opt-in through to the create upsert when ticked', () => {
    reachNamingStep()
    fireEvent.click(screen.getByRole('checkbox', { name: /enable immediately/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(upsertMutate.mock.calls[0]?.[0]).toMatchObject({
      id: 'recordings:nvme',
      type: 'recordings',
      displayName: 'NVMe',
      providerId: 'filesystem',
      enabled: true,
    })
  })

  it('does not offer to mark the location as default', () => {
    reachNamingStep()
    expect(screen.queryByText(/mark as default/i)).toBeNull()
  })

  it('Reset puts the opt-in back to off', () => {
    reachNamingStep()
    fireEvent.click(screen.getByRole('checkbox', { name: /enable immediately/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    fireEvent.click(screen.getByText('Local filesystem'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByPlaceholderText(/recordings on Local filesystem/i), {
      target: { value: 'NVMe' },
    })
    expect(
      (screen.getByRole('checkbox', { name: /enable immediately/i }) as HTMLInputElement).checked,
    ).toBe(false)
  })
})
