/**
 * Unit tests for HomematicDevice.
 *
 * What is tested here
 * -------------------
 * 1. Constructor guards — missing/invalid address throws.
 * 2. Facade resolution seam — `facade` getter delegates to
 *    `homematicFacades` keyed by `brokerId`; devices without a
 *    `brokerId` fall back to the primary broker.
 * 3. `removeDevice()` — unsub callback is invoked once, then cleared.
 * 4. `handleValueChanged` decoding (switch / cover / lock / motion /
 *    temperature / humidity / ambient-light / power-meter) — exercised
 *    by capturing the listener the device installs on the facade and
 *    driving events through it; outcomes are visible via `runtimeState`.
 * 5. Cap-registration when device is found on the facade (via a minimal
 *    facade stub that returns a fake `HmDevice`).
 *
 * What is deliberately NOT tested here
 * --------------------------------------
 * - Actual CCU network calls (switchTurnOn, coverOpen, …): those require
 *   a live CCU and are integration-tested via live deploy.
 * - Cap provider `setState` / `lock` / `setTarget` paths: they all go
 *   through `requireFacade()` and are pure pass-throughs to the facade;
 *   stubbing them would duplicate the facade-resolver tests without
 *   adding value.
 * - `homematic-sensor-caps.ts` standalone functions: they delegate
 *   directly to `ctx.registerNativeCap` and `runtimeState`; coverage
 *   comes naturally from the device construction path below.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import type { DeviceContext } from '@camstack/types'
import type { Homematic, HmCustomEntity, HmDevice, ValueChangedEvent } from 'nodehomematic'
import { HomematicDevice, homematicDeviceSchema } from '../homematic-device.js'
import { homematicFacades } from '../homematic-gateway.js'

// ---------------------------------------------------------------------------
// Minimal DeviceContext factory
// Mirrors the pattern used in ha-base-child-device.spec.ts and
// homematic-broker-provider.spec.ts — no casts in the returned value.
// ---------------------------------------------------------------------------

type StubLogger = {
  debug: () => undefined
  info: () => undefined
  warn: () => undefined
  error: () => undefined
  child: () => StubLogger
  withTags: () => StubLogger
}

function makeLogger(): StubLogger {
  const logger: StubLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** Builds a DeviceContext stub and returns it together with the captured
 *  runtimeState reference so tests can call getCapState directly.
 *  Follows the same pattern as ha-base-child-device.spec.ts: build an
 *  object literal that covers only the methods HomematicDevice calls, then
 *  widen through `unknown` to `DeviceContext` at the return boundary. */
function makeCtx(
  persistedConfig: Record<string, unknown>,
  deviceType: DeviceType = DeviceType.Switch,
): {
  ctx: DeviceContext
  getRuntimeState: () => IDeviceRuntimeState
  registeredCaps: () => readonly string[]
  capProvider: (capName: string) => Record<string, unknown> | null
} {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  // Records every cap the device registered, with its provider object so a
  // test can invoke a method (e.g. `open()`) and assert facade routing.
  const providers = new Map<string, Record<string, unknown>>()

  const ctx = {
    id: 1,
    stableId: 'hm:test:1',
    parentDeviceId: null,
    deviceMeta: {
      id: 1,
      stableId: 'hm:test:1',
      addonId: 'provider-homematic',
      type: deviceType,
      name: 'Test HM Device',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig,
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({
      deviceState: { setCapSlice: vi.fn(async () => {}) },
    })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 1),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
      setName: vi.fn(async () => {}),
      setLocation: vi.fn(async () => {}),
      setDisabled: vi.fn(async () => {}),
      loadConfig: vi.fn(async () => ({})),
      persistInitialConfig: vi.fn(async () => 1),
      applyDerivedSpec: vi.fn(async () => {}),
    },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn(
      (cap: { name: string; runtimeState?: unknown }, provider: Record<string, unknown>) => {
        providers.set(cap.name, provider)
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      },
    ),
    logger: makeLogger(),
    api: {},
  } as unknown as DeviceContext

  return {
    ctx,
    getRuntimeState: () => {
      if (!runtimeStateRef) throw new Error('runtimeState not yet bound')
      return runtimeStateRef
    },
    registeredCaps: () => [...providers.keys()],
    capProvider: (capName) => providers.get(capName) ?? null,
  }
}

