import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const sendCommand = vi.fn(async () => ({ status: 'sent' as const, sends: 1 }))
let presence: 'pending' | 'present' | 'absent' | 'unknown' = 'present'
let commands: readonly { role: string; custom: boolean }[] = []
let sources: readonly unknown[] = []
const selectSource = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
  status: 'sent' as const,
  sends: 1,
}))

const TEMPLATE = {
  id: 'tpl-tv',
  kind: 'remote',
  name: 'Television',
  payload: {
    columns: 2,
    rows: 2,
    buttons: [
      { id: 'a', row: 0, col: 0, rowSpan: 1, colSpan: 1, role: 'power' },
      { id: 'b', row: 0, col: 1, rowSpan: 1, colSpan: 1, role: 'mute' },
      { id: 'w', row: 1, col: 0, rowSpan: 1, colSpan: 2, role: 'source_select' },
    ],
  },
}

vi.mock('../../../../../ui-library/src/generated/system-hooks', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../../ui-library/src/generated/system-hooks')>()
  return {
    ...actual,
    useRemoteSendMediaCommand: () => ({ mutateAsync: selectSource, isPending: false }),
  }
})

vi.mock('@camstack/ui-library', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/ui-library')>()
  return {
    ...actual,
    useCapabilityPresence: () => presence,
    useRemoteGetConfig: () => ({
      data: { layoutTemplateId: 'tpl-tv' },
      status: 'success',
      refetch: vi.fn(),
    }),
    useRemoteListCommands: () => ({
      data: { layoutTemplateId: 'tpl-tv', commands, sources },
    }),
    useRemoteSendCommand: () => ({ mutateAsync: sendCommand }),
    useRemoteSendMediaCommand: () => ({ mutateAsync: selectSource, isPending: false }),
    useRemoteGetAssumedStatus: () => ({ data: { source: 'Rai 1' } }),
    useTemplateList: () => ({ data: [TEMPLATE] }),
  }
})

import { RemoteHeroButton } from '../RemoteHeroButton'

function renderButton(): void {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <RemoteHeroButton deviceId={7} deviceName="Living room TV" />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sendCommand.mockClear()
  selectSource.mockClear()
  sources = []
  presence = 'present'
  commands = [{ role: 'power', custom: false }]
})

describe('RemoteHeroButton', () => {
  it('draws nothing until the remote capability is known present', () => {
    presence = 'pending'
    renderButton()
    expect(screen.queryByTestId('hero-remote')).toBeNull()
    presence = 'absent'
    renderButton()
    expect(screen.queryByTestId('hero-remote')).toBeNull()
  })

  it('draws nothing when the device has no saved command', () => {
    commands = []
    renderButton()
    expect(screen.queryByTestId('hero-remote')).toBeNull()
  })

  it('opens the remote and a press sends the button role once; an unbound key sends nothing', async () => {
    renderButton()
    // The layout link belongs on the customization page, not on the card.
    expect(screen.queryByTestId('hero-edit-template')).toBeNull()
    fireEvent.click(screen.getByTestId('hero-remote'))
    fireEvent.click(screen.getByTestId('remote-grid-button-b'))
    expect(sendCommand).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('remote-grid-button-a'))
    await waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(1))
    expect(sendCommand).toHaveBeenCalledWith({ deviceId: 7, role: 'power', repeat: 1 })
    expect(screen.queryByTestId('hero-remote-edit-template')).toBeNull()
  })

  it('draws no source key when the remote declares no source, never a dead button', () => {
    renderButton()
    fireEvent.click(screen.getByTestId('hero-remote'))
    expect(screen.queryByTestId('remote-grid-button-w')).toBeNull()
  })

  describe('source_select', () => {
    beforeEach(() => {
      sources = [
        { id: 'rai-1', name: 'Rai 1', kind: 'digits', number: '1' },
        { id: 'hdmi', name: 'HDMI 2', kind: 'sequence', steps: ['input', 'ok'] },
      ]
    })

    it('shows the assumed source and picks a declared one through selectSource', async () => {
      renderButton()
      fireEvent.click(screen.getByTestId('hero-remote'))
      const key = screen.getByTestId('remote-grid-button-w')
      expect(key.textContent).toContain('Rai 1')
      fireEvent.click(key)
      expect(screen.getByText('Channels')).toBeTruthy()
      expect(screen.getByText('Inputs')).toBeTruthy()
      fireEvent.click(screen.getByTestId('source-pick-hdmi'))
      await waitFor(() => expect(selectSource).toHaveBeenCalledTimes(1))
      expect(selectSource).toHaveBeenCalledWith({
        deviceId: 7,
        command: 'selectSource',
        source: 'HDMI 2',
        repeat: 1,
      })
      expect(sendCommand).not.toHaveBeenCalled()
    })

    it('shows the reason of a refusal and keeps the picker open', async () => {
      selectSource.mockResolvedValueOnce({
        status: 'refused',
        reason: 'unknown-source',
      })
      renderButton()
      fireEvent.click(screen.getByTestId('hero-remote'))
      fireEvent.click(screen.getByTestId('remote-grid-button-w'))
      fireEvent.click(screen.getByTestId('source-pick-rai-1'))
      const failure = await screen.findByTestId('source-picker-failure')
      expect(failure.textContent).toContain('No declared source has that name')
      expect(screen.getByTestId('source-picker')).toBeTruthy()
    })
  })
})
