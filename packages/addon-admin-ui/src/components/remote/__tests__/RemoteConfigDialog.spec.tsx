import { selectOption } from '@camstack/ui-library/testing'
import {
  type DeviceInfo,
  DeviceType,
  EMPTY_REMOTE_CONFIG,
  type RemoteConfig,
} from '@camstack/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const TV = 901
const BOARD = 902

const onKeep = vi.fn((_config: RemoteConfig): string | null => null)
const updateTemplate = vi.fn(async (_input: { id: string; name: string; payload: unknown }) => ({
  status: 'saved' as const,
}))
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
      onClick={() =>
        onChange({ kind: 'command', target: { kind: 'devices', ids: [TV] }, actionId: 'switch.on' })
      }
    >
      pick
    </button>
  ),
}))

import { RemoteConfigDialog } from '../RemoteConfigDialog'

const DEVICE: DeviceInfo = {
  id: TV,
  name: 'Living room TV',
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
        <RemoteConfigDialog device={device} open onKeep={onKeep} onClose={vi.fn()} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  onKeep.mockClear()
  updateTemplate.mockClear()
  sendCommand.mockClear()
  storedConfig = { ...EMPTY_REMOTE_CONFIG, layoutTemplateId: 'tpl-tv' }
  savedCommands = []
})

describe('RemoteConfigDialog', () => {
  it('keeps a binding made with the command picker in the draft, writing nothing', async () => {
    renderDialog()
    pick('a')
    fireEvent.click(screen.getByTestId('bind-power'))
    fireEvent.click(screen.getByTestId('pick-command'))
    fireEvent.click(screen.getByTestId('remote-save'))
    expect(onKeep).toHaveBeenCalledTimes(1)
    const sent = onKeep.mock.calls[0]?.[0]
    expect(sent?.layoutTemplateId).toBe('tpl-tv')
    expect(sent?.bindings['power']?.action).toEqual({
      kind: 'cap',
      deviceId: TV,
      cap: 'switch',
      method: 'setState',
      args: { on: true },
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
    expect(onKeep).toHaveBeenCalledTimes(1)
    const config = onKeep.mock.calls[0]?.[0]
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
      expect(onKeep).not.toHaveBeenCalled()
      pick('b')
      expect(screen.getByTestId('summary-mute').textContent).not.toMatch(/^Not bound/)
    })

    it('Cancel discards the layout edits and goes back, not closing the modal', () => {
      const onClose = vi.fn()
      render(
        <MemoryRouter>
          <QueryClientProvider client={new QueryClient()}>
            <RemoteConfigDialog device={DEVICE} open onKeep={onKeep} onClose={onClose} />
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

  it('shows the draft configuration instead of the stored one, and Test follows what is stored', async () => {
    storedConfig = {
      ...storedConfig,
      bindings: {
        power: { action: { kind: 'cap', deviceId: TV, cap: 'switch', method: 'turnOn' } },
      },
    }
    savedCommands = ['power']
    const kept: RemoteConfig = {
      ...storedConfig,
      bindings: {
        power: { action: { kind: 'cap', deviceId: TV, cap: 'switch', method: 'turnOff' } },
      },
    }
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <RemoteConfigDialog device={DEVICE} open kept={kept} onKeep={onKeep} onClose={vi.fn()} />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    pick('a')
    // The draft binds power differently from what is stored: the stored command is not the one tested.
    expect((screen.getByTestId('test-power') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Test stays on for a binding the draft leaves as stored', () => {
    storedConfig = {
      ...storedConfig,
      bindings: {
        power: { action: { kind: 'cap', deviceId: TV, cap: 'switch', method: 'turnOn' } },
      },
    }
    savedCommands = ['power']
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <RemoteConfigDialog
            device={DEVICE}
            open
            kept={storedConfig}
            onKeep={onKeep}
            onClose={vi.fn()}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    pick('a')
    expect((screen.getByTestId('test-power') as HTMLButtonElement).disabled).toBe(false)
  })

  it('a refused Keep leaves the modal open and shows why', () => {
    onKeep.mockReturnValueOnce('Nothing was kept.')
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <RemoteConfigDialog device={DEVICE} open onKeep={onKeep} onClose={onClose} />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId('remote-save'))
    expect(screen.getByTestId('remote-keep-refusal').textContent).toBe('Nothing was kept.')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('an accepted Keep closes the modal', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <RemoteConfigDialog device={DEVICE} open onKeep={onKeep} onClose={onClose} />
        </QueryClientProvider>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId('remote-save'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
