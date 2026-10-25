import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaImageDevice } from '../ha-image-device.js'
import type { HaEntityState } from '../../ha-types.js'

interface BuildResult {
  ctx: import('@camstack/types').DeviceContext
  setCapStateCalls: Array<Record<string, unknown>>
  warnCalls: Array<unknown[]>
  getBrokerConfig: ReturnType<typeof vi.fn>
}

function buildImageCtx(
  entityId: string,
  getBrokerConfig: ReturnType<typeof vi.fn> = vi.fn(async () => ({
    baseUrl: 'http://192.168.10.142:8123',
    accessToken: 'x',
  })),
): BuildResult {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const setCapStateCalls: Array<Record<string, unknown>> = []
  const warnCalls: Array<unknown[]> = []

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

  const warn = vi.fn((...args: unknown[]) => {
    warnCalls.push(args)
  })

  const ctx = {
    id: 99,
    stableId: `ha:image:99`,
    parentDeviceId: null,
    deviceMeta: {
      id: 99,
      stableId: `ha:image:99`,
      type: DeviceType.Image,
      name: 'Test Image',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['image'],
    },
    initialRuntimeState: {},
    eventBus: {
      emit: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      getRecent: vi.fn(() => []),
    },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: vi.fn((rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
      Object.assign(rs, rsMock)
    }),
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
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-image-test' })) },
        unsubscribe: { mutate: vi.fn(async () => {}) },
        getBrokerConfig: { query: getBrokerConfig },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: vi.fn(),
      // withTags returns a logger that also routes warn into the same spy.
      withTags: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
        addContext: vi.fn(),
        with: vi.fn(),
      })),
      addContext: vi.fn(),
      with: vi.fn(),
    },
  } as unknown as import('@camstack/types').DeviceContext

  return { ctx, setCapStateCalls, warnCalls, getBrokerConfig }
}

