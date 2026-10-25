/**
 * Mesh identity (D857) — who is calling a node, decided by the CERTIFICATE.
 *
 * There is no shared secret. A node is admitted by the mesh when its mutual-TLS
 * handshake chained to the mesh CA, its leaf CN is the node id it speaks as, and
 * the leaf is not revoked (D856). The transport enforces the first two on every
 * packet (`TlsTcpTransporter.onIncomingMessage` drops a `sender` that is not the
 * peer CN), and answers the third through `verifiedPeer`. These gates do one
 * thing: turn "is this sender a verified peer" into allow or deny, and keep a
 * short list of actions no other node may ever call.
 *
 * Hub gate:   every other node must be a verified peer.
 * Agent gate: only the verified hub may call an agent; an agent's mesh has no
 *             other peer (D848).
 *
 * Nothing here reads a credential, mints a nonce or remembers a node's state:
 * a verdict is a pure function of the transport's current knowledge, so a
 * revocation takes effect on the next packet.
 */
import { Errors } from 'moleculer'

/** Moleculer error `type`: the sender has no certificate identity this node accepts. */
export const MESH_NODE_UNAUTHENTICATED_TYPE = 'MESH_NODE_UNAUTHENTICATED'
/** Moleculer error `type`: the action is never callable from another node. */
export const MESH_ACTION_FORBIDDEN_TYPE = 'MESH_ACTION_FORBIDDEN'

/** Reads a Moleculer error's `type`, including after an RPC round-trip. */
export function meshErrorType(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('type' in err)) return null
  const { type } = err
  return typeof type === 'string' ? type : null
}

export type MeshCallVerdict =
  | { readonly verdict: 'allow'; readonly errorType?: undefined }
  | { readonly verdict: 'deny'; readonly errorType: string; readonly message: string }

/** A gate the broker middleware asks about every inbound action and event. */
export interface MeshCallGate {
  admitCall(sender: string, action: string): MeshCallVerdict
  admitEvent(sender: string, eventName: string): MeshCallVerdict
}

/**
 * Services and actions no other node ever calls on the hub. `$process` spawns
 * runners with an arbitrary environment (code execution); `$node` is
 * Moleculer's introspection; `setLogLevel` is an operator action the hub
 * issues itself.
 */
const HUB_FORBIDDEN_SERVICES: ReadonlySet<string> = new Set(['$process', '$node'])
const HUB_FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set(['$hub.setLogLevel'])

export function isRemoteForbiddenAction(action: string): boolean {
  if (HUB_FORBIDDEN_ACTIONS.has(action)) return true
  const dot = action.indexOf('.')
  return dot > 0 && HUB_FORBIDDEN_SERVICES.has(action.slice(0, dot))
}

/** Moleculer introspection — never from another node, on an agent either. */
const AGENT_FORBIDDEN_SERVICES: ReadonlySet<string> = new Set(['$node'])

export function isRemoteForbiddenOnAgent(action: string): boolean {
  const dot = action.indexOf('.')
  return dot > 0 && AGENT_FORBIDDEN_SERVICES.has(action.slice(0, dot))
}

/** `true` when `nodeId` is a certificate-verified mesh peer right now. */
export type PeerVerifier = (nodeId: string) => boolean

export interface MeshIdentityGateDeps {
  /** The node's own id — its local calls never pass through here. */
  readonly ownNodeId: string
  readonly isVerifiedPeer: PeerVerifier
  /** A sender was refused for lack of a certificate identity (rate-limit in the caller). */
  readonly onRefused?: (nodeId: string, what: string) => void
}

function refuse(message: string, type: string, code = 403): Errors.MoleculerClientError {
  return new Errors.MoleculerClientError(message, code, type)
}

const NOT_PAIRED_HINT =
  'pair it with this hub (System → Cluster → Agents) so it holds a certificate from the mesh CA'

/** The hub's gate: every other node must hold a verified certificate identity. */
export class MeshIdentityGate implements MeshCallGate {
  constructor(private readonly deps: MeshIdentityGateDeps) {}

  admitCall(sender: string, action: string): MeshCallVerdict {
    if (sender === this.deps.ownNodeId) return { verdict: 'allow' }
    if (isRemoteForbiddenAction(action)) {
      return {
        verdict: 'deny',
        errorType: MESH_ACTION_FORBIDDEN_TYPE,
        message: `"${action}" is not callable from another node (caller "${sender}")`,
      }
    }
    return this.admitSender(sender, action)
  }

  /** Same rule as a call, for an inbound event. */
  admitEvent(sender: string, eventName: string): MeshCallVerdict {
    if (sender === this.deps.ownNodeId) return { verdict: 'allow' }
    return this.admitSender(sender, `event:${eventName}`)
  }

  /** Throws when `sender` may not register `nodeId`: a node registers only itself. */
  admitRegistration(sender: string, nodeId: string): void {
    if (sender === this.deps.ownNodeId) return
    if (nodeId !== sender) {
      throw refuse(
        `registration refused: node "${sender}" may register only itself, not "${nodeId}"`,
        MESH_NODE_UNAUTHENTICATED_TYPE,
      )
    }
    if (!this.deps.isVerifiedPeer(sender)) {
      this.deps.onRefused?.(sender, '$hub.registerNode')
      throw refuse(
        `node "${sender}" holds no valid mesh certificate — ${NOT_PAIRED_HINT}`,
        MESH_NODE_UNAUTHENTICATED_TYPE,
      )
    }
  }

  private admitSender(sender: string, what: string): MeshCallVerdict {
    if (this.deps.isVerifiedPeer(sender)) return { verdict: 'allow' }
    this.deps.onRefused?.(sender, what)
    return {
      verdict: 'deny',
      errorType: MESH_NODE_UNAUTHENTICATED_TYPE,
      message: `node "${sender}" holds no valid mesh certificate — ${NOT_PAIRED_HINT}`,
    }
  }
}

export interface AgentMeshIdentityGateDeps extends MeshIdentityGateDeps {
  readonly hubNodeId?: string
}

/**
 * An agent's inbound gate: the hub, proven by the certificate the agent's TLS
 * listener already verified, and nobody else. An agent that is not paired holds
 * no certificate, so it admits no one.
 */
export class AgentMeshIdentityGate implements MeshCallGate {
  private readonly hubNodeId: string

  constructor(private readonly deps: AgentMeshIdentityGateDeps) {
    this.hubNodeId = deps.hubNodeId ?? 'hub'
  }

  admitCall(sender: string, action: string): MeshCallVerdict {
    if (sender === this.deps.ownNodeId) return { verdict: 'allow' }
    if (isRemoteForbiddenOnAgent(action)) {
      return {
        verdict: 'deny',
        errorType: MESH_ACTION_FORBIDDEN_TYPE,
        message: `"${action}" is not callable from another node (caller "${sender}")`,
      }
    }
    return this.admitSender(sender, action)
  }

  admitEvent(sender: string, eventName: string): MeshCallVerdict {
    if (sender === this.deps.ownNodeId) return { verdict: 'allow' }
    return this.admitSender(sender, `event:${eventName}`)
  }

  private admitSender(sender: string, what: string): MeshCallVerdict {
    if (sender === this.hubNodeId && this.deps.isVerifiedPeer(sender)) return { verdict: 'allow' }
    this.deps.onRefused?.(sender, what)
    return {
      verdict: 'deny',
      errorType: MESH_NODE_UNAUTHENTICATED_TYPE,
      message:
        `node "${sender}" is not accepted by this agent — only the hub, ` +
        "proven by the certificate this agent's TLS listener verified, may call it",
    }
  }
}
