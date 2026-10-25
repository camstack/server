/**
 * Certificates inventory and management - fixed core API for Identity ->
 * Certificates (D855, D856).
 *
 * Hand-written (not a `*.cap.ts`) like `cluster-nodes.router.ts`: it joins the node
 * list (agent registry), the `local-network` provider (the hub's HTTPS leaf), the
 * mesh CA and the registry of mesh leaves, and calls each agent's
 * `node-certificates` capability. Device credentials are the `device-credentials`
 * capability; this router never touches them.
 *
 *  - HTTPS: the hub serves its own leaf (renewed with `regenerateCertificate`);
 *    every agent serves a leaf the HUB issued from its local CA, on the same port
 *    as its plain HTTP. An agent without one yet says so (`not-served`, with the
 *    reason), never an empty row that reads as "no certificate".
 *  - Mesh: every leaf the hub issues is recorded; a node enrolled earlier is
 *    recorded from the leaf it presents on its live connection (`observed`).
 *    Renewal is a handover that never leaves a node without a working leaf
 *    (`mesh-renewal.ts`); revocation puts the serial on the CRL and disconnects
 *    the node, which must be paired again. Neither forgets a node:
 *    that stays `clusterNodes.forgetNode`.
 */
import { X509Certificate } from 'node:crypto'
import type {
  CapabilityRegistry,
  MeshCertificateRegistry,
  MeshCrl,
  MeshPeers,
  MeshRegistrations,
} from '@camstack/system'
import {
  caFingerprint,
  describeHttpsLeaf,
  dropProcessPeer,
  getProcessMeshCaState,
  getProcessAgentHttpsNames,
  getProcessMeshCertificateRegistry,
  getProcessMeshTlsListenerState,
  getProcessPeerLeaf,
  onProcessNodeRegistered,
  issueAgentHttpsLeaf,
  type MeshCaSigner,
  processMeshCrl,
  renewMeshCertificate,
  revokeMeshCertificate,
} from '@camstack/system'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { AgentRegistryService } from '../../core/agent/agent-registry.service.js'
import type { NodeCertificatesClient } from '../../core/agent/node-certificates-client.js'
import { adminProcedure, trpcRouter } from '../trpc/trpc.middleware.js'

const HUB_NODE_ID = 'hub'
const EXPIRING_SOON_MS = 7 * 86_400_000

const TlsStatusRowSchema = z.object({
  mode: z.enum(['generated', 'uploaded', 'disabled']),
  leafFingerprintSha256: z.string().nullable(),
  caFingerprintSha256: z.string().nullable(),
  validTo: z.string().nullable(),
  sans: z.array(z.string()),
  reissueError: z.string().nullable(),
  restartRequired: z.boolean(),
})

const NodeHttpsSchema = z.object({
  nodeId: z.string(),
  isHub: z.boolean(),
  online: z.boolean(),
  https: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('served'), status: TlsStatusRowSchema }),
    z.object({ kind: z.literal('not-served'), reason: z.string() }),
    /** The hub could not read it right now: say so, never present it as "none". */
    z.object({ kind: z.literal('unreadable'), reason: z.string() }),
  ]),
})

const MeshLeafRowSchema = z.object({
  serial: z.string(),
  fingerprintSha256: z.string(),
  notBefore: z.number(),
  notAfter: z.number(),
  issuedAt: z.number(),
  /** `enroll` | `pairing` | `renewal` | `boot` were issued by the hub; `observed` was read off a live connection. */
  issuedVia: z.enum(['enroll', 'pairing', 'renewal', 'boot', 'observed']),
  status: z.enum(['valid', 'expiring', 'expired', 'revoked']),
  revokedAt: z.number().nullable(),
  revokedReason: z.string().nullable(),
})

const MeshNodeSchema = z.object({
  nodeId: z.string(),
  online: z.boolean(),
  /** The leaf the node holds now: the newest non-revoked one. `null` when none is known. */
  current: MeshLeafRowSchema.nullable(),
  /** The node is connected and presents exactly `current`. `null` when it is offline. */
  presentingCurrent: z.boolean().nullable(),
  /** Older and revoked leaves, newest first. */
  history: z.array(MeshLeafRowSchema),
})

