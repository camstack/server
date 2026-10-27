/**
 * THE acceptance test of slice 2 (D663): the PetKit feeder Home Assistant
 * imports, CUSTOMIZED — through the real components (`feeder-world.ts` says
 * which are real and which are faked at the edge, and why nothing is pre-seeded).
 *
 * One customization (one-per-target holds):
 *   - FEEDER: ADDS `consumables` (the desiccant, read through `number(d)` from
 *     the `enum-sensor` HA really registers) and `battery` — both GRAFTED.
 *   - FOOD and BATTERY_CAM already serve `binary` and `battery`. A stored
 *     override of those native capabilities is refused (D944) and grafts nothing.
 *
 * WHAT STAYS FOR THE LIVE CHECK (Task 16) — this spec runs the hub-style path,
 * with a `capabilityRegistry`, and cannot see:
 *   - `createContext` on a FOREIGN device id in the shipped forked composer
 *     runner (`udsMode`: the graft lands in `workerNativeCaps`, and the hub
 *     learns it only through the runner's UDS `updateCaps`);
 *   - `LocalChildRegistry` routing after a retract (an ungraft re-sends
 *     `updateCaps`; that the hub stops routing the (cap, device) to the
 *     composer runner is only observable live);
 *   - the UDS paths themselves (sibling short-circuit, `callCapOnChild`).
 */
