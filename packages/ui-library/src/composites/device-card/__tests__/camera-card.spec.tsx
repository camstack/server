// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const slices = vi.hoisted(() => ({
  battery: undefined as unknown,
  lowPowerSleep: undefined as unknown,
  motion: undefined as unknown,
  seriesCount: 0,
  cardBattery: null as null | { level: number },
}))

vi.mock('../../../contexts/system-context', () => ({ useTrpcClient: () => ({}) }))
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
      notice: null,
      offlineLabel: null,
      readOnly: false,
      power: null,
      battery: slices.cardBattery,
      supply: null,
      consumables: null,
      deviceId: 7,
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
vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'absent',
}))
vi.mock('../../device-history/DeviceHistoryView', () => ({
  DeviceHistoryView: () => <div data-testid="history-view" />,
}))

import { ConnectedCameraCard } from '../connected/ConnectedCameraCard'
import { DeviceCardFrameProvider } from '../shell/DeviceCard'

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
  slices.cardBattery = null
})

describe('ConnectedCameraCard', () => {
  it('is the base device card with the host scene as its full-width scene', () => {
    draw()
    const card = screen.getByTestId('device-card')
    expect(card.getAttribute('data-card-kind')).toBe('camera')
    const scene = screen.getByTestId('dc-scene')
    expect(scene.hasAttribute('data-wide')).toBe(true)
    expect(scene.contains(screen.getByTestId('player'))).toBe(true)
    // No side columns, no bottom rows, nothing drawn over the player.
    expect(scene.querySelector('[data-zone]')).toBeNull()
    expect(scene.querySelector('[data-corner]')).toBeNull()
    expect(screen.getByTestId('dc-name').textContent).toBe('Porta retro')
  })

  it('keeps the battery in the card frame, never over the player', () => {
    slices.cardBattery = { level: 64 }
    draw()
    expect(screen.getByTestId('dc-frame-row').contains(screen.getByTestId('dc-battery'))).toBe(true)
    expect(screen.getByTestId('dc-scene').querySelector('[data-corner]')).toBeNull()
  })

  it('says what the camera does in the state line, only from caps it answers', () => {
    draw()
    expect(screen.getByTestId('dc-state').textContent).toBe('')
    cleanup()
    slices.lowPowerSleep = { sleeping: true }
    draw()
    expect(screen.getByTestId('dc-state').textContent).toContain('Asleep')
    cleanup()
    slices.lowPowerSleep = undefined
    slices.motion = { detected: false, lastDetectedAt: NOW - 120_000 }
    slices.battery = { level: 82, charging: 'none', sleeping: false }
    draw()
    expect(screen.getByTestId('dc-state').textContent).toContain('Awake')
    expect(screen.getByTestId('dc-state').textContent).toContain('motion 2 min ago')
    cleanup()
    slices.motion = { detected: true, lastDetectedAt: NOW }
    draw()
    expect(screen.getByTestId('dc-state').textContent).toContain('Motion now')
  })

  it('offers the history only once the device recorded a series: the state line opens it in place of the scene', () => {
    draw()
    expect(screen.getByTestId('dc-state').tagName).not.toBe('BUTTON')
    cleanup()
    slices.seriesCount = 2
    draw()
    expect(screen.queryByTestId('history-view')).toBeNull()
    fireEvent.click(screen.getByTestId('dc-state'))
    expect(screen.getByTestId('history-view')).toBeTruthy()
    expect(screen.getByTestId('dc-history')).toBeTruthy()
    expect(screen.queryByTestId('player')).toBeNull()
    fireEvent.click(screen.getByTestId('dc-back'))
    expect(screen.getByTestId('player')).toBeTruthy()
  })

  it("a host that shows the history itself turns the card's off, camera included", () => {
    slices.seriesCount = 2
    render(
      <DeviceCardFrameProvider frame="card" historyView={false}>
        <ConnectedCameraCard deviceId={7} scene={<div data-testid="player" />} />
      </DeviceCardFrameProvider>,
    )
    expect(screen.getByTestId('dc-state').tagName).not.toBe('BUTTON')
  })
})
