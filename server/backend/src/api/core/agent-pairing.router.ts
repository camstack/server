import { X509Certificate } from 'node:crypto'
/**
 * Agent pairing — fixed core API for System -> Cluster -> Agents (D857).
 *
 * Hand-written (not a `*.cap.ts`) like `certificates.router.ts`: it joins the
 * mesh CA, the certificate registry, mDNS discovery and the agent's own HTTP
 * pairing surface, none of which is a capability.
 *
 *   listDiscoveredAgents  agents found on the LAN + addresses typed so far
 *   addAgentByAddress     probe a typed address (GET .../pairing/hello)
 *   beginPairing          offer the mesh CA to an agent; both screens now show a code
 *   getPairing/listPairings  progress (also advances the pairing)
 *   confirmPairing        the operator typed the code the AGENT shows
 *   rejectPairing         cancel on both sides
 *   unpairAgent           tell the agent to forget the hub, revoke its certificates
 *
 * The operator MUST type the code read on the agent's screen into `confirmPairing`:
 * the hub checks it against the code it computed itself. A page that sends back
 * `code` from `getPairing` defeats the check and is a bug.
 */
import { browseAgentsMdns } from '@camstack/develop/hub-discovery'
import {
  getProcessMeshCaState,
  getProcessMeshCertificateRegistry,
  getProcessPeerLeaf,
  HubPairing,
  isProcessVerifiedMeshPeer,
  dropProcessPeer,
  type AgentPairingTransport,
  type CapabilityRegistry,
  type MeshCaSigner,
  type MeshCertificateRegistry,
  type MeshCrl,
  type MeshPeers,
  processMeshCrl,
  revokeMeshCertificate,
  DEFAULT_HUB_TLS_TCP_PORT,
} from '@camstack/system'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { NodeCertificatesClient } from '../../core/agent/node-certificates-client.js'
import { createHttpAgentPairingTransport } from '../../core/agent/agent-pairing-http.js'
import { HubAgentPairing } from '../../core/agent/hub-agent-pairing.js'
import { adminProcedure, trpcRouter } from '../trpc/trpc.middleware.js'

const HUB_NODE_ID = 'hub'
const BROWSE_TIMEOUT_MS = 3_000

const EndpointSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(4444),
})

const PairingViewSchema = z.object({
  pairingId: z.string(),
  nodeId: z.string(),
  endpoint: z.object({ host: z.string(), port: z.number() }),
  /**
   * The six digits the hub computed. For DISPLAY next to the agent's own: the operator
   * confirms by typing the code the AGENT shows, never by echoing this one.
   */
  code: z.string(),
  state: z.enum(['awaiting-confirmation', 'completing', 'paired', 'rejected', 'expired', 'failed']),
  hubConfirmed: z.boolean(),
  agentConfirmed: z.boolean(),
  expiresAt: z.number(),
  failure: z.string().nullable(),
})

const DiscoveredAgentSchema = z.object({
  nodeId: z.string(),
  host: z.string(),
  port: z.number(),
  version: z.string().nullable(),
  state: z.enum(['unpaired', 'pending', 'paired']),
  fingerprint: z.string().nullable(),
  source: z.enum(['mdns', 'address']),
  connected: z.boolean(),
  pairing: PairingViewSchema.nullable(),
})

const UnpairResultSchema = z.object({
  nodeId: z.string(),
  /** The agent acknowledged and is erasing its certificate; `false` when it could not be reached. */
  agentNotified: z.boolean(),
  revokedSerials: z.array(z.string()),
  disconnected: z.number().int(),
  next: z.string(),
})

export interface AgentPairingRouterDeps {
  /** Hub addresses: the `local-network` capability, as the certificates router reads it. */
  readonly registry: CapabilityRegistry | null
  /** A node's `node-certificates` handle, or `null` when it cannot be reached. */
  readonly nodeClient: (nodeId: string) => NodeCertificatesClient | null
  readonly log: {
    info(m: string, e?: { tags?: Record<string, string>; meta?: Record<string, unknown> }): void
    warn(m: string, e?: { tags?: Record<string, string>; meta?: Record<string, unknown> }): void
    error(m: string, e?: { tags?: Record<string, string>; meta?: Record<string, unknown> }): void
  }
  /** Test seams; production reads the process slots. */
  readonly transport?: AgentPairingTransport
  readonly meshCa?: () => MeshCaSigner | null
  readonly meshRegistry?: () => MeshCertificateRegistry | null
  readonly crl?: () => MeshCrl
  readonly peers?: MeshPeers
  readonly isNodeConnected?: (nodeId: string) => boolean
  readonly hubAddresses?: () => Promise<{
    readonly hubUrl: string
    readonly hubMeshAddress: string
  }>
  readonly browse?: HubAgentPairingBrowse
}

