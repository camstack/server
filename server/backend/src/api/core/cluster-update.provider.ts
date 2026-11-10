/**
 * `cluster-update` — the hub-provided cap over {@link ClusterUpdateService},
 * and the seams that bind the service to the hub's own services: the server
 * update engine (hub) and the `server-management` proxy (agents), the
 * topology, the `backup` singleton and the addons provider the admin UI uses.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ServerPackageStatusSchema,
  ServerUpdateActionResultSchema,
  type IBackupProvider,
  type IClusterUpdateProvider,
} from '@camstack/types'
import type { AddonPackageService } from '../../core/addon/addon-package.service.js'
import { SYSTEM_PACKAGE } from '../../core/addon/addon-package.service.js'
import type { AddonRegistryService } from '../../core/addon/addon-registry.service.js'
import type { AgentRegistryService } from '../../core/agent/agent-registry.service.js'
import type { ConfigService } from '../../core/config/config.service.js'
import type { LoggingService } from '../../core/logging/logging.service.js'
import type { MoleculerService } from '../../core/moleculer/moleculer.service.js'
import type { ServerUpdateService } from '../../core/server-update/server-update.service.js'
import type { ClusterUpdateService } from '../../core/cluster-update/cluster-update.service.js'
import { FileClusterUpdateJobStore } from '../../core/cluster-update/cluster-update-job-store.js'
import {
  DEFAULT_CLUSTER_UPDATE_TIMEOUTS,
  type ClusterNodeView,
  type ClusterUpdateSeams,
} from '../../core/cluster-update/cluster-update-seams.js'
import type { TrpcContext } from '../trpc/trpc.context.js'
import {
  buildAddonsProvider,
  buildNodesProvider,
  createNodeRootPackageLookup,
} from './cap-providers.js'

export interface ClusterUpdateSeamDeps {
  readonly dataDir: string
  readonly serverUpdate: ServerUpdateService
  readonly moleculer: MoleculerService
  readonly agentRegistry: AgentRegistryService
  readonly addonRegistry: AddonRegistryService
  readonly addonPackages: AddonPackageService
  readonly configService: ConfigService
  readonly loggingService: LoggingService
}

const UpdatePackageResultShape = z.looseObject({
  success: z.boolean(),
  error: z.string().optional(),
})

/** The job runs without a request behind it; its addon updates are `system`'s. */
const SYSTEM_CONTEXT: TrpcContext = { user: null }

function serverManagementProxy(
  moleculer: MoleculerService,
  nodeId: string,
): Record<string, (params: unknown) => Promise<unknown>> {
  const proxy = moleculer.createCapabilityProxy('server-management', nodeId)
  if (proxy === null) throw new Error(`server-management unreachable on ${nodeId}`)
  return proxy
}

async function callProxy(
  proxy: Record<string, (params: unknown) => Promise<unknown>>,
  method: string,
  params: unknown,
): Promise<unknown> {
  const fn = proxy[method]
  if (fn === undefined) throw new Error(`server-management.${method} is not callable`)
  return fn(params)
}

export function buildClusterUpdateSeams(deps: ClusterUpdateSeamDeps): ClusterUpdateSeams {
  const logger = deps.loggingService.createLogger('ClusterUpdate')
  const nodes = buildNodesProvider(
    deps.agentRegistry,
    deps.moleculer,
    deps.addonRegistry,
    createNodeRootPackageLookup(deps.moleculer, deps.serverUpdate),
    logger,
  )
  const addons = () =>
    buildAddonsProvider(
      deps.addonRegistry,
      deps.addonPackages,
      deps.loggingService,
      deps.moleculer,
      deps.configService,
      SYSTEM_CONTEXT,
      deps.agentRegistry,
    )
  return {
    readTopology: async () =>
      (await nodes.topology()).map(
        (n): ClusterNodeView => ({
          id: n.id,
          isHub: n.isHub,
          isOnline: n.isOnline,
          ...(n.capabilitiesRegistered !== undefined
            ? { capabilitiesRegistered: n.capabilitiesRegistered }
            : {}),
          capabilityCount: new Set(n.addons.flatMap((a) => a.capabilities)).size,
        }),
      ),
    readServerStatus: async (nodeId) =>
      nodeId === null
        ? deps.serverUpdate.getServerPackageStatus()
        : ServerPackageStatusSchema.parse(
            await callProxy(
              serverManagementProxy(deps.moleculer, nodeId),
              'getServerPackageStatus',
              {},
            ),
          ),
    applyServerUpdate: async (nodeId, version) =>
      nodeId === null
        ? deps.serverUpdate.applyServerUpdate({ version })
        : ServerUpdateActionResultSchema.parse(
            await callProxy(serverManagementProxy(deps.moleculer, nodeId), 'applyServerUpdate', {
              version,
            }),
          ),
    getBackup: () => {
      const backup = deps.addonRegistry
        .getCapabilityRegistry()
        .getSingleton<IBackupProvider>('backup')
      if (backup === null) return null
      return {
        trigger: (label) => backup.trigger({ label }),
        listRuns: () => backup.listRuns(),
      }
    },
    // Framework packages travel with the server closure, and an update held
    // for a server minimum (D989) is not offered: it waits for that server.
    listAddonUpdates: async () =>
      (await deps.addonPackages.checkUpdates()).filter(
        (u) => u.category === 'addon' && u.name !== SYSTEM_PACKAGE && u.blockedBy === undefined,
      ),
    updateAddon: async (name, version) => {
      // The cap declares its output `unknown`; the provider answers this shape.
      const parsed = UpdatePackageResultShape.safeParse(
        await addons().updatePackage({ name, version }),
      )
      if (!parsed.success) return { success: false, error: 'unrecognised updatePackage answer' }
      return parsed.data.success
        ? { success: true }
        : { success: false, error: parsed.data.error ?? 'update failed' }
    },
    readInstallations: async () => (await addons().listInstallations({})).installations,
    store: new FileClusterUpdateJobStore(deps.dataDir, logger),
    logger,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newId: () => randomUUID(),
    timeouts: DEFAULT_CLUSTER_UPDATE_TIMEOUTS,
  }
}

export function buildClusterUpdateProvider(
  service: ClusterUpdateService | null,
  ctx: TrpcContext,
): IClusterUpdateProvider | null {
  if (service === null) return null
  return {
    previewClusterUpdate: (input) => service.preview(input),
    startClusterUpdate: (input) =>
      service.start(input, ctx.user?.username ?? ctx.user?.id ?? 'system'),
    getClusterUpdateJob: async (input) => service.getJob(input.jobId),
  }
}
