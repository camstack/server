import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { climateControlCapability } from '../../capabilities/climate-control.cap.js'
import { dishwasherCapability } from '../../capabilities/dishwasher.cap.js'
import { humidifierCapability } from '../../capabilities/humidifier.cap.js'
import { mediaPlayerCapability } from '../../capabilities/media-player.cap.js'
import { switchCapability } from '../../capabilities/switch.cap.js'
import { DeviceRuntimeState } from '../device-runtime-state.js'
import {
  buildPowerSwitch,
  PowerSwitchRefusedError,
  powerServedBy,
  registerPowerSwitch,
  type PowerSwitchHost,
  type PowerSwitchOwner,
} from '../power-switch.js'

const DEVICE_ID = 42

interface Harness {
  readonly host: PowerSwitchHost
  readonly state: DeviceRuntimeState
  readonly hubSlices: Map<string, Record<string, unknown> | null>
}

function harness(): Harness {
  const state = DeviceRuntimeState.fromInitial({}, async () => {})
  state.installCapSchema(switchCapability.name, switchCapability.runtimeState)
  // Owner slices are written partially here: only the hinted field matters.
  for (const cap of ['humidifier', 'media-player', 'climate-control'])
    state.installCapSchema(cap, z.object({}).loose())
  const hubSlices = new Map<string, Record<string, unknown> | null>()
  const host: PowerSwitchHost = {
    deviceId: DEVICE_ID,
    runtimeState: state,
    registerNativeCap: vi.fn(),
    readHubSlice: async (capName) => hubSlices.get(capName) ?? null,
  }
  return { host, state, hubSlices }
}

function ownerWith(methods: Record<string, (input: unknown) => Promise<void>>): PowerSwitchOwner {
  return methods
}

describe('buildPowerSwitch — field hint (humidifier)', () => {
  it('reads switch.on from the owner field at read time', async () => {
    const { host, state } = harness()
    const { provider } = buildPowerSwitch(host, humidifierCapability, ownerWith({}))
    state.setCapState('humidifier', { on: true, lastChangedAt: 1 })
    expect((await provider.getStatus?.({ deviceId: DEVICE_ID }))?.on).toBe(true)
    state.setCapState('humidifier', { on: false, lastChangedAt: 2 })
    expect((await provider.getStatus?.({ deviceId: DEVICE_ID }))?.on).toBe(false)
  })

  it('reports null — never false — when the owner has not reported', async () => {
    const { host, state } = harness()
    const { provider } = buildPowerSwitch(host, humidifierCapability, ownerWith({}))
    expect((await provider.getStatus?.({ deviceId: DEVICE_ID }))?.on).toBeNull()
    state.setCapState('humidifier', { lastChangedAt: 1 })
    expect((await provider.getStatus?.({ deviceId: DEVICE_ID }))?.on).toBeNull()
  })

  it('routes setState to the hinted setter', async () => {
    const { host } = harness()
    const setOn = vi.fn(async () => {})
    const { provider } = buildPowerSwitch(host, humidifierCapability, ownerWith({ setOn }))
    await provider.setState({ deviceId: DEVICE_ID, on: true })
    expect(setOn).toHaveBeenCalledWith({ deviceId: DEVICE_ID, on: true })
  })

  it('projects the owner field into the switch slice as it changes', () => {
    const { host, state } = harness()
    buildPowerSwitch(host, humidifierCapability, ownerWith({}))
    state.setCapState('humidifier', { on: true, lastChangedAt: 1 })
    expect(state.getCapState('switch')?.on).toBe(true)
    state.setCapState('humidifier', { on: false, lastChangedAt: 2 })
    expect(state.getCapState('switch')?.on).toBe(false)
  })
})