type HubAgentPairingBrowse = ConstructorParameters<typeof HubAgentPairing>[0]['browse']

/** The part of the local-network address book an agent offer reads. */
interface AgentOfferAddressBook {
  readonly roles: { readonly internal: { readonly resolved: string | null } }
}

/** The hub addresses an agent offer carries. */
export interface AgentHubAddresses {
  readonly hubUrl: string
  readonly hubMeshAddress: string
}

/**
 * What an agent is offered: the hub's INTERNAL role for the API URL and the mesh
 * address alike. The public endpoint is for people outside the LAN; an agent on the
 * LAN is shown, and keeps, the address it actually dials.
 */
export function resolveAgentHubAddresses(book: AgentOfferAddressBook): AgentHubAddresses {
  const internal = book.roles.internal.resolved
  if (internal === null) {
    throw new Error(
      'The hub has no LAN address to give an agent yet - set one on System -> Network',
    )
  }
  return {
    hubUrl: internal,
    hubMeshAddress: `${new URL(internal).hostname}:${DEFAULT_HUB_TLS_TCP_PORT}`,
  }
}

export function createAgentPairingRouter(deps: AgentPairingRouterDeps) {
  const transport = deps.transport ?? createHttpAgentPairingTransport()
  const meshCa =
    deps.meshCa ??
    ((): MeshCaSigner | null => {
      const state = getProcessMeshCaState()
      return state.state === 'ready' ? state.ca : null
    })
  const meshRegistry = deps.meshRegistry ?? getProcessMeshCertificateRegistry
  const crl = deps.crl ?? processMeshCrl
  const peers: MeshPeers = deps.peers ?? {
    peerLeaf: (nodeId) => getProcessPeerLeaf(nodeId),
    dropPeer: (nodeId) => dropProcessPeer(nodeId),
  }
  const isNodeConnected = deps.isNodeConnected ?? isProcessVerifiedMeshPeer

  const localNetwork = () => {
    const provider = deps.registry?.getSingleton('local-network')
    if (!provider) {
      throw new Error('The local-network capability is not available yet')
    }
    return provider
  }
  /** The address an agent dials and is shown: the hub's `internal` role. */
  const hubAddresses =
    deps.hubAddresses ??
    (async () => resolveAgentHubAddresses(await localNetwork().getAddresses({ scheme: 'https' })))

  const pairing = new HubPairing({
    transport,
    ca: meshCa,
    hubNodeId: HUB_NODE_ID,
    hubUrl: async () => (await hubAddresses()).hubUrl,
    hubMeshAddress: async () => (await hubAddresses()).hubMeshAddress,
    isNodeConnected,
    recordIssued: async (nodeId, certPem) => {
      const registry = meshRegistry()
      if (registry === null) {
        throw new Error('the certificate registry is not loaded - the pairing was not completed')
      }
      await registry.recordIssued(nodeId, certPem, 'pairing')
    },
    revokeNode: async (nodeId, reason, keepCertPem) => {
      const registry = meshRegistry()
      if (registry === null) return
      const keep =
        keepCertPem === undefined ? undefined : new X509Certificate(keepCertPem).fingerprint256
      await registry.revokeAllForNode(nodeId, reason, crl(), keep)
    },
    isLeafPresented: (nodeId, certPem) => {
      const seen = peers.peerLeaf?.(nodeId)?.fingerprint
      const norm = (f: string): string => f.replaceAll(':', '').toLowerCase()
      return seen !== undefined && norm(seen) === norm(new X509Certificate(certPem).fingerprint256)
    },
    revokeLeaf: async (_nodeId, certPem, reason) => {
      const registry = meshRegistry()
      if (registry === null) return
      await registry.revoke(new X509Certificate(certPem).fingerprint256, reason, crl())
    },
    // Ids the registry has ever issued for: a node id differing only in case from one of them is refused.
    knownNodeIds: () =>
      meshRegistry()
        ?.list()
        .map((r) => r.nodeId) ?? [],
    log: (message, meta) => {
      const nodeId = typeof meta?.['nodeId'] === 'string' ? meta['nodeId'] : undefined
      deps.log.info(`pairing: ${message}`, {
        ...(nodeId !== undefined ? { tags: { nodeId } } : {}),
        ...(meta ? { meta } : {}),
      })
    },
  })

  const service = new HubAgentPairing({
    pairing,
    transport,
    browse:
      deps.browse ??
      (() =>
        browseAgentsMdns({
          timeoutMs: BROWSE_TIMEOUT_MS,
          onProblem: (message) => deps.log.warn(`agent browse problem: ${message}`),
        })),
    isNodeConnected,
    log: deps.log,
  })

  /** A refusal the operator can act on is a PRECONDITION_FAILED with the reason, not a 500. */
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      if (err instanceof TRPCError) throw err
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return trpcRouter({
    /** Agents found over mDNS and addresses typed so far, with any pairing in progress. */
    listDiscoveredAgents: adminProcedure
      .input(z.object({ refresh: z.boolean().optional() }).optional())
      .output(
        z.object({
          agents: z.array(DiscoveredAgentSchema),
          scannedAt: z.number().nullable(),
        }),
      )
      .query(({ input }) =>
        guard(() => service.listDiscovered({ refresh: input?.refresh === true })),
      ),

    /** Probe an address the operator typed. The agent must be on a private / local address. */
    addAgentByAddress: adminProcedure
      .input(
        z.object({
          host: z.string().min(1).max(253),
          port: z.number().int().min(1).max(65535).optional(),
        }),
      )
      .output(DiscoveredAgentSchema)
      .mutation(({ input }) => guard(() => service.addByAddress(input.host.trim(), input.port))),

    /** Offer the mesh CA to an agent and derive the code both screens show. */
    beginPairing: adminProcedure
      .input(EndpointSchema)
      .output(PairingViewSchema)
      .mutation(({ input }) =>
        guard(() => service.begin({ host: input.host.trim(), port: input.port })),
      ),

    getPairing: adminProcedure
      .input(z.object({ pairingId: z.string().min(1) }))
      .output(PairingViewSchema)
      .query(({ input }) => guard(() => service.get(input.pairingId))),

    listPairings: adminProcedure
      .input(z.void())
      .output(z.array(PairingViewSchema))
      .query(() => service.list().map((p) => p)),

    /** The operator typed the code shown on the AGENT. Wrong three times cancels the pairing. */
    confirmPairing: adminProcedure
      .input(z.object({ pairingId: z.string().min(1), code: z.string().min(1).max(16) }))
      .output(PairingViewSchema)
      .mutation(({ input }) => guard(() => service.confirm(input.pairingId, input.code))),

    rejectPairing: adminProcedure
      .input(z.object({ pairingId: z.string().min(1) }))
      .output(PairingViewSchema)
      .mutation(({ input }) => guard(() => service.reject(input.pairingId))),

    /**
     * Unpair an agent: it is told to erase its certificate and advertise itself again, and every
     * certificate the hub issued to it goes on the CRL. Revoke last - the agent is told first,
     * because revoking drops its connection. An unreachable agent is still revoked (it can no longer
     * connect); it is then unpaired by hand on its own page.
     */
    unpairAgent: adminProcedure
      .input(z.object({ nodeId: z.string().min(1) }))
      .output(UnpairResultSchema)
      .mutation(({ input }) =>
        guard(async () => {
          if (input.nodeId === HUB_NODE_ID) {
            throw new Error('The hub is not an agent and cannot be unpaired')
          }
          const registry = meshRegistry()
          if (registry === null) {
            throw new Error('The certificate registry is not loaded - nothing can be revoked yet')
          }
          const tags = { nodeId: input.nodeId }
          let agentNotified = false
          const client = deps.nodeClient(input.nodeId)
          if (client !== null) {
            try {
              await client.forgetHub()
              agentNotified = true
            } catch (err) {
              deps.log.warn('The agent could not be told to forget the hub - revoking anyway', {
                tags,
                meta: { error: err instanceof Error ? err.message : String(err) },
              })
            }
          }
          const revoked = await revokeMeshCertificate({
            nodeId: input.nodeId,
            registry,
            crl: crl(),
            peers,
            log: deps.log,
          })
          return {
            nodeId: input.nodeId,
            agentNotified,
            revokedSerials: [...revoked.revokedSerials],
            disconnected: revoked.disconnected,
            next: agentNotified
              ? 'The agent erased its certificate and advertises itself as unpaired. Pair it again from this page, or forget the node.'
              : 'The agent could not be reached: its certificate is revoked, but it still holds it until it is unpaired on its own page. Pair it again afterwards.',
          }
        }),
      ),
  })
}