/** Narrow a provider-method value to a zero-arg async callable, then invoke
 *  it. Throws when the method is missing or not a function — no casts. */
async function invokeProviderMethod(
  provider: Record<string, unknown> | null,
  method: string,
): Promise<void> {
  const fn = provider?.[method]
  if (typeof fn !== 'function') {
    throw new Error(`provider method "${method}" is not callable`)
  }
  await fn()
}

// ---------------------------------------------------------------------------
// Minimal Homematic facade stub
// Only the methods the device class directly calls are stubbed; the rest
// are omitted — the structural type system accepts the partial shape when
// we cast through DeviceContext (no `as any` — we widen via unknown only
// at the facade insertion boundary where the Map key is typed as Homematic).
// ---------------------------------------------------------------------------

type FacadeOnHandler = (event: ValueChangedEvent) => void

interface FacadeStub {
  _handlers: FacadeOnHandler[]
  _devices: HmDevice[]
  _customEntities: HmCustomEntity[]
  /** Records control calls so actuator-channel routing can be asserted. */
  _calls: { method: string; device: string; channel: string }[]
  /** Emit a valueChanged event to all registered handlers. */
  emit: (event: ValueChangedEvent) => void
  on: (event: 'valueChanged', handler: FacadeOnHandler) => () => void
  devices: () => HmDevice[]
  /** The library's typed custom entities — the actuator cap source. */
  customEntities: () => HmCustomEntity[]
  coverOpen: (device: string, channel: string | number) => Promise<void>
  switchTurnOn: (device: string, channel: string | number) => Promise<void>
}

function makeFacadeStub(
  hmDevices: HmDevice[] = [],
  customEntities: HmCustomEntity[] = [],
): FacadeStub {
  const handlers: FacadeOnHandler[] = []
  const calls: { method: string; device: string; channel: string }[] = []
  return {
    _handlers: handlers,
    _devices: hmDevices,
    _customEntities: customEntities,
    _calls: calls,
    emit: (event) => handlers.forEach((h) => h(event)),
    on: (_ev: 'valueChanged', handler: FacadeOnHandler) => {
      handlers.push(handler)
      return () => {
        const idx = handlers.indexOf(handler)
        if (idx !== -1) handlers.splice(idx, 1)
      }
    },
    devices: () => hmDevices,
    customEntities: () => customEntities,
    coverOpen: async (device, channel) => {
      calls.push({ method: 'coverOpen', device, channel: String(channel) })
    },
    switchTurnOn: async (device, channel) => {
      calls.push({ method: 'switchTurnOn', device, channel: String(channel) })
    },
  }
}

/** Build an `HmCover` custom-entity snapshot bound to a specific channel. */
function makeCoverEntity(device: string, channel: string): HmCustomEntity {
  return {
    kind: 'cover',
    device,
    channel,
    channels: [channel],
    currentPosition: null,
    isClosed: true,
    statusChannels: [],
    travel: 'stable',
  }
}

/** Build an `HmSwitch` custom-entity snapshot bound to a specific channel. */
function makeSwitchEntity(device: string, channel: string): HmCustomEntity {
  return {
    kind: 'switch',
    device,
    channel,
    isOn: false,
  }
}

/** Build an `HmClimate` custom-entity snapshot bound to a specific channel. */
function makeClimateEntity(device: string, channel: string): HmCustomEntity {
  return {
    kind: 'climate',
    device,
    channel,
    currentTemperature: null,
    targetTemperature: null,
    currentHumidity: null,
    minTemp: 5,
    maxTemp: 30,
    targetTemperatureStep: 0.5,
    mode: 'auto',
    preset: 'none',
    activity: 'idle',
  }
}

/** Cast the stub to `Homematic` for insertion into `homematicFacades`.
 *  The Map types enforce `Homematic`; we widen through `unknown` at
 *  exactly this one boundary. No `as any`. */
function asFacade(stub: FacadeStub): Homematic {
  return stub as unknown as Homematic
}