function makeState(value: string, attributes: Record<string, unknown> = {}): HaEntityState {
  return {
    state: value,
    attributes,
    last_changed: '2026-06-06T10:00:00.000Z',
    last_updated: '2026-06-06T10:00:00.000Z',
    entity_id: 'image.front_door',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

/** Like makeState but with an explicit `last_updated` for recency tests. */
function makeStateAt(lastUpdated: string, attributes: Record<string, unknown> = {}): HaEntityState {
  return {
    state: '2026-06-06T10:00:00+00:00',
    attributes,
    last_changed: lastUpdated,
    last_updated: lastUpdated,
    entity_id: 'image.front_door',
    context: { id: '', parent_id: null, user_id: null },
  } as HaEntityState
}

function pushState(device: HaImageDevice, state: HaEntityState): void {
  ;(device as unknown as { handleStatePush: (s: HaEntityState) => void }).handleStatePush(state)
}

/** Flush queued microtasks so the fire-and-forget resolveAndSet completes. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('HaImageDevice', () => {
  it('registers the "image" cap on construction', () => {
    const { ctx } = buildImageCtx('image.front_door')
    void new HaImageDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const names: string[] = registerNativeCap.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toContain('image')
  })

  it('builds an absolute url from the stubbed base url, preserving the token', async () => {
    const { ctx, setCapStateCalls } = buildImageCtx('image.front_door')
    const device = new HaImageDevice(ctx)
    pushState(
      device,
      makeState('2026-06-06T10:00:00+00:00', {
        entity_picture: '/api/image_proxy/image.front_door?token=abc123',
      }),
    )
    await flush()
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    expect(pushed['url']).toBe(
      'http://192.168.10.142:8123/api/image_proxy/image.front_door?token=abc123',
    )
    expect(pushed['lastUpdated']).toBe(Date.parse('2026-06-06T10:00:00.000Z'))
  })

  it('resolves the base url only once across multiple pushes', async () => {
    const { ctx, getBrokerConfig } = buildImageCtx('image.front_door')
    const device = new HaImageDevice(ctx)
    pushState(device, makeState('t1', { entity_picture: '/p?token=a' }))
    await flush()
    pushState(device, makeState('t2', { entity_picture: '/p?token=b' }))
    await flush()
    expect(getBrokerConfig).toHaveBeenCalledTimes(1)
  })

  it('sets url null when entity_picture is absent', async () => {
    const { ctx, setCapStateCalls } = buildImageCtx('image.front_door')
    const device = new HaImageDevice(ctx)
    pushState(device, makeState('t1', {}))
    await flush()
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    expect(pushed['url']).toBeNull()
    expect(pushed['lastUpdated']).toBe(Date.parse('2026-06-06T10:00:00.000Z'))
  })

  it('leaves url null + warns when base-url resolution fails (no throw)', async () => {
    const failing = vi.fn(async () => {
      throw new Error('broker offline')
    })
    const { ctx, setCapStateCalls, warnCalls } = buildImageCtx('image.front_door', failing)
    const device = new HaImageDevice(ctx)
    expect(() =>
      pushState(
        device,
        makeState('t1', {
          entity_picture: '/api/image_proxy/image.front_door?token=abc',
        }),
      ),
    ).not.toThrow()
    await flush()
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    expect(pushed['url']).toBeNull()
    expect(warnCalls.length).toBeGreaterThan(0)
  })

  it('leaves url null + warns when the broker config has no baseUrl', async () => {
    const noBase = vi.fn(async () => ({ supervisorToken: 'sup' }))
    const { ctx, setCapStateCalls, warnCalls } = buildImageCtx('image.front_door', noBase)
    const device = new HaImageDevice(ctx)
    pushState(device, makeState('t1', { entity_picture: '/p?token=a' }))
    await flush()
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    expect(pushed['url']).toBeNull()
    expect(warnCalls.length).toBeGreaterThan(0)
  })

  it('passes an already-absolute entity_picture through unchanged (token preserved)', async () => {
    const { ctx, setCapStateCalls } = buildImageCtx('image.front_door')
    const device = new HaImageDevice(ctx)
    const abs = 'https://custom.local/snapshot.jpg?token=xyz'
    pushState(device, makeState('2026-06-06T10:00:00+00:00', { entity_picture: abs }))
    await flush()
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    // `new URL(abs, base)` returns the absolute url untouched, token intact.
    expect(pushed['url']).toBe(abs)
  })

  it('a newer null push wins over a slower async resolve of an older push', async () => {
    // Defer the broker-config resolve so the first (older, with-picture) push
    // is still resolving when the second (newer, null) sync push lands.
    let releaseConfig: ((cfg: Record<string, unknown>) => void) | null = null
    const deferred = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          releaseConfig = resolve
        }),
    )
    const { ctx, setCapStateCalls } = buildImageCtx('image.front_door', deferred)
    const device = new HaImageDevice(ctx)

    // Older push WITH entity_picture — async resolve pends on the deferred config.
    pushState(
      device,
      makeStateAt('2026-06-06T10:00:00.000Z', {
        entity_picture: '/api/image_proxy/image.front_door?token=old',
      }),
    )
    // Newer push WITHOUT entity_picture — sync null write, newer last_updated.
    pushState(device, makeStateAt('2026-06-06T10:00:05.000Z', {}))

    // Now let the older push's base-url resolve complete.
    releaseConfig!({ baseUrl: 'http://192.168.10.142:8123' })
    await flush()

    // The newer null write must win — the stale image must NOT overwrite it.
    const pushed = setCapStateCalls[setCapStateCalls.length - 1]!
    expect(pushed['url']).toBeNull()
    expect(pushed['lastUpdated']).toBe(Date.parse('2026-06-06T10:00:05.000Z'))
  })

  it('getStatus reads the runtime slice (read-only, no service methods)', () => {
    const { ctx } = buildImageCtx('image.front_door')
    void new HaImageDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const call = registerNativeCap.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'image',
    )
    expect(call).toBeDefined()
    const provider = call![1] as Record<string, unknown>
    expect(typeof provider['getStatus']).toBe('function')
    expect(Object.keys(provider)).toEqual(['getStatus'])
  })
})
