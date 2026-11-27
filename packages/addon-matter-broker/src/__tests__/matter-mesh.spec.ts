import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { decodePowerSourceKind } from '../matter-attr-decode.js'
import { MatterClusterId } from '../matter-cluster-mapping.js'
import type { MatterAttributeReport, MatterNodeSnapshot } from '../matter-controller.js'
import { MatterNodeResolver } from '../matter-gateway.js'
import { decodeNodeMeshFacts, type MeshAttr } from '../matter-mesh-decode.js'
import { buildTopology } from '../matter-mesh-topology.js'
import { MatterMeshService, type MeshReadRequest } from '../matter-mesh.js'

const BROKER = 'matter_001'
const THREAD = MatterClusterId.ThreadNetworkDiagnostics
const GENERAL = MatterClusterId.GeneralDiagnostics
const POWER = MatterClusterId.PowerSource
const FEATURE_MAP = 0xfffc

interface LogLine {
  readonly level: 'warn' | 'debug'
  readonly message: string
  readonly tags: Record<string, unknown>
}

function recordingLogger(lines: LogLine[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (message: string, ctx?: { tags?: Record<string, unknown> }) => {
      lines.push({ level: 'debug', message, tags: ctx?.tags ?? {} })
    },
    info: () => undefined,
    warn: (message: string, ctx?: { tags?: Record<string, unknown> }) => {
      lines.push({ level: 'warn', message, tags: ctx?.tags ?? {} })
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function attr(clusterId: number, attributeId: number, value: unknown, endpointId = 0): MeshAttr {
  return { endpointId, clusterId, attributeId, value, recordedAt: 1000 }
}

const ROUTER_EXT = 0xaaaa000000000001n
const SLEEPY_EXT = 0xbbbb000000000002n
const FOREIGN_EXT = 0xcccc000000000003n

function threadAttrs(own: bigint, role: number, neighbors: readonly unknown[]): MeshAttr[] {
  return [
    attr(GENERAL, 0, [{ type: 4, hardwareAddress: own }]),
    attr(THREAD, 1, role),
    attr(THREAD, 7, neighbors),
  ]
}

describe('decodePowerSourceKind', () => {
  it('reads wired and battery from a numeric FeatureMap', () => {
    expect(decodePowerSourceKind(0x1)).toBe('wired')
    expect(decodePowerSourceKind(0x2)).toBe('battery')
    expect(decodePowerSourceKind(0x3)).toBe('wired')
    expect(decodePowerSourceKind(0x4)).toBeNull()
  })
  it('reads the named-feature record matter.js decodes', () => {
    expect(decodePowerSourceKind({ wired: true, battery: false })).toBe('wired')
    expect(
      decodePowerSourceKind({
        wired: false,
        battery: true,
        rechargeable: true,
      }),
    ).toBe('battery')
    expect(decodePowerSourceKind({ wired: false, battery: false })).toBeNull()
  })
  it('is unknown for an unreadable map', () => {
    expect(decodePowerSourceKind(undefined)).toBeNull()
    expect(decodePowerSourceKind('x')).toBeNull()
  })
})

describe('decodeNodeMeshFacts', () => {
  it('classifies power from the PowerSource FeatureMap, wired winning', () => {
    expect(decodeNodeMeshFacts([attr(POWER, FEATURE_MAP, 0x1, 1)]).power).toBe('mains')
    expect(decodeNodeMeshFacts([attr(POWER, FEATURE_MAP, 0x2, 1)]).power).toBe('battery')
    expect(
      decodeNodeMeshFacts([attr(POWER, FEATURE_MAP, 0x2, 1), attr(POWER, FEATURE_MAP, 0x1, 2)])
        .power,
    ).toBe('mains')
  })
  it('falls back to the Thread role, and to unknown without evidence', () => {
    expect(decodeNodeMeshFacts(threadAttrs(ROUTER_EXT, 5, [])).power).toBe('mains')
    expect(decodeNodeMeshFacts(threadAttrs(SLEEPY_EXT, 2, [])).power).toBe('battery')
    expect(decodeNodeMeshFacts(threadAttrs(SLEEPY_EXT, 3, [])).power).toBe('unknown')
    expect(decodeNodeMeshFacts([]).power).toBe('unknown')
  })
  it('reports everything as null for a node that was never read', () => {
    const facts = decodeNodeMeshFacts([])
    expect(facts).toMatchObject({
      vendor: null,
      uptimeS: null,
      rebootCount: null,
      bootReason: null,
      networkFaults: null,
      fabrics: null,
      thread: null,
      wifi: null,
      ethernet: null,
      transport: 'unknown',
      readAt: null,
    })
  })
  it('keeps a reported empty fault list distinct from an unreported one', () => {
    expect(decodeNodeMeshFacts([attr(GENERAL, 7, [])]).networkFaults).toEqual([])
    expect(decodeNodeMeshFacts([attr(GENERAL, 7, [2])]).networkFaults).toEqual(['network-jammed'])
  })
})

describe('buildTopology', () => {
  it('builds Thread links from neighbor tables and adds an unknown peer as a node with no device', () => {
    const router = decodeNodeMeshFacts(
      threadAttrs(ROUTER_EXT, 5, [
        {
          extAddress: SLEEPY_EXT,
          rloc16: 0x0401,
          lqi: 200,
          averageRssi: -60,
          lastRssi: -61,
          isChild: true,
          fullThreadDevice: false,
        },
        {
          extAddress: FOREIGN_EXT,
          rloc16: 0x0800,
          lqi: 150,
          averageRssi: -70,
          isChild: false,
          fullThreadDevice: true,
        },
      ]),
    )
    const sleepy = decodeNodeMeshFacts(
      threadAttrs(SLEEPY_EXT, 2, [
        {
          extAddress: ROUTER_EXT,
          rloc16: 0x0400,
          lqi: 190,
          averageRssi: -64,
          isChild: false,
          fullThreadDevice: true,
        },
      ]),
    )
    const topology = buildTopology([
      {
        nodeId: '1',
        label: 'Router',
        online: true,
        deviceId: 11,
        facts: router,
      },
      { nodeId: '2', label: 'Lock', online: true, deviceId: 12, facts: sleepy },
    ])
    expect(topology.nodes.map((n) => [n.nodeKey, n.deviceId])).toEqual([
      ['1', 11],
      ['2', 12],
      [`thread:${FOREIGN_EXT.toString(16)}`, null],
    ])
    expect(topology.links).toContainEqual({
      from: '1',
      to: '2',
      kind: 'neighbor',
      lqi: 200,
      rssi: -60,
    })
    expect(topology.links).toContainEqual({
      from: '2',
      to: '1',
      kind: 'neighbor',
      lqi: 190,
      rssi: -64,
    })
    expect(topology.links).toContainEqual({
      from: '1',
      to: `thread:${FOREIGN_EXT.toString(16)}`,
      kind: 'neighbor',
      lqi: 150,
      rssi: -70,
    })
    // The sleepy child's own figures are its parent link; the router has none.
    expect(topology.nodes.find((n) => n.nodeKey === '2')).toMatchObject({
      role: 'sleepy-end-device',
      lqi: 190,
      rssi: -64,
    })
    expect(topology.nodes.find((n) => n.nodeKey === '1')).toMatchObject({
      role: 'router',
      lqi: null,
      rssi: null,
    })
  })
  it('answers nothing-read-yet with a null readAt', () => {
    const facts = decodeNodeMeshFacts([])
    const topology = buildTopology([{ nodeId: '1', label: 'x', online: true, deviceId: 1, facts }])
    expect(topology.readAt).toBeNull()
    expect(topology.nodes[0]).toMatchObject({
      lqi: null,
      rssi: null,
      lastReadAt: null,
    })
  })
})

/** A resolver holding a mains router (device 11), a battery lock (12) and an offline mains plug (13). */
function fabric(): MatterNodeResolver {
  const resolver = new MatterNodeResolver()
  const snapshot = (nodeId: string, label: string, online: boolean): MatterNodeSnapshot => ({
    nodeId,
    label,
    online,
    endpoints: [
      { endpointId: 0, clusterIds: [] },
      { endpointId: 1, clusterIds: [POWER] },
    ],
  })
  resolver.setNodes(BROKER, [
    snapshot('1', 'Router', true),
    snapshot('2', 'Lock', true),
    snapshot('3', 'Plug', false),
  ])
  resolver.bindDevice('1', 11)
  resolver.bindDevice('2', 12)
  resolver.bindDevice('3', 13)
  const put = (
    nodeId: string,
    clusterId: number,
    attributeId: number,
    value: unknown,
    endpointId = 0,
  ): void => {
    resolver.recordAttribute(BROKER, {
      nodeId,
      endpointId,
      clusterId,
      attributeId,
      value,
    })
  }
  put('1', POWER, FEATURE_MAP, 0x1, 1)
  put('2', POWER, FEATURE_MAP, 0x2, 1)
  put('3', POWER, FEATURE_MAP, 0x1, 1)
  return resolver
}

function recordingReader(
  calls: { nodeId: string; requests: readonly MeshReadRequest[] }[],
  fail?: string,
) {
  return async (
    _brokerId: string,
    nodeId: string,
    requests: readonly MeshReadRequest[],
  ): Promise<readonly MatterAttributeReport[]> => {
    calls.push({ nodeId, requests })
    if (fail !== undefined && nodeId === fail) throw new Error('peer unreachable')
    return [
      {
        nodeId,
        endpointId: 0,
        clusterId: GENERAL,
        attributeId: 2,
        value: 3600,
      },
    ]
  }
}

describe('MatterMeshService', () => {
  it('refresh reads the mains online node and never the battery or offline ones', async () => {
    const calls: { nodeId: string; requests: readonly MeshReadRequest[] }[] = []
    const service = new MatterMeshService(fabric())
    service.attach(recordingLogger([]), recordingReader(calls))
    const result = await service.refresh(BROKER)
    expect(calls.map((c) => c.nodeId)).toEqual(['1'])
    expect(result).toEqual({ readNodes: 1, failedNodes: 0, skippedNodes: 2 })
    // The read landed in the cache and shows in the diagnostics.
    expect(service.diagnostics(BROKER, 11).uptimeS).toBe(3600)
    expect(service.diagnostics(BROKER, 12).uptimeS).toBeNull()
  })

  it('readNow reads a battery node on request, PowerSource included', async () => {
    const calls: { nodeId: string; requests: readonly MeshReadRequest[] }[] = []
    const service = new MatterMeshService(fabric())
    service.attach(recordingLogger([]), recordingReader(calls))
    const result = await service.readNow(BROKER, 12)
    expect(result.readOk).toBe(true)
    expect(calls.map((c) => c.nodeId)).toEqual(['2'])
    expect(calls[0]?.requests).toContainEqual({
      endpointId: 1,
      clusterId: POWER,
    })
    expect(result.diagnostics.uptimeS).toBe(3600)
  })

  it('a failed read is reported, logged with the device tag, and invents no value', async () => {
    const lines: LogLine[] = []
    const calls: { nodeId: string; requests: readonly MeshReadRequest[] }[] = []
    const service = new MatterMeshService(fabric())
    service.attach(recordingLogger(lines), recordingReader(calls, '2'))
    const result = await service.readNow(BROKER, 12)
    expect(result.readOk).toBe(false)
    expect(result.error).toBe('peer unreachable')
    expect(result.diagnostics.uptimeS).toBeNull()
    expect(result.diagnostics.rebootCount).toBeNull()
    const warn = lines.find((l) => l.level === 'warn')
    expect(warn?.tags).toMatchObject({ deviceId: 12 })
  })

  it('counts a failed mains read and carries on with the next node', async () => {
    const calls: { nodeId: string; requests: readonly MeshReadRequest[] }[] = []
    const service = new MatterMeshService(fabric())
    service.attach(recordingLogger([]), recordingReader(calls, '1'))
    expect(await service.refresh(BROKER)).toEqual({
      readNodes: 0,
      failedNodes: 1,
      skippedNodes: 2,
    })
  })

  it('refuses a device that is not a node of the broker', async () => {
    const service = new MatterMeshService(fabric())
    await expect(service.readNow(BROKER, 99)).rejects.toThrow(/not a node/)
  })
})

describe('MatterMeshService periodic pass', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A reader that holds every read until the test releases it. */
  function gatedReader(calls: string[]) {
    const gates: (() => void)[] = []
    const reader = (
      _brokerId: string,
      nodeId: string,
    ): Promise<readonly MatterAttributeReport[]> => {
      calls.push(nodeId)
      return new Promise((resolve) => {
        gates.push(() => resolve([]))
      })
    }
    return { reader, release: () => gates.splice(0).forEach((g) => g()) }
  }

  it('runs one pass per tick, mains nodes only', async () => {
    vi.useFakeTimers()
    const calls: { nodeId: string; requests: readonly MeshReadRequest[] }[] = []
    const service = new MatterMeshService(fabric())
    service.attach(recordingLogger([]), recordingReader(calls))
    service.startPeriodic(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.map((c) => c.nodeId)).toEqual(['1'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls.map((c) => c.nodeId)).toEqual(['1', '1'])
    service.detach()
  })

  it('skips a tick while the previous pass is still in flight, and logs its age', async () => {
    vi.useFakeTimers()
    const lines: LogLine[] = []
    const calls: string[] = []
    const gate = gatedReader(calls)
    const service = new MatterMeshService(fabric())
    service.attach(recordingLogger(lines), gate.reader)
    service.startPeriodic(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toEqual(['1'])
    expect(lines.filter((l) => l.message.includes('skipped'))).toHaveLength(2)
    gate.release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toEqual(['1', '1'])
    gate.release()
    service.detach()
  })

  it('detach clears the interval: no pass runs after shutdown', async () => {
    vi.useFakeTimers()
    const calls: { nodeId: string; requests: readonly MeshReadRequest[] }[] = []
    const service = new MatterMeshService(fabric())
    service.attach(recordingLogger([]), recordingReader(calls))
    service.startPeriodic(1000)
    service.detach()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the network a topology names', () => {
  const EXT_PAN = 0x1122334455667788n
  const named = (own: bigint, name: string | null): MeshAttr[] => [
    ...threadAttrs(own, 5, []),
    attr(THREAD, 0, 15),
    attr(THREAD, 3, 4660),
    attr(THREAD, 4, EXT_PAN),
    ...(name === null ? [] : [attr(THREAD, 2, name)]),
  ]
  it('names the Thread network from NetworkName and the extended PAN id', () => {
    const topology = buildTopology(
      [
        {
          nodeId: '1',
          label: 'a',
          online: true,
          deviceId: 1,
          facts: decodeNodeMeshFacts(named(ROUTER_EXT, null)),
        },
        {
          nodeId: '2',
          label: 'b',
          online: true,
          deviceId: 2,
          facts: decodeNodeMeshFacts(named(SLEEPY_EXT, 'Casa-Thread')),
        },
      ],
      'matter:b1',
    )
    expect(topology.network).toEqual({
      id: '1122334455667788',
      name: 'Casa-Thread',
      technology: 'thread',
      channel: 15,
      panId: 4660,
    })
  })
  it('never invents a name: unread stays null', () => {
    const topology = buildTopology([
      {
        nodeId: '1',
        label: 'a',
        online: true,
        deviceId: 1,
        facts: decodeNodeMeshFacts(named(ROUTER_EXT, null)),
      },
    ])
    expect(topology.network?.name).toBeNull()
  })
  it('has no network when nothing was read', () => {
    const facts = decodeNodeMeshFacts([])
    expect(
      buildTopology([{ nodeId: '1', label: 'x', online: true, deviceId: 1, facts }]).network,
    ).toBeNull()
  })
  it('breaks a tie between two Thread networks by the lowest id, whatever the read order', () => {
    const other = (own: bigint): MeshAttr[] => [
      ...threadAttrs(own, 5, []),
      attr(THREAD, 4, 0x0011223344556677n),
    ]
    const mk = (nodeId: string, attrs: MeshAttr[], deviceId: number) => ({
      nodeId,
      label: nodeId,
      online: true,
      deviceId,
      facts: decodeNodeMeshFacts(attrs),
    })
    const a = mk('1', named(ROUTER_EXT, null), 1)
    const b = mk('2', other(SLEEPY_EXT), 2)
    const forward = buildTopology([a, b]).network?.id
    expect(forward).toBe('0011223344556677')
    expect(buildTopology([b, a]).network?.id).toBe(forward)
  })
  it('tags each node with its own network so a fabric spanning two can be split', () => {
    const second = [...threadAttrs(SLEEPY_EXT, 5, []), attr(THREAD, 4, 0x0011223344556677n)]
    const topology = buildTopology([
      {
        nodeId: '1',
        label: 'a',
        online: true,
        deviceId: 1,
        facts: decodeNodeMeshFacts(named(ROUTER_EXT, null)),
      },
      { nodeId: '2', label: 'b', online: true, deviceId: 2, facts: decodeNodeMeshFacts(second) },
    ])
    expect(topology.nodes.map((n) => n.networkId)).toEqual(['1122334455667788', '0011223344556677'])
  })
})
