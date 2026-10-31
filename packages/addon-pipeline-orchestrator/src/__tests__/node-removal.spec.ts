/**
 * `node-removal-hook` implementer of the orchestrator (#265): forgetting a node
 * removes the node-scoped blobs and un-pins every camera that named it.
 */
import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { createNodeRemovalHook, type NodeRemovalDeps } from '../node-removal.js'

type Store = Record<string, unknown>

function world(devices: Record<number, Store>, overrides: Partial<NodeRemovalDeps> = {}) {
  const agentSettings = new Set(['agent-1', 'agent-2'])
  const bindings = new Set(['agent-1', 'agent-2'])
  const attempts = new Set(['agent-1', 'agent-2'])
  const log: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => log,
    withTags: () => log,
  }
  const deps: NodeRemovalDeps = {
    removeAgentSettings: async (id) => agentSettings.delete(id),
    removeCapabilityBindings: async (id) => bindings.delete(id),
    removeAutoBenchmarkAttempts: async (id) => attempts.delete(id),
    listCameraDeviceIds: async () => Object.keys(devices).map(Number),
    readDeviceStore: async (id) => ({ ...devices[id] }),
    writeDeviceStore: async (id, patch) => {
      devices[id] = { ...devices[id], ...patch }
    },
    logger: log,
    ...overrides,
  }
  return { hook: createNodeRemovalHook(deps), agentSettings, bindings, attempts, devices }
}

describe('orchestrator node-removal-hook', () => {
  it('removes the node blobs and un-pins only the cameras that named the node', async () => {
    const w = world({
      1: { pipelineNodeId: 'agent-1', pipelineDeviceKey: 'openvino:GPU', audioNodeId: 'agent-1' },
      2: { pipelineNodeId: 'agent-2', audioNodeId: 'auto' },
      3: { preferredAgent: 'agent-1', pipelineNodeId: 'auto' },
    })
    const r = await w.hook.onNodeRemoved({ nodeId: 'agent-1', removedAt: 1 })
    expect(r.counts).toEqual({
      'agent-settings': 1,
      'node-bindings': 1,
      'auto-benchmark-attempts': 1,
      'camera-node-pins': 2,
    })
    expect([...w.agentSettings]).toEqual(['agent-2'])
    expect(w.devices[1]).toEqual({
      pipelineNodeId: 'auto',
      pipelineDeviceKey: 'auto',
      audioNodeId: 'auto',
    })
    expect(w.devices[2]).toEqual({ pipelineNodeId: 'agent-2', audioNodeId: 'auto' })
    expect(w.devices[3]).toEqual({ preferredAgent: null, pipelineNodeId: 'auto' })
  })

  it('is idempotent: a second call answers zero everywhere', async () => {
    const w = world({ 1: { pipelineNodeId: 'agent-1' } })
    await w.hook.onNodeRemoved({ nodeId: 'agent-1', removedAt: 1 })
    const again = await w.hook.onNodeRemoved({ nodeId: 'agent-1', removedAt: 1 })
    expect(Object.values(again.counts).every((n) => n === 0)).toBe(true)
  })

  it('never touches the hub', async () => {
    const w = world({ 1: { pipelineNodeId: 'hub' } })
    const r = await w.hook.onNodeRemoved({ nodeId: 'hub', removedAt: 1 })
    expect(Object.values(r.counts).every((n) => n === 0)).toBe(true)
    expect(w.devices[1]).toEqual({ pipelineNodeId: 'hub' })
  })

  it('a failed camera list throws (retry) and deletes no pin (D49)', async () => {
    const w = world(
      { 1: { pipelineNodeId: 'agent-1' } },
      {
        listCameraDeviceIds: async () => {
          throw new Error('device-manager unavailable')
        },
      },
    )
    await expect(w.hook.onNodeRemoved({ nodeId: 'agent-1', removedAt: 1 })).rejects.toThrow(
      'device-manager unavailable',
    )
    expect(w.devices[1]).toEqual({ pipelineNodeId: 'agent-1' })
  })
})
