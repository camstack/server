import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  BaseDevice,
  DeviceType,
  ERROR_STATUS_COLD,
  deviceErrorEdge,
  type DeviceContext,
  type ErrorStatus,
} from '@dominevo/types'

interface RuntimeStateLike {
  installCapSchema(capName: string, schema: z.ZodObject<z.core.$ZodLooseShape>): void
}
interface CapLike {
  readonly name: string
  readonly runtimeState?: z.ZodObject<z.core.$ZodLooseShape>
}

const schema = z.object({})

function fixture(): {
  device: FaultyDevice
  emit: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
} {
  let runtimeState: RuntimeStateLike | undefined
  const emit = vi.fn().mockResolvedValue(undefined)
  const update = vi.fn().mockResolvedValue(undefined)
  const ctx = {
    id: 42,
    stableId: 'vac-1',
    parentDeviceId: null,
    persistedConfig: {},
    deviceMeta: {
      id: 42,
      stableId: 'vac-1',
      addonId: 'test-addon',
      type: DeviceType.Sensor,
      name: 'Robot',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    api: { alerts: { emit: { mutate: emit }, update: { mutate: update } } },
    eventBus: { emit: vi.fn(), subscribe: vi.fn() },
    persistConfig: vi.fn(),
    bindRuntimeState: (rs: RuntimeStateLike) => {
      runtimeState = rs
    },
    registerNativeCap: vi.fn((cap: CapLike) => {
      if (cap.runtimeState) runtimeState?.installCapSchema(cap.name, cap.runtimeState)
    }),
    fetchDevice: vi.fn(),
  } as unknown as DeviceContext
  return { device: new FaultyDevice(ctx), emit, update }
}

class FaultyDevice extends BaseDevice<typeof schema> {
  features = [] as const
  constructor(ctx: DeviceContext) {
    super(ctx, schema, { type: DeviceType.Sensor })
    this.registerErrorCap()
  }
  report(reading: ErrorStatus): Promise<void> {
    return this.publishError(reading)
  }
}

const fault = (patch: Partial<ErrorStatus> = {}): ErrorStatus => ({
  active: true,
  code: '38',
  label: 'Dust bin missing',
  severity: 'error',
  since: null,
  lastFetchedAt: 1,
  ...patch,
})
const clear: ErrorStatus = { ...ERROR_STATUS_COLD, active: false, lastFetchedAt: 2 }

describe('deviceErrorEdge', () => {
  it('null/cold to true starts, true to false resolves, unknown never edges', () => {
    expect(deviceErrorEdge(undefined, fault())).toBe('start')
    expect(deviceErrorEdge(ERROR_STATUS_COLD, fault())).toBe('start')
    expect(deviceErrorEdge(fault(), clear)).toBe('resolve')
    expect(deviceErrorEdge(fault(), fault({ code: '39' }))).toBeNull()
    expect(deviceErrorEdge(fault(), ERROR_STATUS_COLD)).toBeNull()
    expect(deviceErrorEdge(clear, ERROR_STATUS_COLD)).toBeNull()
    expect(deviceErrorEdge(ERROR_STATUS_COLD, clear)).toBeNull()
  })
})

describe('BaseDevice.publishError', () => {
  it('emits once on start and once on resolve, and never for unknown', async () => {
    const { device, emit, update } = fixture()
    await device.report(ERROR_STATUS_COLD)
    await device.report(clear)
    expect(emit).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()

    await device.report(fault())
    await device.report(fault({ lastFetchedAt: 3 }))
    expect(emit).toHaveBeenCalledTimes(1)
    const alert = emit.mock.calls[0]?.[0]
    expect(alert).toMatchObject({
      severity: 'critical',
      source: { type: 'device', id: '42' },
      status: 'active',
    })

    await device.report(ERROR_STATUS_COLD)
    expect(update).not.toHaveBeenCalled()
    await device.report(clear)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      alertId: 'device-error:42',
      patch: { status: 'completed' },
    })
    await device.report(clear)
    expect(update).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('stamps since on a start that did not carry one', async () => {
    const { device } = fixture()
    await device.report(fault())
    const stored = device.runtimeState.getCapState('error')
    expect(typeof stored?.['since']).toBe('number')
  })
})