const MeshInventorySchema = z.object({
  ca: z.discriminatedUnion('state', [
    z.object({
      state: z.literal('ready'),
      subject: z.string(),
      fingerprintSha256: z.string(),
      validTo: z.string(),
    }),
    z.object({ state: z.literal('unavailable'), reason: z.string() }),
  ]),
  /** Serials the hub refuses at the mesh handshake. Persisted with the registry and replayed at boot. */
  revokedSerials: z.array(z.string()),
  /** `false` while the registry is not up (no settings store): the node list is then incomplete. */
  registryAvailable: z.boolean(),
  /** The hub's mesh TLS listener: `closed` means every agent is refused (e.g. revocations not loaded). */
  listener: z.discriminatedUnion('state', [
    z.object({ state: z.literal('open') }),
    z.object({ state: z.literal('closed'), reason: z.string(), since: z.number() }),
    z.object({ state: z.literal('not-started') }),
  ]),
  nodes: z.array(MeshNodeSchema),
})

const MeshRenewResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    nodeId: z.string(),
    oldSerial: z.string().nullable(),
    newSerial: z.string(),
    newNotAfter: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    nodeId: z.string(),
    stage: z.enum(['prepare', 'issue', 'install', 'reconnect', 'confirm']),
    reason: z.string(),
    /** The node is on its previous leaf (or never left it): nothing was broken. */
    keptPreviousLeaf: z.boolean(),
  }),
])

const MeshRevokeResultSchema = z.object({
  nodeId: z.string(),
  revokedSerials: z.array(z.string()),
  disconnected: z.number().int(),
  /** What the operator does next. Revoking does not forget the node. */
  next: z.string(),
})

/** The slice of the names registry the router uses. */
export interface AgentHttpsNamesLike {
  takenByOthers(nodeId: string): ReadonlySet<string>
  record(nodeId: string, names: readonly string[]): Promise<void>
}

export interface CertificatesRouterDeps {
  readonly registry: CapabilityRegistry | null
  readonly agentRegistry: Pick<AgentRegistryService, 'listNodeLiveness'>
  /** A node's `node-certificates` handle, or `null` when it cannot be reached. */
  readonly nodeClient: (nodeId: string) => NodeCertificatesClient | null
  /** The hub's data dir (holds `tls/camstack-ca.*`). */
  readonly hubDataDir: string
  /** Names already certified to other nodes (the hub's own memory); `null` while it is not up. */
  readonly httpsNames?: () => AgentHttpsNamesLike | null
  /** The hub's registration completions (D3): what a renewal waits for. */
  readonly registrations?: MeshRegistrations
  /** The addon ids the hub holds for a node: a renewal waits until the node has them all again. */
  readonly nodeAddonIds?: (nodeId: string) => readonly string[]
  readonly log: {
    info(m: string, e?: { tags?: Record<string, string>; meta?: Record<string, unknown> }): void
    warn(m: string, e?: { tags?: Record<string, string>; meta?: Record<string, unknown> }): void
    error(m: string, e?: { tags?: Record<string, string>; meta?: Record<string, unknown> }): void
  }
  /** Test seams; production reads the process slots. */
  readonly meshRegistry?: () => MeshCertificateRegistry | null
  readonly crl?: () => MeshCrl
  readonly meshCa?: () => MeshCaSigner | null
  readonly peers?: MeshPeers
  readonly issueHttps?: typeof issueAgentHttpsLeaf
  readonly reconnectTimeoutMs?: number
  readonly listenerState?: () =>
    | { state: 'open' }
    | { state: 'closed'; reason: string; since: number }
    | { state: 'not-started' }
  readonly sleep?: (ms: number) => Promise<void>
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void }
}

function leafStatus(
  record: { revokedAt: number | null; notAfter: number },
  at: number,
): 'valid' | 'expiring' | 'expired' | 'revoked' {
  if (record.revokedAt !== null) return 'revoked'
  if (record.notAfter <= at) return 'expired'
  return record.notAfter - at < EXPIRING_SOON_MS ? 'expiring' : 'valid'
}

