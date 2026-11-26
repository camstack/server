import {
  composedDeviceStableId,
  CompositionSchema,
  CoreBlockSchema,
  type DeviceInfo,
  DeviceType,
  EMPTY_REMOTE_CONFIG,
  type FanPreset,
  mediaPlayerExtensionCommands,
  type RemoteConfig,
} from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../../i18n'

const BLOCK_ID = 'blk-tv'
const setConfig = vi.fn(
  async (_input: {
    deviceId: number
    config: RemoteConfig
  }): Promise<{ status: 'saved' } | { status: 'refused'; detail: string }> => ({ status: 'saved' }),
)
const setPresets = vi.fn(
  async (_input: {
    deviceId: number
    presets: FanPreset[]
  }): Promise<{ status: 'saved' } | { status: 'refused'; detail: string }> => ({ status: 'saved' }),
)
const updateBlock = vi.fn(async (_input: unknown) => ({}))
const blockView = vi.hoisted((): { current: unknown } => ({ current: null }))

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        coreBlocks: {
          getComposition: {
            fetch: async () => ({ state: 'loaded', view: blockView.current }),
          },
        },
      }),
    },
    useRemoteSetConfig: () => ({ mutateAsync: setConfig }),
    useFanPresetsSetPresets: () => ({ mutateAsync: setPresets }),
    useCoreBlocksUpdateComposition: () => ({ mutateAsync: updateBlock }),
  }
})

import { CustomizeDraftProvider } from '../../customize-draft'
import { ConfigDraftProvider, useConfigDraft } from '../config-draft'

function deviceOf(id: number, name: string, stableId: string): DeviceInfo {
  return {
    id,
    name,
    stableId,
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
}

const native = deviceOf(5, 'TV', 'tv')
const built = deviceOf(6, 'Built TV', composedDeviceStableId(BLOCK_ID))

const CONFIG: RemoteConfig = { ...EMPTY_REMOTE_CONFIG, layoutTemplateId: 'tpl' }
const PRESETS: FanPreset[] = [{ id: 'p1', name: 'Night', state: { speed: 30 } }]

/** Two buttons that hand the draft an edit, and a probe that shows what it holds. */
function Probe({ device }: { device: DeviceInfo }) {
  const draft = useConfigDraft()
  return (
    <div>
      <button type="button" onClick={() => draft?.setRemote(device, CONFIG)}>
        keep-remote
      </button>
      <button type="button" onClick={() => draft?.setFanPresets(device, PRESETS)}>
        keep-presets
      </button>
      <span data-testid="held">{draft?.remote?.layoutTemplateId ?? 'none'}</span>
    </div>
  )
}

function renderDraft(device: DeviceInfo): void {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <CustomizeDraftProvider order={['config-remote', 'config-fan-presets']}>
          <ConfigDraftProvider>
            <Probe device={device} />
          </ConfigDraftProvider>
        </CustomizeDraftProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

function nakedView(features: readonly unknown[]) {
  const composition = CompositionSchema.parse({
    target: { kind: 'new', type: 'media-player' },
    features,
  })
  const block = CoreBlockSchema.parse({
    id: BLOCK_ID,
    name: 'Built TV',
    code: '',
    enabled: true,
    source: { kind: 'composition', composition },
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 7,
    status: 'stopped',
    lastChangedAt: 1,
  })
  return { block, state: null }
}

beforeEach(() => {
  setConfig.mockClear()
  setPresets.mockClear()
  updateBlock.mockClear()
  blockView.current = null
})

describe('ConfigDraftProvider', () => {
  it('writes nothing until Save, then writes the kept remote and presets', async () => {
    renderDraft(native)
    fireEvent.click(screen.getByText('keep-remote'))
    fireEvent.click(screen.getByText('keep-presets'))
    expect(setConfig).not.toHaveBeenCalled()
    expect(setPresets).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: /^save/i }))
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    expect(setConfig.mock.calls[0]?.[0]).toEqual({ deviceId: 5, config: CONFIG })
    await waitFor(() => expect(setPresets).toHaveBeenCalledTimes(1))
    expect(setPresets.mock.calls[0]?.[0]).toEqual({ deviceId: 5, presets: PRESETS })
    expect(updateBlock).not.toHaveBeenCalled()
  })

  it('Discard drops the draft without writing', async () => {
    renderDraft(native)
    fireEvent.click(screen.getByText('keep-remote'))
    expect(screen.getByTestId('held').textContent).toBe('tpl')
    fireEvent.click(await screen.findByRole('button', { name: /discard/i }))
    await waitFor(() => expect(screen.getByTestId('held').textContent).toBe('none'))
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('a refusal keeps the draft', async () => {
    setConfig.mockResolvedValueOnce({ status: 'refused', detail: 'no transmitter' })
    renderDraft(native)
    fireEvent.click(screen.getByText('keep-remote'))
    fireEvent.click(await screen.findByRole('button', { name: /^save/i }))
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/no transmitter/)).toBeTruthy()
    expect(screen.getByTestId('held').textContent).toBe('tpl')
  })

  it('gives a naked built player the media-player commands, with the block stamp', async () => {
    blockView.current = nakedView([])
    renderDraft(built)
    fireEvent.click(screen.getByText('keep-remote'))
    fireEvent.click(await screen.findByRole('button', { name: /^save/i }))
    await waitFor(() => expect(updateBlock).toHaveBeenCalledTimes(1))
    const sent = updateBlock.mock.calls[0]?.[0] as {
      blockId: string
      expectedUpdatedAt: number
      block: { composition: { features: { cap: string; commands?: unknown }[] } }
    }
    expect(sent.blockId).toBe(BLOCK_ID)
    expect(sent.expectedUpdatedAt).toBe(7)
    const feature = sent.block.composition.features.find((f) => f.cap === 'media-player')
    expect(feature?.commands).toEqual(mediaPlayerExtensionCommands())
  })

  it('leaves a player that already serves the commands alone', async () => {
    blockView.current = nakedView([
      { kind: 'fields', cap: 'media-player', fields: {}, commands: mediaPlayerExtensionCommands() },
    ])
    renderDraft(built)
    fireEvent.click(screen.getByText('keep-remote'))
    fireEvent.click(await screen.findByRole('button', { name: /^save/i }))
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    expect(updateBlock).not.toHaveBeenCalled()
  })
})
