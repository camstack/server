/**
 * D648 — `device-extension` through the REAL router and the REAL per-device
 * collection dispatcher (D554).
 *
 * A camera's slot OWNERS are its bindings (step 0: every provider addon of a
 * collection cap), and the contract promises three things this spec pins:
 *
 *  - `listSlots` fans out and concatenates — each owner's rows, side by side;
 *  - an owner that THROWS is one `unreachable` row naming it, with the reason
 *    verbatim, and every other row survives — also when it is the camera's
 *    ONLY owner. "No extensions" must never be claimed from a failure (D315);
 *  - `listCandidates` / `setSlot` reach exactly the owner named by the
 *    `slotRef` prefix, and an unclaimed ref is refused by name (D554.5).
 *
 * Production wiring: the real `CapabilityRegistry`, `buildRuntimeCapRouters`
 * and `requireDeviceCollection`; the providers are the real
 * `createDeviceExtensionProvider` over in-memory stores. Only the stores and
 * the device-manager's `getBindings` are doubles. Production has ONE owner
 * today (device-manager, `linked-devices`); the dispatcher is generic, so the
 * second owner here is a FAKE serving a `linked-devices`-shaped row from its
 * own store — the fan-out and the prefix routing are what is under test.
 */
import { CapabilityRegistry } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import {
  createDeviceExtensionProvider,
  defineExtensionSlotProvider,
  deviceExtensionCapability,
  deviceManagerCapability,
  DeviceType,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildRuntimeCapRouters, type CapProxyProvider } from '../../api/trpc/cap-router-runtime.js'
import { type CreateCallerCapableRouter, makeCtx } from './harness.js'

const MANAGER_ADDON = 'device-manager'
const OTHER_ADDON = 'other-owner'
const CAMERA = 101

interface WarnCall {
  readonly message: string
  readonly meta: unknown
}

function makeLogger(): { readonly logger: IScopedLogger; readonly warns: WarnCall[] } {
  const warns: WarnCall[] = []
  const logger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn((message: string, meta?: unknown) => {
      warns.push({ message, meta })
    }),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
    withTags: vi.fn(() => logger),
  }
  return { logger, warns }
}

interface Stores {
  linked: number[]
  other: number[]
}

interface OwnerOptions {
  /** Make this owner's `listSlots` throw with this message. */
  readonly failWith?: string
}

function managerProvider(stores: Stores, logger: IScopedLogger, options: OwnerOptions = {}) {
  return createDeviceExtensionProvider({
    source: MANAGER_ADDON,
    label: 'Device manager',
    logger,
    hostTypeOf: async () => {
      if (options.failWith !== undefined) throw new Error(options.failWith)
      return DeviceType.Camera
    },
    slots: [
      defineExtensionSlotProvider('linked-devices', {
        list: async () => ({
          authority: 'device-manager:_linkedDeviceIds',
          activation: null,
          value: { slot: 'linked-devices', deviceIds: [...stores.linked] },
          sources: stores.linked.map((deviceId) => ({ deviceId, name: null, health: 'ok' })),
        }),
        set: async (_deviceId, value) => {
          stores.linked = [...value.deviceIds]
          return { applied: true, reload: 'none' }
        },
        candidates: async () => [
          {
            deviceId: 701,
            name: 'Porch contact',
            type: 'sensor',
            location: 'Porch',
            parentName: null,
            suggested: true,
            reason: 'same location',
          },
        ],
      }),
    ],
  })
}

function otherProvider(stores: Stores, logger: IScopedLogger, options: OwnerOptions = {}) {
  return createDeviceExtensionProvider({
    source: OTHER_ADDON,
    label: 'Other owner',
    logger,
    hostTypeOf: async () => {
      if (options.failWith !== undefined) throw new Error(options.failWith)
      return DeviceType.Camera
    },
    slots: [
      defineExtensionSlotProvider('linked-devices', {
        list: async () => ({
          authority: 'other-owner:store',
          activation: { state: 'active', authority: 'device-manager:setWrapperActive' },
          value: { slot: 'linked-devices', deviceIds: [...stores.other] },
          sources: stores.other.map((deviceId) => ({ deviceId, name: null, health: 'ok' })),
        }),
        set: async (_deviceId, value) => {
          stores.other = [...value.deviceIds]
          return { applied: true, reload: 'none' }
        },
        candidates: async () => [],
      }),
    ],
  })
}

interface Setup {
  readonly bound: readonly string[]
  readonly manager?: OwnerOptions
  readonly other?: OwnerOptions
}

function build(setup: Setup, stores: Stores, logger: IScopedLogger) {
  const registry = new CapabilityRegistry(logger)
  registry.declareCapability(deviceExtensionCapability)
  registry.registerProvider(
    'device-extension',
    MANAGER_ADDON,
    managerProvider(stores, logger, setup.manager),
  )
  registry.registerProvider(
    'device-extension',
    OTHER_ADDON,
    otherProvider(stores, logger, setup.other),
  )
  registry.declareCapability({
    ...deviceManagerCapability,
    exposesDeviceSettings: false,
    methods: {},
  })
  registry.registerProvider('device-manager', 'device-manager', {
    getBindings: async (input: { deviceId: number }) => ({
      deviceId: input.deviceId,
      entries: setup.bound.map((providerAddonId) => ({
        capName: 'device-extension',
        kind: 'wrapped' as const,
        providerAddonId,
        providerNodeId: 'hub',
        nativeAddonId: '',
      })),
    }),
  })
  registry.ready()
  const noRemoteNodes: CapProxyProvider = { createCapabilityProxy: () => null }
  const routers = buildRuntimeCapRouters({
    capabilityRegistry: registry,
    moleculer: noRemoteNodes,
    serverProviders: {},
    logger,
  })
  const router = routers['deviceExtension']
  // The one documented type boundary of this file, shared with
  // `videoclips-two-provider-dispatch.spec.ts` and `harness.ts`:
  // `buildRuntimeCapRouters` answers `Record<string, unknown>` because the
  // AppRouter TYPE is codegen-derived, so the router value is narrowed here.
  if (router === undefined) throw new Error('no router built for cap "device-extension"')
  return (router as CreateCallerCapableRouter).createCaller(makeCtx('admin'))
}

