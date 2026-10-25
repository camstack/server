import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { BaseDevice, DeviceType, DeviceFeature } from '@camstack/types'
import type { AddonApi, DeviceContext } from '@camstack/types'

// Test fixture: nothing under test exercises ctx.api — throw loudly if a
// test path accidentally reaches into it so the failure surfaces instead
// of pretending the call succeeded.
function unstubbedAddonApi(): AddonApi {
  const proxy: unknown = new Proxy(
    {},
    {
      get(): never {
        throw new Error('test: ctx.api is not stubbed')
      },
    },
  )
  return proxy as AddonApi
}

const testSchema = z.object({
  ip: z.string().default('192.168.10.1').describe('IP Address'),
  port: z.number().default(554).describe('Port'),
})

class TestCamera extends BaseDevice<typeof testSchema> {
  features = [DeviceFeature.NativeSnapshot] as const

  constructor(ctx: DeviceContext) {
    super(ctx, testSchema, { type: DeviceType.Camera })
  }
}

class BaseDeviceWithParent extends BaseDevice<typeof testSchema> {
  features = [] as const
  constructor(ctx: DeviceContext) {
    super(ctx, testSchema, { type: DeviceType.Camera })
  }
}

let mockIdCounter = 100

/** The slice of `DeviceRuntimeState` this fixture needs — declared structurally
 *  so the test does not import a class it never constructs. */
interface DeviceRuntimeStateLike {
  installCapSchema(capName: string, schema: z.ZodObject<z.core.$ZodLooseShape>): void
}
interface CapWithRuntimeState {
  readonly name: string
  readonly runtimeState?: z.ZodObject<z.core.$ZodLooseShape>
}

function mockDeviceContext(
  stableId: string,
  parentDeviceId: number | null = null,
  persistedConfig: Record<string, unknown> = {},
  name = 'Test Cam',
): DeviceContext {
  const id = mockIdCounter++
  let runtimeState: DeviceRuntimeStateLike | undefined
  return {
    id,
    stableId,
    parentDeviceId,
    persistedConfig,
    // REQUIRED, and deliberately so: `name` / `location` / `disabled` come
    // exclusively from the kernel-managed meta surface, with no fallback to an
    // `options.name` — the only way to set a display name is through the meta
    // API. `BaseDevice` therefore throws without this, and its comment says in
    // as many words that "test fixtures must supply it explicitly". This one
    // did not, and had not since the requirement landed: five specs failing on
    // `ctx.deviceMeta is required`, which is the constructor working.
    deviceMeta: {
      id,
      stableId,
      addonId: 'test-addon',
      type: DeviceType.Camera,
      name,
      location: null,
      disabled: false,
      parentDeviceId,
      metadata: null,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    } as unknown as DeviceContext['logger'],
    api: unstubbedAddonApi(),
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as DeviceContext['eventBus'],
    persistConfig: vi.fn(),
    devices: {
      allocateDeviceId: vi.fn().mockResolvedValue(1),
      create: vi.fn(),
      createContext: vi.fn(),
      register: vi.fn(),
      remove: vi.fn(),
      getAll: vi.fn().mockResolvedValue([]),
      getChildren: vi.fn().mockResolvedValue([]),
      loadConfig: vi.fn().mockResolvedValue({}),
      persistInitialConfig: vi.fn().mockResolvedValue(1),
    },
    // The production context wires these two together, and the fixture has to
    // as well: `BaseDevice` binds its runtime state, then auto-registers the
    // generic `device-status` cap and SEEDS its slice synchronously. A
    // `registerNativeCap` that registers nothing leaves the write with no
    // schema, and `DeviceRuntimeState` refuses it loudly on purpose — that
    // refusal is what catches a `'batery'` typo, so the fixture must satisfy it
    // rather than the code relax for it.
    bindRuntimeState: (rs: DeviceRuntimeStateLike) => {
      runtimeState = rs
    },
    registerNativeCap: vi.fn((cap: CapWithRuntimeState) => {
      if (cap.runtimeState) runtimeState?.installCapSchema(cap.name, cap.runtimeState)
    }),
    fetchDevice: vi.fn(),
  } as unknown as DeviceContext
}

describe('BaseDevice', () => {
  it('initializes with correct properties', () => {
    const ctx = mockDeviceContext('cam-01', null, { ip: '10.0.0.1' })
    const cam = new TestCamera(ctx)

    expect(cam.stableId).toBe('cam-01')
    expect(cam.id).toBe(ctx.id)
    expect(cam.type).toBe(DeviceType.Camera)
    // The name comes from the kernel-managed meta surface and from nowhere
    // else — there is no `options.name` fallback, which is the whole point of
    // the constructor refusing a context without `deviceMeta`.
    expect(cam.name).toBe('Test Cam')
    // PRESUMED REACHABLE. The constructor seeds `device-status` with
    // `online: true` on purpose: a cold `false` would leave every device whose
    // driver never calls `markOnline(true)` — accessory children, never-managed
    // devices — permanently offline once `listAll` reports the real cap-state
    // flag instead of a hardcoded true. This spec asserted the old `false`.
    expect(cam.online).toBe(true)
    expect(cam.features).toContain(DeviceFeature.NativeSnapshot)
  })

  it('config is initialized from persistedConfig + schema defaults', () => {
    const ctx = mockDeviceContext('cam-01', null, { ip: '10.0.0.1' })
    const cam = new TestCamera(ctx)

    expect(cam.config.values.ip).toBe('10.0.0.1')
    expect(cam.config.values.port).toBe(554)
  })

  it('config.set persists via context', async () => {
    const ctx = mockDeviceContext('cam-01')
    const cam = new TestCamera(ctx)

    await cam.config.set('port', 8554)
    expect(cam.config.values.port).toBe(8554)
    // BaseDevice always forwards declared secret paths (empty when the schema
    // has none) so the hub can keep them in the keychain from the first write.
    expect(ctx.persistConfig).toHaveBeenCalledWith(expect.objectContaining({ port: 8554 }), {
      secretConfigPaths: [],
    })
  })

  it('sets parentDeviceId when provided via context', () => {
    const ctx = mockDeviceContext('cam-child', 42)
    const child = new BaseDeviceWithParent(ctx)
    expect(child.parentDeviceId).toBe(42)
  })

  it('removeDevice is a no-op by default', async () => {
    const ctx = mockDeviceContext('cam-01')
    const cam = new TestCamera(ctx)
    await expect(cam.removeDevice()).resolves.toBeUndefined()
  })
})
