import { isInstanceSwitchesUnreadError } from '@camstack/types'

/** The part of a loaded addon the hub-connect hook needs. */
export interface SwitchHydratingAddon {
  readonly addonId: string
  readonly addon: {
    rehydrateSwitches?(): Promise<void>
    onHubReachable?(): Promise<void> | void
  }
}

export interface HubConnectSwitchesDeps {
  /** Raw log of a failure; never throws. */
  readonly onUnread: (addonId: string, err: unknown) => void
  /** The first connect of a forked runner: an unread registry fails the boot (D6 bounds the respawn). */
  readonly fatalOnUnread: boolean
  /** Leave the process; injected so a spec can observe it. */
  readonly exit: (addonId: string, err: unknown) => void
}

/**
 * On a hub connect, every addon with instance kinds reads its switches from the registry again
 * (D1066). Event-driven, no timer (D3): the next connect retries. A forked runner's FIRST connect
 * is its boot, so a registry that still does not answer ends the process and the supervisor
 * respawns it, bounded and marked terminally failed (D6), instead of leaving instances off.
 */
export async function rehydrateSwitchesOnHubConnect(
  entries: readonly SwitchHydratingAddon[],
  deps: HubConnectSwitchesDeps,
): Promise<void> {
  for (const entry of entries) {
    if (entry.addon.rehydrateSwitches === undefined) continue
    try {
      await entry.addon.rehydrateSwitches()
    } catch (err: unknown) {
      if (deps.fatalOnUnread && isInstanceSwitchesUnreadError(err)) deps.exit(entry.addonId, err)
      else deps.onUnread(entry.addonId, err)
    }
  }
}
