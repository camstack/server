/**
 * The hub's revocation of a FORGOTTEN node's mesh certificates (D857, #265).
 *
 * `AgentRegistryService.forgetClusterNode` is handed this as a seam so it never imports the
 * pairing router; the revocation is the same one the operator's "unpair" performs
 * (`revokeMeshCertificate`: every leaf of the node onto the CRL, its sockets cut) with the
 * reason `forgotten`, which is what the node is told when it asks why it is refused.
 */
import {
  dropProcessPeer,
  getProcessMeshCertificateRegistry,
  getProcessPeerLeaf,
  processMeshCrl,
  revokeMeshCertificate,
  type MeshCertificateRegistry,
  type MeshCrl,
  type MeshPeers,
} from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import type { NodeCertificateRevoker } from './agent-registry.service'

export interface ForgottenNodeRevokerDeps {
  readonly logger: IScopedLogger
  readonly registry?: () => MeshCertificateRegistry | null
  readonly crl?: () => MeshCrl
  readonly peers?: MeshPeers
}

export function createForgottenNodeRevoker(deps: ForgottenNodeRevokerDeps): NodeCertificateRevoker {
  const registry = deps.registry ?? getProcessMeshCertificateRegistry
  const crl = deps.crl ?? processMeshCrl
  const peers: MeshPeers = deps.peers ?? {
    peerLeaf: (nodeId) => getProcessPeerLeaf(nodeId),
    dropPeer: (nodeId) => dropProcessPeer(nodeId),
  }
  return async (nodeId, reason) => {
    const loaded = registry()
    if (loaded === null) return null
    const result = await revokeMeshCertificate({
      nodeId,
      registry: loaded,
      crl: crl(),
      peers,
      reason,
      log: deps.logger,
    })
    return result.revokedSerials
  }
}
