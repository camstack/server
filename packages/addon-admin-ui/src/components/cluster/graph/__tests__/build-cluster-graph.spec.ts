import { describe, it, expect } from 'vitest'
import { buildClusterGraph } from '../build-cluster-graph'
import type { NodeData } from '../../NodeCard'

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<NodeData> & Pick<NodeData, 'id' | 'isHub'>): NodeData {
  return {
    name: overrides.id,
    hostname: overrides.id,
    platform: 'linux',
    arch: 'x64',
    cpuCores: 4,
    memoryMB: 8192,
    engines: [],
    isOnline: true,
    cpuPercent: 0,
    memoryPercent: 0,
    addons: [],
    processes: [],
    categories: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fixture 1: hub-first ordering + edges
// ---------------------------------------------------------------------------

const hubNode = makeNode({
  id: 'hub',
  isHub: true,
  isOnline: true,
  cpuPercent: 12,
  memoryPercent: 30,
  localIps: ['10.0.0.1'],
  platform: 'darwin',
  arch: 'arm64',
})

const agent1 = makeNode({
  id: 'agent-1',
  isHub: false,
  isOnline: true,
  localIps: ['10.0.0.2'],
})

const agent2 = makeNode({
  id: 'agent-2',
  isHub: false,
  isOnline: true,
  localIps: ['10.0.0.3'],
})

// agents come BEFORE hub in input order → hub must still be first in output
const topologyOutOfOrder: readonly NodeData[] = [agent1, agent2, hubNode]

// ---------------------------------------------------------------------------
// Fixture 2: runner caps — labelled, deduped, sorted
// ---------------------------------------------------------------------------

const nodeWithCaps = makeNode({
  id: 'hub-caps',
  isHub: true,
  processes: [
    {
      pid: 100,
      name: 'stream-broker',
      state: 'running',
      cpuPercent: 5,
      memoryRss: 1024 * 1024 * 50,
      uptimeSeconds: 3600,
      services: [
        {
          addonId: 'addon-pipeline',
          capabilities: ['stream-broker', 'webrtc'],
          status: 'running',
        },
      ],
    },
  ],
})

// ---------------------------------------------------------------------------
// Fixture 3: multi-service process (co-located addons → union of caps)
// ---------------------------------------------------------------------------

const nodeWithMultiService = makeNode({
  id: 'hub-multi',
  isHub: true,
  processes: [
    {
      pid: 200,
      name: 'grouped-runner',
      state: 'running',
      cpuPercent: 8,
      memoryRss: 1024 * 1024 * 80,
      uptimeSeconds: 7200,
      services: [
        {
          addonId: 'addon-a',
          capabilities: ['motion-detect', 'analytics'],
          status: 'running',
        },
        {
          addonId: 'addon-b',
          capabilities: ['analytics', 'alert'],
          status: 'running',
        },
      ],
    },
  ],
})

// ---------------------------------------------------------------------------
// Fixture 4: offline agent
// ---------------------------------------------------------------------------

const offlineAgent = makeNode({
  id: 'agent-offline',
  isHub: false,
  isOnline: false,
})

// ---------------------------------------------------------------------------
// Fixture 5: node with no processes / no localIps
// ---------------------------------------------------------------------------

const nodeNoProcesses = makeNode({
  id: 'hub-empty',
  isHub: true,
  processes: [],
  // localIps deliberately omitted → undefined
})

// ---------------------------------------------------------------------------
// Fixture 6: many runners (12)
// ---------------------------------------------------------------------------

const manyProcesses = Array.from({ length: 12 }, (_, i) => ({
  pid: 300 + i,
  name: `runner-${i}`,
  state: 'running' as const,
  cpuPercent: i,
  memoryRss: 1024 * 1024 * (i + 1),
  uptimeSeconds: 100 + i,
  services: [{ addonId: `addon-${i}`, capabilities: [`cap-${i}`], status: 'running' as const }],
}))

const nodeWithManyRunners = makeNode({
  id: 'hub-many',
  isHub: true,
  processes: manyProcesses,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildClusterGraph', () => {
  describe('hub-first ordering and edges', () => {
    it('places the hub node first regardless of input order', () => {
      const graph = buildClusterGraph(topologyOutOfOrder)
      expect(graph.nodes[0]?.nodeId).toBe('hub')
    })

    it('preserves agent order after the hub', () => {
      const graph = buildClusterGraph(topologyOutOfOrder)
      expect(graph.nodes[1]?.nodeId).toBe('agent-1')
      expect(graph.nodes[2]?.nodeId).toBe('agent-2')
    })

    it('produces one edge per non-hub node', () => {
      const graph = buildClusterGraph(topologyOutOfOrder)
      expect(graph.edges).toHaveLength(2)
    })

    it('edges source from the hub', () => {
      const graph = buildClusterGraph(topologyOutOfOrder)
      for (const edge of graph.edges) {
        expect(edge.source).toBe('hub')
      }
    })

    it('edge ids follow the hub:<hubId>-><nodeId> format', () => {
      const graph = buildClusterGraph(topologyOutOfOrder)
      const ids = graph.edges.map((e) => e.id)
      expect(ids).toContain('hub:hub->agent-1')
      expect(ids).toContain('hub:hub->agent-2')
    })

    it('all edges are online when both hub and agents are online', () => {
      const graph = buildClusterGraph(topologyOutOfOrder)
      for (const edge of graph.edges) {
        expect(edge.online).toBe(true)
      }
    })
  })

  describe('identity mapping', () => {
    it('maps cpuPercent → identity.cpu and memoryPercent → identity.mem', () => {
      const graph = buildClusterGraph([hubNode])
      const hubGraphNode = graph.nodes.find((n) => n.nodeId === 'hub')
      expect(hubGraphNode?.identity.cpu).toBe(12)
      expect(hubGraphNode?.identity.mem).toBe(30)
    })

    it('uses localIps[0] as identity.ip', () => {
      const graph = buildClusterGraph([hubNode])
      expect(graph.nodes[0]?.identity.ip).toBe('10.0.0.1')
    })

    it('sets identity.platform and identity.arch from input', () => {
      const graph = buildClusterGraph([hubNode])
      expect(graph.nodes[0]?.identity.platform).toBe('darwin')
      expect(graph.nodes[0]?.identity.arch).toBe('arm64')
    })

    it('sets isHub correctly', () => {
      const graph = buildClusterGraph([hubNode, agent1])
      expect(graph.nodes.find((n) => n.nodeId === 'hub')?.isHub).toBe(true)
      expect(graph.nodes.find((n) => n.nodeId === 'agent-1')?.isHub).toBe(false)
    })
  })

  describe('runner caps — labelled with service addonId', () => {
    it('creates one RunnerBlock per process', () => {
      const graph = buildClusterGraph([nodeWithCaps])
      expect(graph.nodes[0]?.runners).toHaveLength(1)
    })

    it('maps process pid, name, state, cpu, mem onto RunnerBlock', () => {
      const graph = buildClusterGraph([nodeWithCaps])
      const runner = graph.nodes[0]?.runners[0]
      expect(runner?.pid).toBe(100)
      expect(runner?.name).toBe('stream-broker')
      expect(runner?.state).toBe('running')
      expect(runner?.cpu).toBe(5)
      expect(runner?.mem).toBe(1024 * 1024 * 50)
    })

    it('sets RunnerBlock.addonId to the first service addonId', () => {
      const graph = buildClusterGraph([nodeWithCaps])
      expect(graph.nodes[0]?.runners[0]?.addonId).toBe('addon-pipeline')
    })

    it('labels each cap with its service addonId', () => {
      const graph = buildClusterGraph([nodeWithCaps])
      const caps = graph.nodes[0]?.runners[0]?.caps ?? []
      expect(caps).toContainEqual({ name: 'stream-broker', addonId: 'addon-pipeline' })
      expect(caps).toContainEqual({ name: 'webrtc', addonId: 'addon-pipeline' })
    })

    it('sorts caps by name', () => {
      const graph = buildClusterGraph([nodeWithCaps])
      const names = (graph.nodes[0]?.runners[0]?.caps ?? []).map((c) => c.name)
      expect(names).toEqual([...names].toSorted())
    })
  })

  describe('multi-service process (co-located addons)', () => {
    it('unions caps from all services', () => {
      const graph = buildClusterGraph([nodeWithMultiService])
      const caps = graph.nodes[0]?.runners[0]?.caps ?? []
      // motion-detect from addon-a, analytics from addon-a AND addon-b (distinct addonIds → kept), alert from addon-b
      const names = caps.map((c) => c.name)
      expect(names).toContain('motion-detect')
      expect(names).toContain('analytics')
      expect(names).toContain('alert')
    })

    it('dedupes caps by (name + addonId) but keeps distinct addonIds', () => {
      const graph = buildClusterGraph([nodeWithMultiService])
      const caps = graph.nodes[0]?.runners[0]?.caps ?? []
      // analytics appears for addon-a AND addon-b → 2 entries (different addonId)
      const analyticsCaps = caps.filter((c) => c.name === 'analytics')
      expect(analyticsCaps).toHaveLength(2)
      const addonIds = analyticsCaps.map((c) => c.addonId)
      expect(addonIds).toContain('addon-a')
      expect(addonIds).toContain('addon-b')
    })

    it('does not duplicate a cap with the same name AND same addonId', () => {
      // Both services declare the same cap + addonId — only one entry should survive
      const nodeWithDupe = makeNode({
        id: 'hub-dupe',
        isHub: true,
        processes: [
          {
            pid: 999,
            name: 'dupe-runner',
            state: 'running',
            cpuPercent: 1,
            memoryRss: 1024,
            uptimeSeconds: 10,
            services: [
              { addonId: 'addon-x', capabilities: ['cap-shared'], status: 'running' },
              { addonId: 'addon-x', capabilities: ['cap-shared'], status: 'running' },
            ],
          },
        ],
      })
      const graph = buildClusterGraph([nodeWithDupe])
      const caps = graph.nodes[0]?.runners[0]?.caps ?? []
      const shared = caps.filter((c) => c.name === 'cap-shared' && c.addonId === 'addon-x')
      expect(shared).toHaveLength(1)
    })

    it('sets RunnerBlock.addonId to first service addonId when multiple services', () => {
      const graph = buildClusterGraph([nodeWithMultiService])
      expect(graph.nodes[0]?.runners[0]?.addonId).toBe('addon-a')
    })
  })

  describe('offline agent', () => {
    it('edge to offline agent has online:false', () => {
      const graph = buildClusterGraph([hubNode, offlineAgent])
      const edge = graph.edges.find((e) => e.target === 'agent-offline')
      expect(edge?.online).toBe(false)
    })

    it('offline node is still present in nodes list', () => {
      const graph = buildClusterGraph([hubNode, offlineAgent])
      const found = graph.nodes.find((n) => n.nodeId === 'agent-offline')
      expect(found).toBeDefined()
      expect(found?.isOnline).toBe(false)
    })
  })

  describe('edge cases — no processes / no localIps', () => {
    it('returns runners:[] when processes is empty', () => {
      const graph = buildClusterGraph([nodeNoProcesses])
      expect(graph.nodes[0]?.runners).toEqual([])
    })

    it('returns ip:"" when localIps is absent', () => {
      const graph = buildClusterGraph([nodeNoProcesses])
      expect(graph.nodes[0]?.identity.ip).toBe('')
    })

    it('returns no edges when there is no hub', () => {
      const graph = buildClusterGraph([agent1, agent2])
      expect(graph.edges).toHaveLength(0)
    })
  })

  describe('many runners', () => {
    it('includes all 12 runners', () => {
      const graph = buildClusterGraph([nodeWithManyRunners])
      expect(graph.nodes[0]?.runners).toHaveLength(12)
    })

    it('maps each runner pid correctly', () => {
      const graph = buildClusterGraph([nodeWithManyRunners])
      const pids = (graph.nodes[0]?.runners ?? []).map((r) => r.pid)
      for (let i = 0; i < 12; i++) {
        expect(pids).toContain(300 + i)
      }
    })
  })

  describe('process with no services', () => {
    it('sets addonId to "" when services is absent', () => {
      const nodeNoServices = makeNode({
        id: 'hub-nosvc',
        isHub: true,
        processes: [
          {
            pid: 42,
            name: 'no-svc',
            state: 'idle',
            cpuPercent: 0,
            memoryRss: 512,
            uptimeSeconds: 5,
            // no services field
          },
        ],
      })
      const graph = buildClusterGraph([nodeNoServices])
      expect(graph.nodes[0]?.runners[0]?.addonId).toBe('')
      expect(graph.nodes[0]?.runners[0]?.caps).toEqual([])
    })
  })
})
