import type { ActionStep, FanPreset } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const FAN = 5
const CAPTURED: ActionStep = {
  kind: 'cap',
  target: { kind: 'devices', ids: [FAN] },
  cap: 'fan-control',
  method: 'setPercentage',
  args: { speed: 60 },
}

const refetch = vi.fn()

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useFanPresetsCapturePreset: () => ({
      refetch,
      isFetching: false,
      isError: false,
      error: null,
    }),
  }
})

// The step list has its own specs; here it only shows how many steps the draft holds.
vi.mock('../../../pages/build/automation/ActionList', () => ({
  ActionList: ({ actions }: { actions: readonly unknown[] }) => (
    <p data-testid="step-count">{actions.length}</p>
  ),
}))

import { FanPresetDialog } from '../FanPresetDialog'

const DRAFT: FanPreset = { id: 'p1', name: 'Notte', steps: [] }

function renderDialog(onSave = vi.fn()): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FanPresetDialog
        fanId={FAN}
        draft={DRAFT}
        others={[]}
        devices={[]}
        saving={false}
        error={null}
        onSave={onSave}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

describe('FanPresetDialog "Use current values"', () => {
  beforeEach(() => refetch.mockReset())

  it('fills the steps for review and names every reading it left out', async () => {
    refetch.mockResolvedValue({
      data: {
        steps: [CAPTURED],
        omitted: [{ what: 'oscillating', reason: 'the fan reports no oscillation' }],
      },
    })
    renderDialog()
    expect(screen.getByTestId('step-count').textContent).toBe('0')
    fireEvent.click(screen.getByTestId('fan-preset-use-current'))
    await waitFor(() => expect(screen.getByTestId('step-count').textContent).toBe('1'))
    expect(screen.getByTestId('fan-preset-omitted').textContent).toContain(
      'oscillating: the fan reports no oscillation',
    )
  })

  it('saves nothing until Save, and then the captured steps', async () => {
    refetch.mockResolvedValue({ data: { steps: [CAPTURED], omitted: [] } })
    const onSave = vi.fn()
    renderDialog(onSave)
    fireEvent.click(screen.getByTestId('fan-preset-use-current'))
    await waitFor(() => expect(screen.getByTestId('step-count').textContent).toBe('1'))
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ id: 'p1', name: 'Notte', steps: [CAPTURED] })
  })
})
