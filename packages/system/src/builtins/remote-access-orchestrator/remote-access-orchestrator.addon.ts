/**
 * Remote-access orchestrator — backend-only boot-autostart service for
 * the `network-access` collection (Cloudflare Tunnel, ngrok, Tailscale, …).
 *
 * Retired its `remote-access` facade cap (2026-05-15): the admin UI now
 * talks to the `network-access` collection cap directly via generic
 * per-`addonId` routing, so this addon registers NO capability.
 *
 * What it still owns — the load-bearing logic:
 *   The orchestrator owns the "operator wants this provider running"
 *   intent — an `enabledProviders: string[]` slice in its addon-store
 *   blob (BaseAddon.config). On boot we iterate the list and call
 *   `provider.start()` for each enabled entry, so a tunnel set up once
 *   stays up across hub restarts.
 *
 *   Since start/stop no longer flow through this addon, the enabled-set
 *   is kept in sync from two sources:
 *     1. `NetworkTunnelStarted` / `NetworkTunnelStopped` bus events —
 *        fast, but lossy (fire-and-forget broadcasts). They drive both
 *        the live UI and removal from the durable set (`Stopped` is the
 *        only reliable "operator stopped it" signal).
 *     2. An RPC-driven ADD-ONLY RECONCILE pass (`reconcileEnabledProviders`)
 *        that pulls authoritative `connected` state via the `network-access`
 *        cap's `getStatus()` on every provider (re)connect. THIS covers
 *        dropped `NetworkTunnelStarted` events — if `connected: true` is
 *        acked, the provider is added to `enabledProviders`. It NEVER
 *        removes on `connected: false` because that signal is ambiguous
 *        (registered-not-yet-started vs transiently-down vs intentionally
 *        stopped). Running before `autoStartEnabledProviders` is safe:
 *        it can only add already-connected providers, never evict.
 */
import { BaseAddon, EventCategory, type ProviderRegistration } from '@camstack/types'
import {
  reconcileEnabledProviders,
  type ProviderProbeResult,
} from './enabled-providers-reconcile.js'

interface NetworkAccessLike {
  start?: () => Promise<{ url: string; hostname: string; port: number; protocol: 'http' | 'https' }>
  getStatus?: () => Promise<{
    connected: boolean
    endpoint: { url: string; hostname: string; port: number; protocol: 'http' | 'https' } | null
    error?: string
  }>
}

interface RemoteAccessOrchestratorConfig {
  /**
   * addonIds the operator has explicitly Started. Auto-respawned on
   * boot so a tunnel set up once stays up across hub restarts.
   */
  readonly enabledProviders: readonly string[]
}

export class RemoteAccessOrchestratorAddon extends BaseAddon<RemoteAccessOrchestratorConfig> {
  constructor() {
    super({ enabledProviders: [] })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.ctx.logger.info('Remote-access orchestrator initialized (backend-only)', {
      meta: { enabledCount: this.config.enabledProviders.length },
    })

    // Lifecycle events give the persisted set a PROMPT update — but
    // they are lossy fire-and-forget broadcasts, so they are NOT the
    // authority. The RPC-driven `reconcileAndPersist` pass below is the
    // backstop that corrects any divergence from a dropped event. The
    // emitting addonId is carried on `event.source.id` (events are
    // emitted with `source: { type: 'addon', id: ctx.id }`).
    this.ctx.eventBus?.subscribe({ category: EventCategory.NetworkTunnelStarted }, (event) => {
      void this.onTunnelLifecycle(event.source, true)
    })
    this.ctx.eventBus?.subscribe({ category: EventCategory.NetworkTunnelStopped }, (event) => {
      void this.onTunnelLifecycle(event.source, false)
    })

    // Defer autostart to next tick so provider registrations from
    // co-located addons settle first. `resolveImpl` reads from the
    // capabilities registry which only sees in-process / cluster-mirrored
    // providers once they've ALSO registered — small delay gives the
    // cluster bridge time to discover them on cold boot. Errors are
    // logged but never block init.
    setImmediate(() => {
      void this.autoStartEnabledProviders()
    })

    // Lazy retry — forked providers (cloudflare-tunnel etc) typically
    // register 15-20 s after this orchestrator boots, well past the
    // `setImmediate` above. Hook BaseAddon's `system.ready-state`
    // subscription so we re-run autoStart every time the
    // `network-access` cap transitions to ready (whichever node holds
    // it). The inner logic is idempotent + skips already-connected
    // providers.
    this.watchCapability('network-access', {
      onReady: () => {
        void this.autoStartEnabledProviders()
      },
    })

    // Same watch for `mesh-network`. The tailscale-ingress provider
    // registers `network-access` synchronously at boot, but `start()`
    // throws when the tailnet isn't joined yet — so the boot-time
    // autoStart call fails for tailscale ingresses if the tailscale
    // daemon hadn't logged in by then. Watching `mesh-network` here
    // re-triggers autoStart the moment the client transitions to
    // joined (manual operator login or auto-rejoin), without needing
    // a server restart. Same idempotency rules: providers already
    // connected are skipped.
    this.watchCapability('mesh-network', {
      onReady: () => {
        void this.autoStartEnabledProviders()
      },
    })

    // Backend-only addon — registers no capability.
    return []
  }

