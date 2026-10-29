/**
 * The hub's membership routes over real HTTP framing (fastify inject): the challenge, the proof, the
 * bare refusals, and the rate limit. The cryptography itself is pinned in the system package.
 */
import {
  generateMeshCa,
  issueMeshLeafForNode,
  MembershipResponder,
  MeshCertificateRegistry,
  MeshCrl,
  signMembershipProof,
  verifyMembershipAnswer,
} from '@camstack/system'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import Fastify from 'fastify'
import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { registerMeshMembershipRoutes } from '../mesh-membership-routes'

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

async function setup(perMinute = 60) {
  const ca = await generateMeshCa()
  const registry = new MeshCertificateRegistry(memoryStore())
  const crl = new MeshCrl()
  const leaf = await issueMeshLeafForNode(ca, 'agent-old')
  await registry.recordIssued('agent-old', leaf.certPem, 'pairing')
  const app = Fastify()
  registerMeshMembershipRoutes(app, {
    logger: silent,
    perMinute,
    responder: new MembershipResponder({
      registry: () => registry,
      crl: () => crl,
      caKeyPem: () => ca.keyPem,
    }),
  })
  const challenge = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mesh/membership/challenge',
    })
    return (res.json() as { nonce: string }).nonce
  }
  return { ca, registry, crl, leaf, app, challenge }
}

describe('POST /api/mesh/membership', () => {
  it('tells a forgotten agent, that proves its key, that it was revoked - signed by the mesh CA', async () => {
    const t = await setup()
    await t.registry.revokeAllForNode('agent-old', 'forgotten', t.crl)
    const nonce = await t.challenge()

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mesh/membership',
      payload: {
        nodeId: 'agent-old',
        certPem: t.leaf.certPem,
        nonce,
        signature: signMembershipProof(t.leaf.keyPem, 'agent-old', nonce),
      },
    })

    expect(res.statusCode).toBe(200)
    const { token } = res.json() as { token: string }
    expect(
      verifyMembershipAnswer(t.ca.certPem, token, {
        nodeId: 'agent-old',
        nonce,
        leafFingerprint: new X509Certificate(t.leaf.certPem).fingerprint256,
      }),
    ).toEqual({ status: 'revoked', reason: 'forgotten' })
  })

  it('gives a caller without the key a bare 401 - no token, no status, no hint', async () => {
    const t = await setup()
    await t.registry.revokeAllForNode('agent-old', 'forgotten', t.crl)
    const other = await issueMeshLeafForNode(t.ca, 'agent-old')
    const nonce = await t.challenge()

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mesh/membership',
      payload: {
        nodeId: 'agent-old',
        certPem: t.leaf.certPem,
        nonce,
        signature: signMembershipProof(other.keyPem, 'agent-old', nonce),
      },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ ok: false })
  })

  it('rate limits a source address', async () => {
    const t = await setup(3)
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/mesh/membership/challenge',
          })
        ).statusCode,
      ).toBe(200)
    }
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mesh/membership/challenge',
    })
    expect(res.statusCode).toBe(429)
  })
})
