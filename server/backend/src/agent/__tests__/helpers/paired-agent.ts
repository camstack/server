/**
 * Test fixtures for a PAIRED agent (D857): an `agent.json` holding mesh material
 * from a throwaway mesh CA, and the hub-side step that turns a CA-signed unlock
 * ticket into a session Bearer.
 */
import * as fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import {
  generateMeshCa,
  issueMeshLeafForNode,
  mintAgentUiUnlockTicket,
  type MeshCaSigner,
} from '@camstack/system'

export interface PairedFixture {
  readonly ca: MeshCaSigner
}

/** Write an `agent.json` that holds a leaf issued by a fresh mesh CA: the agent is paired. */
export async function writePairedConfig(
  configPath: string,
  nodeId: string,
  extra: Record<string, unknown> = {},
): Promise<PairedFixture> {
  const ca = await generateMeshCa()
  const leaf = await issueMeshLeafForNode(ca, nodeId)
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...extra,
      hubAddress: 'hub.example.test',
      meshTls: { certPem: leaf.certPem, keyPem: leaf.keyPem, caCertPem: ca.certPem },
    }),
  )
  return { ca }
}

/** Redeem a ticket signed by `ca` for `nodeId`; returns the session Bearer header. */
export async function unlockSession(
  app: FastifyInstance,
  ca: MeshCaSigner,
  nodeId: string,
): Promise<{ readonly authorization: string }> {
  const ticket = mintAgentUiUnlockTicket({ caKeyPem: ca.keyPem, nodeId })
  const res = await app.inject({
    method: 'POST',
    url: '/api/agent/session',
    remoteAddress: '192.168.10.50',
    payload: { ticket },
  })
  if (res.statusCode !== 200) throw new Error(`unlock failed: ${res.statusCode} ${res.body}`)
  const body: unknown = res.json()
  const token = body !== null && typeof body === 'object' ? Reflect.get(body, 'token') : null
  if (typeof token !== 'string') throw new Error('unlock returned no token')
  return { authorization: `Bearer ${token}` }
}
