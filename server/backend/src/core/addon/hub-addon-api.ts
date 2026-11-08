/**
 * The `ctx.api` of an in-process hub addon.
 *
 * Identity is the whole point: a caller-stamped capability (`device-history`,
 * keychain, records) learns WHO is calling only from the `callerAddonId` its
 * `localProviderLink` stamps, so each addon needs its own client — a shared one
 * cannot say whose call it is.
 */

import { createTRPCClient, type TRPCLink } from '@trpc/client'
import type { AnyRouter } from '@trpc/server'
import type { AddonApi } from '@camstack/types'
import {
  commandObserverLink,
  getCommandObserverRegistry,
  localProviderLink,
  type CommandObserver,
  type LocalProviderResolver,
} from '@camstack/server/system'

type CapUsageObserverOptions = NonNullable<Parameters<typeof localProviderLink>[1]>

export interface HubAddonApiOptions {
  readonly resolver: LocalProviderResolver
  readonly callerAddonId: string
  /** Links after `localProviderLink` (device-scoped resolver, broker transport). */
  readonly links: ReadonlyArray<TRPCLink<AnyRouter>>
  /**
   * Told of this addon's device commands (D1022); defaults to the process-wide
   * registry the hub mirror listens on. An in-process addon reaches a device cap
   * without crossing the UDS parent or the tRPC mount, so this client is the
   * only seam that knows both the command and who sent it.
   */
  readonly commandSink?: CommandObserver
}

export function createHubAddonApi(options: HubAddonApiOptions): AddonApi {
  // The observer options carry the stamp only. Cap usage stays recorded on the
  // callee side (`LocalChildRegistry`), so in-process calls are not counted
  // here and the hub's usage graph keeps its meaning.
  const observerOpts: CapUsageObserverOptions = {
    callerAddonId: options.callerAddonId,
    providerAddonIdForCap: (): string | null => null,
    observer: (): void => undefined,
  }
  const client: unknown = createTRPCClient({
    links: [
      commandObserverLink({
        callerAddonId: options.callerAddonId,
        sink: options.commandSink ?? ((obs) => getCommandObserverRegistry().observe(obs)),
      }),
      localProviderLink(options.resolver, observerOpts),
      ...options.links,
    ],
  })
  return client as AddonApi
}