export function createCertificatesRouter(deps: CertificatesRouterDeps) {
  const localNetwork = () => {
    const provider = deps.registry?.getSingleton('local-network')
    if (!provider) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The local-network capability is not available yet',
      })
    }
    return provider
  }
  const peers: MeshPeers = deps.peers ?? {
    peerLeaf: (nodeId) => getProcessPeerLeaf(nodeId),
    dropPeer: (nodeId) => dropProcessPeer(nodeId),
  }
  const meshRegistry = deps.meshRegistry ?? getProcessMeshCertificateRegistry
  const crl = deps.crl ?? processMeshCrl
  const meshCa =
    deps.meshCa ??
    ((): MeshCaSigner | null => {
      const state = getProcessMeshCaState()
      return state.state === 'ready' ? state.ca : null
    })
  const issueHttps = deps.issueHttps ?? issueAgentHttpsLeaf
  const listenerState =
    deps.listenerState ??
    (() => getProcessMeshTlsListenerState() ?? { state: 'not-started' as const })
  const httpsNames = deps.httpsNames ?? getProcessAgentHttpsNames
  const registrations: MeshRegistrations = deps.registrations ?? {
    subscribe: (listener) => onProcessNodeRegistered(listener),
  }

  /** One certificate operation per node at a time: a second one is refused, not interleaved. */
  const busy = new Set<string>()
  const exclusive = async <T>(key: string, what: string, run: () => Promise<T>): Promise<T> => {
    if (busy.has(key)) {
      deps.log.warn('Certificate operation refused: another one is running on this node', {
        tags: { nodeId: key },
        meta: { what },
      })
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Another certificate operation is already running on ${key}. Wait for it to finish.`,
      })
    }
    busy.add(key)
    try {
      return await run()
    } finally {
      busy.delete(key)
    }
  }

  const requireAgent = (nodeId: string): NodeCertificatesClient => {
    if (nodeId === HUB_NODE_ID) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          'The hub is not an agent: its HTTPS leaf is renewed with renewHttpsOnNode on "hub", and its mesh leaf is re-issued at every boot.',
      })
    }
    const client = deps.nodeClient(nodeId)
    if (client === null) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Node ${nodeId} is not reachable, or runs an agent too old to manage its certificates (update it).`,
      })
    }
    return client
  }

  /** Record the leaf each connected node presents, for nodes enrolled before the registry existed. */
  const observeConnectedNodes = async (registry: MeshCertificateRegistry): Promise<void> => {
    for (const node of deps.agentRegistry.listNodeLiveness()) {
      if (node.id === HUB_NODE_ID || !node.isOnline) continue
      const leaf = peers.peerLeaf(node.id)
      if (leaf === undefined) continue
      await registry.recordObserved(node.id, {
        cn: node.id,
        serial: leaf.serial,
        fingerprint: leaf.fingerprint,
        notBefore: leaf.notBefore,
        notAfter: leaf.notAfter,
      })
    }
  }

  const statusOfLeaf = (
    leaf: ReturnType<typeof describeHttpsLeaf>,
  ): z.infer<typeof TlsStatusRowSchema> => ({
    mode: 'generated',
    leafFingerprintSha256: leaf.fingerprintSha256,
    caFingerprintSha256: null,
    validTo: new Date(leaf.notAfter).toISOString(),
    sans: leaf.sans,
    reissueError: null,
    restartRequired: false,
  })

  return trpcRouter({
    /** HTTPS certificate state per node. The hub serves its own; an agent serves a hub-issued leaf. */
    listHttpsCertificates: adminProcedure
      .input(z.void())
      .output(z.array(NodeHttpsSchema))
      .query(async () => {
        const nodes = deps.agentRegistry.listNodeLiveness()
        const entries = nodes.some((n) => n.id === HUB_NODE_ID)
          ? nodes
          : [{ id: HUB_NODE_ID, isOnline: true }, ...nodes]
        const rows: z.infer<typeof NodeHttpsSchema>[] = []
        for (const node of entries) {
          const isHub = node.id === HUB_NODE_ID
          if (isHub) {
            try {
              const status = await localNetwork().getTlsStatus()
              const { caCertPem: _pem, ...rest } = status
              rows.push({
                nodeId: node.id,
                isHub,
                online: true,
                https: { kind: 'served', status: rest },
              })
            } catch (error: unknown) {
              rows.push({
                nodeId: node.id,
                isHub,
                online: true,
                https: {
                  kind: 'unreadable',
                  reason: error instanceof Error ? error.message : String(error),
                },
              })
            }
            continue
          }
          if (!node.isOnline) {
            rows.push({
              nodeId: node.id,
              isHub,
              online: false,
              https: {
                kind: 'unreadable',
                reason: 'The node is offline - its certificate cannot be read.',
              },
            })
            continue
          }
          const client = deps.nodeClient(node.id)
          if (client === null) {
            rows.push({
              nodeId: node.id,
              isHub,
              online: true,
              https: {
                kind: 'unreadable',
                reason: 'The node does not provide node-certificates (update the agent).',
              },
            })
            continue
          }
          try {
            const answer = await client.getCertificates()
            rows.push({
              nodeId: node.id,
              isHub,
              online: true,
              https:
                answer.https.state === 'served'
                  ? { kind: 'served', status: statusOfLeaf(answer.https.leaf) }
                  : { kind: 'not-served', reason: answer.https.reason },
            })
          } catch (error: unknown) {
            rows.push({
              nodeId: node.id,
              isHub,
              online: true,
              https: {
                kind: 'unreadable',
                reason: error instanceof Error ? error.message : String(error),
              },
            })
          }
        }
        return rows
      }),

    /**
     * Issue a new HTTPS leaf. On the hub: a new leaf under the local CA
     * (`regenerateCertificate`; refused while an uploaded certificate is served). On an
     * agent: the agent makes a key + CSR, the hub signs the public key under the same
     * local CA for the names the agent reports (private addresses and local-only host
     * names), and the agent hot-swaps it - no restart, no private key on the mesh.
     */
    renewHttpsOnNode: adminProcedure
      .input(z.object({ nodeId: z.string().min(1), reason: z.string().max(200).optional() }))
      .output(TlsStatusRowSchema)
      .mutation(async ({ input }) => {
        if (input.nodeId === HUB_NODE_ID) {
          const status = await localNetwork().regenerateCertificate({
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })
          const { caCertPem: _pem, ...rest } = status
          return rest
        }
        const client = requireAgent(input.nodeId)
        const tags = { nodeId: input.nodeId }
        return exclusive(input.nodeId, 'https', async () => {
          try {
            const prepared = await client.prepareHttpsCertificate()
            // The hub signs what it knows by itself: the node id and the address of the node's
            // LIVE mesh socket. Whatever the agent reports is dropped (and logged below).
            const observedAddress = peers.peerLeaf(input.nodeId)?.remoteAddress
            if (observedAddress === undefined) {
              throw new Error(
                'the node has no live mesh connection the hub can read its address from - connect it first',
              )
            }
            // Without the names registry the hub cannot tell whether a name is already another
            // node's, so it signs nothing.
            const names = httpsNames()
            if (names === null) {
              throw new Error(
                'the agent HTTPS names registry is not loaded yet - try again shortly',
              )
            }
            const issued = await issueHttps({
              hubDataDir: deps.hubDataDir,
              nodeId: input.nodeId,
              csrPem: prepared.csrPem,
              reportedNames: [...prepared.hostnames, ...prepared.addresses],
              observedAddress,
              takenByOthers: names.takenByOthers(input.nodeId),
            })
            // Written down BEFORE the install answer: if the answer is lost the names stay taken
            // (the node may hold the leaf), never silently free for another node.
            await names.record(input.nodeId, issued.accepted)
            // The hub's local CA was rotated (D227) when the node pinned another one: say so, over
            // the authenticated install call, so the node re-pins instead of refusing for ever.
            const caRotation =
              prepared.pinnedCaFingerprintSha256 !== null &&
              prepared.pinnedCaFingerprintSha256 !==
                new X509Certificate(issued.caCertPem).fingerprint256
            deps.log.info('Agent HTTPS leaf issued', {
              tags,
              meta: { accepted: issued.accepted, rejected: issued.rejected },
            })
            const leaf = await client.installHttpsCertificate({
              certPem: issued.certPem,
              caCertPem: issued.caCertPem,
              ...(caRotation ? { caRotation: true } : {}),
            })
            deps.log.info('Agent HTTPS leaf installed', {
              tags,
              meta: { fingerprint: leaf.fingerprintSha256 },
            })
            return statusOfLeaf(leaf)
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            deps.log.error('Agent HTTPS renewal failed', { tags, meta: { error: message } })
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `HTTPS renewal on ${input.nodeId} failed: ${message}. The node keeps serving what it had.`,
            })
          }
        })
      }),

    /** The mesh CA, the revocation list, and every node's recorded leaves. */
    getMeshCertificates: adminProcedure
      .input(z.void())
      .output(MeshInventorySchema)
      .query(async () => {
        const state = getProcessMeshCaState()
        const ca =
          state.state === 'ready'
            ? {
                state: 'ready' as const,
                subject: new X509Certificate(state.ca.certPem).subject,
                fingerprintSha256: caFingerprint(state.ca.certPem),
                validTo: new X509Certificate(state.ca.certPem).validTo,
              }
            : { state: 'unavailable' as const, reason: state.reason }
        const registry = meshRegistry()
        const at = Date.now()
        const nodes: z.infer<typeof MeshNodeSchema>[] = []
        if (registry !== null) {
          await observeConnectedNodes(registry)
          const liveness = new Map(
            deps.agentRegistry.listNodeLiveness().map((n) => [n.id, n.isOnline] as const),
          )
          const nodeIds = new Set([...registry.list().map((r) => r.nodeId), ...liveness.keys()])
          for (const nodeId of [...nodeIds].toSorted()) {
            const rows = registry.list(nodeId).map((r) => ({
              serial: r.serial,
              fingerprintSha256: r.fingerprint,
              notBefore: r.notBefore,
              notAfter: r.notAfter,
              issuedAt: r.issuedAt,
              issuedVia: r.issuedVia,
              status: leafStatus(r, at),
              revokedAt: r.revokedAt,
              revokedReason: r.revokedReason,
            }))
            const current = rows.find((r) => r.status !== 'revoked') ?? null
            const online = nodeId === HUB_NODE_ID ? true : (liveness.get(nodeId) ?? false)
            const presented = nodeId === HUB_NODE_ID ? undefined : peers.peerLeaf(nodeId)
            nodes.push({
              nodeId,
              online,
              current,
              presentingCurrent:
                !online || nodeId === HUB_NODE_ID || current === null
                  ? null
                  : presented?.fingerprint === current.fingerprintSha256,
              history: rows.filter((r) => r !== current),
            })
          }
        }
        return {
          ca,
          revokedSerials: [...crl().list()],
          registryAvailable: registry !== null,
          listener: listenerState(),
          nodes,
        }
      }),

    /**
     * Replace a node's mesh leaf without ever leaving it without one: the node makes a new
     * key and CSR, the hub signs and records it, the node swaps and reconnects, and only
     * after the hub SEES it connected with the new leaf is the old serial revoked. A failed
     * swap keeps the old leaf valid and says why.
     */
    renewMeshOnNode: adminProcedure
      .input(z.object({ nodeId: z.string().min(1) }))
      .output(MeshRenewResultSchema)
      .mutation(async ({ input }) => {
        const client = requireAgent(input.nodeId)
        const ca = meshCa()
        const registry = meshRegistry()
        if (ca === null || registry === null) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'The mesh CA or the certificate registry is not available yet.',
          })
        }
        const result = await exclusive(input.nodeId, 'mesh', () =>
          renewMeshCertificate({
            nodeId: input.nodeId,
            client,
            ca,
            registry,
            crl: crl(),
            peers,
            registrations,
            ...(deps.nodeAddonIds !== undefined ? { expectedAddons: deps.nodeAddonIds } : {}),
            log: deps.log,
            ...(deps.reconnectTimeoutMs !== undefined
              ? { reconnectTimeoutMs: deps.reconnectTimeoutMs }
              : {}),
            ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
            ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),
          }),
        )
        return { ...result, nodeId: input.nodeId }
      }),

    /**
     * Put the node's mesh leaf on the CRL and disconnect it. The node can no longer
     * connect: it must be paired again. It is NOT forgotten - that stays
     * `clusterNodes.forgetNode`.
     */
    revokeMeshOnNode: adminProcedure
      .input(z.object({ nodeId: z.string().min(1) }))
      .output(MeshRevokeResultSchema)
      .mutation(async ({ input }) => {
        if (input.nodeId === HUB_NODE_ID) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              "The hub's own mesh leaf is re-issued at every boot; there is nothing to revoke.",
          })
        }
        const registry = meshRegistry()
        if (registry === null) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'The certificate registry is not available yet.',
          })
        }
        const result = await revokeMeshCertificate({
          nodeId: input.nodeId,
          registry,
          crl: crl(),
          peers,
          log: deps.log,
        })
        return { ...result, revokedSerials: [...result.revokedSerials] }
      }),
  })
}
