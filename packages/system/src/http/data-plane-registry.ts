/**
 * Hub-side registry of addon HTTP **data-planes**. Maps `addonId` → the set of
 * `{ prefix, access, baseUrl, secret }` endpoints the addon advertised (pulled
 * over the UDS `data-planes` call when the addon mounts). The hub's
 * `/addon/:addonId/*` dispatch consults `match()` BEFORE the control-route path:
 * a hit means "authenticate, then reverse-proxy to the addon's listener".
 *
 * Single authority, hub-resident, in-memory — rebuilt from the addons on every
 * mount (no persistence, no shadow copies).
 */
import type { AddonDataPlaneEndpoint } from '@camstack/types'

export interface DataPlaneMatch {
  readonly addonId: string
  readonly endpoint: AddonDataPlaneEndpoint
  /** Request path AFTER the matched prefix, leading-slashed (`/7/master.m3u8`).
   *  Query string is NOT included here — the caller appends it. */
  readonly rest: string
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+/, '').replace(/\/+$/, '')
}

export class DataPlaneRegistry {
  private readonly byAddon = new Map<string, readonly AddonDataPlaneEndpoint[]>()

  /** Replace ALL endpoints for an addon (idempotent re-mount). */
  registerAddon(addonId: string, endpoints: readonly AddonDataPlaneEndpoint[]): void {
    if (endpoints.length === 0) {
      this.byAddon.delete(addonId)
      return
    }
    this.byAddon.set(addonId, [...endpoints])
  }

  /** Drop an addon's endpoints (stop / disconnect). */
  unregisterAddon(addonId: string): void {
    this.byAddon.delete(addonId)
  }

  /** True when the addon has at least one data-plane registered. */
  has(addonId: string): boolean {
    return this.byAddon.has(addonId)
  }

  /**
   * Match `subPath` (the part after `/addon/<addonId>/`, with or without a
   * leading slash, NO query string) against the addon's prefixes. Longest prefix
   * wins. Returns the matched endpoint + the remaining path the addon handler sees.
   */
  match(addonId: string, subPath: string): DataPlaneMatch | null {
    const endpoints = this.byAddon.get(addonId)
    if (!endpoints) return null
    const normalized = `/${trimSlashes(subPath)}`
    let best: { endpoint: AddonDataPlaneEndpoint; rest: string; len: number } | null = null
    for (const endpoint of endpoints) {
      const prefix = `/${trimSlashes(endpoint.prefix)}`
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        const rest = normalized.slice(prefix.length) || '/'
        if (best === null || prefix.length > best.len) best = { endpoint, rest, len: prefix.length }
      }
    }
    if (best === null) return null
    return { addonId, endpoint: best.endpoint, rest: best.rest }
  }
}

/** What the hub knows about an addon when it re-evaluates its data-planes. */
export interface DataPlaneEligibility {
  /** The addon still has an entry in the registry service. */
  readonly hasEntry: boolean
  /** That entry is a FORKED addon — the only kind that serves a data-plane today. */
  readonly isForked: boolean
  /** The child process is currently known to the child registry. */
  readonly childKnown: boolean
}

/**
 * Whether an addon can serve a data-plane RIGHT NOW.
 *
 * Extracted as a predicate because the three ways of answering "no" used to be
 * three early `return`s inside the mount path, and every one of them left the
 * PREVIOUS registration standing. The registry then held a `baseUrl` pointing
 * at the port of a process that no longer existed, and `/addon/:addonId/*` kept
 * reverse-proxying to it — a 502 per request until a replacement child finished
 * handshaking, and forever for an addon removed from disk. `unregisterAddon`
 * existed for exactly this and had no call site anywhere in the repo.
 *
 * A `false` here means UNREGISTER, never "leave it alone". Dropping is the safe
 * direction: an absent data-plane falls through to the control-route path,
 * while a stale one sends live traffic at a dead socket.
 */
export function canServeDataPlane(state: DataPlaneEligibility): boolean {
  return state.hasEntry && state.isForked && state.childKnown
}
