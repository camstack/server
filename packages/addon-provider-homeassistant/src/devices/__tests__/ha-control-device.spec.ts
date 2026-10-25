import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaControlDevice } from '../ha-control-device.js'
import type { HaEntityState } from '../../ha-types.js'

function buildControlCtx(role: string, entityId: string): import('@camstack/types').DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null

  return {
    id: 10,
    stableId: `ha:control:10`,
    parentDeviceId: null,
    deviceMeta: {
      id: 10,
      stableId: `ha:control:10`,
      type: DeviceType.Control,
      name: 'Test Control',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      role,
      capabilities: ['control'],
    },
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    fetchDevice: vi.fn(async () => ({ deviceState: { setCapSlice: vi.fn(async () => {}) } })),
    devices: {
      create: vi.fn(async () => null),
      allocateDeviceId: vi.fn(async () => 10),
      createContext: vi.fn(() => null),
      register: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      decommission: vi.fn(async () => {}),
      getAll: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {
      broker: {
        publish: { mutate: vi.fn(async () => null) },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-ctrl-test' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
      addContext: vi.fn(),
      with: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext
}

function makeNumericState(value: string, attributes: Record<string, unknown> = {}): HaEntityState {
  return {
    state: value,
    attributes,
    last_changed: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    entity_id: 'number.test',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

describe('HaControlDevice — decodeControlSlice (numeric)', () => {
  it('populates unit, min, max, step from HA attributes', () => {
    const ctx = buildControlCtx('numeric-control', 'number.thermostat_temp')

    // Use a simple in-memory runtime state mock to capture setCapState calls
    const setCapStateCalls: Array<Record<string, unknown>> = []
    const rsMock: IDeviceRuntimeState = {
      installCapSchema: vi.fn(),
      setCapState: vi.fn((_cap: string, val: Record<string, unknown>) => {
        setCapStateCalls.push(val)
      }),
      getCapState: vi.fn(() => undefined),
      getCapField: vi.fn(),
      patchCapState: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeCap: vi.fn(() => () => {}),
      snapshot: vi.fn(() => ({})),
      flush: vi.fn(async () => {}),
    } as unknown as IDeviceRuntimeState

    ;(ctx as unknown as { bindRuntimeState: (r: IDeviceRuntimeState) => void }).bindRuntimeState =
      vi.fn((rs: IDeviceRuntimeState) => {
        Object.assign(rs, rsMock)
      })

    const device = new HaControlDevice(ctx)

    // Invoke handleStatePush via a state event with all numeric attributes
    const state = makeNumericState('21.5', {
      unit_of_measurement: '°C',
      min: 5,
      max: 30,
      step: 0.5,
    })
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(state)

    // The last setCapState call after the push should carry the new slice
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed).toBeDefined()
    expect(pushed!['kind']).toBe('numeric')
    expect(pushed!['value']).toBe(21.5)
    expect(pushed!['unit']).toBe('°C')
    expect(pushed!['min']).toBe(5)
    expect(pushed!['max']).toBe(30)
    expect(pushed!['step']).toBe(0.5)
  })

  it('omits unit/min/max/step when attributes are absent', () => {
    const ctx = buildControlCtx('numeric-control', 'number.bare')
    const setCapStateCalls: Array<Record<string, unknown>> = []
    const rsMock: IDeviceRuntimeState = {
      installCapSchema: vi.fn(),
      setCapState: vi.fn((_cap: string, val: Record<string, unknown>) => {
        setCapStateCalls.push(val)
      }),
      getCapState: vi.fn(() => undefined),
      getCapField: vi.fn(),
      patchCapState: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeCap: vi.fn(() => () => {}),
      snapshot: vi.fn(() => ({})),
      flush: vi.fn(async () => {}),
    } as unknown as IDeviceRuntimeState

    ;(ctx as unknown as { bindRuntimeState: (r: IDeviceRuntimeState) => void }).bindRuntimeState =
      vi.fn((rs: IDeviceRuntimeState) => {
        Object.assign(rs, rsMock)
      })

    void new HaControlDevice(ctx)
    const state = makeNumericState('10', {})
    // Access through a cast — handleStatePush is protected
    const device = new HaControlDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(state)

    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed).toBeDefined()
    expect(pushed!['unit']).toBeUndefined()
    expect(pushed!['min']).toBeUndefined()
    expect(pushed!['max']).toBeUndefined()
    expect(pushed!['step']).toBeUndefined()
  })

  it('ignores non-numeric min/max/step and empty unit strings', () => {
    const ctx = buildControlCtx('numeric-control', 'number.bad_attrs')
    const setCapStateCalls: Array<Record<string, unknown>> = []
    const rsMock: IDeviceRuntimeState = {
      installCapSchema: vi.fn(),
      setCapState: vi.fn((_cap: string, val: Record<string, unknown>) => {
        setCapStateCalls.push(val)
      }),
      getCapState: vi.fn(() => undefined),
      getCapField: vi.fn(),
      patchCapState: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeCap: vi.fn(() => () => {}),
      snapshot: vi.fn(() => ({})),
      flush: vi.fn(async () => {}),
    } as unknown as IDeviceRuntimeState

    ;(ctx as unknown as { bindRuntimeState: (r: IDeviceRuntimeState) => void }).bindRuntimeState =
      vi.fn((rs: IDeviceRuntimeState) => {
        Object.assign(rs, rsMock)
      })

    const device = new HaControlDevice(ctx)
    const state = makeNumericState('10', {
      unit_of_measurement: '', // empty string → omit
      min: 'five', // non-numeric → omit
      max: null, // null → omit
      step: 0, // zero step → omit (not > 0)
    })
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(state)

    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed).toBeDefined()
    expect(pushed!['unit']).toBeUndefined()
    expect(pushed!['min']).toBeUndefined()
    expect(pushed!['max']).toBeUndefined()
    expect(pushed!['step']).toBeUndefined()
  })

  it('does not affect select kind slices', () => {
    const ctx = buildControlCtx('select-control', 'select.mode')
    const setCapStateCalls: Array<Record<string, unknown>> = []
    const rsMock: IDeviceRuntimeState = {
      installCapSchema: vi.fn(),
      setCapState: vi.fn((_cap: string, val: Record<string, unknown>) => {
        setCapStateCalls.push(val)
      }),
      getCapState: vi.fn(() => undefined),
      getCapField: vi.fn(),
      patchCapState: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      subscribeCap: vi.fn(() => () => {}),
      snapshot: vi.fn(() => ({})),
      flush: vi.fn(async () => {}),
    } as unknown as IDeviceRuntimeState

    ;(ctx as unknown as { bindRuntimeState: (r: IDeviceRuntimeState) => void }).bindRuntimeState =
      vi.fn((rs: IDeviceRuntimeState) => {
        Object.assign(rs, rsMock)
      })

    const device = new HaControlDevice(ctx)
    const state: HaEntityState = {
      state: 'eco',
      attributes: { options: ['eco', 'boost', 'off'] },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      entity_id: 'select.mode',
      context: { id: '', parent_id: null, user_id: null },
    } as HaEntityState
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(state)

    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed).toBeDefined()
    expect(pushed!['kind']).toBe('select')
    expect(pushed!['options']).toEqual(['eco', 'boost', 'off'])
    // Numeric fields must not appear on select slice
    expect(pushed!['unit']).toBeUndefined()
  })
})

// ── Datetime format derivation + service dispatch ───────────────────────────

function buildDatetimeCtx(
  entityId: string,
  publishMutate = vi.fn(async () => null),
): {
  ctx: import('@camstack/types').DeviceContext
  setCapStateCalls: Array<Record<string, unknown>>
} {
  const ctx = buildControlCtx('datetime-control', entityId)
  const setCapStateCalls: Array<Record<string, unknown>> = []
  const rsMock: IDeviceRuntimeState = {
    installCapSchema: vi.fn(),
    setCapState: vi.fn((_cap: string, val: Record<string, unknown>) => {
      setCapStateCalls.push(val)
    }),
    getCapState: vi.fn(() => undefined),
    getCapField: vi.fn(),
    patchCapState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeCap: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({})),
    flush: vi.fn(async () => {}),
  } as unknown as IDeviceRuntimeState
  ;(
    ctx as unknown as { api: { broker: { publish: { mutate: typeof publishMutate } } } }
  ).api.broker.publish.mutate = publishMutate
  ;(ctx as unknown as { bindRuntimeState: (r: IDeviceRuntimeState) => void }).bindRuntimeState =
    vi.fn((rs: IDeviceRuntimeState) => {
      Object.assign(rs, rsMock)
    })
  return { ctx, setCapStateCalls }
}

