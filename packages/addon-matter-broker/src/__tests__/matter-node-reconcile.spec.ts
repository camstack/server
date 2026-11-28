import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import type { MatterNodeSnapshot } from '../matter-controller.js'
import type { MatterEndpointEntry } from '../devices/matter-node-device.js'
import {
  NodeEndpointReporter,
  reconcileNodeEndpoints,
  type ReconcileDeps,
} from '../matter-node-reconcile.js'

interface InfoLine {
  readonly message: string
  readonly tags: unknown
  readonly meta: unknown
}

function loggerInto(infos: InfoLine[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message: string, extra?: { tags?: unknown; meta?: unknown }) => {
      infos.push({ message, tags: extra?.tags, meta: extra?.meta })
    },
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const LOCK_ENDPOINT = { endpointId: 1, clusterIds: [0x0101], deviceTypeIds: [0x000a] }
const EMPTY_NODE: MatterNodeSnapshot = { nodeId: '1', label: 'Lock', online: true, endpoints: [] }
const LOCK_NODE: MatterNodeSnapshot = { ...EMPTY_NODE, endpoints: [LOCK_ENDPOINT] }

function harness(config: Record<string, unknown>): {
  deps: ReconcileDeps
  infos: InfoLine[]
  stamped: number[]
  applied: Array<{ id: number; endpoints: MatterEndpointEntry[] }>
} {
  const infos: InfoLine[] = []
  const stamped: number[] = []
  const applied: Array<{ id: number; endpoints: MatterEndpointEntry[] }> = []
  const logger = loggerInto(infos)
  return {
    infos,
    stamped,
    applied,
    deps: {
      logger,
      reporter: new NodeEndpointReporter(logger),
      loadAdopted: async () => [{ id: 6017, config }],
      markEndpointsRead: (id) => {
        stamped.push(id)
      },
      applyEndpoints: async (id, endpoints) => {
        applied.push({ id, endpoints })
      },
    },
  }
}

const ADOPTED = { system: 'matter', brokerId: 'b1', nodeId: '1', endpoints: [] }

describe('reconcileNodeEndpoints', () => {
  it('gives an empty container its children once the snapshot carries the lock endpoint', async () => {
    const { deps, applied } = harness(ADOPTED)
    await reconcileNodeEndpoints(deps, 'b1', [EMPTY_NODE])
    expect(applied).toEqual([])
    await reconcileNodeEndpoints(deps, 'b1', [LOCK_NODE])
    expect(applied).toHaveLength(1)
    expect(applied[0]?.id).toBe(6017)
    expect(applied[0]?.endpoints.map((e) => e.endpointId)).toEqual([1])
  })

  it('logs the endpoint inventory once per change, tagged with the adopted deviceId', async () => {
    const { deps, infos } = harness(ADOPTED)
    await reconcileNodeEndpoints(deps, 'b1', [EMPTY_NODE])
    await reconcileNodeEndpoints(deps, 'b1', [EMPTY_NODE])
    await reconcileNodeEndpoints(deps, 'b1', [EMPTY_NODE])
    const reads = () => infos.filter((l) => l.message === 'Matter: node endpoints read')
    expect(reads()).toHaveLength(1)
    expect(reads()[0]?.tags).toEqual({ deviceId: 6017 })
    await reconcileNodeEndpoints(deps, 'b1', [LOCK_NODE])
    expect(reads()).toHaveLength(2)
    expect(JSON.stringify(reads()[1]?.meta)).toContain('lock-control')
  })

  it('tags a not-yet-adopted node with the addon id and carries the nodeId in meta', async () => {
    const { deps, infos } = harness({ system: 'matter', brokerId: 'other', nodeId: '9' })
    await reconcileNodeEndpoints(deps, 'b1', [LOCK_NODE])
    const line = infos.find((l) => l.message === 'Matter: node endpoints read')
    expect(line?.tags).toEqual({ addonId: 'matter-broker' })
    expect(JSON.stringify(line?.meta)).toContain('"nodeId":"1"')
  })
})

describe('NodeEndpointReporter empty-cluster warning', () => {
  it('warns, tagged with the deviceId, when an endpoint has device types but no clusters', () => {
    const warns: InfoLine[] = []
    const logger: IScopedLogger = {
      ...loggerInto([]),
      warn: (message: string, extra?: { tags?: unknown; meta?: unknown }) => {
        warns.push({ message, tags: extra?.tags, meta: extra?.meta })
      },
    }
    const node: MatterNodeSnapshot = {
      nodeId: '1',
      label: 'Lock',
      online: true,
      endpoints: [{ endpointId: 1, clusterIds: [], deviceTypeIds: [0x000a] }],
    }
    new NodeEndpointReporter(logger).report('b1', node, 6017)
    expect(warns).toHaveLength(1)
    expect(warns[0]?.tags).toEqual({ deviceId: 6017 })
    expect(JSON.stringify(warns[0]?.meta)).toContain('"endpointId":1')
  })
})

describe('reconcileNodeEndpoints probe stamp (drives the kernel shrink gate)', () => {
  const LOCK_ENTRY = { ...LOCK_ENDPOINT, attributes: [] }
  const adopted = { ...ADOPTED, endpoints: [LOCK_ENTRY] }

  it('stamps on a successful re-read that agrees with the persisted list, every time', async () => {
    const h = harness(adopted)
    await reconcileNodeEndpoints(h.deps, 'b1', [LOCK_NODE])
    await reconcileNodeEndpoints(h.deps, 'b1', [LOCK_NODE])
    expect(h.stamped).toEqual([6017, 6017])
    expect(h.applied).toEqual([])
  })

  it('does not stamp while the list is being changed, offline, or with no endpoints read', async () => {
    const changed = harness(ADOPTED)
    await reconcileNodeEndpoints(changed.deps, 'b1', [LOCK_NODE])
    expect(changed.stamped).toEqual([])
    const offline = harness(adopted)
    await reconcileNodeEndpoints(offline.deps, 'b1', [{ ...LOCK_NODE, online: false }])
    expect(offline.stamped).toEqual([])
    const unread = harness(adopted)
    await reconcileNodeEndpoints(unread.deps, 'b1', [{ ...LOCK_NODE, endpoints: [] }])
    expect(unread.stamped).toEqual([])
  })
})
