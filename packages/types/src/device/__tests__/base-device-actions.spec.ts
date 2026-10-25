import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { BaseDevice } from '../base-device.js'
import { DeviceType } from '../device-type.js'
import { deviceCustomAction } from '../../capabilities/custom-actions.js'
import type { DeviceContext } from '../device-context.js'
import type { IDeviceRuntimeState } from '../device-runtime-state.js'
import type { CustomActionSpec } from '../../capabilities/custom-actions.js'
import type { DeviceFeature } from '../device-type.js'
import type {
  CapabilityDefinition,
  InferNativeProvider,
} from '../../capabilities/capability-definition.js'

class TestDevice extends BaseDevice<z.ZodObject<Record<string, never>>> {
  readonly features: readonly DeviceFeature[] = []

  constructor(ctx: DeviceContext) {
    super(ctx, z.object({}), { type: DeviceType.Camera })
  }

  reg<TIn extends z.ZodType, TOut extends z.ZodType>(
    name: string,
    spec: CustomActionSpec<TIn, TOut>,
    handler: (input: z.infer<TIn>) => Promise<z.infer<TOut>>,
  ): void {
    this.registerDeviceAction(name, spec, handler)
  }
}

let mockIdCounter = 1

function makeCtx(): DeviceContext {
  const id = mockIdCounter++
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }

  // Mirrors the kernel's context-factory pattern: bindRuntimeState captures
  // the device's runtimeState so registerNativeCap can install cap schemas.
  let runtimeStateRef: IDeviceRuntimeState | null = null

  return {
    id,
    stableId: `test-device-${id}`,
    parentDeviceId: null,
    persistedConfig: {},
    persistConfig: vi.fn().mockResolvedValue(undefined),
    logger: noopLogger as unknown as DeviceContext['logger'],
    api: new Proxy(
      {},
      {
        get(): never {
          throw new Error('test: ctx.api not stubbed')
        },
      },
    ) as unknown as DeviceContext['api'],
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as DeviceContext['eventBus'],
    deviceMeta: {
      id,
      stableId: `test-device-${id}`,
      addonId: 'test-addon',
      type: DeviceType.Camera,
      name: 'Test Device',
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
      _provider: InferNativeProvider<TCap>,
    ): void {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(cap.name, cap.runtimeState)
      }
    },
    devices: {
      allocateDeviceId: vi.fn().mockResolvedValue(id),
      create: vi.fn(),
      createContext: vi.fn(),
      register: vi.fn(),
      remove: vi.fn(),
      decommission: vi.fn(),
      applyDerivedSpec: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      getChildren: vi.fn().mockResolvedValue([]),
      loadConfig: vi.fn().mockResolvedValue({}),
      persistInitialConfig: vi.fn().mockResolvedValue(id),
      setName: vi.fn().mockResolvedValue(undefined),
      setLocation: vi.fn().mockResolvedValue(undefined),
      setDisabled: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as DeviceContext
}

describe('BaseDevice custom actions', () => {
  it('runDeviceAction dispatches to the registered handler with validated input', async () => {
    const dev = new TestDevice(makeCtx())
    dev.reg(
      'double',
      deviceCustomAction(z.object({ v: z.number() }), z.object({ doubled: z.number() }), {
        kind: 'mutation',
      }),
      async (i: { v: number }) => ({ doubled: i.v * 2 }),
    )
    expect(await dev.runDeviceAction('double', { v: 21 })).toEqual({ doubled: 42 })
  })

  it('throws on unknown action', async () => {
    const dev = new TestDevice(makeCtx())
    await expect(dev.runDeviceAction('nope', {})).rejects.toThrow(/unknown device action/i)
  })

  it('validates input against the spec schema', async () => {
    const dev = new TestDevice(makeCtx())
    dev.reg(
      'needsNum',
      deviceCustomAction(z.object({ v: z.number() }), z.void(), { kind: 'mutation' }),
      async () => {},
    )
    await expect(dev.runDeviceAction('needsNum', { v: 'x' })).rejects.toThrow()
  })
})