import {
  type Composition,
  CompositionSchema,
  type CompositionSourceRef,
  feederCustomizationExample,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
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

const CAM_NATIVE = { level: 80, charging: 'none', sleeping: false, lastUpdated: T0 }

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

function releases(since = 0): readonly unknown[] {
  return w.hubCalls
    .slice(since)
    .filter((c) => c.path === 'deviceState.releaseClaim')
    .map((c) => c.input)
}

async function pushOn(ref: CompositionSourceRef, on: boolean, at: number): Promise<void> {
  await w.ha.push(id(ref), 'binary', { on, lastChangedAt: at })
  await settle()
}

async function bootCustomized(): Promise<void> {
  await w.blocks.load()
  expect(await create(feederCustomizationExample(SOURCES))).toBe(FEEDER_BLOCK)
  // The composer's own rows read empty once, then the claims index reads empty
  // once: each needs the next apply's read to agree before anything is claimed (D49).
  await converge(3)
  expect(await state(FEEDER_BLOCK)).toMatchObject({ status: 'running' })
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
  it('the desiccant item, keyed, with remaining days; battery level null while battery_status is unavailable — never 0 (D393)', async () => {
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
    expect(agg['battery']).toMatchObject({ level: null, charging: 'unknown', binary: true })
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

describe('5 — a native capability is not replaced (D944)', () => {
  it('refuses invert-state, a cross-device binary override, and a native battery override', async () => {
    const before = w.blocks.list().length
    await expect(create(INVERT_FOOD)).rejects.toThrow('native-capability-replace')
    await expect(create(FOOD_FROM_CHARGING)).rejects.toThrow('native-capability-replace')
    await expect(create(CAM_CHARGING)).rejects.toThrow('native-capability-replace')
    expect(w.blocks.list()).toHaveLength(before)
    expect(await slice(FOOD, 'binary')).toMatchObject({ on: false })
    expect(await slice(BATTERY_CAM, 'battery')).toEqual(CAM_NATIVE)
    expect(await claimsOn(FOOD)).toEqual([])
    expect(await claimsOn(BATTERY_CAM)).toEqual([])
  })
})

describe('6 — restore exactly', () => {
  it('deleting the feeder block hands every field back: last native slices, no graft, no $owned, no claim; HA natives untouched', async () => {
    await pushOn(FOOD, true, T0 + 1)
    const lastFoodNative = { on: true, lastChangedAt: T0 + 1 }
    await w.blocks.delete(FEEDER_BLOCK)
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

  it('the grafted battery is served from the row while core_blocks has not loaded; nothing is released', async () => {
    const claims = await claimsOn(FEEDER)
    expect(claims.some((claim) => claim.startsWith('battery:'))).toBe(true)
    const persisted = await persistedAfterBoot()
    await restart(persisted)

    expect(await slice(FEEDER, 'battery')).toMatchObject({ level: null })
    await converge() // core_blocks not loaded: nothing is claimed or released (D49)
    expect(w.blocks.isLoaded()).toBe(false)
    expect(releases()).toEqual([])
    expect(await claimsOn(FEEDER)).toEqual(claims)

    await converge(3)
    expect(w.blocks.isLoaded()).toBe(true)
    expect(await state(FEEDER_BLOCK)).toMatchObject({ status: 'running' })
    expect(releases()).toEqual([])
    expect(await slice(FEEDER, 'battery')).toMatchObject({ level: null })
  })

  it('a persisted claim whose source cannot be read on the first applies is NOT released (Task 9)', async () => {
    const persisted = await persistedAfterBoot()
    const desiccantId = id(DESICCANT_DAYS)
    await restart(persisted, [`${desiccantId}#enum-sensor`])
    await converge(4)
    expect(releases()).toEqual([])
    expect((await claimsOn(FEEDER)).some((claim) => claim.startsWith('consumables:'))).toBe(true)
    const failedRead = w.hubCalls.some((call) => {
      const input = call.input
      if (typeof input !== 'object' || input === null) return false
      return (
        Reflect.get(input, 'deviceId') === desiccantId &&
        Reflect.get(input, 'capName') === 'enum-sensor'
      )
    })
    expect(failedRead).toBe(true)
    // An added cap keeps its graft when the source re-read throws (D49). It does not release.
    expect(await state(FEEDER_BLOCK)).toMatchObject({ status: 'running' })

    w.failingSliceReads.clear()
    await w.ha.push(id(DESICCANT_DAYS), 'enum-sensor', { value: '30', lastFetchedAt: T0 + 20 })
    await settle()
    await converge()
    expect(await state(FEEDER_BLOCK)).toMatchObject({ status: 'running' })
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
    expect(await slice(FEEDER, 'battery')).toMatchObject({ level: 15 })
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

describe('10 — a source unavailable on an added cap (S1b, D49)', () => {
  it('contrast (a): the source merely OFFLINE is stale — the composed values stay, nothing is released (D49)', async () => {
    await w.ha.push(id(DESICCANT_DAYS), 'enum-sensor', { value: '30', lastFetchedAt: T0 + 1 })
    await settle()
    await converge()
    const mark = w.hubCalls.length
    await w.ha.push(id(DESICCANT_DAYS), 'device-status', { online: false, lastChangedAt: T0 + 5 })
    await settle()
    await converge()
    expect(releases(mark)).toEqual([])
    const consumables = await slice(FEEDER, 'consumables')
    expect(consumables?.['items']).toEqual([
      expect.objectContaining({
        key: 'desiccant',
        remaining: { value: 30, kind: 'duration' },
      }),
    ])
  })

  it('contrast (b): an ADDED cap has no native to hand back to — battery_status gone writes level null, releases nothing', async () => {
    await w.ha.push(id(BATTERY_STATUS), 'enum-sensor', { value: 'low', lastFetchedAt: T0 + 1 })
    await settle()
    expect(await slice(FEEDER, 'battery')).toMatchObject({ level: 15 })
    const mark = w.hubCalls.length
    w.ha.unregister(id(BATTERY_STATUS), 'enum-sensor')
    await settle()
    await converge()
    expect(releases(mark)).toEqual([])
    expect(await slice(FEEDER, 'battery')).toMatchObject({ level: null })
    expect(await claimsOn(FEEDER)).toContain('battery:level,binary,charging,sleeping,lastUpdated')
  })
})

describe('one customization per device', () => {
  it('a second customization of the feeder is refused by name and stores nothing', async () => {
    const before = w.blocks.list().length
    await expect(create(feederCustomizationExample(SOURCES))).rejects.toThrow('duplicate-target')
    expect(w.blocks.list()).toHaveLength(before)
  })
})
