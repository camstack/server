import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../i18n'

const sendCommand = vi.fn(async () => ({ status: 'sent' as const, sends: 1 }))
let presence: 'pending' | 'present' | 'absent' | 'unknown' = 'present'
let commands: readonly { role: string; custom: boolean }[] = []

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
    useCapabilityPresence: () => presence,
    useRemoteGetConfig: () => ({
      data: { layoutTemplateId: 'tpl-tv' },
      status: 'success',
      refetch: vi.fn(),
    }),
    useRemoteListCommands: () => ({
      data: { layoutTemplateId: 'tpl-tv', power: { mode: 'toggle' }, commands },
    }),
    useRemoteSendCommand: () => ({ mutateAsync: sendCommand }),
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
})
