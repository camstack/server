/**
 * THE acceptance test of slice 2 (D663): the PetKit feeder Home Assistant
 * imports, CUSTOMIZED — through the real components (`feeder-world.ts` says
 * which are real and which are faked at the edge, and why nothing is pre-seeded).
 *
 * Three customizations, one per device (one-per-target holds):
 *   - FEEDER: ADDS `consumables` (the desiccant, read through `number(d)` from
 *     the `enum-sensor` HA really registers) and `battery` — both GRAFTED;
 *   - FOOD (`binary_sensor.freshelement_3_food_level`): "Invert state", a
 *     REPLACE of `binary.on` reading its own native (rule 5);
 *   - BATTERY_CAM (synthetic, native battery): `charging` REPLACED from
 *     ANOTHER device, the feeder's `battery_charging` child.
 *
 * A replaced field is served on EVERY getStatus path — the D13 resolver
 * (`getNativeProvider` → the claimed-status overlay), the hub's status
 * aggregate, and a child→child call through `createParentUnownedCallHandler`
 * with its `claimedStatus` wired to the real registry (S3).
 *
 * WHAT STAYS FOR THE LIVE CHECK (Task 16) — this spec runs the hub-style path,
 * with a `capabilityRegistry`, and cannot see:
 *   - `createContext` on a FOREIGN device id in the shipped forked composer
 *     runner (`udsMode`: the graft lands in `workerNativeCaps`, and the hub
 *     learns it only through the runner's UDS `updateCaps`);
 *   - `LocalChildRegistry` routing after a retract (an ungraft re-sends
 *     `updateCaps`; that the hub stops routing the (cap, device) to the
 *     composer runner is only observable live);
 *   - the UDS paths themselves (sibling short-circuit, `callCapOnChild`): here
 *     the child→child entry is `createParentUnownedCallHandler`, the one of the
 *     three transport entries a hub-local harness can drive.
 */
import {
  type Composition,
  CompositionSchema,
  type CompositionSourceRef,
  compositionSourceKey,
  EventCategory,
  feederCustomizationExample,
  type StatusOverlayAnswer,
} from '@camstack/types'
import type { ServiceBroker } from 'moleculer'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import type { HubNodeRegistry } from '../../../kernel/moleculer/node-registry.js'
import type { CapRoute } from '../../../kernel/transport/cap-route.js'
import type { CapRouteResolver } from '../../../kernel/transport/cap-route-resolver.js'
import { createParentUnownedCallHandler } from '../../../kernel/transport/parent-unowned-call.js'
import { OWNED_FIELDS_KEY } from '../../device-manager/field-ownership.js'
import { NodeDeadlineTimer } from '../deadline-timer.js'
import {
  BATTERY_CAM,
  BATTERY_CHARGING,
  BATTERY_STATUS,
  DESICCANT_DAYS,
  FEEDER,
  FOOD,
  HA,
  SOURCES,
} from './feeder-fixture.js'
import {
  adoptHa,
  buildWorld,
  CALLER,
  type PersistedHub,
  type ProviderRecord,
  type World,
} from './feeder-world.js'

const T0 = 1_700_000_000_000
/** The mirror's debounced disk writer: the row holds a native slice only once it has run. */
const DISK_DEBOUNCE_MS = 1_100
/** Zero-delay turns a converge's event cascade takes to go quiet; generous, and still a bound. */
const SETTLE_TURNS = 60

const FOOD_BLOCK = 'blk-2'
const CAM_BLOCK = 'blk-3'
const FEEDER_BLOCK = 'blk-1'

function from(source: CompositionSourceRef, cap: string, fieldPath: string) {
  return { kind: 'from', source, cap, fieldPath } as const
}

/** "Invert state": FOOD's `binary.on` becomes `!on` of its own native. */
const INVERT_FOOD: Composition = CompositionSchema.parse({
  target: { kind: 'existing', device: FOOD },
  features: [
    {
      kind: 'fields',
      cap: 'binary',
      fields: {
        on: { kind: 'expression', expr: '!on', bindings: { on: from(FOOD, 'binary', 'on') } },
      },
    },
  ],
})

