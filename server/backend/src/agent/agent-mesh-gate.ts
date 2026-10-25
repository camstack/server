/**
 * The agent's mesh gate (D802, D857): only the hub may call this agent, and the
 * hub is recognised by its CERTIFICATE — the agent's own TLS listener accepted
 * it only because its leaf chains to the mesh CA this agent was paired with
 * (`TlsTcpTransporter.verifiedPeer`).
 *
 * There is no join to run and nothing to hold: a verdict is a function of what
 * the transport already knows, so the hub's very first packet on a new
 * connection is judged correctly. An agent that is not paired holds no
 * certificate, so it admits no one.
 *
 * Also here: the agent's outbound event scope (D848) — its events go to the hub only.
 */
import {
  AgentMeshIdentityGate,
  createAgentEventScope,
  createMeshAccessMiddleware,
  type AgentEventScope,
} from '@camstack/system'
import type { Middleware } from 'moleculer'

const HUB_NODE_ID = 'hub'

export interface AgentMeshGateOptions {
  readonly nodeId: string
  /** True when `nodeId` is a certificate-verified peer of the agent's CURRENT transport. */
  readonly isVerifiedPeer: (nodeId: string) => boolean
  readonly log?: (message: string) => void
}

export interface AgentMeshGate {
  readonly gate: AgentMeshIdentityGate
  /** Outbound event scope (D848): the agent's events go to the hub only. */
  readonly eventScope: AgentEventScope
  /** Pass to `createBroker({ middlewares })`: the inbound gate and the outbound event scope. */
  readonly middlewares: readonly Middleware[]
}

/** At most one "refused" line per sender per this long. */
const REFUSED_LOG_INTERVAL_MS = 60_000

export function createAgentMeshGate(opts: AgentMeshGateOptions): AgentMeshGate {
  const lastLoggedAt = new Map<string, number>()
  const gate = new AgentMeshIdentityGate({
    ownNodeId: opts.nodeId,
    hubNodeId: HUB_NODE_ID,
    isVerifiedPeer: opts.isVerifiedPeer,
    onRefused: (nodeId, what) => {
      const at = Date.now()
      const last = lastLoggedAt.get(nodeId)
      if (last !== undefined && at - last < REFUSED_LOG_INTERVAL_MS) return
      if (lastLoggedAt.size >= 64) lastLoggedAt.clear()
      lastLoggedAt.set(nodeId, at)
      opts.log?.(
        `mesh inbound: "${nodeId}" is not the certified hub — refused (first call: ${what})`,
      )
    },
  })
  const eventScope = createAgentEventScope({
    hubNodeId: HUB_NODE_ID,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  })
  const inbound = createMeshAccessMiddleware({
    ownNodeId: opts.nodeId,
    gate,
    logger: {
      warn: (message, meta) => {
        const detail =
          meta === undefined
            ? ''
            : ` ${Object.entries(meta)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(' ')}`
        opts.log?.(`${message}${detail}`)
      },
    },
  })
  return { gate, eventScope, middlewares: [inbound, eventScope.middleware] }
}
