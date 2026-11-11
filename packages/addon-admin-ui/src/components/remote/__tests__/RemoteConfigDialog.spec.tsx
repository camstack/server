import { selectOption } from '@camstack/ui-library/testing'
import {
  composedDeviceStableId,
  CompositionSchema,
  CoreBlockSchema,
  type DeviceInfo,
  EMPTY_REMOTE_CONFIG,
  mediaPlayerExtensionCommands,
  type RemoteConfig,
} from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const TV = 901
const BOARD = 902

const setConfig = vi.fn(async (_input: { deviceId: number; config: RemoteConfig }) => ({
  status: 'saved' as const,
}))
const updateTemplate = vi.fn(async (_input: { id: string; name: string; payload: unknown }) => ({
  status: 'saved' as const,
}))
const updateBlock = vi.fn(async (_input: unknown) => ({}))
let blockView: unknown = null
const sendCommand = vi.fn(async () => ({ status: 'sent' as const, sends: 1 }))
let storedConfig: RemoteConfig = EMPTY_REMOTE_CONFIG
let savedCommands: readonly string[] = []

const TEMPLATE = {
  id: 'tpl-tv',
  kind: 'remote',
  name: 'Television',
  payload: {
    columns: 2,
    rows: 1,
    buttons: [
      { id: 'a', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'power' },
      { id: 'b', row: 0, col: 1, rowSpan: 1, colSpan: 1, role: 'mute' },
    ],
  },
}

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useRemoteGetConfig: () => ({
      data: storedConfig,
      status: 'success',
      refetch: vi.fn(),
    }),
    useRemoteListCommands: () => ({
      data: {
        layoutTemplateId: null,
        commands: savedCommands.map((role) => ({ role, custom: false })),
      },
    }),
    useCoreBlocksGetComposition: () => ({
      status: 'success',
      data: { state: 'loaded', view: blockView },
    }),
    useCoreBlocksUpdateComposition: () => ({ mutateAsync: updateBlock, isPending: false }),
    useRemoteSetConfig: () => ({ mutateAsync: setConfig, isPending: false }),
    useRemoteSendCommand: () => ({ mutateAsync: sendCommand }),
    useTemplateList: () => ({ data: [TEMPLATE] }),
    useTemplateUpdate: () => ({ mutateAsync: updateTemplate, isPending: false }),
    useTemplateCreate: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeviceManagerListDeviceIdsByCaps: () => ({ data: [BOARD] }),
  }
})

vi.mock('../../../pages/build/automation/automation-data', () => ({
  useAutomationDevices: () => [
    { id: TV, name: 'Living room TV', stableId: 'tv', type: 'mediaPlayer' },
    {
      id: BOARD,
      name: 'send_raw_command',
      stableId: 'ir',
      type: 'switch',
      parentName: 'Kitchen board',
    },
  ],
}))

// The command picker has its own specs; here it only hands back a finished action.
vi.mock('../../../pages/build/flow/CommandStep', () => ({
  CommandStep: ({ onChange }: { onChange: (step: unknown) => void }) => (
    <button
      type="button"
      data-testid="pick-command"
      onClick={() => onChange({ kind: 'cap', deviceId: TV, cap: 'switch', method: 'turnOn' })}
    >
      pick
    </button>
  ),
}))

import { RemoteConfigDialog } from '../RemoteConfigDialog'

const DEVICE = {
  id: TV,
  name: 'Living room TV',
  stableId: 'tv',
  type: 'media-player',
} as unknown as DeviceInfo

const TRAIN = '[9000,-4500,560,-560,560,-1690]'
const TRAIN_OFF = '[9000,-4500,560,-1690,560,-560]'
const SMARTIR = JSON.stringify({
  manufacturer: 'Acme',
  supportedModels: ['TV-1'],
  supportedController: 'Broadlink',
  commandsEncoding: 'Raw',
  delay: 0.4,
  commands: { on: TRAIN, off: TRAIN_OFF, volumeUp: TRAIN },
})

