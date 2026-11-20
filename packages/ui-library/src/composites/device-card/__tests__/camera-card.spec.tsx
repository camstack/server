// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const slices = vi.hoisted(() => ({
  battery: undefined as unknown,
  lowPowerSleep: undefined as unknown,
  motion: undefined as unknown,
  seriesCount: 0,
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    ...(slices.battery === undefined ? {} : { battery: {} }),
    ...(slices.lowPowerSleep === undefined ? {} : { lowPowerSleep: {} }),
    ...(slices.motion === undefined ? {} : { motion: {} }),
    state: {
      battery: slices.battery,
      lowPowerSleep: slices.lowPowerSleep,
      motion: slices.motion,
    },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../connected/use-card-common', () => ({
  useCardCommon: () => ({
    common: {
      name: 'Porta retro',
      integration: null,
      online: true,
      readOnly: false,
      history: null,
    },
  }),
}))
vi.mock('../../device-history/use-device-history', () => ({
  useDeviceSeriesList: () => ({
    presence: 'present',
    list: { status: 'ok', data: new Array(slices.seriesCount).fill({}) },
  }),
}))
vi.mock('../../device-history/DeviceHistoryView', () => ({
  DeviceHistoryView: () => <div data-testid="history-view" />,
}))

import { ConnectedCameraCard } from '../connected/ConnectedCameraCard'

const NOW = Date.now()

function draw(): void {
  render(<ConnectedCameraCard deviceId={7} scene={<div data-testid="player" />} />)
}

afterEach(() => {
  cleanup()
  slices.battery = undefined
  slices.lowPowerSleep = undefined
  slices.motion = undefined
  slices.seriesCount = 0
})

describe('ConnectedCameraCard', () => {
  it('embeds the host scene and draws no chip and no history for a bare camera', () => {
    draw()
    expect(screen.getByTestId('player')).toBeTruthy()
    expect(screen.queryByTestId('dc-camera-chips')).toBeNull()
    expect(screen.queryByTestId('dc-camera-open-history')).toBeNull()
  })

  it('draws a chip only for each generic cap the camera answers', () => {
    slices.battery = { level: 82, charging: 'none', sleeping: false }
    slices.motion = { detected: false, lastDetectedAt: NOW - 120_000 }
    draw()
    expect(screen.getByTestId('dc-camera-chip-battery').textContent).toContain('82%')
    expect(screen.getByTestId('dc-camera-chip-power').textContent).toContain('Battery')
    expect(screen.getByTestId('dc-camera-chip-sleep').textContent).toContain('Awake')
    expect(screen.getByTestId('dc-camera-chip-motion').textContent).toContain('2 min')
  })

  it('a wired camera without a battery shows no battery or power chip', () => {
    slices.lowPowerSleep = { sleeping: true }
    draw()
    expect(screen.queryByTestId('dc-camera-chip-battery')).toBeNull()
    expect(screen.queryByTestId('dc-camera-chip-power')).toBeNull()
    expect(screen.getByTestId('dc-camera-chip-sleep').textContent).toContain('Asleep')
  })

  it('offers the history only once the device recorded a series, and opens it in place of the scene', () => {
    draw()
    expect(screen.queryByTestId('dc-camera-open-history')).toBeNull()
    cleanup()
    slices.seriesCount = 2
    draw()
    expect(screen.queryByTestId('history-view')).toBeNull()
    fireEvent.click(screen.getByTestId('dc-camera-open-history'))
    expect(screen.getByTestId('history-view')).toBeTruthy()
    expect(screen.getByTestId('dc-history')).toBeTruthy()
    expect(screen.queryByTestId('player')).toBeNull()
    fireEvent.click(screen.getByTestId('dc-back'))
    expect(screen.getByTestId('player')).toBeTruthy()
  })
})
