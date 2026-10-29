/**
 * The seam `forgetClusterNode` revokes through: against a REAL certificate registry, a forgotten
 * node's leaf lands on the CRL (so `TlsTcpTransporter.verifiedPeer` refuses it on the next
 * connection) with the reason the node is later told - and its sockets are cut.
 */
import {
  generateMeshCa,
  issueMeshLeafForNode,
  MeshCertificateRegistry,
  MeshCrl,
  type MeshPeers,
} from '@camstack/system'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createForgottenNodeRevoker } from '../forgotten-node-revoker'

function memoryStore(): SettingsStoreClient {
  const rows = new Map<string, Map<string, { id: string; data: Record<string, unknown> }>>()
  const coll = (n: string) => {
    let c = rows.get(n)
    if (c === undefined) {
      c = new Map()
      rows.set(n, c)
    }
    return c
  }
  const store = {
    insert: {
      mutate: async (a: {
        collection: string
        record: { id: string; data: Record<string, unknown> }
      }) => {
        coll(a.collection).set(a.record.id, a.record)
      },
    },
    update: {
      mutate: async (a: { collection: string; id: string; data: Record<string, unknown> }) => {
        coll(a.collection).set(a.id, { id: a.id, data: a.data })
      },
    },
    delete: {
      mutate: async (a: { collection: string; key: string }) =>
        void coll(a.collection).delete(a.key),
    },
    query: {
      query: async (a: { collection: string }) => [...coll(a.collection).values()],
    },
  }
  return store as unknown as SettingsStoreClient
}

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

describe('createForgottenNodeRevoker', () => {
  it('puts every leaf of the node on the CRL with the given reason and cuts its sockets', async () => {
    const ca = await generateMeshCa()
    const leaf = await issueMeshLeafForNode(ca, 'agent-old')
    const registry = new MeshCertificateRegistry(memoryStore())
    await registry.recordIssued('agent-old', leaf.certPem, 'pairing')
    const crl = new MeshCrl()
    const dropped: string[] = []
    const peers: MeshPeers = {
      peerLeaf: () => undefined,
      dropPeer: (nodeId) => {
        dropped.push(nodeId)
        return 1
      },
    }

    const revoke = createForgottenNodeRevoker({
      logger: silent,
      registry: () => registry,
      crl: () => crl,
      peers,
    })
    const serials = await revoke('agent-old', 'forgotten')

    expect(serials).toHaveLength(1)
    expect(crl.isRevoked(serials?.[0] ?? '')).toBe(true)
    expect(serials?.[0]).toBe(registry.list('agent-old')[0]?.serial)
    expect(registry.list('agent-old')[0]?.revokedReason).toBe('forgotten')
    expect(dropped).toEqual(['agent-old'])
  })

  it('answers null (not []) while the certificate registry is not loaded', async () => {
    const revoke = createForgottenNodeRevoker({
      logger: silent,
      registry: () => null,
    })
    expect(await revoke('agent-old', 'forgotten')).toBeNull()
  })
})
