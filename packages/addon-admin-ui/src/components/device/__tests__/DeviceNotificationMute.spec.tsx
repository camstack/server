/**
 * The per-device notification mute — the WRITE side.
 *
 * The round-trip this pins is the whole point of
 * [D113](../../../../../../docs/decisions/adr-0113.md) phase 3: the control
 * reads the notification centre's OWN store and writes back to it. If the
 * deprecated `pipelineOrchestrator.setCameraSwitch` shim were the write path,
 * phase 4 would delete this surface's authority out from under it.
 *
 *  - **The real authority.** `notificationRules.setDeviceMuted`, with the
 *    inverted polarity the store speaks (`muted`), and NOTHING else.
 *  - **STATE SURVIVAL + no write on mount.** A device already muted (the
 *    deprecated group wrote this same store) renders MUTED on first render and
 *    issues no mutation.
 *  - **Unknown is not a control.** A failed read draws unknown and refuses the
 *    click.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setDeviceMuted = vi.fn()
/** The deprecated shim. Present in the mock ONLY so calling it can be caught. */
const setCameraSwitch = vi.fn()

let mutesData: unknown = { mutedDeviceIds: [] }

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...actual,
    useNotificationRulesListDeviceMutes: () => ({
      data: mutesData,
      isLoading: false,
      error: null,
    }),
    useNotificationRulesSetDeviceMuted: () => ({
      mutate: setDeviceMuted,
      isPending: false,
    }),
    usePipelineOrchestratorSetCameraSwitch: () => ({
      mutate: setCameraSwitch,
      isPending: false,
    }),
  }
})

import { DeviceNotificationMute } from '../DeviceNotificationMute'

function renderPanel(deviceId = 102, isCamera = true): ReactElement | void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DeviceNotificationMute deviceId={deviceId} isCamera={isCamera} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setDeviceMuted.mockReset()
  setCameraSwitch.mockReset()
  mutesData = { mutedDeviceIds: [] }
})

afterEach(() => {
  cleanup()
})

describe('DeviceNotificationMute', () => {
  it('a camera’s copy names its tracks and recordings', () => {
    renderPanel(102, true)
    expect(screen.getByText(/^This camera never notifies/)).toBeTruthy()
  })

  it('a NON-camera device (the dishwasher) is a device, with no camera-only media', () => {
    renderPanel(501, false)
    expect(
      screen.getByText('This device never notifies — no rule, no target, no alarm.'),
    ).toBeTruthy()
    expect(screen.queryByText(/camera|tracks|recordings/i)).toBeNull()
    expect(screen.getByRole('switch').getAttribute('title')).not.toMatch(/camera/i)
  })

  it('muting writes the REAL authority — setDeviceMuted, never the deprecated shim', () => {
    renderPanel(102)
    fireEvent.click(screen.getByRole('switch'))
    expect(setDeviceMuted).toHaveBeenCalledTimes(1)
    expect(setDeviceMuted).toHaveBeenCalledWith({ deviceId: 102, muted: true })
    expect(setCameraSwitch).not.toHaveBeenCalled()
  })

  it('un-muting writes muted: false for the same device', () => {
    mutesData = { mutedDeviceIds: [102] }
    renderPanel(102)
    fireEvent.click(screen.getByRole('switch'))
    expect(setDeviceMuted).toHaveBeenCalledWith({ deviceId: 102, muted: false })
  })

  it('STATE SURVIVAL: an already-muted device renders MUTED and writes NOTHING on mount', () => {
    mutesData = { mutedDeviceIds: [101, 102] }
    renderPanel(102)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Muted')).toBeTruthy()
    expect(setDeviceMuted).not.toHaveBeenCalled()
  })

  it('a device absent from the list renders as notifying', () => {
    mutesData = { mutedDeviceIds: [101] }
    renderPanel(102)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Notifying')).toBeTruthy()
  })

  it('an unreadable answer is UNKNOWN — the control is disabled and writes nothing', () => {
    mutesData = undefined
    renderPanel(102)
    const control = screen.getByRole('switch')
    expect(control).toHaveProperty('disabled', true)
    expect(screen.getByText('Unknown')).toBeTruthy()
    fireEvent.click(control)
    expect(setDeviceMuted).not.toHaveBeenCalled()
  })

  it('reports the mute as off (the badge), never as a broken notification centre', () => {
    mutesData = { mutedDeviceIds: [102] }
    renderPanel(102)
    expect(screen.getByText('muted')).toBeTruthy()
  })
})
