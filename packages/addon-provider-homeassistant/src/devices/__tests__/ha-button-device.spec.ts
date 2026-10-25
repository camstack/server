import { describe, it, expect, vi } from 'vitest'
import { DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { HaButtonDevice } from '../ha-button-device.js'

function buildButtonCtx(
  entityId: string,
  publishMutate = vi.fn(async () => null),
): import('@camstack/types').DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null

  return {
    id: 42,
    stableId: `ha:button:42`,
    parentDeviceId: null,
    deviceMeta: {
      id: 42,
      stableId: `ha:button:42`,
      type: DeviceType.Button,
      name: 'Test Button',
      location: null,
      disabled: false,
      addonId: 'provider-homeassistant',
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'broker-ha',
      entityId,
      capabilities: ['button'],
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
      allocateDeviceId: vi.fn(async () => 42),
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
        publish: { mutate: publishMutate },
        subscribe: { mutate: vi.fn(async () => ({ subscriptionId: 'sub-btn-test' })) },
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

describe('HaButtonDevice', () => {
  it('registers the "button" cap on construction', () => {
    const publishMutate = vi.fn(async () => null)
    const ctx = buildButtonCtx('button.my_scene_button', publishMutate)
    void new HaButtonDevice(ctx)
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const registeredNames: string[] = registerNativeCap.mock.calls.map(
      (call: ReadonlyArray<{ name: string }>) => call[0]!.name,
    )
    expect(registeredNames).toContain('button')
  })

  it('press() calls broker.publish with domain derived from entity_id prefix', async () => {
    const publishMutate = vi.fn(async () => null)
    const ctx = buildButtonCtx('button.my_scene_button', publishMutate)
    void new HaButtonDevice(ctx)

    // Extract the registered provider's press method
    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const buttonCall = registerNativeCap.mock.calls.find(
      (call: ReadonlyArray<{ name: string }>) => call[0]?.name === 'button',
    )
    expect(buttonCall).toBeDefined()

    // Invoke press directly by calling callHaService through the cap
    // We verify the broker.publish mutate is called with the right domain + service
    await (buttonCall![1] as { press: (i: { deviceId: number }) => Promise<void> }).press({
      deviceId: 42,
    })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        brokerId: 'broker-ha',
        target: expect.objectContaining({
          domain: 'button',
          service: 'press',
          entityId: 'button.my_scene_button',
        }),
      }),
    )
  })

  it('press() uses "input_button" domain for input_button entity', async () => {
    const publishMutate = vi.fn(async () => null)
    const ctx = buildButtonCtx('input_button.doorbell_test', publishMutate)
    void new HaButtonDevice(ctx)

    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const buttonCall = registerNativeCap.mock.calls.find(
      (call: ReadonlyArray<{ name: string }>) => call[0]?.name === 'button',
    )
    expect(buttonCall).toBeDefined()

    await (buttonCall![1] as { press: (i: { deviceId: number }) => Promise<void> }).press({
      deviceId: 42,
    })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          domain: 'input_button',
          service: 'press',
        }),
      }),
    )
  })

  it('press() on a scene entity calls scene.turn_on (NOT scene.press)', async () => {
    const publishMutate = vi.fn(async () => null)
    const ctx = buildButtonCtx('scene.movie_night', publishMutate)
    void new HaButtonDevice(ctx)

    const registerNativeCap = ctx.registerNativeCap as ReturnType<typeof vi.fn>
    const buttonCall = registerNativeCap.mock.calls.find(
      (call: ReadonlyArray<{ name: string }>) => call[0]?.name === 'button',
    )
    expect(buttonCall).toBeDefined()

    await (buttonCall![1] as { press: (i: { deviceId: number }) => Promise<void> }).press({
      deviceId: 42,
    })

    expect(publishMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          domain: 'scene',
          service: 'turn_on',
          entityId: 'scene.movie_night',
        }),
      }),
    )
  })
})