/** FOOD's `on` from ANOTHER device (assertion 10): `!c`, c = the feeder's battery_charging. */
const FOOD_FROM_CHARGING: Composition = CompositionSchema.parse({
  target: { kind: 'existing', device: FOOD },
  features: [
    {
      kind: 'fields',
      cap: 'binary',
      fields: {
        on: {
          kind: 'expression',
          expr: '!c',
          bindings: { c: from(BATTERY_CHARGING, 'binary', 'on') },
        },
      },
    },
  ],
})

/** BATTERY_CAM's native `charging` replaced from the feeder's battery_charging child. */
const CAM_CHARGING: Composition = CompositionSchema.parse({
  target: { kind: 'existing', device: BATTERY_CAM },
  features: [
    {
      kind: 'fields',
      cap: 'battery',
      fields: {
        charging: {
          kind: 'expression',
          expr: 'c ? "dc" : "unknown"',
          bindings: { c: from(BATTERY_CHARGING, 'binary', 'on') },
        },
      },
    },
  ],
})

const CAM_NATIVE = { percentage: 80, charging: 'none', sleeping: false, lastUpdated: T0 }

let w: World
let armed: MockInstance<NodeDeadlineTimer['arm']>

async function settle(): Promise<void> {
  for (let i = 0; i < SETTLE_TURNS; i++) await new Promise<void>((r) => setImmediate(r))
}

async function converge(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await w.supervisor.converge()
    await settle()
  }
}

const id = (ref: CompositionSourceRef): number => w.ha.id(ref)

async function create(composition: Composition): Promise<string> {
  const { block } = await w.compositions.createComposition({
    block: { enabled: true, composition },
    caller: CALLER,
  })
  return block.id
}

async function state(blockId: string) {
  const [s] = (await w.composer.getStates({ blockIds: [blockId] })).states
  if (s === undefined) throw new Error(`no composer state for ${blockId}`)
  return s
}

async function slice(ref: CompositionSourceRef, cap: string) {
  return w.dm.deviceState.getCapSlice({ deviceId: id(ref), capName: cap })
}

async function claimsOn(ref: CompositionSourceRef): Promise<readonly string[]> {
  const listing = await w.dm.deviceState.listClaims({})
  if (listing.state !== 'loaded') throw new Error('claims index not loaded')
  return listing.claims
    .filter((c) => c.deviceId === id(ref))
    .map((c) => `${c.capName}:${c.fields.join(',')}`)
}

/** Every `setCapSlice`-emitted change of `cap` on `ref`, in order (the PUBLIC channel). */
function stateEvents(ref: CompositionSourceRef, cap: string, since = 0) {
  return w.events.slice(since).flatMap((e) => {
    // The originals only: a parent-scope copy (`via`) re-carries the same data.
    if (e.category !== EventCategory.DeviceStateChanged || e.via !== undefined) return []
    const data = e.data
    if (data['deviceId'] !== id(ref) || data['capName'] !== cap) return []
    return [data]
  })
}

function releases(since = 0): readonly unknown[] {
  return w.hubCalls
    .slice(since)
    .filter((c) => c.path === 'deviceState.releaseClaim')
    .map((c) => c.input)
}

/** No co-resident sibling owns the device: route STRAIGHT to the HA runner's own provider. */
function childToChildHandler() {
  const resolver = {
    // The route's shape is this fake's own: `dispatch` below reads only its cap.
    resolveCapRoute: (capName: string): CapRoute => ({
      kind: 'hub-in-process',
      capName,
      ref: { invoke: async () => null },
    }),
    dispatch: async (route: CapRoute, method: string, args: unknown) => {
      const deviceId =
        typeof args === 'object' && args !== null ? Reflect.get(args, 'deviceId') : undefined
      if (typeof deviceId !== 'number') throw new Error('no deviceId')
      const fn = w.ha.runnerProvider(deviceId, route.capName)[method]
      if (fn === undefined) throw new Error(`HA serves no ${route.capName}.${method}`)
      return fn(args)
    },
  }
  const handler = createParentUnownedCallHandler({
    // The handler calls only `resolveCapRoute` + `dispatch`; documented test
    // boundary, as `parent-unowned-call-claimed-status.spec.ts`.
    getResolver: () => resolver as unknown as CapRouteResolver,
    broker: { nodeID: 'hub' } as unknown as ServiceBroker,
    nodeRegistry: { listNativeCapEntriesForDevice: () => [] } as unknown as HubNodeRegistry,
    claimedStatus: (capName, deviceId): Promise<StatusOverlayAnswer> =>
      w.capabilities.resolveClaimedStatus(capName, deviceId),
  })
  return (capName: string, method: string, args: unknown): Promise<unknown> =>
    handler({ capName, method, args })
}

