import type { FanPreset, FanPresetCaptureResult } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

/** The Dreo studio fan (3370): its horizontal axis linked to 3361/3364 in Customize. */
const FAN = 3370

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

import { FanPresetDialog } from '../FanPresetDialog'

const DRAFT: FanPreset = { id: 'p1', name: 'Notte', state: {} }

const CAPTURED: FanPresetCaptureResult = {
  state: {
    speed: 40,
    preset: 'Preset 2',
    oscillationAxes: { horizontal: { oscillating: true, angle: 30 } },
  },
  omitted: [{ what: 'direction', reason: 'the fan reports no direction' }],
}

function renderDialog(onSave = vi.fn()): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FanPresetDialog
        fanId={FAN}
        draft={DRAFT}
        others={[]}
        saving={false}
        error={null}
        onSave={onSave}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

const valueOf = (testId: string): string => (screen.getByTestId(testId) as HTMLInputElement).value

describe('FanPresetDialog', () => {
  beforeEach(() => refetch.mockReset())

  it('"Use current values" fills the form from the fan-control state and names what it left out', async () => {
    refetch.mockResolvedValue({ data: CAPTURED })
    renderDialog()
    fireEvent.click(screen.getByTestId('fan-preset-use-current'))
    await waitFor(() => expect(valueOf('fan-preset-speed')).toBe('40'))
    expect(valueOf('fan-preset-mode')).toBe('Preset 2')
    expect(valueOf('fan-preset-axis-horizontal-angle')).toBe('30')
    expect(valueOf('fan-preset-axis-vertical-angle')).toBe('')
    expect(screen.getByTestId('fan-preset-omitted').textContent).toContain(
      'direction: the fan reports no direction',
    )
  })

  it('saves the desired state, with an emptied field left out, only on Save', async () => {
    refetch.mockResolvedValue({ data: CAPTURED })
    const onSave = vi.fn()
    renderDialog(onSave)
    fireEvent.click(screen.getByTestId('fan-preset-use-current'))
    await waitFor(() => expect(valueOf('fan-preset-speed')).toBe('40'))
    fireEvent.change(screen.getByTestId('fan-preset-speed'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('fan-preset-axis-horizontal-angle'), {
      target: { value: '45' },
    })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith({
      id: 'p1',
      name: 'Notte',
      state: {
        preset: 'Preset 2',
        oscillationAxes: { horizontal: { oscillating: true, angle: 45 } },
      },
    })
  })

  it('a preset that sets nothing cannot be saved', () => {
    renderDialog()
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })
})
