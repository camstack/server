/**
 * AgentRegistryService — node.connected + cold-scan event emission.
 *
 * Regression guard for the race between hub boot and remote agents: when
 * a dev.sh cluster starts hub + agents simultaneously, agents can register
 * with Moleculer BEFORE the hub's `AgentRegistryService.onModuleInit`
 * wires its `$node.connected` listener. Without the cold-scan below,
 * those agents never produced an `agent.online` event, so alert-center
 * and admin-ui lost their lifecycle view of the cluster.
 *
 * These specs validate both the hot path (new connections fire the
 * listener) and the cold path (already-connected nodes retroactively
 * emit on init).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { AgentRegistryService } from '../core/agent/agent-registry.service.js'
import type { EventBusService } from '../core/events/event-bus.service.js'
import type { MoleculerService } from '../core/moleculer/moleculer.service.js'
import type { CapabilityService } from '../core/capability/capability.service.js'
import type { SystemEvent } from '@camstack/types'

interface CapturedEmits {
  readonly events: SystemEvent[]
}

function createFakes(opts: { preExistingNodeIds?: readonly string[] } = {}) {
  const emits: CapturedEmits = { events: [] }
  const fakeEventBus = {
    emit: (event: SystemEvent) => {
      emits.events.push(event)
    },
  } as unknown as EventBusService

  const localBus = new EventEmitter()
  const nodeList = (opts.preExistingNodeIds ?? []).map((id) => ({ id }))
  // D3: setOnAgentRegistered is called by AgentRegistryService.onModuleInit
  // to wire the handshake-driven reconcile trigger. The fake captures the
  // callback but does not invoke it (reconcile tests are out of scope here).
  const fakeMoleculer = {
    broker: {
      nodeID: 'hub',
      localBus,
      registry: {
        getNodeList: ({ onlyAvailable }: { onlyAvailable: boolean }) => {
          void onlyAvailable
          return nodeList
        },
      },
    },
    setOnAgentRegistered: (_cb: (nodeId: string) => void) => {
      /* no-op in unit tests */
    },
  } as unknown as MoleculerService

  const fakeCapability = {} as unknown as CapabilityService
  const service = new AgentRegistryService(fakeEventBus, fakeMoleculer, fakeCapability)

  return { service, emits, localBus }
}

describe('AgentRegistryService — agent.online event lifecycle', () => {
  let captured: CapturedEmits
  let service: AgentRegistryService
  let localBus: EventEmitter

  describe('hot path: $node.connected fired after onModuleInit', () => {
    beforeEach(() => {
      const fakes = createFakes()
      service = fakes.service
      captured = fakes.emits
      localBus = fakes.localBus
      service.onModuleInit()
    })

    it('emits agent.online with the agentId when a new node connects', () => {
      localBus.emit('$node.connected', { node: { id: 'dev-agent-0' } })
      expect(captured.events).toHaveLength(1)
      expect(captured.events[0]!.category).toBe('agent.online')
      expect((captured.events[0]!.data as Record<string, unknown>).agentId).toBe('dev-agent-0')
    })

    it('emits agent.offline on $node.disconnected', () => {
      localBus.emit('$node.disconnected', { node: { id: 'dev-agent-0' } })
      expect(captured.events).toHaveLength(1)
      expect(captured.events[0]!.category).toBe('agent.offline')
    })

    it('handles burst of connections without loss', () => {
      for (let i = 0; i < 5; i++) {
        localBus.emit('$node.connected', { node: { id: `agent-${i}` } })
      }
      expect(captured.events).toHaveLength(5)
      expect(captured.events.map((e) => (e.data as Record<string, unknown>).agentId)).toEqual([
        'agent-0',
        'agent-1',
        'agent-2',
        'agent-3',
        'agent-4',
      ])
    })
  })

  describe('cold path: nodes already connected before onModuleInit', () => {
    it('retroactively emits agent.online for pre-existing remote agents and worker.online for sub-workers', () => {
      const fakes = createFakes({
        preExistingNodeIds: ['dev-agent-0', 'dev-agent-1', 'hub/benchmark'],
      })
      fakes.service.onModuleInit()
      // Skip the self-node ('hub'). Bare ids → agents (`agent.online`);
      // `hub/<x>` ids → in-process workers (`worker.online`). The split
      // is intentional — see "Event system: separate WorkerOnline /
      // WorkerOffline events split from agent lifecycle" in
      // `agent-registry.service.ts::onModuleInit`.
      const agentIds = fakes.emits.events
        .filter((e) => e.category === 'agent.online')
        .map((e) => (e.data as Record<string, unknown>).agentId)
      const workerIds = fakes.emits.events
        .filter((e) => e.category === 'worker.online')
        .map((e) => (e.data as Record<string, unknown>).workerId)
      expect(agentIds.toSorted()).toEqual(['dev-agent-0', 'dev-agent-1'])
      expect(workerIds).toEqual(['hub/benchmark'])
    })

    it('skips the hub self-node on cold-scan', () => {
      const fakes = createFakes({ preExistingNodeIds: ['hub', 'dev-agent-0'] })
      fakes.service.onModuleInit()
      const ids = fakes.emits.events
        .filter((e) => e.category === 'agent.online')
        .map((e) => (e.data as Record<string, unknown>).agentId)
      expect(ids).toEqual(['dev-agent-0'])
      expect(ids).not.toContain('hub')
    })

    it('combined cold-scan + hot-path: no duplicates, both sources produce events', () => {
      const fakes = createFakes({ preExistingNodeIds: ['dev-agent-0'] })
      fakes.service.onModuleInit()
      // One from cold-scan.
      expect(fakes.emits.events).toHaveLength(1)
      // New connection fires the hot path.
      fakes.localBus.emit('$node.connected', { node: { id: 'dev-agent-1' } })
      expect(fakes.emits.events).toHaveLength(2)
      expect((fakes.emits.events[1]!.data as Record<string, unknown>).agentId).toBe('dev-agent-1')
    })
  })

  describe('resilience: malformed registry shape', () => {
    it('does not throw if broker.registry.getNodeList is missing', () => {
      const emits: CapturedEmits = { events: [] }
      const fakeEventBus = {
        emit: (e: SystemEvent) => emits.events.push(e),
      } as unknown as EventBusService
      const fakeMoleculer = {
        broker: { nodeID: 'hub', localBus: new EventEmitter(), registry: {} },
        setOnAgentRegistered: (_cb: (nodeId: string) => void) => {
          /* no-op */
        },
      } as unknown as MoleculerService
      const svc = new AgentRegistryService(fakeEventBus, fakeMoleculer, {} as CapabilityService)
      expect(() => svc.onModuleInit()).not.toThrow()
      expect(emits.events).toHaveLength(0)
    })

    it('does not throw if broker.registry itself is missing', () => {
      const emits: CapturedEmits = { events: [] }
      const fakeEventBus = {
        emit: (e: SystemEvent) => emits.events.push(e),
      } as unknown as EventBusService
      const fakeMoleculer = {
        broker: { nodeID: 'hub', localBus: new EventEmitter() },
        setOnAgentRegistered: (_cb: (nodeId: string) => void) => {
          /* no-op */
        },
      } as unknown as MoleculerService
      const svc = new AgentRegistryService(fakeEventBus, fakeMoleculer, {} as CapabilityService)
      expect(() => svc.onModuleInit()).not.toThrow()
    })
  })
})
