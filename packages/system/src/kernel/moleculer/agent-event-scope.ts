/**
 * An agent's events go to the hub, and to no other node (D848).
 *
 * `getBrokerEventBus(...).emit` broadcasts `camstack.evt.<cat>` to every node
 * whose `$event-bus` subscribes to it — and every node's does
 * (`camstack.evt.**`). On an agent that meant every telemetry event
 * (`pipeline.inference-result`, `pipeline.trace`, `motion.*`: ~3,000/min per
 * agent on the 2026-10-13 cluster) was also written to every PEER agent, in
 * clear text, where the peer's inbound gate (`AgentMeshAuthenticator`, D802)
 * refused it by design: only the hub may send an agent anything. The bytes
 * were paid for nothing.
 *
 * This middleware stops them at the source: an EVENT packet an agent
 * publishes to any node other than the hub is not written. Nothing a peer
 * agent receives changes — it refused every such packet already — and the
 * hub, the only consumer, still gets every event. A packet to the agent's own
 * node id never reaches the transport (Moleculer delivers it in-process).
 *
 * Counted, never silent: {@link AgentEventScope.stats} reports what was held
 * back per peer, and the first event withheld from each peer is logged.
 */
import type { Middleware } from 'moleculer'

/** Moleculer's EVENT packet type (`packets.PACKET_EVENT`). */
const PACKET_EVENT = 'EVENT'

/** The part of a Moleculer `Packet` this gate reads. */
export interface OutboundPacket {
  readonly type: string
  readonly target: string | null
}

/** `Transit.publish` — what a `transitPublish` hook wraps. */
export type TransitPublish = (packet: OutboundPacket) => Promise<unknown>

export interface AgentEventScopeOptions {
  /** The only node an agent's events are written to. */
  readonly hubNodeId: string
  /** Told once per peer, the first time an event to it is withheld. */
  readonly log?: (message: string) => void
}

export interface AgentEventScopeStats {
  /** EVENT packets written to the hub. */
  readonly toHub: number
  /** EVENT packets withheld, per peer node id. */
  readonly withheld: Readonly<Record<string, number>>
}

export interface AgentEventScope {
  /** Pass to `createBroker({ middlewares })` on every agent broker. */
  readonly middleware: Middleware
  stats(): AgentEventScopeStats
}

/** Is this an event packet addressed to a node other than the hub? */
export function isPeerEventPacket(packet: OutboundPacket, hubNodeId: string): boolean {
  return packet.type === PACKET_EVENT && packet.target !== null && packet.target !== hubNodeId
}

export function createAgentEventScope(opts: AgentEventScopeOptions): AgentEventScope {
  let toHub = 0
  const withheld = new Map<string, number>()

  const gate = (next: TransitPublish): TransitPublish =>
    function agentEventScoped(packet: OutboundPacket): Promise<unknown> {
      if (packet.type !== PACKET_EVENT) return next(packet)
      if (!isPeerEventPacket(packet, opts.hubNodeId)) {
        if (packet.target === opts.hubNodeId) toHub++
        return next(packet)
      }
      const peer = packet.target ?? ''
      const prev = withheld.get(peer) ?? 0
      withheld.set(peer, prev + 1)
      if (prev === 0) {
        opts.log?.(
          `mesh events: not sending events to node "${peer}" — an agent's events go to the hub only (D848)`,
        )
      }
      return Promise.resolve()
    }

  const hooks = { name: 'CamstackAgentEventScope', transitPublish: gate }
  return {
    // TECH-DEBT: documented type boundary — moleculer's middleware.d.ts declares every wrapper hook as returning the wrapped method's RESULT (`ReturnType<Transit['publish']>`), while the runtime (`wrapMethod`) expects and calls the returned WRAPPER function, which is what `gate` is.
    middleware: hooks as unknown as Middleware, // TECH-DEBT: moleculer middleware typings vs runtime wrapMethod
    stats: () => ({ toHub, withheld: Object.fromEntries(withheld) }),
  }
}
