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
import type {
  LaunchOverrides,
  SetLaunchOverridesInput,
  SetLaunchOverridesResult,
} from '@camstack/types'
import { readLaunchOverrides, writeLaunchOverrides } from '../../launch-args.js'
import type { RootUpdateService } from '../../server-root/index.js'

/** The per-node launch override methods (ADR 0970), backed by the node's data dir. */
export function buildLaunchOverrideMethods(dataDir: string): {
  readonly getLaunchOverrides: () => Promise<LaunchOverrides>
  readonly setLaunchOverrides: (input: SetLaunchOverridesInput) => Promise<SetLaunchOverridesResult>
} {
  return {
    getLaunchOverrides: () => Promise.resolve(readLaunchOverrides(dataDir)),
    setLaunchOverrides: (input) => {
      const next = {
        heapMb: input.heapMb,
        // Omitted = keep what is stored; null = clear.
        rssBudgetMb:
          input.rssBudgetMb === undefined
            ? readLaunchOverrides(dataDir).rssBudgetMb
            : input.rssBudgetMb,
      }
      writeLaunchOverrides(dataDir, next)
      return Promise.resolve({ ...next, restartRequired: true })
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
    installDesktopUpdate: () => Promise.resolve(service.installDesktopUpdate()),
    rollbackServerUpdate: () => service.rollbackServerUpdate(),
    restartServer: () => Promise.resolve(service.restartNode()),
    ...buildLaunchOverrideMethods(dataDir),
  }
}