function makeDatetimeState(value: string, attributes: Record<string, unknown> = {}): HaEntityState {
  return {
    state: value,
    attributes,
    last_changed: '2026-06-06T10:00:00.000Z',
    last_updated: '2026-06-06T10:00:00.000Z',
    entity_id: 'datetime.test',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

function getControlProvider(ctx: import('@camstack/types').DeviceContext): {
  setValue: (i: { deviceId: number; control: { kind: 'datetime'; value: string } }) => Promise<void>
} {
  const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
  const call = registerNativeCap.mock.calls.find(
    (c: ReadonlyArray<{ name: string }>) => c[0]?.name === 'control',
  )
  expect(call).toBeDefined()
  return call![1]
}

describe('HaControlDevice — datetime format derivation', () => {
  it('date.* → format "date"', () => {
    const { ctx, setCapStateCalls } = buildDatetimeCtx('date.alarm')
    const device = new HaControlDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeDatetimeState('2026-06-06'),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['kind']).toBe('datetime')
    expect(pushed!['format']).toBe('date')
    expect(pushed!['value']).toBe('2026-06-06')
  })

  it('time.* → format "time"', () => {
    const { ctx, setCapStateCalls } = buildDatetimeCtx('time.wake')
    const device = new HaControlDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeDatetimeState('07:30:00'),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['format']).toBe('time')
  })

  it('datetime.* → format "datetime"', () => {
    const { ctx, setCapStateCalls } = buildDatetimeCtx('datetime.event')
    const device = new HaControlDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeDatetimeState('2026-06-06T10:00:00'),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['format']).toBe('datetime')
  })

  it.each([
    [{ has_date: true, has_time: true }, 'datetime'],
    [{ has_date: true, has_time: false }, 'date'],
    [{ has_date: false, has_time: true }, 'time'],
    [{}, 'datetime'],
  ] as const)('input_datetime has_date/has_time %o → %s', (attrs, expected) => {
    const { ctx, setCapStateCalls } = buildDatetimeCtx('input_datetime.helper')
    const device = new HaControlDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeDatetimeState('2026-06-06 10:00:00', attrs),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['format']).toBe(expected)
  })

  it('time-only input_datetime stores the time value verbatim and trims to a valid time input', () => {
    // A time-only input_datetime (has_date:false, has_time:true) pushes a
    // realistic time-only state ('07:30:00'). The slice must report format
    // 'time' and keep the value verbatim; the browser <input type=time> shape
    // is derived by trimming to 'HH:MM'. `toTimeInput` is the canonical helper
    // in @camstack/ui-library (control-panel) — pure `value.slice(0, 5)`,
    // unit-tested there. Re-expressed locally to avoid importing the React
    // composite barrel into this self-contained addon's backend test.
    const toTimeInput = (value: string): string => value.slice(0, 5)

    const { ctx, setCapStateCalls } = buildDatetimeCtx('input_datetime.wake_only')
    const device = new HaControlDevice(ctx)
    ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(
      makeDatetimeState('07:30:00', { has_date: false, has_time: true }),
    )
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]
    expect(pushed!['kind']).toBe('datetime')
    expect(pushed!['format']).toBe('time')
    const storedValue = pushed!['value']
    expect(storedValue).toBe('07:30:00')
    expect(typeof storedValue).toBe('string')
    if (typeof storedValue === 'string') {
      expect(toTimeInput(storedValue)).toBe('07:30')
    }
  })
})

