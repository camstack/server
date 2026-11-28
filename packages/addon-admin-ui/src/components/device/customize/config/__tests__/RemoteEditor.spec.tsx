import {
  type DeviceInfo,
  DeviceType,
  EMPTY_REMOTE_CONFIG,
  type RemoteConfig,
} from '@dominevo/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

const STORED: RemoteConfig = { ...EMPTY_REMOTE_CONFIG, layoutTemplateId: 'tpl-stored' }
const CHANGED: RemoteConfig = { ...EMPTY_REMOTE_CONFIG, layoutTemplateId: 'tpl-changed' }
const setConfig = vi.fn(async (_input: { deviceId: number; config: RemoteConfig }) => ({
  status: 'saved' as const,
}))

vi.mock('@dominevo/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dominevo/ui-library')>()
  return {
    ...actual,
    trpc: { useUtils: () => ({}) },
    useRemoteGetConfig: () => ({ data: STORED, status: 'success' }),
    useRemoteSetConfig: () => ({ mutateAsync: setConfig }),
    useFanPresetsSetPresets: () => ({ mutateAsync: vi.fn() }),
    useCoreBlocksUpdateComposition: () => ({ mutateAsync: vi.fn() }),
  }
})

// The modal has its own specs; here it is a stub that calls `onKeep` and shows what it was handed.
vi.mock('../../../../remote/RemoteConfigDialog', () => ({
  RemoteConfigDialog: ({
    kept,
    onKeep,
  }: {
    kept: RemoteConfig | null
    onKeep: (config: RemoteConfig) => string | null
  }) => {
    const [refusal, setRefusal] = useState<string | null>(null)
    return (
      <div>
        <button type="button" onClick={() => setRefusal(onKeep(CHANGED))}>
          keep-changed
        </button>
        <button type="button" onClick={() => setRefusal(onKeep(STORED))}>
          keep-stored
        </button>
        <span data-testid="kept">{kept?.layoutTemplateId ?? 'none'}</span>
        <span data-testid="refusal">{refusal ?? 'accepted'}</span>
      </div>
    )
  },
}))

import { CustomizeDraftProvider } from '../../customize-draft'
import { RemoteEditor } from '../ConfigCustomizeList'
import { ConfigDraftProvider } from '../config-draft'

const TV: DeviceInfo = {
  id: 5,
  name: 'TV',
  stableId: 'tv',
  addonId: 'test',
  type: DeviceType.MediaPlayer,
  location: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
  integrationId: 'int_test',
}

function renderEditor(withDraft: boolean): void {
  const editor = <RemoteEditor device={TV} onClose={vi.fn()} />
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        {withDraft ? (
          <CustomizeDraftProvider order={['config-remote', 'config-fan-presets']}>
            <ConfigDraftProvider>{editor}</ConfigDraftProvider>
          </CustomizeDraftProvider>
        ) : (
          editor
        )}
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => setConfig.mockClear())

describe('RemoteEditor', () => {
  it('Keep with a change holds it in the tab draft, shows it as kept, and writes only on Save', async () => {
    renderEditor(true)
    fireEvent.click(screen.getByText('keep-changed'))
    expect(screen.getByTestId('refusal').textContent).toBe('accepted')
    expect(screen.getByTestId('kept').textContent).toBe('tpl-changed')
    expect(setConfig).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /^save/i }))
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    expect(setConfig.mock.calls[0]?.[0]).toEqual({ deviceId: 5, config: CHANGED })
  })

  it('Keep without a change leaves the tab clean', async () => {
    renderEditor(true)
    fireEvent.click(screen.getByText('keep-stored'))
    expect(screen.getByTestId('refusal').textContent).toBe('accepted')
    expect(screen.getByTestId('kept').textContent).toBe('none')
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull()
  })

  it('with no draft to keep it in, Keep is refused with a message instead of dropped', () => {
    renderEditor(false)
    fireEvent.click(screen.getByText('keep-changed'))
    expect(screen.getByTestId('refusal').textContent).toMatch(/nothing was kept/i)
    expect(setConfig).not.toHaveBeenCalled()
  })
})