interface ThreePaths {
  readonly resolver: unknown
  readonly aggregate: unknown
  readonly childToChild: unknown
}

/** getStatus of (cap, device) on all three hub paths. */
async function getStatusEverywhere(ref: CompositionSourceRef, cap: string): Promise<ThreePaths> {
  const deviceId = id(ref)
  const native = w.capabilities.getNativeProvider<ProviderRecord>(cap, deviceId)
  const getStatus = native?.['getStatus']
  if (getStatus === undefined) throw new Error(`no native ${cap}@${deviceId}`)
  return {
    resolver: await getStatus({ deviceId }),
    aggregate: (await w.dm.provider.getDeviceStatusAggregate({ deviceId, caps: [cap] }))[cap],
    childToChild: await childToChildHandler()(cap, 'getStatus', { deviceId }),
  }
}

/** Each path judged on its own (`expect.soft`), so a red names WHICH path answered the native. */
async function expectEverywhere(
  ref: CompositionSourceRef,
  cap: string,
  expected: unknown,
): Promise<void> {
  const paths = await getStatusEverywhere(ref, cap)
  expect.soft(paths.resolver, 'the D13 resolver (getNativeProvider)').toEqual(expected)
  expect.soft(paths.aggregate, 'getDeviceStatusAggregate').toEqual(expected)
  expect.soft(paths.childToChild, 'child→child (createParentUnownedCallHandler)').toEqual(expected)
}

async function pushOn(ref: CompositionSourceRef, on: boolean, at: number): Promise<void> {
  await w.ha.push(id(ref), 'binary', { on, lastChangedAt: at })
  await settle()
}

async function bootCustomized(): Promise<void> {
  await w.blocks.load()
  expect(await create(feederCustomizationExample(SOURCES))).toBe(FEEDER_BLOCK)
  expect(await create(INVERT_FOOD)).toBe(FOOD_BLOCK)
  expect(await create(CAM_CHARGING)).toBe(CAM_BLOCK)
  // The composer's own rows read empty once, then the claims index reads empty
  // once: each needs the next apply's read to agree before anything is claimed (D49).
  await converge(3)
  for (const b of [FEEDER_BLOCK, FOOD_BLOCK, CAM_BLOCK])
    expect(await state(b), b).toMatchObject({ status: 'running' })
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  vi.setSystemTime(T0)
  armed = vi.spyOn(NodeDeadlineTimer.prototype, 'arm')
  w = await buildWorld()
  await adoptHa(w.ha, T0)
  await settle()
  await bootCustomized()
})