describe('HaControlDevice — datetime service dispatch', () => {
  it('date.* dispatch → date.set_value { date }', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildDatetimeCtx('date.alarm', publishMutate)
    void new HaControlDevice(ctx)
    const provider = getControlProvider(ctx)
    await provider.setValue({ deviceId: 10, control: { kind: 'datetime', value: '2026-12-25' } })
    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ domain: 'date', service: 'set_value' }),
        payload: { date: '2026-12-25' },
      }),
    )
  })

  it('time.* dispatch → time.set_value { time } with seconds appended', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildDatetimeCtx('time.wake', publishMutate)
    void new HaControlDevice(ctx)
    const provider = getControlProvider(ctx)
    await provider.setValue({ deviceId: 10, control: { kind: 'datetime', value: '07:30' } })
    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ domain: 'time', service: 'set_value' }),
        payload: { time: '07:30:00' },
      }),
    )
  })

  it('time.* dispatch keeps seconds when already present', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildDatetimeCtx('time.wake', publishMutate)
    void new HaControlDevice(ctx)
    const provider = getControlProvider(ctx)
    await provider.setValue({ deviceId: 10, control: { kind: 'datetime', value: '07:30:45' } })
    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { time: '07:30:45' } }),
    )
  })

  it('datetime.* dispatch → datetime.set_value { datetime }', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildDatetimeCtx('datetime.event', publishMutate)
    void new HaControlDevice(ctx)
    const provider = getControlProvider(ctx)
    await provider.setValue({
      deviceId: 10,
      control: { kind: 'datetime', value: '2026-06-06T10:00:00' },
    })
    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ domain: 'datetime', service: 'set_value' }),
        payload: { datetime: '2026-06-06T10:00:00' },
      }),
    )
  })

  it('input_datetime.* dispatch → input_datetime.set_datetime { datetime }', async () => {
    const publishMutate = vi.fn(async () => null)
    const { ctx } = buildDatetimeCtx('input_datetime.helper', publishMutate)
    void new HaControlDevice(ctx)
    const provider = getControlProvider(ctx)
    await provider.setValue({
      deviceId: 10,
      control: { kind: 'datetime', value: '2026-06-06 10:00:00' },
    })
    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ domain: 'input_datetime', service: 'set_datetime' }),
        payload: { datetime: '2026-06-06 10:00:00' },
      }),
    )
  })
})