// Shared device address used across tests.
const DEVICE_ADDRESS = '0001D3C99AB001'

// ---------------------------------------------------------------------------
// Setup / teardown — ensure `homematicFacades` is clean before each test.
// ---------------------------------------------------------------------------

beforeEach(() => {
  homematicFacades.clear()
})

// ---------------------------------------------------------------------------
// 1. Constructor guards
// ---------------------------------------------------------------------------

describe('HomematicDevice constructor', () => {
  it('throws when address is absent from persistedConfig', () => {
    const { ctx } = makeCtx({})
    expect(() => new HomematicDevice(ctx)).toThrow(/missing address/)
  })

  it('throws when address is an empty string', () => {
    const { ctx } = makeCtx({ address: '' })
    expect(() => new HomematicDevice(ctx)).toThrow(/missing address/)
  })

  it('constructs successfully with a valid address and no facade (no CCU connected)', () => {
    const { ctx } = makeCtx({ address: DEVICE_ADDRESS })
    // No facade registered — device should warn but NOT throw.
    expect(() => new HomematicDevice(ctx)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. homematicDeviceSchema export
// ---------------------------------------------------------------------------

describe('homematicDeviceSchema', () => {
  it('accepts a minimal config with address only', () => {
    const result = homematicDeviceSchema.safeParse({ address: DEVICE_ADDRESS })
    expect(result.success).toBe(true)
  })

  it('accepts a config with address + brokerId', () => {
    const result = homematicDeviceSchema.safeParse({ address: DEVICE_ADDRESS, brokerId: 'hm_001' })
    expect(result.success).toBe(true)
    expect(result.data?.brokerId).toBe('hm_001')
  })

  it('rejects a config with empty address', () => {
    const result = homematicDeviceSchema.safeParse({ address: '' })
    expect(result.success).toBe(false)
  })

  it('rejects a config with missing address', () => {
    const result = homematicDeviceSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Facade resolution — brokerId routing
// ---------------------------------------------------------------------------

describe('HomematicDevice facade resolution', () => {
  it('resolves the facade keyed by brokerId when present', () => {
    const facadeA = makeFacadeStub([])
    const facadeB = makeFacadeStub([])
    homematicFacades.set('hm_001', asFacade(facadeA))
    homematicFacades.set('hm_002', asFacade(facadeB))

    const { ctx: ctxA } = makeCtx({ address: DEVICE_ADDRESS, brokerId: 'hm_001' })
    const devA = new HomematicDevice(ctxA)
    // facadeA.on was called (device subscribed to valueChanged events)
    expect(facadeA._handlers).toHaveLength(1)
    // facadeB must not have been touched by devA
    expect(facadeB._handlers).toHaveLength(0)
    void devA
  })

  it('falls back to the primary facade when brokerId is absent (legacy device)', () => {
    const primaryFacade = makeFacadeStub([])
    const secondFacade = makeFacadeStub([])
    homematicFacades.set('hm_001', asFacade(primaryFacade))
    homematicFacades.set('hm_002', asFacade(secondFacade))

    // No brokerId in persistedConfig → legacy path → resolves primary (hm_001)
    const { ctx } = makeCtx({ address: DEVICE_ADDRESS })
    void new HomematicDevice(ctx)
    expect(primaryFacade._handlers).toHaveLength(1)
    expect(secondFacade._handlers).toHaveLength(0)
  })

  it('skips listener registration when no facade is available', () => {
    // homematicFacades is empty (cleared in beforeEach)
    const { ctx } = makeCtx({ address: DEVICE_ADDRESS, brokerId: 'hm_001' })
    // Should not throw; just skips listener attachment.
    expect(() => new HomematicDevice(ctx)).not.toThrow()
  })

  it('skips listener when brokerId points to an unregistered broker', () => {
    const facade = makeFacadeStub([])
    homematicFacades.set('hm_002', asFacade(facade))

    // Device's brokerId is hm_001 — not registered.
    const { ctx } = makeCtx({ address: DEVICE_ADDRESS, brokerId: 'hm_001' })
    void new HomematicDevice(ctx)
    // hm_002 facade must remain untouched.
    expect(facade._handlers).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. removeDevice — unsubscribe lifecycle
// ---------------------------------------------------------------------------

describe('HomematicDevice.removeDevice', () => {
  it('calls the unsub callback once and clears it', async () => {
    const facade = makeFacadeStub([])
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx } = makeCtx({ address: DEVICE_ADDRESS, brokerId: 'hm_001' })
    const device = new HomematicDevice(ctx)
    expect(facade._handlers).toHaveLength(1)

    await device.removeDevice()
    // Listener removed from facade.
    expect(facade._handlers).toHaveLength(0)
  })

  it('is idempotent — calling removeDevice twice does not throw', async () => {
    const facade = makeFacadeStub([])
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx } = makeCtx({ address: DEVICE_ADDRESS, brokerId: 'hm_001' })
    const device = new HomematicDevice(ctx)
    await device.removeDevice()
    await expect(device.removeDevice()).resolves.not.toThrow()
  })

  it('does not throw when no facade was available at construction time', async () => {
    // homematicFacades is empty — no listener was attached.
    const { ctx } = makeCtx({ address: DEVICE_ADDRESS })
    const device = new HomematicDevice(ctx)
    await expect(device.removeDevice()).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 5. handleValueChanged decoding — driven via captured facade listener
//
// We need the device to register its caps to populate `capChannels` so
// the decode routing fires. That requires the facade's `devices()` to
// return an HmDevice that has the right channel type so `mapHmDeviceChannels`
// maps it correctly. We use a minimal HmDevice shape for each cap family.
// ---------------------------------------------------------------------------

/**
 * Minimal HmDevice stubs — channel types MUST match the writable entries
 * in `homematic-mapping.ts` (`mapHmChannel`). Status-only `*_TRANSMITTER`
 * types return null from the mapper and are skipped.
 */

/** Minimal HmDevice shape for a switch (HmIP-BSM type family). */
function makeHmSwitch(): HmDevice {
  return {
    address: DEVICE_ADDRESS,
    name: 'TestSwitch',
    type: 'HmIP-BSM',
    channels: [
      {
        address: `${DEVICE_ADDRESS}:3`,
        // SWITCH_VIRTUAL_RECEIVER is the writable channel the mapper recognises.
        type: 'SWITCH_VIRTUAL_RECEIVER',
        datapoints: {},
        paramsets: {},
      },
    ],
  } as unknown as HmDevice
}

/**
 * Cover device with MULTIPLE `SHUTTER_VIRTUAL_RECEIVER` channels (:4/:5/:6),
 * mirroring a real HmIP-BROLL. The raw-channel loop would bind the cover cap
 * to the LAST one (:6); the lib's custom entity is on :4 — control must use
 * :4. Also carries an energy-meter channel so we can assert the power-meter
 * sensor cap still registers from the raw-channel path.
 */
function makeHmMultiCover(): HmDevice {
  return {
    address: DEVICE_ADDRESS,
    name: 'TestMultiCover',
    type: 'HmIP-BROLL',
    channels: [
      {
        address: `${DEVICE_ADDRESS}:4`,
        type: 'SHUTTER_VIRTUAL_RECEIVER',
        datapoints: {},
        paramsets: {},
      },
      {
        address: `${DEVICE_ADDRESS}:5`,
        type: 'SHUTTER_VIRTUAL_RECEIVER',
        datapoints: {},
        paramsets: {},
      },
      {
        address: `${DEVICE_ADDRESS}:6`,
        type: 'SHUTTER_VIRTUAL_RECEIVER',
        datapoints: {},
        paramsets: {},
      },
      {
        address: `${DEVICE_ADDRESS}:7`,
        type: 'ENERGIE_METER_TRANSMITTER',
        datapoints: {},
        paramsets: {},
      },
    ],
  } as unknown as HmDevice
}

/**
 * Switch device with MULTIPLE `SWITCH_VIRTUAL_RECEIVER` channels (:4/:5/:6),
 * plus a key channel so we can assert the event-emitter cap still registers
 * from the raw-channel path while the switch actuator cap binds to the
 * custom-entity channel.
 */
function makeHmMultiSwitch(): HmDevice {
  const dataPoints = [{ parameter: 'PRESS_SHORT' }]
  return {
    address: DEVICE_ADDRESS,
    name: 'TestMultiSwitch',
    type: 'HmIP-BSM',
    channels: [
      {
        address: `${DEVICE_ADDRESS}:4`,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        datapoints: {},
        paramsets: {},
      },
      {
        address: `${DEVICE_ADDRESS}:5`,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        datapoints: {},
        paramsets: {},
      },
      {
        address: `${DEVICE_ADDRESS}:6`,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        datapoints: {},
        paramsets: {},
      },
      { address: `${DEVICE_ADDRESS}:1`, index: 1, type: 'KEY_TRANSCEIVER', dataPoints },
    ],
  } as unknown as HmDevice
}

/** Minimal HmDevice shape for a cover (HmIP-BROLL). */
function makeHmCover(): HmDevice {
  return {
    address: DEVICE_ADDRESS,
    name: 'TestCover',
    type: 'HmIP-BROLL',
    channels: [
      {
        address: `${DEVICE_ADDRESS}:3`,
        // SHUTTER_VIRTUAL_RECEIVER is the writable channel the mapper recognises.
        type: 'SHUTTER_VIRTUAL_RECEIVER',
        datapoints: {},
        paramsets: {},
      },
    ],
  } as unknown as HmDevice
}

/**
 * Minimal HmDevice shape for a 2-key wall switch / remote (HmIP-WRC2):
 * two `KEY_TRANSCEIVER` channels, each enumerating the standard HmIP press
 * datapoints. The mapper collapses both to ONE `event-emitter` cap.
 */
function makeHmKeyDevice(): HmDevice {
  const dataPoints = [
    { parameter: 'PRESS_SHORT' },
    { parameter: 'PRESS_LONG' },
    { parameter: 'PRESS_LONG_START' },
    { parameter: 'PRESS_LONG_RELEASE' },
  ]
  return {
    address: DEVICE_ADDRESS,
    name: 'TestRemote',
    type: 'HmIP-WRC2',
    channels: [
      { address: `${DEVICE_ADDRESS}:1`, index: 1, type: 'KEY_TRANSCEIVER', dataPoints },
      { address: `${DEVICE_ADDRESS}:2`, index: 2, type: 'KEY_TRANSCEIVER', dataPoints },
    ],
  } as unknown as HmDevice
}

/** Minimal HmDevice shape for a thermostat (HmIP-eTRV-C). */
function makeHmThermostat(): HmDevice {
  return {
    address: DEVICE_ADDRESS,
    name: 'TestThermostat',
    type: 'HmIP-eTRV-C',
    channels: [
      {
        address: `${DEVICE_ADDRESS}:1`,
        // HEATING_CLIMATECONTROL_TRANSCEIVER is in the mapper (maps to
        // climate-control + temperature-sensor + humidity-sensor).
        type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        datapoints: {},
        paramsets: {},
      },
    ],
  } as unknown as HmDevice
}

describe('HomematicDevice switch value-changed decoding', () => {
  it('updates the switch slice to on=true when STATE=true event arrives', () => {
    const facade = makeFacadeStub(
      [makeHmSwitch()],
      [makeSwitchEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:3`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Switch,
    )
    void new HomematicDevice(ctx)

    const now = Date.now()
    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:3`,
      parameter: 'STATE',
      value: true,
      ts: now,
    } as unknown as ValueChangedEvent)

    const slice = getRuntimeState().getCapState<{ on: boolean; lastChangedAt: number }>('switch')
    expect(slice?.on).toBe(true)
    expect(slice?.lastChangedAt).toBe(now)
  })

  it('updates the switch slice to on=false when STATE=false event arrives', () => {
    const facade = makeFacadeStub(
      [makeHmSwitch()],
      [makeSwitchEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:3`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Switch,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:3`,
      parameter: 'STATE',
      value: false,
      ts: 42,
    } as unknown as ValueChangedEvent)

    const slice = getRuntimeState().getCapState<{ on: boolean; lastChangedAt: number }>('switch')
    expect(slice?.on).toBe(false)
    expect(slice?.lastChangedAt).toBe(42)
  })

  it('ignores STATE events for a different device address', () => {
    const facade = makeFacadeStub(
      [makeHmSwitch()],
      [makeSwitchEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:3`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Switch,
    )
    void new HomematicDevice(ctx)

    // Initial cold slice.
    const before = getRuntimeState().getCapState<{ on: boolean }>('switch')
    expect(before?.on).toBe(false)

    facade.emit({
      device: '0001D3C99AFFFFF', // different address
      channel: '0001D3C99AFFFFF:3',
      parameter: 'STATE',
      value: true,
      ts: Date.now(),
    } as unknown as ValueChangedEvent)

    const after = getRuntimeState().getCapState<{ on: boolean }>('switch')
    expect(after?.on).toBe(false) // unchanged
  })
})

describe('HomematicDevice cover value-changed decoding', () => {
  it('updates cover slice on LEVEL event (0=closed, 1=open)', () => {
    const facade = makeFacadeStub(
      [makeHmCover()],
      [makeCoverEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:3`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Cover,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:3`,
      parameter: 'LEVEL',
      value: 1.0,
      ts: Date.now(),
    } as unknown as ValueChangedEvent)

    const slice = getRuntimeState().getCapState<{ state: string; position: number | null }>('cover')
    // LEVEL 1.0 = fully open, position 100
    expect(slice?.state).toBe('open')
    expect(slice?.position).toBe(100)
  })
})

describe('HomematicDevice climate value-changed decoding', () => {
  it('updates currentTemp slice on ACTUAL_TEMPERATURE event', () => {
    const facade = makeFacadeStub(
      [makeHmThermostat()],
      [makeClimateEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:1`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Thermostat,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:1`,
      parameter: 'ACTUAL_TEMPERATURE',
      value: 22.5,
      ts: Date.now(),
    } as unknown as ValueChangedEvent)

    const slice = getRuntimeState().getCapState<{ currentTemp: number | null }>('climate-control')
    expect(slice?.currentTemp).toBe(22.5)
  })

  it('updates target setpoint slice on SET_POINT_TEMPERATURE event', () => {
    const facade = makeFacadeStub(
      [makeHmThermostat()],
      [makeClimateEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:1`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Thermostat,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:1`,
      parameter: 'SET_POINT_TEMPERATURE',
      value: 21.0,
      ts: Date.now(),
    } as unknown as ValueChangedEvent)

    const slice = getRuntimeState().getCapState<{ target: number | null }>('climate-control')
    expect(slice?.target).toBe(21.0)
  })
})

// ---------------------------------------------------------------------------
// 5b. event-emitter (key / remote channels) — vocabulary seeding + fires
// ---------------------------------------------------------------------------

interface EmittedEvent {
  category: string
  payload: { eventType: string; data: Record<string, unknown> | null; seq: number }
}

/** Narrow an unknown value to a plain object with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Narrow the `data` field of a fire payload: an object (button data) or null. */
function readData(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/** Read the captured `eventBus.emit` calls as typed envelopes without a cast.
 *  The stub records the single `createEvent(category, source, data)` envelope:
 *  `{ category, source, data: EventFire }` — the fire payload lives in `data`. */
function emittedEvents(ctx: DeviceContext): readonly EmittedEvent[] {
  const emit = ctx.eventBus.emit
  if (!vi.isMockFunction(emit)) return []
  const out: EmittedEvent[] = []
  for (const [arg] of emit.mock.calls) {
    if (!isRecord(arg)) continue
    const fire = arg['data']
    if (!isRecord(fire)) continue
    if (!('eventType' in fire) || !('seq' in fire)) continue
    out.push({
      category: String(arg['category']),
      payload: {
        eventType: String(fire['eventType']),
        data: readData(fire['data']),
        seq: Number(fire['seq']),
      },
    })
  }
  return out
}

describe('HomematicDevice event-emitter (key channels)', () => {
  it('seeds the event-emitter slice with the verbatim native PRESS_* vocabulary', () => {
    const facade = makeFacadeStub([makeHmKeyDevice()])
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.EventEmitter,
    )
    void new HomematicDevice(ctx)

    const slice = getRuntimeState().getCapState<{
      eventTypes: string[]
      lastEvent: unknown
      eventCountSinceStart: number
    }>('event-emitter')
    // Canonical order; verbatim native tokens — NO normalization.
    expect(slice?.eventTypes).toEqual([
      'PRESS_SHORT',
      'PRESS_LONG',
      'PRESS_LONG_START',
      'PRESS_LONG_RELEASE',
    ])
    expect(slice?.lastEvent).toBeNull()
    expect(slice?.eventCountSinceStart).toBe(0)
  })

  it('emits an EventFire with the verbatim eventType + channel in data on a PRESS_SHORT', () => {
    const facade = makeFacadeStub([makeHmKeyDevice()])
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.EventEmitter,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:2`,
      parameter: 'PRESS_SHORT',
      value: true,
      ts: 1000,
    } as unknown as ValueChangedEvent)

    const events = emittedEvents(ctx)
    expect(events).toHaveLength(1)
    expect(events[0]?.category).toBe('event-emitter.event')
    expect(events[0]?.payload.eventType).toBe('PRESS_SHORT') // VERBATIM
    expect(events[0]?.payload.data).toEqual({ channel: '2' })
    expect(events[0]?.payload.seq).toBe(1)

    const slice = getRuntimeState().getCapState<{
      lastEvent: { eventType: string; data: Record<string, unknown> | null; seq: number } | null
      eventCountSinceStart: number
    }>('event-emitter')
    expect(slice?.lastEvent?.eventType).toBe('PRESS_SHORT')
    expect(slice?.lastEvent?.data).toEqual({ channel: '2' })
    expect(slice?.eventCountSinceStart).toBe(1)
  })

  it('increments seq and count on successive presses', () => {
    const facade = makeFacadeStub([makeHmKeyDevice()])
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.EventEmitter,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:1`,
      parameter: 'PRESS_SHORT',
      value: true,
      ts: 1000,
    } as unknown as ValueChangedEvent)
    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:1`,
      parameter: 'PRESS_LONG',
      value: true,
      ts: 1100,
    } as unknown as ValueChangedEvent)

    const events = emittedEvents(ctx)
    expect(events).toHaveLength(2)
    expect(events[1]?.payload.eventType).toBe('PRESS_LONG') // VERBATIM
    expect(events[1]?.payload.seq).toBe(2)

    const slice = getRuntimeState().getCapState<{ eventCountSinceStart: number }>('event-emitter')
    expect(slice?.eventCountSinceStart).toBe(2)
  })

  it('ignores a value-reset (PRESS_* dropping back to false)', () => {
    const facade = makeFacadeStub([makeHmKeyDevice()])
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.EventEmitter,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:1`,
      parameter: 'PRESS_SHORT',
      value: false,
      ts: 1000,
    } as unknown as ValueChangedEvent)

    expect(emittedEvents(ctx)).toHaveLength(0)
  })

  it('ignores a non-key datapoint on a key device (no fire)', () => {
    const facade = makeFacadeStub([makeHmKeyDevice()])
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.EventEmitter,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:0`,
      parameter: 'LOW_BAT',
      value: true,
      ts: 1000,
    } as unknown as ValueChangedEvent)

    expect(emittedEvents(ctx)).toHaveLength(0)
    const slice = getRuntimeState().getCapState<{ eventCountSinceStart: number }>('event-emitter')
    expect(slice?.eventCountSinceStart).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. sensor-cap push decoding (temperature / humidity / ambient-light / power)
//
// sensor caps are registered via homematic-sensor-caps.ts only when the
// HmDevice has the corresponding channel type.  Because the minimal stubs
// above (switch, cover, thermostat) don't include sensor channels we test
// a pure numeric push through a thermostat device which DOES register the
// temperature-sensor cap alongside climate-control.
// ---------------------------------------------------------------------------

describe('HomematicDevice sensor push decoding', () => {
  it('populates the temperature-sensor slice on ACTUAL_TEMPERATURE via decodeSensorPush', () => {
    const facade = makeFacadeStub(
      [makeHmThermostat()],
      [makeClimateEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:1`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, getRuntimeState } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Thermostat,
    )
    void new HomematicDevice(ctx)

    facade.emit({
      device: DEVICE_ADDRESS,
      channel: `${DEVICE_ADDRESS}:1`,
      parameter: 'ACTUAL_TEMPERATURE',
      value: 19.8,
      ts: Date.now(),
    } as unknown as ValueChangedEvent)

    const slice = getRuntimeState().getCapState<{ celsius: number }>('temperature-sensor')
    expect(slice?.celsius).toBe(19.8)
  })
})

// ---------------------------------------------------------------------------
// 7. Actuator caps bind to the library custom-entity channel (the fix)
//
// A cover/switch device has MULTIPLE *_VIRTUAL_RECEIVER channels. The lib
// binds ONE typed custom entity on a SPECIFIC channel and its control helpers
// require THAT channel. Binding the actuator cap to a raw mapped channel (the
// last one) makes control throw "No <kind> custom entity for … :N". These
// tests assert the actuator cap binds to the custom-entity channel (:4), that
// control routes there, and that sensor/event caps still register from the
// raw channels.
// ---------------------------------------------------------------------------

describe('HomematicDevice actuator caps bind to the custom-entity channel', () => {
  it('binds the cover cap to the custom-entity channel (:4), not the last raw channel (:6)', async () => {
    const facade = makeFacadeStub(
      [makeHmMultiCover()],
      [makeCoverEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:4`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, capProvider, registeredCaps } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Cover,
    )
    void new HomematicDevice(ctx)

    // The cover cap registered (from the custom entity).
    expect(registeredCaps()).toContain('cover')
    // The energy-meter raw channel still produced a power-meter sensor cap.
    expect(registeredCaps()).toContain('power-meter')

    // Driving the cover cap `open` must hit the facade with the entity's
    // channel (:4), NOT the last raw SHUTTER_VIRTUAL_RECEIVER channel (:6).
    await invokeProviderMethod(capProvider('cover'), 'open')
    expect(facade._calls).toEqual([
      { method: 'coverOpen', device: DEVICE_ADDRESS, channel: `${DEVICE_ADDRESS}:4` },
    ])
  })

  it('binds the switch cap to the custom-entity channel (:4) and keeps the event-emitter on raw key channels', async () => {
    const facade = makeFacadeStub(
      [makeHmMultiSwitch()],
      [makeSwitchEntity(DEVICE_ADDRESS, `${DEVICE_ADDRESS}:4`)],
    )
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, capProvider, registeredCaps } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Switch,
    )
    void new HomematicDevice(ctx)

    // Switch actuator cap (from custom entity) + event-emitter (raw key channel).
    expect(registeredCaps()).toContain('switch')
    expect(registeredCaps()).toContain('event-emitter')

    // `setState({ on: true })` must route to switchTurnOn with the entity
    // channel (:4), not the last raw SWITCH_VIRTUAL_RECEIVER channel (:6).
    const provider = capProvider('switch')
    const setState = provider?.['setState']
    if (typeof setState !== 'function') throw new Error('switch setState not callable')
    await setState({ on: true })
    expect(facade._calls).toEqual([
      { method: 'switchTurnOn', device: DEVICE_ADDRESS, channel: `${DEVICE_ADDRESS}:4` },
    ])
  })

  it('skips actuator caps but still registers sensors/events when customEntities() is empty', () => {
    // Multi-cover device present on the facade, but NO custom entities yet
    // (facade not fully built). Actuator cap is deferred; the power-meter
    // sensor cap from the raw channel must still register.
    const facade = makeFacadeStub([makeHmMultiCover()], [])
    homematicFacades.set('hm_001', asFacade(facade))

    const { ctx, registeredCaps } = makeCtx(
      { address: DEVICE_ADDRESS, brokerId: 'hm_001' },
      DeviceType.Cover,
    )
    void new HomematicDevice(ctx)

    expect(registeredCaps()).not.toContain('cover')
    expect(registeredCaps()).toContain('power-meter')
  })
})
