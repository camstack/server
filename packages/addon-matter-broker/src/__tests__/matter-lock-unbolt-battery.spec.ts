/**
 * A lock whose DoorLock FeatureMap carries Unbolting exposes Open, and its
 * unlock/open commands map to UnboltDoor/UnlockDoor. A PowerSource-only endpoint
 * is folded into the node's functional child, which carries the battery fed by
 * that endpoint's reports.
 */
import {
  DeviceFeature,
  DeviceType,
  type AccessoryChildrenAnswer,
  type AccessoryChildSpec,
  type IScopedLogger,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { MatterCommandInvocation, MatterNodeSnapshot } from '../matter-controller.js'
import { matterCommands, matterNodes } from '../matter-gateway.js'
import { MatterAttributeId } from '../matter-attr-decode.js'
import { MatterClusterId } from '../matter-cluster-mapping.js'
import { readNodeEndpoints } from '../matter-endpoint-introspect.js'
import {
  endpointsEqual,
  mappableEndpoints,
  NodeEndpointReporter,
  planEndpoints,
} from '../matter-node-reconcile.js'
import { MatterNodeDevice, matterNodeSchema } from '../devices/matter-node-device.js'
import { MatterEndpointDevice } from '../devices/matter-endpoint-device.js'
import { activeEndpoint } from './matter-device-fixture.js'

const UNBOLTING_BIT = 0x1000

function first(specs: readonly AccessoryChildSpec[]): AccessoryChildSpec {
  const [spec] = specs
  if (spec === undefined) throw new Error('no child spec')
  return spec
}

/** The specs of a children answer, whichever form (plain, complete, unknown + known). */
function childrenOf(answer: AccessoryChildrenAnswer): readonly AccessoryChildSpec[] {
  if (Array.isArray(answer)) return answer
  if ('kind' in answer) return answer.kind === 'complete' ? answer.children : (answer.known ?? [])
  return []
}

function behaviorClass(clusterId: number): unknown {
  return class {
    static readonly cluster = { id: clusterId }
  }
}

function lockEndpointWith(doorLockState: Record<string, unknown>): unknown {
  return {
    number: 1,
    behaviors: { supported: { doorLock: behaviorClass(0x0101) } },
    parts: [],
    stateOf: (id: string): unknown =>
      id === 'doorLock' ? doorLockState : { deviceTypeList: [{ deviceType: 10 }] },
    commandsOf: (): unknown => ({}),
  }
}

describe('DoorLock FeatureMap is read off the endpoint', () => {
  it('a numeric featureMap with bit 12 means Unbolting', () => {
    const [ep] = readNodeEndpoints(lockEndpointWith({ featureMap: UNBOLTING_BIT | 0x1 }))
    expect(ep?.lockUnbolting).toBe(true)
  })
  it('a named-feature featureMap record is read the same way', () => {
    const [on] = readNodeEndpoints(lockEndpointWith({ featureMap: { unbolting: true } }))
    const [off] = readNodeEndpoints(lockEndpointWith({ featureMap: { unbolting: false } }))
    expect(on?.lockUnbolting).toBe(true)
    expect(off?.lockUnbolting).toBe(false)
  })
  it('bit 8 alone is not Unbolting; an absent map is unknown', () => {
    const [bit8] = readNodeEndpoints(lockEndpointWith({ featureMap: 0x100 }))
    const [none] = readNodeEndpoints(lockEndpointWith({}))
    expect(bit8?.lockUnbolting).toBe(false)
    expect(none?.lockUnbolting).toBeUndefined()
  })
})

const LOCK_AND_POWER: MatterNodeSnapshot = {
  nodeId: '1',
  label: 'Lock',
  online: true,
  endpoints: [
    { endpointId: 0, clusterIds: [29, 40], deviceTypeIds: [22] },
    { endpointId: 1, clusterIds: [0x0101], deviceTypeIds: [10], lockUnbolting: true },
    { endpointId: 2, clusterIds: [29, 47], deviceTypeIds: [0x11] },
  ],
}

describe('PowerSource-only endpoint is folded into the functional child', () => {
  it('yields one entry, on the lock, pointing at the power source', () => {
    const entries = mappableEndpoints(LOCK_AND_POWER)
    expect(entries.map((e) => e.endpointId)).toEqual([1])
    expect(entries[0]?.powerSourceEndpointId).toBe(2)
    expect(entries[0]?.lockUnbolting).toBe(true)
  })
  it('a node with only a battery endpoint keeps it as its own child', () => {
    const entries = mappableEndpoints({
      ...LOCK_AND_POWER,
      endpoints: [{ endpointId: 2, clusterIds: [29, 47], deviceTypeIds: [0x11] }],
    })
    expect(entries.map((e) => e.endpointId)).toEqual([2])
    expect(entries[0]?.powerSourceEndpointId).toBeUndefined()
  })
  it('an install persisted before the fold re-derives', () => {
    const old = [
      { endpointId: 1, clusterIds: [0x0101], deviceTypeIds: [10], attributes: [] },
      { endpointId: 2, clusterIds: [29, 47], deviceTypeIds: [0x11], attributes: [] },
    ]
    expect(endpointsEqual(old, mappableEndpoints(LOCK_AND_POWER))).toBe(false)
  })
  it('the node spawns a single lock child carrying the battery cap', () => {
    const entries = mappableEndpoints(LOCK_AND_POWER)
    const node = Object.create(MatterNodeDevice.prototype)
    Object.defineProperty(node, 'config', {
      value: {
        values: matterNodeSchema.parse({ brokerId: 'b1', nodeId: '1', endpoints: entries }),
      },
    })
    Object.defineProperty(node, 'id', { value: 6017 })
    const specs = childrenOf(node.getAccessoryChildren())
    expect(specs).toHaveLength(1)
    expect(first(specs).meta.type).toBe(DeviceType.Lock)
    expect(first(specs).config.capabilities).toContain('battery')
    expect(first(specs).config.powerSourceEndpointId).toBe(2)
    expect(first(specs).config.lockUnbolting).toBe(true)
  })
})

afterEach(() => {
  matterNodes.clear()
  matterCommands.clear()
})

function statusOf(providers: Map<string, object>, cap: string): Promise<Record<string, unknown>> {
  const fn: unknown = Reflect.get(providers.get(cap) ?? {}, 'getStatus')
  if (typeof fn !== 'function') throw new Error(`no getStatus on ${cap}`)
  return Promise.resolve(fn())
}

async function lockWith(extraConfig: Record<string, unknown>) {
  const sent: MatterCommandInvocation[] = []
  matterCommands.setDispatcher(async (_brokerId, invocation) => {
    sent.push(invocation)
  })
  const fx = await activeEndpoint({
    type: DeviceType.Lock,
    capabilities: ['lock-control', 'event-emitter', 'battery'],
    extraConfig,
  })
  const call = async (name: string): Promise<void> => {
    const fn: unknown = Reflect.get(fx.providers.get('lock-control') ?? {}, name)
    if (typeof fn !== 'function') throw new Error(name)
    await fn({})
  }
  return { fx, sent, call }
}

describe('the node answers a complete read only when it can stand behind it', () => {
  const nodeOver = (entries: ReturnType<typeof mappableEndpoints>) => {
    const node = Object.create(MatterNodeDevice.prototype)
    Object.defineProperty(node, 'config', {
      value: {
        values: matterNodeSchema.parse({ brokerId: 'b1', nodeId: '1', endpoints: entries }),
      },
    })
    Object.defineProperty(node, 'brokerId', { value: 'b1' })
    Object.defineProperty(node, 'nodeId', { value: '1' })
    Object.defineProperty(node, 'id', { value: 6017 })
    return node
  }
  /** The node as adopted BEFORE the fold: lock and battery each had a child (6018, 6019). */
  const OLD_ENTRIES = [
    { endpointId: 1, clusterIds: [0x0101], deviceTypeIds: [10], attributes: [] },
    { endpointId: 2, clusterIds: [29, 47], deviceTypeIds: [0x11], attributes: [] },
  ]
  const suffixes = (answer: ReturnType<typeof MatterNodeDevice.prototype.getAccessoryChildren>) =>
    childrenOf(answer).map((s) => s.stableIdSuffix)

  it('is complete, without the folded endpoint, once the persisted list matches the live read', () => {
    matterNodes.setNodes('b1', [LOCK_AND_POWER])
    const answer = nodeOver(mappableEndpoints(LOCK_AND_POWER)).getAccessoryChildren()
    expect(answer).toMatchObject({ kind: 'complete' })
    expect(suffixes(answer)).toEqual(['1'])
  })

  it('is unknown while the persisted list still holds the old battery child', () => {
    matterNodes.setNodes('b1', [LOCK_AND_POWER])
    const answer = nodeOver(OLD_ENTRIES).getAccessoryChildren()
    expect(answer).toMatchObject({ kind: 'unknown' })
    expect(suffixes(answer)).toEqual(['1', '2'])
  })

  it('re-stamps the probe strictly forward on every agreeing re-read, so the shrink gate sees a later probe', () => {
    const slices = new Map<string, unknown>()
    const node = nodeOver(mappableEndpoints(LOCK_AND_POWER))
    Object.defineProperty(node, 'runtimeState', {
      value: {
        getCapState: (cap: string) => slices.get(cap),
        setCapState: (cap: string, value: unknown) => slices.set(cap, value),
      },
    })
    const stamp = (): number => {
      const slice = slices.get('feature-probe')
      const at =
        typeof slice === 'object' && slice !== null ? Reflect.get(slice, 'lastProbedAt') : 0
      return typeof at === 'number' ? at : 0
    }
    slices.set('feature-probe', { flags: {}, lastProbedAt: 1_000 })
    node.markEndpointsRead()
    const first = stamp()
    node.markEndpointsRead()
    const second = stamp()
    expect(first).toBeGreaterThan(1_000)
    expect(second).toBeGreaterThan(first)
  })

  it('is unknown when the node is offline or its endpoints were not read', () => {
    matterNodes.setNodes('b1', [{ ...LOCK_AND_POWER, online: false }])
    expect(nodeOver(mappableEndpoints(LOCK_AND_POWER)).getAccessoryChildren()).toMatchObject({
      kind: 'unknown',
    })
    matterNodes.setNodes('b1', [{ ...LOCK_AND_POWER, endpoints: [] }])
    expect(nodeOver(mappableEndpoints(LOCK_AND_POWER)).getAccessoryChildren()).toMatchObject({
      kind: 'unknown',
    })
    matterNodes.setNodes('b1', null)
    expect(nodeOver(mappableEndpoints(LOCK_AND_POWER)).getAccessoryChildren()).toMatchObject({
      kind: 'unknown',
    })
  })
})

describe('the reporter warns, with the deviceId, when the DoorLock FeatureMap is unreadable', () => {
  const warnings: Array<{ message: string; tags: unknown }> = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, extra?: { tags?: unknown }) => {
      warnings.push({ message, tags: extra?.tags })
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }

  it('tags the line with the node device id', () => {
    warnings.length = 0
    const unreadable: MatterNodeSnapshot = {
      ...LOCK_AND_POWER,
      endpoints: [{ endpointId: 1, clusterIds: [0x0101], deviceTypeIds: [10] }],
    }
    new NodeEndpointReporter(logger).report('b1', unreadable, 6017)
    const line = warnings.find((w) => w.message.includes('FeatureMap could not be read'))
    expect(line?.tags).toEqual({ deviceId: 6017 })
  })

  it('stays silent when the map was read', () => {
    warnings.length = 0
    new NodeEndpointReporter(logger).report('b1', LOCK_AND_POWER, 6017)
    expect(warnings.filter((w) => w.message.includes('FeatureMap'))).toEqual([])
  })
})