  /**
   * Maintain the persisted `enabledProviders` set from a tunnel
   * lifecycle event. `source.id` is `string | number`; `network-access`
   * providers emit with `type: 'addon'` so it is always the addonId
   * string. Non-string / non-addon sources are ignored defensively.
   */
  private async onTunnelLifecycle(
    source: { readonly type: string; readonly id: string | number },
    started: boolean,
  ): Promise<void> {
    if (source.type !== 'addon' || typeof source.id !== 'string') {
      this.ctx.logger.warn('tunnel lifecycle event with non-addon source — ignoring', {
        meta: { sourceType: source.type, sourceId: source.id, started },
      })
      return
    }
    await this.markEnabled(source.id, started)
  }

  /**
   * Probe every locally-visible `network-access` provider's
   * `getStatus()` over RPC and reconcile the durable `enabledProviders`
   * set against the result. This is the D8 backstop for dropped
   * `NetworkTunnelStarted` events: if `connected: true` is acked, the
   * provider is added to `enabledProviders`. ADD-ONLY — never removes on
   * `connected: false` (see enabled-providers-reconcile.ts for rationale).
   *
   * `getStatus()` is an acknowledged cap RPC — a transport blip surfaces
   * as a rejected promise (recorded as `ok: false`, membership left
   * untouched), never as a silent lossy write. Runs on every provider
   * (re)connect via the `watchCapability` hooks, mirroring the kernel
   * readiness-registry hydration on `$node.connected`. Safe to call
   * before `autoStartEnabledProviders`: add-only semantics mean it cannot
   * wipe the enabled-set even when providers are registered-not-yet-started.
   */
  private async reconcileAndPersist(): Promise<void> {
    const entries =
      this.capabilities?.getCollectionEntries<NetworkAccessLike>('network-access') ?? []
    if (entries.length === 0) return

    const probes: ProviderProbeResult[] = await Promise.all(
      entries.map(async ([addonId, impl]): Promise<ProviderProbeResult> => {
        if (!impl.getStatus) {
          // Provider can't report status — treat as unknown, leave as-is.
          return { addonId, ok: false }
        }
        try {
          const status = await impl.getStatus()
          return { addonId, ok: true, connected: status.connected }
        } catch (err) {
          this.ctx.logger.warn('reconcile: getStatus RPC failed — leaving membership as-is', {
            meta: { addonId, error: err instanceof Error ? err.message : String(err) },
          })
          return { addonId, ok: false }
        }
      }),
    )

    const result = reconcileEnabledProviders(this.config.enabledProviders, probes)
    if (!result.changed) return

    this.ctx.logger.info('reconcile: corrected enabledProviders from RPC-pulled state', {
      meta: { added: result.added, removed: result.removed },
    })
    await this.updateGlobalSettings({ enabledProviders: result.nextEnabled })
  }

  private async autoStartEnabledProviders(): Promise<void> {
    // RPC-driven ADD-ONLY reconcile first: recovers any dropped
    // `NetworkTunnelStarted` events by adding providers that are already
    // connected. Cannot evict — safe to run before start() calls.
    await this.reconcileAndPersist()

    const ids = this.config.enabledProviders
    if (ids.length === 0) return
    this.ctx.logger.info('Auto-starting enabled remote-access providers', {
      meta: { addonIds: [...ids] },
    })
    for (const addonId of ids) {
      try {
        const impl = this.resolveImpl(addonId)
        if (!impl?.start) {
          // Provider isn't loaded yet (worker bridge still hydrating)
          // OR it doesn't implement start. Log at warn level — the
          // `watchCapability` subscriptions above retry as soon as the
          // provider appears.
          this.ctx.logger.warn('autostart: provider not ready or unsupported', {
            meta: { addonId, hasImpl: !!impl, hasStart: !!impl?.start },
          })
          continue
        }
        // Idempotent: skip when the provider is already connected.
        // Avoids spamming start() on every ready-state event and
        // prevents respawning a child process that's already alive.
        if (impl.getStatus) {
          const status = await impl.getStatus().catch(() => null)
          if (status?.connected) {
            this.ctx.logger.info('autostart: provider already connected — skipping', {
              meta: { addonId, url: status.endpoint?.url },
            })
            continue
          }
        }
        const endpoint = await impl.start()
        this.ctx.logger.info('autostart: provider started', {
          meta: { addonId, url: endpoint.url },
        })
      } catch (err) {
        this.ctx.logger.error('autostart: provider start failed', {
          meta: {
            addonId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }

  private async markEnabled(addonId: string, enabled: boolean): Promise<void> {
    const current = new Set(this.config.enabledProviders)
    const wasEnabled = current.has(addonId)
    if (enabled) current.add(addonId)
    else current.delete(addonId)
    if (wasEnabled === enabled) return
    this.ctx.logger.info('remote-access intent updated', {
      meta: { addonId, enabled },
    })
    await this.updateGlobalSettings({ enabledProviders: [...current] })
  }

  private resolveImpl(addonId: string): NetworkAccessLike | null {
    const entries =
      this.capabilities?.getCollectionEntries<NetworkAccessLike>('network-access') ?? []
    const found = entries.find(([id]) => id === addonId)
    return found?.[1] ?? null
  }
}

export default RemoteAccessOrchestratorAddon
