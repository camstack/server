/**
 * A Floodlight / Siren child whose parent does not advertise the ability
 * refuses operator writes instead of accepting them and writing the slice.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { AccessoryAbilityError } from '../ability-guard.js'
import { FloodlightAccessory } from '../floodlight.js'

interface SwitchProvider {
  setState(input: { deviceId: number; on: boolean }): Promise<void>
}

function build(hasFloodlight: boolean | undefined) {
  let runtime: IDeviceRuntimeState | null = null
  const providers: { switch?: SwitchProvider } = {}
  const setWhiteLedState = vi.fn(async () => {})
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = {
    id: 51,
    stableId: 'reolink-fl',
    parentDeviceId: 50,
    deviceMeta: {
      type: DeviceType.Light,
      name: 'Floodlight',
      location: null,
      disabled: false,
      addonId: 'provider-reolink',
      metadata: {},
    },
    persistedConfig: { kind: 'floodlight', channel: 0 },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }, provider: unknown) => {
      Object.assign(providers, { [cap.name]: provider })
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    api: {},
    logger,
  } as unknown as DeviceContext
  const parent = {
    name: 'cam',
    ensureApi: async () => ({ setWhiteLedState }),
    probeAbility: () => hasFloodlight,
  }
  const device = new FloodlightAccessory(ctx, parent)
  return { device, providers, setWhiteLedState, logger }
}

describe('Floodlight accessory on a camera without a floodlight', () => {
  it.each([false, undefined])('refuses setState when the parent reports %s', async (flag) => {
    const h = build(flag)
    await expect(h.providers.switch!.setState({ deviceId: 51, on: true })).rejects.toBeInstanceOf(
      AccessoryAbilityError,
    )
    expect(h.setWhiteLedState).not.toHaveBeenCalled()
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('refused'),
      expect.objectContaining({ tags: { deviceId: 51 } }),
    )
  })

  it('accepts setState when the parent reports hasFloodlight', async () => {
    const h = build(true)
    await h.providers.switch!.setState({ deviceId: 51, on: true })
    expect(h.setWhiteLedState).toHaveBeenCalledOnce()
  })
})
