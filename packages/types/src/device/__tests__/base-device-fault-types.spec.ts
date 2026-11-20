import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { BaseDevice } from '../base-device.js'
import { DeviceType } from '../device-type.js'
import type { DeviceContext } from '../device-context.js'
import type { IDeviceRuntimeState } from '../device-runtime-state.js'
import type { DeviceFeature } from '../device-type.js'
import type { DeviceFaultType } from '../../capabilities/error.cap.js'
import type {
  CapabilityDefinition,
  InferNativeProvider,
} from '../../capabilities/capability-definition.js'
import { buildDeviceErrorAlert } from '../device-error-episode.js'
import { ERROR_STATUS_COLD } from '../../capabilities/error.cap.js'

class FaultDevice extends BaseDevice<z.ZodObject<Record<string, never>>> {
  readonly features: readonly DeviceFeature[] = []
  constructor(ctx: DeviceContext) {
    super(ctx, z.object({}), { type: DeviceType.Gateway })
  }
  enable(types?: readonly DeviceFaultType[]): void {
    if (types !== undefined) this.declareFaultTypes(types)
    this.registerErrorCap()
  }
}

function makeCtx(providers: Map<string, unknown>): DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  return {
    id: 5,
    stableId: 'fault-device',
    parentDeviceId: null,
    persistedConfig: {},
    persistConfig: vi.fn().mockResolvedValue(undefined),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    eventBus: { emit: vi.fn(), subscribe: vi.fn() },
    deviceMeta: {
      id: 5,
      stableId: 'fault-device',
      addonId: 'test-addon',
      type: DeviceType.Gateway,
      name: 'Gateway',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    fetchDevice: vi.fn().mockResolvedValue({
      deviceState: { setCapSlice: { mutate: vi.fn().mockResolvedValue(undefined) } },
    }),
    bindRuntimeState: (state: IDeviceRuntimeState) => {
      runtimeStateRef = state
    },
    registerNativeCap<TCap extends CapabilityDefinition>(
      cap: TCap,
      provider: InferNativeProvider<TCap>,
    ): void {
      providers.set(cap.name, provider)
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(cap.name, cap.runtimeState)
      }
    },
  } as unknown as DeviceContext
}

async function listTypes(providers: Map<string, unknown>): Promise<unknown> {
  const fn: unknown = Reflect.get(providers.get('error') ?? {}, 'listFaultTypes')
  if (typeof fn !== 'function') throw new Error('no error.listFaultTypes registered')
  return fn({ deviceId: 5 })
}

describe('error.listFaultTypes (the fault catalog)', () => {
  it('is [] until the integration declares one', async () => {
    const providers = new Map<string, unknown>()
    new FaultDevice(makeCtx(providers)).enable()
    expect(await listTypes(providers)).toEqual({ types: [] })
  })

  it('serves what the integration declared', async () => {
    const providers = new Map<string, unknown>()
    const types: DeviceFaultType[] = [
      { code: 'unreach', label: 'Unreachable', severity: 'error' },
      { code: 'low-bat', label: 'Battery low', severity: 'warning' },
    ]
    new FaultDevice(makeCtx(providers)).enable(types)
    expect(await listTypes(providers)).toEqual({ types })
  })
})

describe('buildDeviceErrorAlert metadata', () => {
  it('carries every active fault and the principal label', () => {
    const alert = buildDeviceErrorAlert(
      5,
      'CCU',
      {
        ...ERROR_STATUS_COLD,
        active: true,
        code: 'a',
        label: 'Fault A',
        faults: [
          { code: 'a', label: 'Fault A', severity: 'error' },
          { code: 'b', label: 'Fault B', severity: 'warning' },
        ],
      },
      1,
    )
    expect(alert.metadata).toMatchObject({
      label: 'Fault A',
      faults: [
        { code: 'a', label: 'Fault A', severity: 'error' },
        { code: 'b', label: 'Fault B', severity: 'warning' },
      ],
    })
  })

  it('names the principal when the status lists no faults', () => {
    const alert = buildDeviceErrorAlert(
      5,
      'CCU',
      { ...ERROR_STATUS_COLD, active: true, code: 'a', label: null },
      1,
    )
    expect(alert.metadata?.['faults']).toEqual([{ code: 'a', label: 'a', severity: 'error' }])
  })
})
