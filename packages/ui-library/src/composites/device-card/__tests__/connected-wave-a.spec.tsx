// @vitest-environment jsdom
/**
 * The Wave-A connected cards against a fake hub: which capability a command
 * reaches. Power goes through `switch` (D1042) — never a per-cap setter — the
 * timer through `timed-run`, a refused command lands on the reason line, and a
 * saved fan preset applies through `fan-presets.applyPreset`.
 */
import {
  DeviceFeature,
  DeviceRole,
  DeviceType,
  type FanControlStatus,
  type FanPresetApplyResult,
} from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedFanCard } from '../connected/ConnectedFanCard'
import { ConnectedHeaterCard } from '../connected/ConnectedHeaterCard'
import { ConnectedLightCard } from '../connected/ConnectedLightCard'

const hub = vi.hoisted(() => ({
  setState: vi.fn(),
  setBrightness: vi.fn(),
  setPercentage: vi.fn(),
  setPreset: vi.fn(),
  runFor: vi.fn(),
  cancel: vi.fn(),
  applyPreset: vi.fn(),
  deviceType: 'light',
  role: null as string | null,
  features: [] as string[],
  fan: null as FanControlStatus | null,
}))

const FAN: FanControlStatus = {
  speed: 50,
  preset: '',
  availablePresets: ['eco'],
  direction: null,
  oscillating: null,
  lastChangedAt: 0,
}

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    switch: { setState: hub.setState },
    timedRun: { runFor: hub.runFor, cancel: hub.cancel },
    brightness: { setBrightness: hub.setBrightness },
    color: undefined,
    fanControl: { setPercentage: hub.setPercentage, setPreset: hub.setPreset },
    state: {
      switch: { on: true, lastChangedAt: 0 },
      timedRun: { activeUntil: null, requestedBy: null, quickRun: null },
      brightness: { level: 70, lastChangedAt: 0 },
      color: undefined,
      fanControl: hub.fan ?? undefined,
    },
  }),
  // The fake proxy carries the slice value itself.
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../../../hooks/use-capability-presence', () => ({
  useCapabilityPresence: () => 'present',
}))
vi.mock('../../../generated/system-hooks', () => ({
  useFanPresetsGetPresets: () => ({
    data: [{ id: 'p1', name: 'Sera', state: {} }],
  }),
  useFanPresetsApplyPreset: () => ({ mutateAsync: hub.applyPreset }),
}))
// The shell's data comes from a fixture; the notice is the REAL hook, so a
// refusal travels command -> notice -> reason line.
vi.mock('../connected/use-card-common', async () => {
  const { useCommandNotice } = await import('../connected/use-command-notice')
  return {
    useCardCommon: () => {
      const { notice, fail, succeed } = useCommandNotice()
      const common = plugFixtures(0)[0]?.model.common
      if (common === undefined) throw new Error('no plug fixture')
      return {
        common: {
          ...common,
          consumables: null,
          supply: null,
          remote: null,
          notice,
        },
        actions: {},
        deviceType: hub.deviceType,
        role: hub.role,
        features: hub.features,
        fail,
        succeed,
      }
    },
  }
})

beforeEach(() => {
  for (const fn of [
    hub.setState,
    hub.setBrightness,
    hub.setPercentage,
    hub.setPreset,
    hub.runFor,
    hub.cancel,
    hub.applyPreset,
  ]) {
    fn.mockReset()
    fn.mockResolvedValue(undefined)
  }
  hub.deviceType = DeviceType.Light
  hub.role = null
  hub.features = []
  hub.fan = FAN
})
afterEach(cleanup)

describe('power goes through switch, never a per-cap setter', () => {
  it('the light turns off through switch.setState', async () => {
    render(<ConnectedLightCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-light-power'))
    await vi.waitFor(() => expect(hub.setState).toHaveBeenCalledWith({ on: false }))
    expect(hub.setBrightness).not.toHaveBeenCalled()
  })

  it('the fan turns off through switch.setState', async () => {
    hub.deviceType = DeviceType.Fan
    render(<ConnectedFanCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-fan-power'))
    await vi.waitFor(() => expect(hub.setState).toHaveBeenCalledWith({ on: false }))
    expect(hub.setPercentage).not.toHaveBeenCalled()
  })

  it('the heater turns off through switch.setState', async () => {
    hub.deviceType = DeviceType.Switch
    hub.role = DeviceRole.SwitchHeater
    render(<ConnectedHeaterCard deviceId={1} optimistic={false} />)
    fireEvent.click(screen.getByTestId('dc-heater-power'))
    await vi.waitFor(() => expect(hub.setState).toHaveBeenCalledWith({ on: false }))
  })
})

describe('the heater timer is timed-run', () => {
  it('starts a run in minutes through timedRun.runFor', async () => {
    hub.deviceType = DeviceType.Switch
    hub.role = DeviceRole.SwitchHeater
    render(<ConnectedHeaterCard deviceId={1} />)
    fireEvent.click(screen.getByTestId('dc-plug-timer-start'))
    await vi.waitFor(() =>
      expect(hub.runFor).toHaveBeenCalledWith({
        duration: expect.any(Number),
        unit: 'min',
      }),
    )
  })

  it('a switch whose role has no timed-run limit draws no timer', () => {
    hub.deviceType = DeviceType.Switch
    hub.role = null
    render(<ConnectedHeaterCard deviceId={1} />)
    expect(screen.queryByTestId('dc-plug-timer')).toBeNull()
  })
})

describe('a refused command says why on the card', () => {
  it('a refused brightness puts its reason on the reason line', async () => {
    hub.setBrightness.mockRejectedValueOnce(new Error('bulb unreachable'))
    render(<ConnectedLightCard deviceId={1} />)
    const slider = screen.getByTestId('dc-light-brightness')
    fireEvent.change(slider, { target: { value: '30' } })
    fireEvent.pointerUp(slider)
    await vi.waitFor(() => expect(hub.setBrightness).toHaveBeenCalledWith({ level: 30 }))
    const reason = await screen.findByTestId('dc-reason')
    expect(reason.textContent).toBe('Command failed: bulb unreachable')
  })
})

describe('fan presets', () => {
  it('a saved preset applies through fan-presets, and a partial result names the field', async () => {
    hub.deviceType = DeviceType.Fan
    const partial: FanPresetApplyResult = {
      status: 'partial',
      fields: [{ field: 'speed', outcome: 'failed', message: 'out of range' }],
    }
    hub.applyPreset.mockResolvedValueOnce(partial)
    render(<ConnectedFanCard deviceId={7} />)
    fireEvent.pointerDown(screen.getByTestId('dc-fan-preset'), { button: 0 })
    fireEvent.click(screen.getByTestId('dc-fan-preset'))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sera' }))
    await vi.waitFor(() =>
      expect(hub.applyPreset).toHaveBeenCalledWith({
        deviceId: 7,
        presetId: 'p1',
      }),
    )
    expect(hub.setPreset).not.toHaveBeenCalled()
    const reason = await screen.findByTestId('dc-reason')
    expect(reason.textContent).toBe('Command failed: preset not fully applied: speed: out of range')
  })

  it('draws a declared speed before fan-control answers, holding no value', () => {
    hub.deviceType = DeviceType.Fan
    hub.fan = null
    hub.features = [DeviceFeature.FanSpeed]
    render(<ConnectedFanCard deviceId={1} />)
    expect(screen.getByTestId('dc-fan-speed')).toHaveProperty('disabled', true)
  })
})
