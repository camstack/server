/**
 * Unit tests for motion-wasm device-settings contribution.
 *
 * Exercises `getDeviceSettingsContribution`, `getDeviceLiveContribution`,
 * and `applyDeviceSettingsPatch` directly on the addon class (the cap
 * provider). `BaseAddon` is not initialized here — we inject a minimal
 * `ctx` with a settings double, which is all the three methods touch.
 */
import { describe, it, expect, vi } from 'vitest'
import MotionWasmAddon from '../addon/index.js'

function makeCtx() {
  const store: Record<number, Record<string, unknown>> = {}
  return {
    ctx: {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(function (this: unknown) {
          return this
        }),
      },
      settings: {
        readDeviceStore: vi.fn(async (deviceId: number) => ({ ...store[deviceId] })),
        writeDeviceStore: vi.fn(async (deviceId: number, patch: Record<string, unknown>) => {
          store[deviceId] = { ...store[deviceId], ...patch }
        }),
      },
    },
    store,
  }
}

function makeAddon() {
  const addon = new MotionWasmAddon()
  const { ctx, store } = makeCtx()
  Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
  return { addon, store }
}

describe('MotionWasmAddon — device-settings contribution', () => {
  const CAM_ID = 1

  it('returns schema + hydrated defaults for a device with no stored settings', async () => {
    const { addon } = makeAddon()
    const contribution = await addon.getDeviceSettingsContribution({ deviceId: CAM_ID })
    expect(contribution).not.toBeNull()
    const section = contribution!.sections[0]!
    expect(section.id).toBe('motion-wasm-settings')
    // Retagged to the dedicated `motion` tab in the device-aggregate
    // rework — previously 'detection' (legacy catch-all).
    expect(section.tab).toBe('motion')
    const threshold = section.fields.find((f) => (f as { key?: string }).key === 'threshold')
    expect(threshold).toBeDefined()
    expect((threshold as { value?: unknown }).value).toBe(45) // DEFAULT_CONFIG.threshold
  })

  it('live contribution is always null (motion-wasm has no live info)', async () => {
    const { addon } = makeAddon()
    expect(await addon.getDeviceLiveContribution({ deviceId: CAM_ID })).toBeNull()
  })

  it('applyDeviceSettingsPatch writes to the device store and invalidates the cache', async () => {
    const { addon, store } = makeAddon()

    await addon.applyDeviceSettingsPatch({ deviceId: CAM_ID, patch: { threshold: 99 } })
    expect(store[CAM_ID]?.['threshold']).toBe(99)

    // Subsequent contribution read reflects the updated value.
    const contribution = await addon.getDeviceSettingsContribution({ deviceId: CAM_ID })
    const threshold = contribution!.sections[0]!.fields.find(
      (f) => (f as { key?: string }).key === 'threshold',
    )
    expect((threshold as { value?: unknown }).value).toBe(99)
  })
})

describe('MotionWasmAddon — the rule a camera is on is visible in the log', () => {
  // The D394 rollout gesture is a settings write, and a settings write is
  // invisible. This line is how an operator confirms the camera moved.
  const CAM_ID = 7

  it('logs the LEGACY rule for a camera nobody has moved', async () => {
    const { addon } = makeAddon()
    await addon['getDeviceConfig'](String(CAM_ID))
    const logger = addon['ctx'].logger as unknown as { info: ReturnType<typeof vi.fn> }
    const line = logger.info.mock.calls.find((c) => c[0] === 'motion area rule resolved')
    expect(line).toBeDefined()
    expect(line?.[1]).toMatchObject({
      tags: { deviceId: CAM_ID },
      meta: { rule: 'legacy-per-region', minArea: 1500 },
    })
  })

  it('logs the MERGED rule once minArea is set to 0, and only on change', async () => {
    const { addon } = makeAddon()
    const logger = addon['ctx'].logger as unknown as { info: ReturnType<typeof vi.fn> }

    await addon['getDeviceConfig'](String(CAM_ID))
    await addon.applyDeviceSettingsPatch({ deviceId: CAM_ID, patch: { minArea: 0 } })
    await addon['getDeviceConfig'](String(CAM_ID))
    // A second resolve with nothing changed must not add a line.
    addon['deviceConfigCache'].delete(String(CAM_ID))
    await addon['getDeviceConfig'](String(CAM_ID))

    const lines = logger.info.mock.calls.filter((c) => c[0] === 'motion area rule resolved')
    expect(lines).toHaveLength(2)
    expect(lines[1]?.[1]).toMatchObject({
      tags: { deviceId: CAM_ID },
      meta: { rule: 'merged-relative', minArea: 0 },
    })
  })
})