describe('buildPowerSwitch — methods hint (media-player)', () => {
  it('maps the state enum: standby and off are off, anything else is on', async () => {
    const { host, state } = harness()
    const { provider } = buildPowerSwitch(host, mediaPlayerCapability, ownerWith({}))
    state.setCapState('media-player', { state: 'standby' })
    expect((await provider.getStatus?.({ deviceId: DEVICE_ID }))?.on).toBe(false)
    state.setCapState('media-player', { state: 'playing' })
    expect((await provider.getStatus?.({ deviceId: DEVICE_ID }))?.on).toBe(true)
  })

  it('calls turnOn / turnOff', async () => {
    const { host } = harness()
    const turnOn = vi.fn(async () => {})
    const turnOff = vi.fn(async () => {})
    const { provider } = buildPowerSwitch(
      host,
      mediaPlayerCapability,
      ownerWith({ turnOn, turnOff }),
    )
    await provider.setState({ deviceId: DEVICE_ID, on: false })
    expect(turnOff).toHaveBeenCalledWith({ deviceId: DEVICE_ID })
    expect(turnOn).not.toHaveBeenCalled()
  })

  it('refuses by name when the owner does not serve the hinted method', async () => {
    const { host } = harness()
    const { provider } = buildPowerSwitch(host, mediaPlayerCapability, ownerWith({}))
    await expect(provider.setState({ deviceId: DEVICE_ID, on: true })).rejects.toMatchObject({
      reason: 'owner-method-missing',
    })
  })
})

describe('buildPowerSwitch — mode hint (climate-control)', () => {
  it('is off exactly when the mode is the off value', async () => {
    const { host, state } = harness()
    const { provider } = buildPowerSwitch(host, climateControlCapability, ownerWith({}))
    state.setCapState('climate-control', { mode: 'off' })
    expect((await provider.getStatus?.({ deviceId: DEVICE_ID }))?.on).toBe(false)
    state.setCapState('climate-control', { mode: 'heat' })
    expect((await provider.getStatus?.({ deviceId: DEVICE_ID }))?.on).toBe(true)
  })

  it('turns off by writing the off value', async () => {
    const { host } = harness()
    const setMode = vi.fn(async () => {})
    const { provider } = buildPowerSwitch(host, climateControlCapability, ownerWith({ setMode }))
    await provider.setState({ deviceId: DEVICE_ID, on: false })
    expect(setMode).toHaveBeenCalledWith({ deviceId: DEVICE_ID, mode: 'off' })
  })

  it('turns on by restoring the last non-off mode the hub kept', async () => {
    const { host, hubSlices } = harness()
    hubSlices.set('climate-control', { mode: 'off', lastActiveMode: 'cool' })
    const setMode = vi.fn(async () => {})
    const { provider } = buildPowerSwitch(host, climateControlCapability, ownerWith({ setMode }))
    await provider.setState({ deviceId: DEVICE_ID, on: true })
    expect(setMode).toHaveBeenCalledWith({ deviceId: DEVICE_ID, mode: 'cool' })
  })

  it('refuses with no-last-mode rather than guess a mode', async () => {
    const { host, state } = harness()
    state.setCapState('climate-control', { mode: 'off' })
    const setMode = vi.fn(async () => {})
    const { provider } = buildPowerSwitch(host, climateControlCapability, ownerWith({ setMode }))
    const attempt = provider.setState({ deviceId: DEVICE_ID, on: true })
    await expect(attempt).rejects.toBeInstanceOf(PowerSwitchRefusedError)
    await expect(attempt).rejects.toMatchObject({ reason: 'no-last-mode' })
    expect(setMode).not.toHaveBeenCalled()
  })
})

describe('powerServedBy — an owner that does not serve its hinted methods has no switch', () => {
  it('is false for a media player without turnOn / turnOff, true with both', () => {
    const hint = mediaPlayerCapability.power
    expect(powerServedBy(hint, ownerWith({}))).toBe(false)
    expect(powerServedBy(hint, ownerWith({ turnOn: async () => {} }))).toBe(false)
    expect(
      powerServedBy(hint, ownerWith({ turnOn: async () => {}, turnOff: async () => {} })),
    ).toBe(true)
  })

  it('registerPowerSwitch registers nothing for such an owner', () => {
    const { state } = harness()
    const registerNativeCap = vi.fn()
    const warn = vi.fn()
    registerPowerSwitch(
      {
        ctx: {
          id: DEVICE_ID,
          registerNativeCap,
          logger: { warn, debug: vi.fn() },
          api: { deviceState: { getCapSlice: { query: async () => null } } },
        },
        runtimeState: state,
      },
      mediaPlayerCapability,
      { play: async () => {}, pause: async () => {} },
    )
    expect(registerNativeCap).not.toHaveBeenCalled()
  })
})

describe('buildPowerSwitch — a cap with no power hint', () => {
  it('throws: a cap without a hint has no switch to project', () => {
    const { host } = harness()
    expect(() => buildPowerSwitch(host, dishwasherCapability, ownerWith({}))).toThrow(
      /no power hint/,
    )
  })
})