afterEach(async () => {
  await w.composerAddon.shutdown()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('1 — the added caps are grafted beside the HA natives; a replace grafts nothing', () => {
  it('getBindings(feeder) lists battery + consumables served by the composer; getBindings(cam) keeps HA', async () => {
    const feeder = await w.dm.provider.getBindings({ deviceId: id(FEEDER) })
    const byCap = new Map(feeder.entries.map((e) => [e.capName, e.providerAddonId]))
    expect(byCap.get('battery')).toBe('composer')
    expect(byCap.get('consumables')).toBe('composer')
    expect(byCap.get('device-status')).toBe(HA)
    const cam = await w.dm.provider.getBindings({ deviceId: id(BATTERY_CAM) })
    expect(cam.entries.find((e) => e.capName === 'battery')?.providerAddonId).toBe(HA)
  })
})

describe('2 — the added slices, as the status aggregate shows them', () => {
  it('the desiccant item, keyed, with remaining days; battery percentage null while battery_status is unavailable — never 0 (D393)', async () => {
    const agg = await w.dm.provider.getDeviceStatusAggregate({
      deviceId: id(FEEDER),
      caps: ['battery', 'consumables'],
    })
    expect(agg['consumables']).toEqual({
      items: [
        {
          key: 'desiccant',
          label: 'Desiccant',
          remaining: { value: 0, kind: 'duration' },
          status: 'replace',
          level: null,
          lastResetAt: null,
          resettable: false,
        },
      ],
      lastChangedAt: T0,
    })
    expect(agg['battery']).toMatchObject({ percentage: null, charging: 'unknown', binary: true })
  })
})

describe('3 — the grafted methods answer through the Task 7 wrapper', () => {
  it('consumables.reset refuses by its declared reason; battery.wakeForStream answers { awoke: false }', async () => {
    const feederId = id(FEEDER)
    // The provider every consumer resolves (D13) — and it IS the overlay's
    // wrapper: both caps are claimed, so a spread-shaped wrap would lose these.
    expect((await w.capabilities.resolveClaimedStatus('battery', feederId)).kind).toBe('claimed')
    expect((await w.capabilities.resolveClaimedStatus('consumables', feederId)).kind).toBe(
      'claimed',
    )
    const consumables = w.capabilities.getProviderForDevice<ProviderRecord>('consumables', feederId)
    const battery = w.capabilities.getProviderForDevice<ProviderRecord>('battery', feederId)
    await expect(
      consumables?.['reset']?.({ deviceId: feederId, key: 'desiccant' }),
    ).rejects.toThrow('a composed consumable is not resettable until commands (forward) arrive')
    await expect(
      battery?.['wakeForStream']?.({ deviceId: feederId, timeoutMs: 1000 }),
    ).resolves.toEqual({ awoke: false, durationMs: 0 })
  })
})

describe('4 — a source change is event-driven', () => {
  it('the desiccant reads 30 → the item shows 30 days, ok; no deadline timer was ever armed', async () => {
    await w.ha.push(id(DESICCANT_DAYS), 'enum-sensor', { value: '30', lastFetchedAt: T0 + 1 })
    await settle()
    const consumables = await slice(FEEDER, 'consumables')
    expect(consumables?.['items']).toEqual([
      expect.objectContaining({
        key: 'desiccant',
        remaining: { value: 30, kind: 'duration' },
        status: 'ok',
      }),
    ])
    // `now` fields need no deadline: nothing here is a poll (D3).
    expect(armed).not.toHaveBeenCalled()
  })
})

describe('5 — the replace witness, on every getStatus path (S3)', () => {
  it('FOOD: !on of its own native, and native writes never oscillate the effective value', async () => {
    expect(await slice(FOOD, 'binary')).toMatchObject({ on: true })
    await expectEverywhere(FOOD, 'binary', expect.objectContaining({ on: true }))
    const mark = w.events.length
    const effective: boolean[] = []
    for (const [i, native] of [true, false, true, false].entries()) {
      await pushOn(FOOD, native, T0 + 1 + i)
      const now = await slice(FOOD, 'binary')
      effective.push(now?.['on'] === true)
    }
    expect(effective).toEqual([false, true, false, true])
    // The PUBLIC channel: each native write first re-emits the merge (the
    // native's new lastChangedAt under the STILL-composed `on`), then the
    // composer's new `on` — so each native write is exactly ONE flip of `on`
    // on the channel, starting from the effective `true` before it. A native
    // leaking onto the channel adds a flip back per write.
    const flips = stateEvents(FOOD, 'binary', mark)
      .map((d) => Reflect.get(Reflect.get(d, 'slice') ?? {}, 'on'))
      .filter((on, i, all) => i === 0 || on !== all[i - 1])
    expect(flips).toEqual([true, false, true, false, true])
    await expectEverywhere(FOOD, 'binary', expect.objectContaining({ on: true }))
  })

  it('BATTERY_CAM: charging from another device; percentage stays native; wakeForStream still reaches HA', async () => {
    await pushOn(BATTERY_CHARGING, true, T0 + 1)
    await expectEverywhere(BATTERY_CAM, 'battery', { ...CAM_NATIVE, charging: 'dc' })
    // A native write under the claim: its unowned fields follow the native, and
    // the public channel never carries the native `charging: 'none'`.
    const mark = w.events.length
    const next = { ...CAM_NATIVE, percentage: 70, lastUpdated: T0 + 2 }
    await w.ha.push(id(BATTERY_CAM), 'battery', next)
    await settle()
    const published = stateEvents(BATTERY_CAM, 'battery', mark).map((d) => Reflect.get(d, 'slice'))
    expect(published).toEqual([{ ...next, charging: 'dc' }])
    await expectEverywhere(BATTERY_CAM, 'battery', { ...next, charging: 'dc' })
    await expect(
      childToChildHandler()('battery', 'wakeForStream', {
        deviceId: id(BATTERY_CAM),
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ awoke: true, durationMs: 0 })
  })
})

describe('6 — restore exactly', () => {
  it('deleting the three blocks hands every field back: last native slices, no graft, no $owned, no claim; HA natives untouched', async () => {
    await pushOn(FOOD, true, T0 + 1)
    const lastFoodNative = { on: true, lastChangedAt: T0 + 1 }
    for (const b of [FEEDER_BLOCK, FOOD_BLOCK, CAM_BLOCK]) await w.blocks.delete(b)
    await converge(2)
    await vi.advanceTimersByTimeAsync(DISK_DEBOUNCE_MS)
    await settle()

    expect(await slice(FOOD, 'binary')).toEqual(lastFoodNative)
    expect(await slice(BATTERY_CAM, 'battery')).toEqual(CAM_NATIVE)
    const feeder = await w.dm.provider.getBindings({ deviceId: id(FEEDER) })
    expect(feeder.entries.map((e) => e.capName)).not.toContain('battery')
    expect(feeder.entries.map((e) => e.capName)).not.toContain('consumables')
    // Task 10: the ungraft removed only the composer's entries — HA's stay.
    expect(feeder.entries.find((e) => e.capName === 'device-status')?.providerAddonId).toBe(HA)
    expect(w.capabilities.getNativeAddonId('device-status', id(FEEDER))).toBe(HA)
    for (const ref of [FEEDER, FOOD, BATTERY_CAM])
      expect(await w.dm.settings.readDeviceRuntimeState(id(ref))).not.toHaveProperty(
        OWNED_FIELDS_KEY,
      )
    expect(await w.dm.deviceState.listClaims({})).toEqual({ state: 'loaded', claims: [] })
  })
})

describe('7 — boot safety: a restart from the persisted rows only', () => {
  async function restart(persisted: PersistedHub, failing: readonly string[] = []) {
    await w.composerAddon.shutdown()
    w = await buildWorld({
      from: persisted,
      // `core_blocks` answers not-loaded for the first apply.
      blockStoreReadFailures: 1,
      beforeComposer: async ({ ha, failingSliceReads }) => {
        for (const slot of failing) failingSliceReads.add(slot)
        await adoptHa(ha, T0 + 10, persisted.haIds)
      },
    })
    await settle()
  }

  async function persistedAfterBoot(): Promise<PersistedHub> {
    await vi.advanceTimersByTimeAsync(DISK_DEBOUNCE_MS)
    await settle()
    return await w.persisted()
  }

  it('the owned values are served from the row while core_blocks has not loaded; nothing is released, no native flash', async () => {
    const persisted = await persistedAfterBoot()
    await restart(persisted)

    expect(await slice(FOOD, 'binary')).toMatchObject({ on: true })
    await converge() // core_blocks not loaded: nothing is claimed or released (D49)
    expect(w.blocks.isLoaded()).toBe(false)
    expect(releases()).toEqual([])
    expect(await claimsOn(FOOD)).toEqual(['binary:on'])
    expect(await slice(FOOD, 'binary')).toMatchObject({ on: true })

    await converge(3)
    expect(w.blocks.isLoaded()).toBe(true)
    expect(await state(FOOD_BLOCK)).toMatchObject({ status: 'running' })
    expect(releases()).toEqual([])
    await expectEverywhere(FOOD, 'binary', expect.objectContaining({ on: true }))
    // The native `on: false` was re-pushed at boot: it never reached the public channel.
    const ons = stateEvents(FOOD, 'binary').map((d) =>
      Reflect.get(Reflect.get(d, 'slice') ?? {}, 'on'),
    )
    expect(ons.length).toBeGreaterThan(0)
    expect(ons.every((on) => on === true)).toBe(true)
  })

  it('a persisted claim whose source cannot be read on the first applies is NOT released (Task 9)', async () => {
    const persisted = await persistedAfterBoot()
    const chargingId = id(BATTERY_CHARGING)
    await restart(persisted, [`${chargingId}#binary`])
    await converge(4)
    expect(releases()).toEqual([])
    expect(await claimsOn(BATTERY_CAM)).toEqual(['battery:charging'])
    expect(await state(CAM_BLOCK)).toMatchObject({ status: 'starting' })

    w.failingSliceReads.clear()
    await pushOn(BATTERY_CHARGING, true, T0 + 20)
    await converge()
    expect(await state(CAM_BLOCK)).toMatchObject({ status: 'running' })
    expect(await slice(BATTERY_CAM, 'battery')).toMatchObject({ charging: 'dc' })
    expect(releases()).toEqual([])
  })
})

describe('8 — a gone source', () => {
  it('the desiccant child row deleted: failed by name, remaining.value null (never a stale 30), battery keeps updating', async () => {
    await w.ha.push(id(DESICCANT_DAYS), 'enum-sensor', { value: '30', lastFetchedAt: T0 + 1 })
    await settle()
    await w.dm.provider.removeDevice({ deviceId: id(DESICCANT_DAYS) })
    await settle()
    await converge(2)
    const s = await state(FEEDER_BLOCK)
    expect(s.status).toBe('failed')
    expect(s.reason).toContain(DESICCANT_DAYS.stableId)
    const consumables = await slice(FEEDER, 'consumables')
    expect(consumables?.['items']).toEqual([
      expect.objectContaining({ key: 'desiccant', remaining: { value: null, kind: 'duration' } }),
    ])
    await w.ha.push(id(BATTERY_STATUS), 'enum-sensor', { value: 'low', lastFetchedAt: T0 + 2 })
    await settle()
    expect(await slice(FEEDER, 'battery')).toMatchObject({ percentage: 15 })
  })
})

describe('9 — a gone target', () => {
  it('the FEEDER row deleted: failed naming it, both grafts unregistered on its id, no composer binding left', async () => {
    const feederId = id(FEEDER)
    await w.dm.provider.removeDevice({ deviceId: feederId })
    await settle()
    await converge(2)
    const s = await state(FEEDER_BLOCK)
    expect(s.status).toBe('failed')
    expect(s.reason).toContain(FEEDER.stableId)
    const ctx = w.graftContexts.get(feederId)
    expect(ctx?.unregisterNativeCap).toHaveBeenCalledWith('battery')
    expect(ctx?.unregisterNativeCap).toHaveBeenCalledWith('consumables')
    const bindings = await w.dm.provider.getBindings({ deviceId: feederId })
    expect(bindings.entries.filter((e) => e.providerAddonId === 'composer')).toEqual([])
  })
})

describe('10 — a source unavailable hands the field back; back, it is re-claimed (S1b)', () => {
  async function customizeFoodFromCharging(): Promise<void> {
    const stored = w.blocks.get(FOOD_BLOCK)
    if (stored === null) throw new Error('no FOOD block')
    await w.compositions.updateComposition({
      blockId: FOOD_BLOCK,
      expectedUpdatedAt: stored.updatedAt,
      block: { composition: FOOD_FROM_CHARGING },
      caller: CALLER,
    })
    await pushOn(FOOD, true, T0 + 1)
    await pushOn(BATTERY_CHARGING, true, T0 + 2)
    await converge()
    expect(await slice(FOOD, 'binary')).toMatchObject({ on: false })
    expect(await state(FOOD_BLOCK)).toMatchObject({ status: 'running' })
  }

  it('unregistered → released after ONE apply: native on every path, one native event, degraded by name; registered → re-claimed', async () => {
    await customizeFoodFromCharging()
    const chargingId = id(BATTERY_CHARGING)
    const mark = w.events.length
    w.ha.unregister(chargingId, 'binary')
    await settle()
    await converge()

    expect(await claimsOn(FOOD)).toEqual([])
    const nativeFood = { on: true, lastChangedAt: T0 + 1 }
    expect(await slice(FOOD, 'binary')).toEqual(nativeFood)
    await expectEverywhere(FOOD, 'binary', nativeFood)
    const foodEvents = stateEvents(FOOD, 'binary', mark)
    expect(foodEvents).toHaveLength(1)
    expect(Reflect.get(foodEvents[0] ?? {}, 'slice')).toEqual(nativeFood)
    expect(foodEvents[0]).not.toHaveProperty('native')
    const degraded = await state(FOOD_BLOCK)
    expect(degraded.status).toBe('degraded')
    expect(degraded.reason).toContain('binary.on')
    expect(degraded.reason).toContain(compositionSourceKey(BATTERY_CHARGING))

    // The same unregister releases BATTERY_CAM's charging: its native 'none'
    // shows on every path — never 'unknown', although the enum could say it.
    expect(await claimsOn(BATTERY_CAM)).toEqual([])
    await expectEverywhere(BATTERY_CAM, 'battery', CAM_NATIVE)

    w.ha.register(chargingId, 'binary')
    await pushOn(BATTERY_CHARGING, true, T0 + 3)
    await converge()
    expect(await claimsOn(FOOD)).toEqual(['binary:on'])
    expect(await slice(FOOD, 'binary')).toMatchObject({ on: false })
    expect(await state(FOOD_BLOCK)).toMatchObject({ status: 'running' })
    expect(await claimsOn(BATTERY_CAM)).toEqual(['battery:charging'])
    expect(await slice(BATTERY_CAM, 'battery')).toMatchObject({ charging: 'dc' })
  })

  it('contrast (a): the source merely OFFLINE is stale — the composed values stay, nothing is released (D49)', async () => {
    await customizeFoodFromCharging()
    const mark = w.hubCalls.length
    await w.ha.push(id(BATTERY_CHARGING), 'device-status', { online: false, lastChangedAt: T0 + 5 })
    await settle()
    await converge()
    expect(releases(mark)).toEqual([])
    expect(await slice(FOOD, 'binary')).toMatchObject({ on: false })
    expect(await slice(BATTERY_CAM, 'battery')).toMatchObject({ charging: 'dc' })
    expect(await claimsOn(FOOD)).toEqual(['binary:on'])
  })

  it('contrast (b): an ADDED cap has no native to hand back to — battery_status gone writes percentage null, releases nothing', async () => {
    await w.ha.push(id(BATTERY_STATUS), 'enum-sensor', { value: 'low', lastFetchedAt: T0 + 1 })
    await settle()
    expect(await slice(FEEDER, 'battery')).toMatchObject({ percentage: 15 })
    const mark = w.hubCalls.length
    w.ha.unregister(id(BATTERY_STATUS), 'enum-sensor')
    await settle()
    await converge()
    expect(releases(mark)).toEqual([])
    expect(await slice(FEEDER, 'battery')).toMatchObject({ percentage: null })
    expect(await claimsOn(FEEDER)).toContain(
      'battery:percentage,binary,charging,sleeping,lastUpdated',
    )
  })
})

describe('one customization per device', () => {
  it('a second customization of the feeder is refused by name and stores nothing', async () => {
    const before = w.blocks.list().length
    await expect(create(feederCustomizationExample(SOURCES))).rejects.toThrow('duplicate-target')
    expect(w.blocks.list()).toHaveLength(before)
  })
})
