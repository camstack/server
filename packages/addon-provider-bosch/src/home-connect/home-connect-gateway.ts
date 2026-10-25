import type { HomeConnectApplianceInfo, HomeConnectWsClient } from './home-connect-ws-client.js'

export interface HomeConnectConnectionSurface {
  readonly appliances: readonly HomeConnectApplianceInfo[]
  readonly client: HomeConnectWsClient
}

/** What a watcher is told. Every event means "recompute from the client now"; the payload is for logs. */
export type HomeConnectWatchEvent =
  | { readonly kind: 'client' }
  | { readonly kind: 'feature'; readonly key: string }
  | { readonly kind: 'link' }
  | { readonly kind: 'description' }

interface Watcher {
  readonly haId: string
  readonly listener: (event: HomeConnectWatchEvent) => void
  detach: (() => void) | null
}

/**
 * Where devices find the client of their integration. A device that started before
 * its integration connected, or whose integration was restarted (a NEW client), still
 * hears about it: `watch` follows the integration, not one client instance.
 */
export class HomeConnectConnectionResolver {
  readonly #surfaces: Map<string, HomeConnectConnectionSurface> = new Map()
  readonly #watchers: Map<string, Set<Watcher>> = new Map()

  set(integrationId: string, surface: HomeConnectConnectionSurface | null): void {
    const previous = this.#surfaces.get(integrationId)
    if (surface === null) this.#surfaces.delete(integrationId)
    else this.#surfaces.set(integrationId, surface)
    if (previous?.client === surface?.client) return
    for (const watcher of this.#watchers.get(integrationId) ?? []) {
      watcher.detach?.()
      watcher.detach = this.#attach(surface?.client ?? null, watcher)
      watcher.listener({ kind: 'client' })
    }
  }

  appliances(integrationId: string): readonly HomeConnectApplianceInfo[] {
    return this.#surfaces.get(integrationId)?.appliances ?? []
  }

  has(integrationId: string): boolean {
    return this.#surfaces.has(integrationId)
  }

  list(): readonly { readonly id: string }[] {
    return Array.from(this.#surfaces.keys()).map((id) => ({ id }))
  }

  getClient(integrationId: string): HomeConnectWsClient | null {
    return this.#surfaces.get(integrationId)?.client ?? null
  }

  /**
   * Hear about everything that can change what `haId` shows: its features, its link,
   * its description, and the client itself appearing, vanishing or being replaced.
   */
  watch(
    integrationId: string,
    haId: string,
    listener: (event: HomeConnectWatchEvent) => void,
  ): () => void {
    const watcher: Watcher = { haId, listener, detach: null }
    watcher.detach = this.#attach(this.getClient(integrationId), watcher)
    const set = this.#watchers.get(integrationId) ?? new Set<Watcher>()
    set.add(watcher)
    this.#watchers.set(integrationId, set)
    return () => {
      watcher.detach?.()
      watcher.detach = null
      set.delete(watcher)
    }
  }

  #attach(client: HomeConnectWsClient | null, watcher: Watcher): (() => void) | null {
    if (client === null) return null
    const unsubs = [
      client.onFeatureChange((haId, key) => {
        if (haId === watcher.haId) watcher.listener({ kind: 'feature', key })
      }),
      client.onLinkChange((haId) => {
        if (haId === watcher.haId) watcher.listener({ kind: 'link' })
      }),
    ]
    const description = client.getDescription(watcher.haId)
    if (description !== null) {
      unsubs.push(description.onChange(() => watcher.listener({ kind: 'description' })))
    }
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }

  clear(): void {
    for (const id of [...this.#surfaces.keys()]) this.set(id, null)
  }
}

export const homeConnectConnections = new HomeConnectConnectionResolver()