describe('a restored child takes the node entry list, not its spawn-time config', () => {
  /** The child spec a parent with these CURRENT entries derives for endpoint 1. */
  function lockSpecFor(entries: ReturnType<typeof mappableEndpoints>) {
    const node = Object.create(MatterNodeDevice.prototype)
    Object.defineProperty(node, 'config', {
      value: {
        values: matterNodeSchema.parse({ brokerId: 'b1', nodeId: '1', endpoints: entries }),
      },
    })
    Object.defineProperty(node, 'id', { value: 6017 })
    const spec = childrenOf(node.getAccessoryChildren()).find(
      (s: { stableIdSuffix: string }) => s.stableIdSuffix === '1',
    )
    if (spec === undefined) throw new Error('no lock spec')
    return spec
  }

  /** A row written before these facts existed: no lockUnbolting, no powerSourceEndpointId, no battery. */
  async function restoredLock() {
    const spec = lockSpecFor(mappableEndpoints(LOCK_AND_POWER))
    const sent: MatterCommandInvocation[] = []
    matterCommands.setDispatcher(async (_brokerId, invocation) => {
      sent.push(invocation)
    })
    const fx = await activeEndpoint({
      type: DeviceType.Lock,
      capabilities: ['lock-control', 'event-emitter'],
      deviceTypeIds: [10],
      build: (ctx) => {
        const device = spec.factory(ctx)
        if (!(device instanceof MatterEndpointDevice)) throw new Error('not an endpoint device')
        return device
      },
    })
    return { fx, sent }
  }

  it('offers Open and unbolts although the old row says nothing', async () => {
    const { fx, sent } = await restoredLock()
    expect(fx.device.features).toContain(DeviceFeature.LockOpen)
    const unlock: unknown = Reflect.get(fx.providers.get('lock-control') ?? {}, 'unlock')
    if (typeof unlock !== 'function') throw new Error('no unlock')
    await unlock({})
    expect(sent.map((s) => s.commandName)).toEqual(['unboltDoor'])
  })

  it('registers the battery and routes the folded endpoint reports to it', async () => {
    const { fx } = await restoredLock()
    expect(fx.caps).toContain('battery')
    matterNodes.recordAttribute('b1', {
      nodeId: '1',
      endpointId: 2,
      clusterId: MatterClusterId.PowerSource,
      attributeId: MatterAttributeId.BatPercentRemaining,
      value: 100,
    })
    expect((await statusOf(fx.providers, 'battery'))['level']).toBe(50)
  })
})

