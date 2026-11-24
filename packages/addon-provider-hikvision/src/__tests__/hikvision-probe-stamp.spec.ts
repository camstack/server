/**
 * The Hikvision probe overrides the base `onProbe`, so it must stamp the
 * `feature-probe` slice itself: it never did, and 615 stayed `probed: false`
 * for ever (the kernel retried a probe that had worked, and every export
 * carry-forward gate stayed shut). A probe that FAILS names why, with the id.
 *
 * Disarm: drop the `super.onProbe()` call and the first case fails.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HikvisionCamera } from '../hikvision-camera.js'

interface WarnLine {
  readonly message: string
  readonly deviceId: number | undefined
}

class ProbeCamera extends HikvisionCamera {
  constructor(
    ctx: DeviceContext,
    private readonly accessoryProbe: () => Promise<void>,
  ) {
    super(ctx)
  }
  protected override async probeAndPersistAccessoryCaps(): Promise<void> {
    await this.accessoryProbe()
  }
  override ensureClient(): ReturnType<HikvisionCamera['ensureClient']> {
    // Unset while the base constructor runs: only the probe's own client use throws.
    if (this.accessoryProbe === undefined) return super.ensureClient()
    throw new Error('no client in this spec')
  }
  probedAt(): number {
    return (
      this.runtimeState.getCapState<{ lastProbedAt?: number }>('feature-probe')?.lastProbedAt ?? 0
    )
  }
}

function bootCtx(warns: WarnLine[]): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  // The kernel's DeviceContext is far wider than the camera's constructor reads: the one documented spec boundary.
  const ctx = {
    id: 7,
    stableId: 'stub:7',
    parentDeviceId: null,
    deviceMeta: {
      id: 7,
      stableId: 'stub:7',
      addonId: 'stub',
      type: DeviceType.Camera,
      name: 'Camera',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {
      host: '192.0.2.10',
      port: 80,
      username: 'admin',
      password: 'x',
      deviceCache: {},
    },
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string, opts?: { tags?: { deviceId?: number } }) => {
        warns.push({ message, deviceId: opts?.tags?.deviceId })
      },
      error: () => {},
      child() {
        return this
      },
      withTags() {
        return this
      },
    },
    api: {},
  } as unknown as DeviceContext
  return ctx
}

describe('HikvisionCamera.onProbe stamps the feature-probe slice', () => {
  it('a successful accessory-cap probe marks the device probed', async () => {
    const camera = new ProbeCamera(bootCtx([]), async () => {})
    expect(camera.probedAt()).toBe(0)
    await camera.onProbe()
    expect(camera.probedAt()).toBeGreaterThan(0)
  })

  it('a failed accessory-cap probe leaves it unprobed and logs the reason with the device id', async () => {
    const warns: WarnLine[] = []
    const camera = new ProbeCamera(bootCtx(warns), async () => {
      throw new Error('ISAPI 401')
    })
    await camera.onProbe()
    expect(camera.probedAt()).toBe(0)
    expect(warns.filter((w) => w.message.includes('accessory cap probe failed'))).toEqual([
      expect.objectContaining({ deviceId: 7 }),
    ])
  })
})
