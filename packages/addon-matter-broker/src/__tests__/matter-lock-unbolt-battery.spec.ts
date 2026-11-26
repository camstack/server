/**
 * A lock whose DoorLock FeatureMap carries Unbolting exposes Open, and its
 * unlock/open commands map to UnboltDoor/UnlockDoor. A PowerSource-only endpoint
 * is folded into the node's functional child, which carries the battery fed by
 * that endpoint's reports.
 */
import { DeviceFeature, DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { MatterCommandInvocation, MatterNodeSnapshot } from '../matter-controller.js'
import { matterCommands, matterNodes } from '../matter-gateway.js'
import { MatterAttributeId } from '../matter-attr-decode.js'
import { MatterClusterId } from '../matter-cluster-mapping.js'
import { readNodeEndpoints } from '../matter-endpoint-introspect.js'
import { endpointsEqual, mappableEndpoints } from '../matter-node-reconcile.js'
import { MatterNodeDevice, matterNodeSchema } from '../devices/matter-node-device.js'
import { activeEndpoint } from './matter-device-fixture.js'

const UNBOLTING_BIT = 0x1000

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
    const specs = node.getAccessoryChildren()
    expect(specs).toHaveLength(1)
    expect(specs[0].meta.type).toBe(DeviceType.Lock)
    expect(specs[0].config.capabilities).toContain('battery')
    expect(specs[0].config.powerSourceEndpointId).toBe(2)
    expect(specs[0].config.lockUnbolting).toBe(true)
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