describe('the fold is taken only when it is unambiguous', () => {
  const functional = (endpointId: number) => ({
    endpointId,
    clusterIds: [0x0101],
    deviceTypeIds: [10],
  })
  const battery = (endpointId: number) => ({
    endpointId,
    clusterIds: [29, 47],
    deviceTypeIds: [0x11],
  })
  const nodeWith = (endpoints: MatterNodeSnapshot['endpoints']): MatterNodeSnapshot => ({
    ...LOCK_AND_POWER,
    endpoints,
  })

  it('one functional + one battery endpoint folds', () => {
    const plan = planEndpoints(nodeWith([functional(1), battery(2)]))
    expect(plan.fold.kind).toBe('folded')
    expect(plan.entries.map((e) => e.endpointId)).toEqual([1])
  })
  it('several functional endpoints keep the battery as its own child', () => {
    const plan = planEndpoints(nodeWith([functional(1), functional(3), battery(2)]))
    expect(plan.fold).toMatchObject({
      kind: 'kept-separate',
      reason: 'several-functional-endpoints',
    })
    expect(plan.entries.map((e) => e.endpointId)).toEqual([1, 3, 2])
    expect(plan.entries.every((e) => e.powerSourceEndpointId === undefined)).toBe(true)
  })
  it('several battery endpoints stay separate', () => {
    const plan = planEndpoints(nodeWith([functional(1), battery(2), battery(4)]))
    expect(plan.fold).toMatchObject({ kind: 'kept-separate', reason: 'several-battery-endpoints' })
    expect(plan.entries.map((e) => e.endpointId)).toEqual([1, 2, 4])
  })
})

