/**
 * D648 — the `device-extension` contract and its generated slot table.
 *
 *  - The generated union accepts each slot's value and REFUSES a value under
 *    the wrong `slot` (the discriminant is what routes a write to its owner).
 *  - Every table row points at the cap that really declares the descriptor.
 *  - The cap resolves the per-device mount (D554), so a camera's owners are
 *    its bindings and not the first registered provider.
 *  - The owner-side factory offers a slot only on its host types, routes a
 *    write by `slotRef`, refuses a value for another slot by name, and logs
 *    the write tagged with the device.
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveCapMount } from '../capabilities/capability-definition.js'
import { deviceExtensionCapability } from '../capabilities/device-extension.cap.js'
import { deviceManagerCapability } from '../capabilities/device-manager.cap.js'
import {
  createDeviceExtensionProvider,
  defineExtensionSlotProvider,
} from '../device-extension/slot-provider.js'
import { DeviceType } from '../device/device-type.js'
import {
  EXTENSION_HOST_DEVICE_TYPES,
  EXTENSION_SLOT_IDS,
  EXTENSION_SLOTS,
  type ExtensionSlotValue,
  ExtensionSlotValueSchema,
} from '../generated/extension-slots.js'
import type { IScopedLogger } from '../interfaces/logging.js'

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
    withTags: vi.fn(() => logger),
  }
  return logger
}

describe('generated extension slots', () => {
  it('declares exactly one slot, by its owning cap (slice 6, D671)', () => {
    expect([...EXTENSION_SLOT_IDS]).toEqual(['linked-devices'])
    expect(EXTENSION_SLOTS['linked-devices'].declaringCap).toBe(deviceManagerCapability.name)
    expect(deviceManagerCapability.extensionSlots).toContain(
      EXTENSION_SLOTS['linked-devices'].descriptor,
    )
  })

  it('accepts each slot value under its own slot', () => {
    for (const slot of EXTENSION_SLOT_IDS) {
      expect(ExtensionSlotValueSchema.safeParse({ slot, deviceIds: [12, 13] }).success).toBe(true)
    }
  })

  it('refuses a value under an undeclared slot, and a malformed value under a real one', () => {
    expect(ExtensionSlotValueSchema.safeParse({ slot: 'battery', deviceIds: [1] }).success).toBe(
      false,
    )
    expect(
      ExtensionSlotValueSchema.safeParse({ slot: 'linked-devices', deviceIds: ['12'] }).success,
    ).toBe(false)
    expect(ExtensionSlotValueSchema.safeParse({ slot: 'linked-devices' }).success).toBe(false)
  })

  it('offers device-extension exactly where a slot is offered', () => {
    expect(EXTENSION_HOST_DEVICE_TYPES).toEqual([DeviceType.Camera])
    expect(deviceExtensionCapability.deviceTypes).toBe(EXTENSION_HOST_DEVICE_TYPES)
  })
})

describe('device-extension capability', () => {
  it('resolves the per-device mount — its owners are the device’s, never the first registered', () => {
    expect(resolveCapMount(deviceExtensionCapability).kind).toBe('device-scoped')
  })

  it('declares no store-shaped method — the contract is a view', () => {
    const methods = Object.keys(deviceExtensionCapability.methods)
    expect(methods.toSorted()).toEqual(['listCandidates', 'listSlots', 'listSources', 'setSlot'])
    expect(deviceExtensionCapability.methods.setSlot.auth).toBe('admin')
  })
})

describe('createDeviceExtensionProvider', () => {
  const CAMERA = 101
  const SENSOR = 700

  function makeProvider(logger: IScopedLogger, written: number[][]) {
    const linked = defineExtensionSlotProvider('linked-devices', {
      list: async () => ({
        authority: 'device-manager:_linkedDeviceIds',
        activation: null,
        value: { slot: 'linked-devices', deviceIds: [701] },
        sources: [{ deviceId: 701, name: 'Porch contact', health: 'ok' }],
      }),
      set: async (_deviceId, value) => {
        written.push([...value.deviceIds])
        return { applied: true, reload: 'none' }
      },
      candidates: async () => [],
    })
    return createDeviceExtensionProvider({
      source: 'device-manager',
      label: 'Device manager',
      slots: [linked],
      hostTypeOf: async (deviceId) => (deviceId === CAMERA ? DeviceType.Camera : DeviceType.Sensor),
      logger,
    })
  }

  it('lists the slot on a camera, routed by `<source>:<slot>`, and nothing on a sensor', async () => {
    const provider = makeProvider(makeLogger(), [])
    const rows = await provider.listSlots({ deviceId: CAMERA })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      state: 'ok',
      slotRef: 'device-manager:linked-devices',
      slot: 'linked-devices',
      value: { slot: 'linked-devices', deviceIds: [701] },
    })
    // D663: an association row carries no graft switch and no projected cap.
    expect(rows[0]).not.toHaveProperty('enabled')
    expect(rows[0]).not.toHaveProperty('projects')
    expect(await provider.listSlots({ deviceId: SENSOR })).toEqual([])
  })

  it('writes through the owner and logs the write tagged with the device', async () => {
    const logger = makeLogger()
    const written: number[][] = []
    const provider = makeProvider(logger, written)
    await expect(
      provider.setSlot({
        deviceId: CAMERA,
        slotRef: 'device-manager:linked-devices',
        value: { slot: 'linked-devices', deviceIds: [701, 702] },
      }),
    ).resolves.toEqual({ applied: true, reload: 'none' })
    expect(written).toEqual([[701, 702]])
    expect(logger.info).toHaveBeenCalledWith(
      'device-extension: slot written',
      expect.objectContaining({ tags: { deviceId: CAMERA } }),
    )
  })

  it('refuses a value for ANOTHER slot by name, before the owner sees it', async () => {
    const written: number[][] = []
    const provider = makeProvider(makeLogger(), written)
    // A value as it arrives over the wire for a slot this owner does not serve.
    // With one declared slot the typed API cannot spell it, so it is built at an
    // untyped boundary (JSON.parse), not cast: the owner-side guard is the D648
    // rule the NEXT slot relies on, and nothing else pins it.
    const foreign: ExtensionSlotValue = JSON.parse('{"slot":"probe","deviceIds":[701]}')
    await expect(
      provider.setSlot({
        deviceId: CAMERA,
        slotRef: 'device-manager:linked-devices',
        value: foreign,
      }),
    ).rejects.toThrow(/"probe" value was sent to slot "linked-devices"/)
    expect(written).toEqual([])
  })

  it('refuses a slotRef it does not serve, and a slot on a host it is not offered on', async () => {
    const provider = makeProvider(makeLogger(), [])
    await expect(
      provider.listCandidates({ deviceId: CAMERA, slotRef: 'other-owner:linked-devices' }),
    ).rejects.toThrow(/not a slot of "device-manager"/)
    await expect(
      provider.listCandidates({ deviceId: SENSOR, slotRef: 'device-manager:linked-devices' }),
    ).rejects.toThrow(/not offered on device 700/)
  })
})
