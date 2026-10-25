/**
 * TopologyEmitterService — push the cluster topology over the event bus.
 *
 * Subscribes to agent connect/disconnect + addon lifecycle events,
 * recomputes the topology snapshot on each change (debounced), and
 * emits `cluster.topology-snapshot`. Also fires a periodic safety-net
 * snapshot every TOPOLOGY_HEARTBEAT_MS so consumers that boot mid-
 * stream get a fresh payload without waiting for the next lifecycle
 * change.
 *
 * Replaces UI polling on `nodes.topology`. Admin-ui dashboards
 * subscribe to the snapshot category and read state directly from the
 * payload — zero round-trip.
 */
import { randomUUID } from 'node:crypto'
import { EventCategory } from '@camstack/types'

type Unsubscribe = () => void

import {
  computeTopologyPass,
  type NodeRegistrationLookup,
  type NodeRootPackageLookup,
} from '../../api/core/cap-providers'
import type { AddonRegistryService } from '../addon/addon-registry.service'
import type { AgentRegistryService } from '../agent/agent-registry.service'
import type { EventBusService } from '../events/event-bus.service'

const DEBOUNCE_MS = 200
const HEARTBEAT_MS = 30_000

const LIFECYCLE_CATEGORIES: readonly EventCategory[] = [
  EventCategory.AgentOnline,
  EventCategory.AgentOffline,
  EventCategory.WorkerOnline,
  EventCategory.WorkerOffline,
  EventCategory.AgentUnregistered,
  EventCategory.AddonStarted,
  EventCategory.AddonStopped,
  EventCategory.AddonRestarted,
  EventCategory.AddonInstalled,
  EventCategory.AddonUninstalled,
  EventCategory.AddonUpdated,
  EventCategory.AddonCrashed,
]

export class TopologyEmitterService {
  private readonly unsubscribers: Unsubscribe[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private emitting = false

  constructor(
    private readonly eventBus: EventBusService,
    private readonly agentRegistry: AgentRegistryService,
    private readonly addonRegistry: AddonRegistryService,
    /** Root-package identity per node (version visibility) — optional. */
    private readonly getNodeRootPackage?: NodeRootPackageLookup,
    /** Whether the hub holds each agent's capability registration — optional. */
    private readonly isNodeRegistered?: NodeRegistrationLookup,
  ) {}

  onModuleInit(): void {
    for (const category of LIFECYCLE_CATEGORIES) {
      const unsub = this.eventBus.subscribe({ category }, () => this.scheduleEmit())
      this.unsubscribers.push(unsub)
    }
    // Heartbeat fires the first emit ~immediately so consumers that
    // mount before any lifecycle change still see a snapshot.
    void this.emitNow()
    this.heartbeatTimer = setInterval(() => this.scheduleEmit(), HEARTBEAT_MS)
  }

  onModuleDestroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    for (const unsub of this.unsubscribers) {
      try {
        unsub()
      } catch {
        /* idempotent */
      }
    }
    this.unsubscribers.length = 0
  }

  private scheduleEmit(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.emitNow()
    }, DEBOUNCE_MS)
  }

  private async emitNow(): Promise<void> {
    if (this.emitting) return
    this.emitting = true
    try {
      const { nodes, liveNodes } = await computeTopologyPass(
        this.agentRegistry,
        this.addonRegistry,
        this.getNodeRootPackage,
        this.isNodeRegistered,
      )
      this.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'core', id: 'topology-emitter' },
        category: EventCategory.ClusterTopologySnapshot,
        data: { nodes, timestamp: Date.now() },
      })
      // The durable capture rides THIS pass, not an operator's read (D317).
      // This service is the periodic observer of the cluster; persisting each
      // online node's descriptor — so it can still be rendered OFFLINE later —
      // is that observation's durable half. It runs AFTER the emit so a stalled
      // settings-store delays nothing a subscriber is waiting for.
      await this.agentRegistry.captureNodeHistory(liveNodes)
    } catch {
      // Best-effort observability path. Next lifecycle event or the
      // heartbeat will retry — no need to log here.
    } finally {
      this.emitting = false
    }
  }
}