describe('lock child: Open feature and command mapping', () => {
  it('Unbolting: LockOpen is advertised, unlock = UnboltDoor, open = UnlockDoor', async () => {
    const { fx, sent, call } = await lockWith({ lockUnbolting: true })
    expect(fx.device.features).toContain(DeviceFeature.LockOpen)
    await call('unlock')
    await call('open')
    expect(sent.map((s) => s.commandName)).toEqual(['unboltDoor', 'unlockDoor'])
  })

  it('no Unbolting: no LockOpen, unlock = UnlockDoor', async () => {
    const { fx, sent, call } = await lockWith({ lockUnbolting: false })
    expect(fx.device.features).not.toContain(DeviceFeature.LockOpen)
    await call('unlock')
    expect(sent.map((s) => s.commandName)).toEqual(['unlockDoor'])
  })

  it('an unknown feature map is no LockOpen', async () => {
    const { fx } = await lockWith({})
    expect(fx.device.features).not.toContain(DeviceFeature.LockOpen)
  })

  it('the battery on the lock is fed by the power-source endpoint reports', async () => {
    const { fx } = await lockWith({ powerSourceEndpointId: 2 })
    matterNodes.recordAttribute('b1', {
      nodeId: '1',
      endpointId: 2,
      clusterId: MatterClusterId.PowerSource,
      attributeId: MatterAttributeId.BatPercentRemaining,
      value: 150,
    })
    expect((await statusOf(fx.providers, 'battery'))['level']).toBe(75)
  })

  it('a power-source report from an unrelated endpoint is ignored', async () => {
    const { fx } = await lockWith({ powerSourceEndpointId: 2 })
    matterNodes.recordAttribute('b1', {
      nodeId: '1',
      endpointId: 3,
      clusterId: MatterClusterId.PowerSource,
      attributeId: MatterAttributeId.BatPercentRemaining,
      value: 150,
    })
    expect((await statusOf(fx.providers, 'battery'))['level']).toBeNull()
  })
})
