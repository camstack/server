/**
 * `server-management` cap provider — thin trampoline over a node's
 * `RootUpdateService` (runtime-updatable root package). The trampoline calls
 * only base-class methods, so ONE builder backs BOTH node types: the hub's
 * `ServerUpdateService` (registered via `buildServerProviders` in
 * trpc.router.ts, `mount: 'server-provided'`) AND the agent's
 * `AgentUpdateService` (registered by the agent bootstrap). Both are
 * `RootUpdateService` subclasses, so there is no per-node provider copy.
 */
import type { IServerManagementProvider } from '@camstack/types'
import type { LaunchOverrides, SetLaunchOverridesResult } from '@camstack/types'
import { readHeapOverrideMb, writeHeapOverrideMb } from '../../launch-args.js'
import type { RootUpdateService } from '../../server-root/index.js'

/** The per-node launch override methods (ADR 0970), backed by the node's data dir. */
export function buildLaunchOverrideMethods(dataDir: string): {
  readonly getLaunchOverrides: () => Promise<LaunchOverrides>
  readonly setLaunchOverrides: (input: {
    readonly heapMb: number | null
  }) => Promise<SetLaunchOverridesResult>
} {
  return {
    getLaunchOverrides: () => Promise.resolve({ heapMb: readHeapOverrideMb(dataDir) }),
    setLaunchOverrides: (input) => {
      writeHeapOverrideMb(dataDir, input.heapMb)
      return Promise.resolve({ heapMb: input.heapMb, restartRequired: true })
    },
  }
}

export function buildServerManagementProvider(
  service: RootUpdateService | null,
  dataDir: string,
): IServerManagementProvider | null {
  if (service === null) return null
  return {
    getServerPackageStatus: () => service.getServerPackageStatus(),
    checkServerUpdate: () => service.checkServerUpdate(),
    applyServerUpdate: (input) => service.applyServerUpdate(input),
    rollbackServerUpdate: () => service.rollbackServerUpdate(),
    restartServer: () => Promise.resolve(service.restartNode()),
    ...buildLaunchOverrideMethods(dataDir),
  }
}
