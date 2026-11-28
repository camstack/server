/**
 * `switch.toggle` on a composed actuator group: the kernel default is
 * registered over the group's own `switch` slice — the aggregate — so a toggle fans out
 * `setState(!aggregate)` to every member through the one dispatcher, and an aggregate that was
 * never seeded refuses by name instead of guessing.
 */
import {
  type DeviceContext,
  type IDeviceRuntimeState,
  DeviceType,
  switchCapability,
} from '@dominevo/types'
import { afterEach, describe, expect, it } from 'vitest'
import { withDefaultSwitchToggle } from '../../../kernel/moleculer/switch-toggle.js'
import { setActuatorDispatcher, type ActuatorDispatchInput } from '../actuator-dispatch.js'
import { ComposedDevice } from '../composed-device.js'

interface TogglePort {
  toggle(input: { deviceId: number }): Promise<void>
}

function isTogglePort(value: object): value is TogglePort {
  return typeof Reflect.get(value, 'toggle') === 'function'
}

function harness(): {
  readonly device: ComposedDevice
  readonly toggle: () => Promise<void>
  readonly sent: ActuatorDispatchInput[]
} {
  const sent: ActuatorDispatchInput[] = []
  setActuatorDispatcher(async (input) => {
    sent.push(input)
  })
  let runtime: IDeviceRuntimeState | null = null
  let registered: object | null = null
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child() {
      return this
    },
    withTags() {
      return this
    },
  }
  // The kernel's DeviceContext is far wider than the composer reads: the one documented spec boundary.
  const ctx = {
    id: 9,
    stableId: 'composed:9',
    parentDeviceId: null,
    deviceMeta: {
      id: 9,
      stableId: 'composed:9',
      addonId: 'composer',
      type: DeviceType.Light,
      name: 'Group',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {},
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    // Same wiring as the kernel's registration site (device-cap-proxy): the default toggle over the own slice.
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }, provider: object) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
      if (cap.name !== switchCapability.name) return
      registered = withDefaultSwitchToggle(cap.name, provider, {
        deviceId: 9,
        readSlice: () => runtime?.getCapState('switch'),
        logger,
      })
    },
    unregisterNativeCap: () => {},
    logger,
    api: {},
  } as unknown as DeviceContext
  const device = new ComposedDevice(ctx, DeviceType.Light, [switchCapability])
  const toggle = async (): Promise<void> => {
    if (registered === null || !isTogglePort(registered)) throw new Error('no toggle registered')
    await registered.toggle({ deviceId: 9 })
  }
  return { device, toggle, sent }
}

afterEach(() => setActuatorDispatcher(null))

describe('switch.toggle on a composed actuator group', () => {
  it('fans out off when the aggregate is on, and on when it is off', async () => {
    const { device, toggle, sent } = harness()
    device.seed('switch', { on: true, lastChangedAt: 1 })
    await toggle()
    device.seed('switch', { on: false, lastChangedAt: 2 })
    await toggle()
    expect(sent.map((s) => [s.groupDeviceId, s.cap, s.method, s.args])).toEqual([
      [9, 'switch', 'setState', { on: false }],
      [9, 'switch', 'setState', { on: true }],
    ])
  })

  it('refuses an aggregate nobody seeded, and commands no member', async () => {
    const { toggle, sent } = harness()
    await expect(toggle()).rejects.toThrow(/refusing to guess/)
    expect(sent).toEqual([])
  })
})
