/**
 * TopologyEmitterService — the periodic pass owns the durable capture (D317).
 *
 * The capture ("snapshot every online node's descriptor so it can still be
 * rendered OFFLINE later") used to ride the tail of `listNodes()`, so every
 * operator poll of `nodes.topology` performed it. It is an observation's
 * durable half, and the periodic observer is this service.
 *
 * Two things must both hold, and only one of them is about speed:
 *   - the capture still runs, over the SAME set the pass just projected;
 *   - it runs on ONE cluster fan-out, not a second `listNodes()`;
 *   - it runs AFTER the emit, so a stalled settings-store delays no subscriber.
 */
import { describe, expect, it } from 'vitest'
import type { AddonRegistryService } from '../../addon/addon-registry.service.js'
import type { AgentRegistryService } from '../../agent/agent-registry.service.js'
import type { EventBusService } from '../../events/event-bus.service.js'
import { TopologyEmitterService } from '../topology-emitter.service.js'

interface Trace {
  readonly ops: string[]
  readonly captured: string[][]
}

function createEmitter(trace: Trace): TopologyEmitterService {
  const eventBus = {
    subscribe: () => () => {},
    emit: () => {
      trace.ops.push('emit')
    },
  } as unknown as EventBusService

  const liveNodes = [
    { info: { id: 'hub' }, isHub: true, status: {}, connectedSince: 0, subProcesses: [] },
    { info: { id: 'agent-a' }, isHub: false, status: {}, connectedSince: 0, subProcesses: [] },
  ]

  const agentRegistry = {
    listNodes: async () => {
      trace.ops.push('listNodes')
      return liveNodes
    },
    getClusterNodeHistory: async () => [],
    captureNodeHistory: async (entries: readonly { info: { id: string } }[]) => {
      trace.ops.push('captureNodeHistory')
      trace.captured.push(entries.map((e) => e.info.id))
    },
  } as unknown as AgentRegistryService

  const addonRegistry = { listAddons: () => [] } as unknown as AddonRegistryService

  return new TopologyEmitterService(eventBus, agentRegistry, addonRegistry)
}

describe('TopologyEmitterService — the periodic pass owns the capture (D317)', () => {
  it('captures every node the pass projected, on ONE fan-out, after the emit', async () => {
    const trace: Trace = { ops: [], captured: [] }
    const emitter = createEmitter(trace)

    emitter.onModuleInit()
    // `onModuleInit` fires the first pass without awaiting it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    emitter.onModuleDestroy()

    expect(trace.ops).toEqual(['listNodes', 'emit', 'captureNodeHistory'])
    expect(trace.captured).toEqual([['hub', 'agent-a']])
  })
})
