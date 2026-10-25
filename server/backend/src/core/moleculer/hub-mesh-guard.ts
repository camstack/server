/**
 * The hub's mesh guard (D802, D857) — the one object that decides whether
 * another node may talk to the hub.
 *
 * A node is admitted by its CERTIFICATE: the mutual-TLS handshake chained to
 * the mesh CA, the leaf CN is the node id it speaks as, and the serial is not
 * revoked. The transport answers that (`TlsTcpTransporter.verifiedPeer`,
 * published through the process peer lookup); this class turns the answer
 * into the broker middleware and says, once per node and minute, who was
 * turned away and why. There is no shared secret, no mode and no transition.
 *
 * Kept out of `moleculer.service.ts` so that file only wires it.
 */
import {
  createMeshAccessMiddleware,
  isProcessVerifiedMeshPeer,
  MeshIdentityGate,
} from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'

/** At most one "refused" line per node per this long. */
const REFUSED_LOG_INTERVAL_MS = 60_000

export class HubMeshGuard {
  readonly gate: MeshIdentityGate
  private readonly lastLoggedAt = new Map<string, number>()

  constructor(
    private readonly ownNodeId: string,
    private readonly logger: IScopedLogger,
    private readonly now: () => number = Date.now,
    isVerifiedPeer: (nodeId: string) => boolean = isProcessVerifiedMeshPeer,
  ) {
    this.gate = new MeshIdentityGate({
      ownNodeId,
      isVerifiedPeer,
      onRefused: (nodeId, what) => this.noteRefused(nodeId, what),
    })
  }

  /** The middleware the hub broker must be constructed with. */
  middleware() {
    return createMeshAccessMiddleware({
      ownNodeId: this.ownNodeId,
      gate: this.gate,
      logger: {
        warn: (message, meta) => this.logger.warn(message, meta ? { meta } : undefined),
      },
    })
  }

  /** A node's connection dropped: forget the throttle, not an identity (there is none to forget). */
  forget(nodeId: string): void {
    this.lastLoggedAt.delete(nodeId)
  }

  private noteRefused(nodeId: string, what: string): void {
    const at = this.now()
    const last = this.lastLoggedAt.get(nodeId)
    if (last !== undefined && at - last < REFUSED_LOG_INTERVAL_MS) return
    if (this.lastLoggedAt.size >= 256) this.lastLoggedAt.clear()
    this.lastLoggedAt.set(nodeId, at)
    this.logger.warn(
      'a node without a valid mesh certificate called the hub — refused. Pair it from ' +
        'System → Cluster → Agents',
      { tags: { nodeId }, meta: { firstCall: what } },
    )
  }
}
