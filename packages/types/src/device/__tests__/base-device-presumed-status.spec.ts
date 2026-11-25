/**
 * planning#713 (C) — the construction seed of `device-status` is a PRESUMPTION,
 * not an answer: it carries `unknown: true`, and the driver's first
 * `markOnline` ends it even when the value is unchanged.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { BaseDevice } from '../base-device.js'
import { DeviceType } from '../device-type.js'
import type { DeviceContext } from '../device-context.js'
import type { DeviceFeature } from '../device-type.js'
import type { IDeviceRuntimeState } from '../device-runtime-state.js'
import type { CapabilityDefinition } from '../../capabilities/capability-definition.js'
import type { DeviceStatus } from '../../capabilities/device-status.cap.js'

class PlainDevice extends BaseDevice<z.ZodObject<Record<string, never>>> {
  readonly features: readonly DeviceFeature[] = []
  constructor(ctx: DeviceContext) {
    super(ctx, z.object({}), { type: DeviceType.Gateway })
  }
  status(): DeviceStatus | undefined {
    return this.runtimeState.getCapState<DeviceStatus>('device-status')
  }
}

function makeCtx(): DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  // Test fixture boundary: only the surface BaseDevice's constructor touches.
  return {
    id: 5,
    stableId: 'plain',
    parentDeviceId: null,
    persistedConfig: {},
    persistConfig: vi.fn().mockResolvedValue(undefined),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    eventBus: { emit: vi.fn(), subscribe: vi.fn() },
    deviceMeta: {
      id: 5,
      stableId: 'plain',
      addonId: 'test-addon',
      type: DeviceType.Gateway,
      name: 'Plain',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    bindRuntimeState: (state: IDeviceRuntimeState) => {
      runtimeStateRef = state
    },
    registerNativeCap<TCap extends CapabilityDefinition>(cap: TCap): void {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(cap.name, cap.runtimeState)
      }
    },
  } as unknown as DeviceContext
}

describe('the device-status construction seed is a presumption (planning#713 C)', () => {
  it('is seeded online and marked unknown', () => {
    expect(new PlainDevice(makeCtx()).status()).toMatchObject({
      online: true,
      unknown: true,
    })
  })

  it('markOnline(true) answers: the marker is gone even though the value did not change', () => {
    const device = new PlainDevice(makeCtx())
    device.markOnline(true)
    const status = device.status()
    expect(status?.online).toBe(true)
    expect(status?.unknown).toBeUndefined()
  })

  it('markOnline(false) answers offline, without the marker', () => {
    const device = new PlainDevice(makeCtx())
    device.markOnline(false)
    expect(device.status()).toMatchObject({ online: false })
    expect(device.status()?.unknown).toBeUndefined()
  })
})
