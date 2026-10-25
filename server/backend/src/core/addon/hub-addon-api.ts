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
import { localProviderLink, type LocalProviderResolver } from '@camstack/system'

type CapUsageObserverOptions = NonNullable<Parameters<typeof localProviderLink>[1]>

export interface HubAddonApiOptions {
  readonly resolver: LocalProviderResolver
  readonly callerAddonId: string
  /** Links after `localProviderLink` (device-scoped resolver, broker transport). */
  readonly links: ReadonlyArray<TRPCLink<AnyRouter>>
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
    links: [localProviderLink(options.resolver, observerOpts), ...options.links],
  })
  return client as AddonApi
}
