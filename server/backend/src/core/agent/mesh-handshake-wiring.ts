/**
 * Publishes the hub's mesh handshake reporter (#558): refused handshakes reach the log at WARN
 * through a real scoped logger (the transporter's own logger is pinned to `error`), and a leaf the
 * hub admitted only because it expired is handed to the renewal.
 */
import {
  dropProcessPeer,
  getProcessMeshCaState,
  getProcessMeshCertificateRegistry,
  getProcessPeerLeaf,
  onProcessNodeRegistered,
  processMeshCrl,
  renewMeshCertificate,
  setProcessMeshHandshakeReporter,
  type MeshLog,
  type MeshPeers,
  type MeshRegistrations,
  type RenewMeshResult,
} from '@dominevo/server/system'
import type { MoleculerService } from '../moleculer/moleculer.service.js'
import { createExpiredLeafRenewer } from './expired-leaf-renewer.js'
import { createNodeCertificatesClient } from './node-certificates-client.js'

export interface MeshHandshakeWiringDeps {
  readonly log: MeshLog
  readonly moleculer: Pick<MoleculerService, 'createCapabilityProxy' | 'getNodeAddonIds'>
}

export function installMeshHandshakeReporter(deps: MeshHandshakeWiringDeps): void {
  const peers: MeshPeers = {
    peerLeaf: (nodeId) => getProcessPeerLeaf(nodeId),
    dropPeer: (nodeId) => dropProcessPeer(nodeId),
  }
  const registrations: MeshRegistrations = {
    subscribe: (listener) => onProcessNodeRegistered(listener),
  }
  const renew = async (nodeId: string): Promise<RenewMeshResult | null> => {
    const client = createNodeCertificatesClient(deps.moleculer, nodeId)
    const state = getProcessMeshCaState()
    const registry = getProcessMeshCertificateRegistry()
    if (client === null || state.state !== 'ready' || registry === null) return null
    return renewMeshCertificate({
      nodeId,
      client,
      ca: state.ca,
      registry,
      crl: processMeshCrl(),
      peers,
      registrations,
      expectedAddons: (id) => deps.moleculer.getNodeAddonIds(id),
      log: deps.log,
    })
  }
  const expiredLeafAdmitted = createExpiredLeafRenewer({
    log: deps.log,
    registrations,
    renew,
    isRegistered: (nodeId) => deps.moleculer.getNodeAddonIds(nodeId).length > 0,
  })
  setProcessMeshHandshakeReporter({
    warn: (message, extras) => deps.log.warn(message, extras),
    expiredLeafAdmitted,
  })
}