/** Select a button of the preview grid (a = power, b = mute in the test template). */
const pick = (id: string): void => {
  fireEvent.click(screen.getByTestId(`remote-grid-button-${id}`))
}

function renderDialog(device: DeviceInfo = DEVICE): void {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <RemoteConfigDialog device={device} open onClose={vi.fn()} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  setConfig.mockClear()
  updateBlock.mockClear()
  updateTemplate.mockClear()
  blockView = null
  sendCommand.mockClear()
  storedConfig = { ...EMPTY_REMOTE_CONFIG, layoutTemplateId: 'tpl-tv' }
  savedCommands = []
})

describe('RemoteConfigDialog', () => {
  it('saves a binding made with the command picker', async () => {
    renderDialog()
    pick('a')
    fireEvent.click(screen.getByTestId('bind-power'))
    fireEvent.click(screen.getByTestId('pick-command'))
    fireEvent.click(screen.getByTestId('remote-save'))
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    const sent = setConfig.mock.calls[0]?.[0]
    expect(sent?.deviceId).toBe(TV)
    expect(sent?.config.layoutTemplateId).toBe('tpl-tv')
    expect(sent?.config.bindings['power']?.action).toEqual({
      kind: 'cap',
      deviceId: TV,
      cap: 'switch',
      method: 'turnOn',
    })
  })

  it('blocks Save while a binding is unfinished', () => {
    renderDialog()
    pick('b')
    fireEvent.click(screen.getByTestId('bind-mute'))
    expect(screen.getByTestId('remote-incomplete')).toBeTruthy()
    expect((screen.getByTestId('remote-save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses a SmartIR import until a default transmitter is picked', () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('smartir-text'), {
      target: { value: SMARTIR },
    })
    fireEvent.click(screen.getByTestId('smartir-read'))
    expect(screen.getByTestId('smartir-refused').textContent).toMatch(/default transmitter/i)
  })

  it('imports a SmartIR file through the default transmitter and saves only the bindings', async () => {
    renderDialog()
    selectOption(screen.getByTestId('remote-transmitter'), String(BOARD))
    fireEvent.change(screen.getByTestId('smartir-text'), {
      target: { value: SMARTIR },
    })
    fireEvent.click(screen.getByTestId('smartir-read'))
    expect(screen.getByTestId('smartir-summary').textContent).toMatch(/fills 3 commands/)
    fireEvent.click(screen.getByTestId('smartir-apply'))
    // volume_up is not on the test layout: it is reached through the off-layout picker.
    selectOption(screen.getByTestId('binding-other'), 'volume_up')
    expect(screen.getByTestId('transmitter-volume_up')).toBeTruthy()
    fireEvent.click(screen.getByTestId('remote-save'))
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    const config = setConfig.mock.calls[0]?.[0].config
    expect(config?.defaultTransmitterId).toBe(BOARD)
    expect(Object.keys(config?.bindings ?? {}).toSorted()).toEqual(
      ['power_off', 'power_on', 'volume_up'].toSorted(),
    )
    for (const binding of Object.values(config?.bindings ?? {})) {
      expect(binding.action).toMatchObject({
        cap: 'ir-transmitter',
        method: 'send',
        deviceId: BOARD,
      })
    }
    // The file itself is nowhere in what is sent.
    expect(JSON.stringify(config)).not.toContain('Acme')
  })

  it('offers Test only for a role the device has saved, and shows the outcome', async () => {
    storedConfig = {
      ...storedConfig,
      bindings: {
        power: {
          action: {
            kind: 'cap',
            deviceId: TV,
            cap: 'switch',
            method: 'turnOn',
          },
        },
        mute: {
          action: {
            kind: 'cap',
            deviceId: TV,
            cap: 'switch',
            method: 'turnOff',
          },
        },
      },
    }
    savedCommands = ['power']
    renderDialog()
    pick('b')
    expect((screen.getByTestId('test-mute') as HTMLButtonElement).disabled).toBe(true)
    pick('a')
    fireEvent.click(screen.getByTestId('test-power'))
    await waitFor(() => expect(screen.getByTestId('result-power').textContent).toMatch(/Sent/))
    expect(sendCommand).toHaveBeenCalledWith({
      deviceId: TV,
      role: 'power',
      repeat: 1,
    })
  })

  it('names an infrared target by device and parent board, with a summary of the code', () => {
    storedConfig = {
      ...storedConfig,
      bindings: {
        power: {
          action: {
            kind: 'cap',
            deviceId: BOARD,
            cap: 'ir-transmitter',
            method: 'send',
            args: { timings: [9000, -4500, 560, -560, 560, -1690] },
          },
        },
      },
    }
    renderDialog()
    pick('a')
    const select = screen.getByTestId('transmitter-power') as HTMLButtonElement
    expect(select.textContent).toContain('send_raw_command · Kitchen board')
    expect(screen.getByTestId('summary-power').textContent).toBe(
      'Sends an infrared code of 6 pulses through send_raw_command · Kitchen board.',
    )
    // The code itself is on screen the moment the button is selected (planning#464).
    expect(screen.getByTestId('code-power').textContent).toBe('9000, -4500, 560, -560, 560, -1690')
    expect(screen.getByTestId('binding-panel').textContent).toContain(
      'Raw timings in µs · 6 pulses',
    )
  })

  it('a capability binding shows the call it makes as its code', () => {
    storedConfig = {
      ...storedConfig,
      bindings: {
        power: {
          action: { kind: 'cap', deviceId: TV, cap: 'switch', method: 'turnOn' },
        },
      },
    }
    renderDialog()
    pick('a')
    expect(screen.getByTestId('code-power').textContent).toBe('switch.turnOn()')
  })

  it('selecting a button shows its binding and sends nothing until Test is clicked', async () => {
    storedConfig = {
      ...storedConfig,
      bindings: {
        power: {
          action: {
            kind: 'cap',
            deviceId: TV,
            cap: 'switch',
            method: 'turnOn',
          },
        },
      },
    }
    savedCommands = ['power']
    renderDialog()
    expect(screen.queryByTestId('binding-panel')).toBeNull()
    fireEvent.click(screen.getByTestId('remote-grid-button-a'))
    const panel = screen.getByTestId('binding-panel')
    expect(panel.textContent).toContain('Calls switch.turnOn on Living room TV.')
    expect(sendCommand).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('test-power'))
    await waitFor(() => expect(screen.getByTestId('result-power').textContent).toMatch(/Sent/))
    expect(sendCommand).toHaveBeenCalledTimes(1)
    expect(sendCommand).toHaveBeenCalledWith({
      deviceId: TV,
      role: 'power',
      repeat: 1,
    })
  })

  it("renders only the selected button's action, never the whole list", () => {
    storedConfig = {
      ...storedConfig,
      bindings: {
        power: {
          action: {
            kind: 'cap',
            deviceId: TV,
            cap: 'switch',
            method: 'turnOn',
          },
        },
        mute: {
          action: {
            kind: 'cap',
            deviceId: TV,
            cap: 'switch',
            method: 'turnOff',
          },
        },
      },
    }
    renderDialog()
    expect(screen.queryByTestId('summary-power')).toBeNull()
    expect(screen.queryByTestId('summary-mute')).toBeNull()
    pick('a')
    expect(screen.getAllByTestId('binding-panel')).toHaveLength(1)
    expect(screen.getByTestId('summary-power')).toBeTruthy()
    expect(screen.queryByTestId('summary-mute')).toBeNull()
    pick('b')
    expect(screen.getAllByTestId('binding-panel')).toHaveLength(1)
    expect(screen.getByTestId('summary-mute').textContent).toContain('switch.turnOff')
    expect(screen.queryByTestId('summary-power')).toBeNull()
  })

  it('reads an unbound button as unbound', () => {
    renderDialog()
    pick('b')
    expect(screen.getByTestId('summary-mute').textContent).toMatch(/^Not bound/)
    expect(screen.getByTestId('bind-mute')).toBeTruthy()
    expect(screen.queryByTestId('test-mute')).toBeNull()
  })

  describe('the layout editor inside the same modal', () => {
    it('swaps the body for the template editor, titled with the template, and back returns to the bindings', () => {
      renderDialog()
      pick('b')
      fireEvent.click(screen.getByTestId('remote-edit-layout'))
      expect(screen.getByText('Layout: Television')).toBeTruthy()
      expect(screen.queryByTestId('remote-preview')).toBeNull()
      expect(screen.getByTestId('template-back').textContent).toContain('Living room TV')
      // One dialog only: nothing stacked on top.
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      fireEvent.click(screen.getByTestId('template-back'))
      expect(updateTemplate).not.toHaveBeenCalled()
      expect(screen.getByTestId('remote-preview')).toBeTruthy()
    })

    it('Save writes the template and returns to the bindings, keeping the unsaved binding edits', async () => {
      renderDialog()
      pick('b')
      fireEvent.click(screen.getByTestId('bind-mute'))
      fireEvent.click(screen.getByTestId('pick-command'))
      fireEvent.click(screen.getByTestId('remote-edit-layout'))
      fireEvent.click(screen.getByTestId('template-save'))
      await waitFor(() => expect(screen.getByTestId('remote-preview')).toBeTruthy())
      expect(updateTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tpl-tv', name: 'Television' }),
      )
      expect(setConfig).not.toHaveBeenCalled()
      pick('b')
      expect(screen.getByTestId('summary-mute').textContent).not.toMatch(/^Not bound/)
    })

    it('Cancel discards the layout edits and goes back, not closing the modal', () => {
      const onClose = vi.fn()
      render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <RemoteConfigDialog device={DEVICE} open onClose={onClose} />
          </QueryClientProvider>
        </MemoryRouter>,
      )
      fireEvent.click(screen.getByTestId('remote-edit-layout'))
      fireEvent.click(screen.getByText('Cancel'))
      expect(updateTemplate).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(screen.getByTestId('remote-preview')).toBeTruthy()
    })
  })

  describe('on a built (composed) media player', () => {
    const BLOCK_ID = 'blk-tv'
    const BUILT = {
      id: TV,
      name: 'Built TV',
      type: 'media-player',
      stableId: composedDeviceStableId(BLOCK_ID),
    } as unknown as DeviceInfo

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
        placement: 'hub',
        source: { kind: 'composition', composition },
        createdBy: 'u1',
        createdAt: 1,
        updatedAt: 7,
        status: 'stopped',
        lastChangedAt: 1,
      })
      return { block, state: null }
    }

    async function saveWithBinding(): Promise<void> {
      renderDialog(BUILT)
      pick('a')
      fireEvent.click(screen.getByTestId('bind-power'))
      fireEvent.click(screen.getByTestId('pick-command'))
      fireEvent.click(screen.getByTestId('remote-save'))
      await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    }

    it('gives a naked player the media-player commands, every one served by the remote', async () => {
      blockView = nakedView([])
      await saveWithBinding()
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

    it('leaves a player that already serves media-player commands alone', async () => {
      blockView = nakedView([
        {
          kind: 'fields',
          cap: 'media-player',
          fields: {},
          commands: mediaPlayerExtensionCommands(),
        },
      ])
      await saveWithBinding()
      expect(updateBlock).not.toHaveBeenCalled()
    })
  })

  it('never rewrites a block for a native device', async () => {
    renderDialog()
    pick('a')
    fireEvent.click(screen.getByTestId('bind-power'))
    fireEvent.click(screen.getByTestId('pick-command'))
    fireEvent.click(screen.getByTestId('remote-save'))
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1))
    expect(updateBlock).not.toHaveBeenCalled()
  })
})