function fieldsOf(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) return []
  return value.map((row: unknown) =>
    row !== null && typeof row === 'object' ? Reflect.get(row, field) : undefined,
  )
}

const BOTH = [MANAGER_ADDON, OTHER_ADDON]

describe('device-extension — the owners of a camera are its bindings, fanned out', () => {
  it('listSlots concatenates every owner’s rows', async () => {
    const { logger } = makeLogger()
    const caller = build({ bound: BOTH }, { linked: [701], other: [702] }, logger)
    const rows = await caller['listSlots']?.({ deviceId: CAMERA })
    expect(fieldsOf(rows, 'slotRef')).toEqual([
      'device-manager:linked-devices',
      'other-owner:linked-devices',
    ])
    expect(fieldsOf(rows, 'state')).toEqual(['ok', 'ok'])
  })

  it('listSources names each owner and stamps the addon that served it', async () => {
    const { logger } = makeLogger()
    const caller = build({ bound: BOTH }, { linked: [], other: [] }, logger)
    const sources = await caller['listSources']?.({ deviceId: CAMERA })
    expect(fieldsOf(sources, 'source')).toEqual([MANAGER_ADDON, OTHER_ADDON])
    expect(fieldsOf(sources, 'addonId')).toEqual([MANAGER_ADDON, OTHER_ADDON])
  })
})

describe('device-extension — an owner that cannot answer is a ROW, never an absence', () => {
  it('a throwing owner becomes one unreachable row naming it; the other rows survive', async () => {
    const { logger, warns } = makeLogger()
    const caller = build(
      { bound: BOTH, other: { failWith: 'settings store unavailable' } },
      { linked: [701], other: [702] },
      logger,
    )
    const rows = await caller['listSlots']?.({ deviceId: CAMERA })
    expect(rows).toEqual([
      expect.objectContaining({ state: 'ok', slotRef: 'device-manager:linked-devices' }),
      { state: 'unreachable', addonId: OTHER_ADDON, reason: 'settings store unavailable' },
    ])
    expect(warns.some((w) => JSON.stringify(w.meta).includes(`"addonId":"${OTHER_ADDON}"`))).toBe(
      true,
    )
  })

  it('a camera whose ONLY owner throws still gets its row, not an error and not []', async () => {
    const { logger } = makeLogger()
    const caller = build(
      { bound: [MANAGER_ADDON], manager: { failWith: 'metadata store not ready' } },
      { linked: [701], other: [] },
      logger,
    )
    await expect(caller['listSlots']?.({ deviceId: CAMERA })).resolves.toEqual([
      { state: 'unreachable', addonId: MANAGER_ADDON, reason: 'metadata store not ready' },
    ])
  })
})

describe('device-extension — scalar calls reach the owner named by the slotRef', () => {
  it('setSlot writes the owner named by the prefix and nobody else — even on the same slot id', async () => {
    const { logger } = makeLogger()
    const stores: Stores = { linked: [701], other: [] }
    const caller = build({ bound: BOTH }, stores, logger)
    await expect(
      caller['setSlot']?.({
        deviceId: CAMERA,
        slotRef: 'other-owner:linked-devices',
        value: { slot: 'linked-devices', deviceIds: [702, 703] },
      }),
    ).resolves.toEqual({ applied: true, reload: 'none' })
    expect(stores).toEqual({ linked: [701], other: [702, 703] })
  })

  it('listCandidates reaches the linked-devices owner', async () => {
    const { logger } = makeLogger()
    const caller = build({ bound: BOTH }, { linked: [], other: [] }, logger)
    const answer = await caller['listCandidates']?.({
      deviceId: CAMERA,
      slotRef: 'device-manager:linked-devices',
    })
    expect(answer).toMatchObject({ candidates: [{ deviceId: 701, suggested: true }] })
  })

  it('an unclaimed slotRef is refused by name, and no store is written', async () => {
    const { logger } = makeLogger()
    const stores: Stores = { linked: [701], other: [] }
    const caller = build({ bound: BOTH }, stores, logger)
    await expect(
      caller['setSlot']?.({
        deviceId: CAMERA,
        slotRef: 'provider-homeassistant:consumables-graft',
        value: { slot: 'linked-devices', deviceIds: [9] },
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('provider-homeassistant:consumables-graft'),
    })
    expect(stores).toEqual({ linked: [701], other: [] })
  })

  it('a value under the wrong slot is refused by the schema before any owner', async () => {
    const { logger } = makeLogger()
    const stores: Stores = { linked: [701], other: [] }
    const caller = build({ bound: BOTH }, stores, logger)
    await expect(
      caller['setSlot']?.({
        deviceId: CAMERA,
        slotRef: 'device-manager:linked-devices',
        value: { slot: 'consumables-graft', deviceIds: [9] },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(stores.linked).toEqual([701])
  })
})
