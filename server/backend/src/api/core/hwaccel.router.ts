/**
 * Hwaccel router — fixed core API (not a capability).
 *
 * Repointed (S3 consolidation) onto the `platform-probe` capability — the SOLE
 * cross-node-pinnable hwaccel surface — instead of the retired `$hwaccel`
 * Moleculer service. The hub-local instance is resolved via
 * `capabilityRegistry.getSingleton('platform-probe')`; any other cluster node
 * via `moleculer.createCapabilityProxy('platform-probe', nodeId)` (the same
 * node-routing the codegen'd cap routers use). Used by the admin UI pipeline /
 * NodeDetail pages to show which hardware backend each node will use.
 *
 * The tRPC input/output shapes are UNCHANGED for clients (`{prefer}` in,
 * `{preferred, rationale}` out) — no SDK break.
 */
import { z } from 'zod'
import type { CapabilityRegistry } from '@camstack/system'
import type { IPlatformProbeProvider } from '@camstack/types'
import type { MoleculerService } from '../../core/moleculer/moleculer.service.js'
import { trpcRouter, adminProcedure } from '../trpc/trpc.middleware.js'

const HwAccelBackendSchema = z.enum([
  'videotoolbox',
  'cuda',
  'nvdec',
  'vaapi',
  'qsv',
  'd3d11va',
  'dxva2',
  'amf',
  'vdpau',
  'drm',
])

const HwAccelPreferSchema = z
  .union([HwAccelBackendSchema, z.literal('none')])
  .nullable()
  .optional()

type HwAccelPrefer = z.infer<typeof HwAccelPreferSchema>

// `preferred` is a plain string array (not the decode-backend enum) to match
// the `platform-probe` cap's own resolution schema: the resolver only ever
// emits decode backends, but a narrow enum would reject any future addition and
// force a cast at the cap boundary.
const HwAccelResolutionSchema = z.object({
  preferred: z.array(z.string()).readonly(),
  rationale: z.string(),
})

type HwAccelResolutionResult = z.infer<typeof HwAccelResolutionSchema>

/**
 * Resolve hwaccel on a specific cluster node through the `platform-probe` cap
 * proxy. `createCapabilityProxy` returns `Record<string, (params) =>
 * Promise<unknown>> | null`; rather than casting that to the provider type
 * (the webrtc-session mount does — repo rule forbids it), we call the proxy's
 * `resolveHwAccel` and narrow its result through the cap's Zod OUTPUT schema.
 * A missing proxy (node unreachable), a missing method, a malformed response,
 * or a thrown call all degrade to an EXPLAINED empty list rather than
 * corrupting the typed API surface.
 */
async function resolveHwAccelOnNode(
  moleculer: MoleculerService | null,
  nodeId: string,
  prefer: HwAccelPrefer,
): Promise<HwAccelResolutionResult> {
  const proxy = moleculer?.createCapabilityProxy('platform-probe', nodeId) ?? null
  const resolveFn = proxy?.['resolveHwAccel']
  if (!resolveFn) {
    return { preferred: [], rationale: `node ${nodeId} unreachable` }
  }
  try {
    const raw = await resolveFn({ prefer })
    const parsed = HwAccelResolutionSchema.safeParse(raw)
    if (!parsed.success) {
      return { preferred: [], rationale: `invalid probe response from ${nodeId}` }
    }
    return parsed.data
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { preferred: [], rationale: `resolve failed: ${msg}` }
  }
}

/** Moleculer registry surface used to enumerate reachable nodes. Documented
 *  boundary onto the broker internals — not exposed on the typed contract. */
interface NodeListRegistry {
  readonly registry: {
    getNodeList: (opts: { onlyAvailable: boolean }) => readonly { id: string }[]
  }
}

function listAvailableNodeIds(moleculer: MoleculerService | null): readonly string[] {
  const broker = moleculer?.broker ?? null
  if (!broker) return []
  const withRegistry: NodeListRegistry = broker as NodeListRegistry
  return withRegistry.registry.getNodeList({ onlyAvailable: true }).map((n) => n.id)
}

export function createHwAccelRouter(
  capabilityRegistry: CapabilityRegistry | null,
  moleculer: MoleculerService | null,
) {
  return trpcRouter({
    /** Probe the current hub process via the local `platform-probe` singleton. */
    resolve: adminProcedure
      .input(z.object({ prefer: HwAccelPreferSchema }).optional())
      .output(HwAccelResolutionSchema)
      .query(async ({ input }) => {
        const provider =
          capabilityRegistry?.getSingleton<IPlatformProbeProvider>('platform-probe') ?? null
        if (!provider) {
          return { preferred: [], rationale: 'platform-probe capability not available' }
        }
        return provider.resolveHwAccel({ prefer: input?.prefer ?? null })
      }),

    /** Probe a specific node in the cluster — used by per-agent UI cards. */
    resolveForNode: adminProcedure
      .input(z.object({ nodeId: z.string(), prefer: HwAccelPreferSchema }))
      .output(HwAccelResolutionSchema)
      .query(async ({ input }) => {
        return resolveHwAccelOnNode(moleculer, input.nodeId, input.prefer ?? null)
      }),

    /** List every node currently reachable and the hwaccel each resolves to. */
    resolveAll: adminProcedure
      .output(
        z.array(
          z.object({
            nodeId: z.string(),
            resolution: HwAccelResolutionSchema,
          }),
        ),
      )
      .query(async () => {
        const nodeIds = listAvailableNodeIds(moleculer)
        return Promise.all(
          nodeIds.map(async (nodeId) => ({
            nodeId,
            resolution: await resolveHwAccelOnNode(moleculer, nodeId, null),
          })),
        )
      }),
  })
}
