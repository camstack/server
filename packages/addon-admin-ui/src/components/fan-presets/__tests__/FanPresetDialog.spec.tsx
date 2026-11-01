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

const SWITCH: ActionStep = {
  kind: 'cap',
  target: { kind: 'devices', ids: [7] },
  cap: 'switch',
  method: 'setState',
  args: { on: true },
}
const ANGLE: ActionStep = {
  kind: 'cap',
  target: { kind: 'devices', ids: [8] },
  cap: 'control',
  method: 'setValue',
  args: { control: { kind: 'numeric', value: 45 } },
}
const PROPOSAL = {
  steps: [ANGLE, SWITCH, CAPTURED],
  items: [
    { group: 'angles', label: 'Angolo orizzontale' },
    { group: 'oscillation', label: 'Oscillazione orizzontale' },
    { group: 'fan', label: 'speed' },
  ],
  omitted: [{ what: 'oscillating', reason: 'the fan reports no oscillation' }],
}

describe('FanPresetDialog "Use current values"', () => {
  beforeEach(() => refetch.mockReset())

  it('proposes every sibling ticked, grouped fan / oscillation / angles, and names what it left out', async () => {
    refetch.mockResolvedValue({ data: PROPOSAL })
    renderDialog()
    fireEvent.click(screen.getByTestId('fan-preset-use-current'))
    await waitFor(() => expect(screen.getByTestId('fan-preset-capture')).toBeTruthy())
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(3)
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true)
    const text = screen.getByTestId('fan-preset-capture').textContent ?? ''
    expect(text.indexOf('Fan')).toBeLessThan(text.indexOf('Oscillation'))
    expect(text.indexOf('Oscillation')).toBeLessThan(text.indexOf('Angles'))
    expect(screen.getByTestId('fan-preset-omitted').textContent).toContain(
      'oscillating: the fan reports no oscillation',
    )
    expect(screen.getByTestId('step-count').textContent).toBe('0')
  })

  it('applies only the ticked steps, in the proposed order, and saves nothing until Save', async () => {
    refetch.mockResolvedValue({ data: PROPOSAL })
    const onSave = vi.fn()
    renderDialog(onSave)
    fireEvent.click(screen.getByTestId('fan-preset-use-current'))
    await waitFor(() => expect(screen.getByTestId('fan-preset-capture')).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Oscillazione orizzontale' }))
    fireEvent.click(screen.getByTestId('fan-preset-capture-apply'))
    await waitFor(() => expect(screen.getByTestId('step-count').textContent).toBe('2'))
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({ id: 'p1', name: 'Notte', steps: [ANGLE, CAPTURED] })
  })
})
