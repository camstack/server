import { describe, expect, it } from 'vitest'
import { readNodeEndpoints } from '../matter-endpoint-introspect.js'

/** A matter.js Behavior.Type is a CLASS carrying a static `cluster`. */
function behaviorClass(clusterId: number): unknown {
  return class {
    static readonly cluster = { id: clusterId }
  }
}

interface FakeEndpointInput {
  readonly number: number
  readonly deviceTypes: readonly number[]
  readonly supported: Record<string, unknown>
  readonly serverList?: readonly number[]
}

function fakeEndpoint(input: FakeEndpointInput, parts: unknown[] = []): unknown {
  return {
    number: input.number,
    behaviors: { supported: input.supported },
    parts,
    stateOf: (id: string): unknown => {
      if (id === 'descriptor') {
        return {
          deviceTypeList: input.deviceTypes.map((deviceType) => ({ deviceType, revision: 1 })),
          ...(input.serverList !== undefined ? { serverList: input.serverList } : {}),
        }
      }
      return {}
    },
    commandsOf: (): unknown => ({}),
  }
}

function lockNode(withSupported: boolean, withServerList: boolean): unknown {
  const lock = fakeEndpoint({
    number: 1,
    deviceTypes: [10],
    supported: withSupported ? { doorLock: behaviorClass(0x0101) } : {},
    ...(withServerList ? { serverList: [0x0101] } : {}),
  })
  const power = fakeEndpoint({
    number: 2,
    deviceTypes: [17],
    supported: withSupported ? { powerSource: behaviorClass(0x002f) } : {},
    ...(withServerList ? { serverList: [0x002f] } : {}),
  })
  return fakeEndpoint({ number: 0, deviceTypes: [22], supported: {} }, [lock, power])
}

describe('readNodeEndpoints', () => {
  it('reads the cluster id off a behavior CLASS', () => {
    const eps = readNodeEndpoints(lockNode(true, false))
    expect(eps.map((e) => [e.number, e.clusterIds])).toEqual([
      [0, []],
      [1, [0x0101]],
      [2, [0x002f]],
    ])
  })

  it('reads the Descriptor serverList when no behavior is installed', () => {
    const eps = readNodeEndpoints(lockNode(false, true))
    expect(eps.map((e) => [e.number, e.clusterIds])).toEqual([
      [0, []],
      [1, [0x0101]],
      [2, [0x002f]],
    ])
    expect(eps[1]?.deviceTypeIds).toEqual([10])
  })
})
