// @vitest-environment jsdom
/**
 * The card's remote view draws the shared layout grid (label + tone), not the
 * raw key list. A device with no saved layout gets a built-in preset, and a
 * raw code stored on the command never becomes the key's name.
 */
import type { RemoteLayoutPayload } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { layoutForRemoteCommands } from '../../remote'
import { mockupCommon } from '../__fixtures__/common'
import { DeviceCard } from '../shell/DeviceCard'
import type { CardRemotePanel } from '../shell/model'

afterEach(cleanup)

const LAYOUT: RemoteLayoutPayload = {
  columns: 1,
  rows: 1,
  buttons: [
    {
      id: 'pwr',
      role: 'power',
      label: 'Power',
      tone: 'accent',
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
    },
  ],
}

function panel(layout: RemoteLayoutPayload, roles: readonly string[]): CardRemotePanel {
  return {
    layout,
    boundRoles: roles,
    sources: [],
    currentSource: '',
    deviceId: 7,
  }
}

function renderRemote(remotePanel: CardRemotePanel, label: string): void {
  render(
    <DeviceCard
      kind="media"
      initialView="remote"
      common={{
        ...mockupCommon({
          name: 'Living room',
          integration: 'TV',
          watts: 40,
          supplyName: 'Plug',
          consumables: [],
          remote: [{ id: 'power', label }],
        }),
        remotePanel,
      }}
      state={{ label: 'On', since: null, tone: 'success' }}
      scene={{ image: null }}
      actions={{ onRemoteKey: vi.fn() }}
    />,
  )
}

describe('device card remote view', () => {
  it('draws a layout key with its label and tone, and a press sends the role', () => {
    const onRemoteKey = vi.fn()
    render(
      <DeviceCard
        kind="media"
        initialView="remote"
        common={{
          ...mockupCommon({
            name: 'Living room',
            integration: 'TV',
            watts: 40,
            supplyName: 'Plug',
            consumables: [],
            remote: [{ id: 'power', label: '0xE0E040BF' }],
          }),
          remotePanel: panel(LAYOUT, ['power']),
        }}
        state={{ label: 'On', since: null, tone: 'success' }}
        scene={{ image: null }}
        actions={{ onRemoteKey }}
      />,
    )
    const key = screen.getByTestId('remote-grid-button-pwr')
    expect(key.textContent).toContain('Power')
    expect(key.getAttribute('data-tone')).toBe('accent')
    expect(key.className).toContain('bg-primary')
    expect(screen.queryByText('0xE0E040BF')).toBeNull()
    fireEvent.click(key)
    expect(onRemoteKey).toHaveBeenCalledWith('power')
  })

  it('with no saved layout, draws the preset and the human name, never the raw role', () => {
    const layout = layoutForRemoteCommands(null, ['volume_up'])
    if (layout === null) throw new Error('no preset')
    renderRemote(panel(layout, ['volume_up']), '0xE0E0E01F')
    expect(screen.getByRole('button', { name: 'Volume up' })).toBeTruthy()
    expect(screen.queryByText('0xE0E0E01F')).toBeNull()
    expect(screen.queryByText('volume_up')).toBeNull()
  })
})
