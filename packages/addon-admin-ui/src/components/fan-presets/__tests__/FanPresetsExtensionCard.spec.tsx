import { type DeviceInfo, DeviceType, type FanPreset } from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const STORED: FanPreset[] = [{ id: 'p1', name: 'Night', state: { speed: 30 } }]
const setPresets = vi.fn(async (_input: { deviceId: number; presets: FanPreset[] }) => ({
  status: 'saved' as const,
}))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    trpc: { useUtils: () => ({}) },
    useFanPresetsGetPresets: () => ({ data: STORED, status: 'success', error: null }),
    useFanPresetsCapturePreset: () => ({
      refetch: vi.fn(),
      isFetching: false,
      isError: false,
      error: null,
    }),
    useFanPresetsSetPresets: () => ({ mutateAsync: setPresets }),
    useRemoteSetConfig: () => ({ mutateAsync: vi.fn() }),
    useCoreBlocksUpdateComposition: () => ({ mutateAsync: vi.fn() }),
  }
})

import { ConfirmDialogProvider } from '@camstack/ui-library'
import { CustomizeDraftProvider } from '../../device/customize/customize-draft'
import { ConfigDraftProvider } from '../../device/customize/config/config-draft'
import { FanPresetsExtensionCard } from '../FanPresetsExtensionCard'

const FAN: DeviceInfo = {
  id: 7,
  name: 'Studio fan',
  stableId: 'fan',
  addonId: 'test',
  type: DeviceType.Fan,
  location: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
  integrationId: 'int_test',
}

function renderCard(withDraft: boolean): void {
  const card = <FanPresetsExtensionCard device={FAN} />
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <ConfirmDialogProvider>
          {withDraft ? (
            <CustomizeDraftProvider order={['config-remote', 'config-fan-presets']}>
              <ConfigDraftProvider>{card}</ConfigDraftProvider>
            </CustomizeDraftProvider>
          ) : (
            card
          )}
        </ConfirmDialogProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const saveButton = (): HTMLElement | null => screen.queryByRole('button', { name: /^save/i })

beforeEach(() => setPresets.mockClear())

describe('FanPresetsExtensionCard in the Customize draft', () => {
  it('an edit is held in the draft and written only on Save', async () => {
    renderCard(true)
    fireEvent.click(screen.getByRole('button', { name: /edit night/i }))
    fireEvent.change(screen.getByDisplayValue('Night'), { target: { value: 'Day' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^save/i })[0] as HTMLElement)
    expect(await screen.findByText('Day')).toBeTruthy()
    expect(setPresets).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /^save/i }))
    await waitFor(() => expect(setPresets).toHaveBeenCalledTimes(1))
    expect(setPresets.mock.calls[0]?.[0]?.presets.map((p) => p.name)).toEqual(['Day'])
  })

  it('delete asks first and names where the preset stops being offered', async () => {
    renderCard(true)
    fireEvent.click(screen.getByRole('button', { name: /delete night/i }))
    expect(await screen.findByText(/Alexa, HomeKit and Home Assistant stop offering/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(screen.queryByText('Night')).toBeNull())
    expect(setPresets).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /^save/i })).toBeTruthy()
  })

  it('an edit that lands back on the stored list leaves nothing pending', async () => {
    renderCard(true)
    fireEvent.click(screen.getByRole('button', { name: /edit night/i }))
    fireEvent.change(screen.getByDisplayValue('Night'), { target: { value: 'Day' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^save/i })[0] as HTMLElement)
    expect(await screen.findByText('Day')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /edit day/i }))
    fireEvent.change(screen.getByDisplayValue('Day'), { target: { value: 'Night' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^save/i })[0] as HTMLElement)
    await waitFor(() => expect(screen.getByText('Night')).toBeTruthy())
    await waitFor(() => expect(saveButton()).toBeNull())
  })

  it('with no draft to keep the edit in, the dialog stays open and says so', async () => {
    renderCard(false)
    fireEvent.click(screen.getByRole('button', { name: /edit night/i }))
    fireEvent.change(screen.getByDisplayValue('Night'), { target: { value: 'Day' } })
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    expect(await screen.findByText(/nothing was kept/i)).toBeTruthy()
    expect(screen.getByDisplayValue('Day')).toBeTruthy()
    expect(setPresets).not.toHaveBeenCalled()
  })
})
