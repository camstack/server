import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `node-certificates` - what a node holds and the two renewals the hub drives
 * (D856): the node's MESH leaf (mutual TLS to the hub) and its HTTPS leaf (issued
 * from the hub's local CA so a device that trusts the hub root trusts the node).
 *
 * Provided by the AGENT RUNTIME (the synthetic `agent-runtime` addon id, like
 * `server-management`): the hub reaches it through the ordinary node-pinned
 * capability call - no new Moleculer action. The hub's own certificates are
 * handled in-process by the hub (`certificates` router), so this cap has no hub
 * provider.
 *
 * No private key ever crosses the mesh: the node generates its key pair, sends a
 * CSR, and the hub returns only the signed certificate.
 */

export const MeshLeafInfoSchema = z.object({
  cn: z.string(),
  serial: z.string(),
  fingerprintSha256: z.string(),
  notBefore: z.number(),
  notAfter: z.number(),
})
export type MeshLeafInfo = z.infer<typeof MeshLeafInfoSchema>

export const HttpsLeafInfoSchema = z.object({
  fingerprintSha256: z.string(),
  issuer: z.string(),
  sans: z.array(z.string()),
  notBefore: z.number(),
  notAfter: z.number(),
})
export type HttpsLeafInfo = z.infer<typeof HttpsLeafInfoSchema>

export const NodeHttpsStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('served'), leaf: HttpsLeafInfoSchema }),
  /** The node has no hub-issued HTTPS leaf yet (it serves plain HTTP only on its port). */
  z.object({ state: z.literal('not-issued'), reason: z.string() }),
])
export type NodeHttpsState = z.infer<typeof NodeHttpsStateSchema>

export const nodeCertificatesCapability = {
  name: 'node-certificates',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /** The node's current mesh leaf (`null` when it is not enrolled on mTLS) and HTTPS state. */
    getCertificates: method(
      z.object({}),
      z.object({
        nodeId: z.string(),
        mesh: MeshLeafInfoSchema.nullable(),
        https: NodeHttpsStateSchema,
      }),
      { auth: 'admin' },
    ),

    /** Generate a NEW mesh key pair on the node; return the CSR (CN = node id). The key stays here. */
    prepareMeshRenewal: method(z.object({}), z.object({ csrPem: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Install the hub-signed leaf for the key made by `prepareMeshRenewal`: persist it
     * (keeping the previous one), then reconnect to the hub with it. The node reverts to
     * the previous leaf by itself unless `confirmMeshLeaf` arrives within `confirmWithinMs`.
     */
    installMeshLeaf: method(
      z.object({
        certPem: z.string().min(1),
        caCertPem: z.string().min(1),
        confirmWithinMs: z.number().int().min(10_000).max(600_000),
      }),
      z.object({ fingerprintSha256: z.string(), serial: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** The hub saw the node reconnect with the new leaf: keep it, forget the previous one. */
    confirmMeshLeaf: method(
      z.object({ fingerprintSha256: z.string() }),
      z.object({ confirmed: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Go back to the previous leaf now. `false` when there is none to go back to. */
    rollbackMeshLeaf: method(z.object({}), z.object({ rolledBack: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** A key pair + CSR for the node's HTTPS leaf, and the names the node reports for itself. */
    prepareHttpsCertificate: method(
      z.object({}),
      z.object({
        csrPem: z.string(),
        hostnames: z.array(z.string()),
        addresses: z.array(z.string()),
        /** SHA-256 of the hub local CA this node pinned at its first install; `null` before one. */
        pinnedCaFingerprintSha256: z.string().nullable(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * The hub unpairs this node (D857): it erases its mesh material, goes back to the
     * unpaired state and advertises itself again. The call is answered first; the wire
     * goes down right after, so the hub revokes the node's certificates BEFORE this
     * connection drops, never after.
     */
    forgetHub: method(z.object({}), z.object({ ok: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Install the hub-signed HTTPS leaf and hot-swap the serving context (no restart). */
    installHttpsCertificate: method(
      z.object({
        certPem: z.string().min(1),
        caCertPem: z.string().min(1),
        /**
         * The hub signals that its local CA was rotated (D227) and this leaf chains to the NEW
         * one. Only the hub, over the authenticated mesh, can say so; a leaf with a different CA
         * and no signal is refused.
         */
        caRotation: z.boolean().optional(),
      }),
      HttpsLeafInfoSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type INodeCertificatesProvider = InferProvider<typeof nodeCertificatesCapability>
