/**
 * Tailscale Ingress addon — manages `tailscale serve` (in-tailnet
 * HTTPS) and `tailscale funnel` (public HTTPS) ingresses.
 *
 * Depends on `@camstack/addon-tailscale-client` being installed and
 * the host being joined to a tailnet. The mesh readiness check goes
 * through the `mesh-network` cap so we don't have to import the client
 * package directly.
 *
 * Registers the `network-access` collection cap so the Remote Access
 * page can toggle the public Funnel ingress alongside other ingress
 * providers (cloudflare-tunnel, ngrok, …).
 *
 * Auto-start on boot is owned by the `remote-access-orchestrator` — it
 * persists `enabledProviders[]` and re-invokes `start()` on every server
 * boot. No per-addon autoStart toggle.
 *
 * Graceful disposer — registered via `ctx.addDisposer(...)` so it
 * survives addon-disable AND addon-uninstall. Runs `off` for every
 * active ingress; if the daemon is unreachable we log + skip rather
 * than zombieing the addon.
 */
import {
  BaseAddon,
  EventCategory,
  networkAccessCapability,
  type InferProvider,
  type ProviderRegistration,
} from '@camstack/types'

type NetworkAccessProvider = InferProvider<typeof networkAccessCapability>
import { randomUUID } from 'node:crypto'

import { TailscaleCli, TailscaleCliError, type UpstreamScheme } from './tailscale-cli.js'

// ── Settings shape (#176) ───────────────────────────────────────────

type IngressMode = 'serve' | 'funnel'

/**
 * Subset of the `mesh-network` cap's `getStatus` payload the ingress
 * reads. `daemonSocket` / `daemonCliPath` are populated only when the
 * tailscale-client runs in onboard mode — see mesh-network.cap.ts.
 */
interface MeshStatusView {
  readonly joined: boolean
  readonly magicDnsHostname: string
  readonly error?: string
  readonly daemonSocket?: string
  readonly daemonCliPath?: string
}

interface TailscaleIngressConfig {
  /** Serve (in-tailnet) or Funnel (public). */
  readonly mode: IngressMode
  /** Local source port to expose (e.g. 4443 for the hub). */
  readonly sourcePort: number
  /** Public-side mount path. Empty / `/` = root. */
  readonly targetPath: string
  /**
   * Scheme tailscale uses to reach the local hub. The hub listens
   * HTTPS-with-self-signed by default, so 'https+insecure' is the
   * default — plain 'http' makes the proxy speak cleartext to the
   * TLS listener and return 502. Set 'http' only if the hub is
   * explicitly running with `tls.enabled: false`.
   */
  readonly upstreamScheme: UpstreamScheme
}

const DEFAULT_CONFIG: TailscaleIngressConfig = {
  mode: 'serve',
  sourcePort: 4443,
  targetPath: '',
  upstreamScheme: 'https+insecure',
}

interface ResolvedEndpoint {
  readonly id: string
  readonly label: string
  readonly mode: IngressMode
  readonly sourcePort: number
  readonly url: string
  readonly hostname: string
  readonly port: 443
  readonly protocol: 'https'
}

export class TailscaleIngressAddon extends BaseAddon<TailscaleIngressConfig> {
  private cli!: TailscaleCli
  /**
   * Snapshot of the running ingress params so stop()/disposer can issue
   * the matching `off` call even if `this.config` mutates mid-flight.
   * `null` ⇒ nothing live.
   */
  private active: {
    mode: IngressMode
    sourcePort: number
    targetPath: string
    upstreamScheme: UpstreamScheme
  } | null = null
  /** Set once disposer fires so re-entrant stop() calls are no-ops. */
  private disposed = false

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    // Late-construct so the CLI gets the scoped logger; the field was
    // declared with `!:` because TS can't see this assignment.
    this.cli = new TailscaleCli(this.ctx.logger.child('tailscale-cli'))

    // Sanity-probe the CLI early so the operator sees a clear error
    // when the daemon isn't installed.
    let cliReachable = false
    try {
      await this.cli.version()
      cliReachable = true
    } catch (err) {
      this.ctx.logger.warn('tailscale-ingress: Tailscale CLI not found', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    const provider: NetworkAccessProvider = {
      start: () => this.start(),
      stop: () => this.stop(),
      getEndpoint: () => this.getPrimaryEndpoint(),
      getStatus: () => this.getStatus(),
      listEndpoints: () => this.listEndpoints(),
    }

    // Graceful shutdown disposer (#177) — runs on:
    //   • addon disable / uninstall (kernel calls `addon.shutdown()`)
    //   • restartAddon (kernel calls shutdown + re-init)
    //   • full server shutdown
    // We don't try to be clever about "uninstall vs disable" — for
    // active ingresses the right cleanup is identical (turn rules off).
    // Disposers run before `_ctx` is nulled, so logging still works.
    this.ctx.addDisposer(() => this.gracefulShutdown())

    // No boot-time auto-start here — `remote-access-orchestrator` owns
    // the "should I run on boot?" decision via its persisted
    // `enabledProviders[]`. If the CLI is unreachable now, the
    // orchestrator's start() call will surface a clean error to the UI.
    void cliReachable

    return [{ capability: networkAccessCapability, provider }]
  }

  // ── Single-ingress lifecycle ────────────────────────────────────────

  private async start(): Promise<{
    url: string
    hostname: string
    port: number
    protocol: 'http' | 'https'
  }> {
    if (this.disposed) {
      throw new Error('tailscale-ingress: addon shut down — cannot start')
    }
    const log = this.ctx.logger
    log.info('start: phase=verify-client', {
      tags: { topic: 'tailscale-ingress', phase: 'verify-client' },
    })
    const meshStatus = await this.requireClientJoined()

    // Route our CLI at the SAME tailscaled the client drives. If the
    // client runs onboard, that's its private socket — must happen
    // before funnelCapable() / applyRule() so every CLI call below
    // hits the right daemon.
    this.syncCliToDaemon(meshStatus)

    // Funnel pre-flight: the tailnet ACL must grant THIS host the
    // `funnel` attribute. Checking the node's CapMap up-front means
    // we fail fast with the enable-URL instead of spending 15s on a
    // `tailscale funnel` call the daemon rejects anyway.
    if (this.config.mode === 'funnel') {
      log.info('start: phase=verify-funnel-grant', {
        tags: { topic: 'tailscale-ingress', phase: 'verify-funnel-grant' },
      })
      const capable = await this.cli.funnelCapable()
      if (!capable) {
        throw new Error(
          'tailscale-ingress: Funnel is not enabled for this host in the tailnet ACL policy. ' +
            'Enable it at https://login.tailscale.com/admin/settings/funnel ' +
            '(or add a `funnel` nodeAttr for this machine), then retry. ' +
            'Serve mode works without this grant.',
        )
      }
    }

    const next = {
      mode: this.config.mode,
      sourcePort: this.config.sourcePort,
      targetPath: this.config.targetPath,
      upstreamScheme: this.config.upstreamScheme,
    }
    log.info('start: phase=apply-rule', {
      meta: {
        mode: next.mode,
        sourcePort: next.sourcePort,
        targetPath: next.targetPath,
        upstreamScheme: next.upstreamScheme,
      },
      tags: { topic: 'tailscale-ingress', phase: 'apply-rule' },
    })
    await this.applyRule(next, true)
    this.active = next

    log.info('start: phase=resolve-endpoint', {
      tags: { topic: 'tailscale-ingress', phase: 'resolve-endpoint' },
    })
    const endpoint = await this.resolveEndpoint()
    if (!endpoint) {
      throw new Error(
        'tailscale-ingress: CLI accepted the ingress but no MagicDNS hostname yet — has the host fully joined the tailnet?',
      )
    }

    this.ctx.eventBus?.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'addon', id: this.ctx.id },
      category: EventCategory.NetworkTunnelStarted,
      data: { url: endpoint.url },
    })

    return {
      url: endpoint.url,
      hostname: endpoint.hostname,
      port: endpoint.port,
      protocol: endpoint.protocol,
    }
  }

  private async stop(): Promise<void> {
    // Snapshot then clear so re-entrant calls don't double-issue `off`.
    const live = this.active
    this.active = null
    if (live) {
      try {
        await this.applyRule(live, false)
      } catch (err) {
        // Log but don't throw — `stop()` must always succeed from the
        // operator's POV. A failed off-call is recoverable on the next
        // boot via the disposer or a manual CLI cleanup.
        this.ctx.logger.warn(
          'tailscale-ingress: failed to stop ingress — will retry on next disposer call',
          {
            meta: {
              ingress: live,
              error: err instanceof Error ? err.message : String(err),
            },
            tags: { topic: 'tailscale-ingress', phase: 'stop-error' },
          },
        )
      }
    }
    this.ctx.eventBus?.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'addon', id: this.ctx.id },
      category: EventCategory.NetworkTunnelStopped,
      data: {},
    })
  }

  // ── #177 — graceful disposer ────────────────────────────────────────

  /**
   * Runs from `ctx.addDisposer(...)` on every teardown path:
   *   - addon disable / uninstall
   *   - restartAddon
   *   - full server shutdown
   *
   * Strategy: ask the daemon to clear the active rule. If the daemon is
   * unreachable we log the failure and proceed — leaving the addon
   * zombied with mesh ingress is worse than a stale rule the operator
   * can clean up by hand.
   */
  private async gracefulShutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const live = this.active
    this.active = null
    if (!live) return

    try {
      await this.cli.version()
    } catch (err) {
      this.ctx.logger.warn(
        "tailscale-ingress: disposer can't reach tailscale CLI — leaving rule in place",
        {
          meta: {
            error: err instanceof Error ? err.message : String(err),
            ingress: live,
          },
          tags: { topic: 'tailscale-ingress', phase: 'dispose-cli-missing' },
        },
      )
      return
    }

    try {
      await this.applyRule(live, false)
    } catch (err) {
      this.ctx.logger.warn('tailscale-ingress: disposer failed to clear ingress — continuing', {
        meta: {
          ingress: live,
          error: err instanceof Error ? err.message : String(err),
        },
        tags: { topic: 'tailscale-ingress', phase: 'dispose-entry-error' },
      })
    }
  }

  // ── network-access provider impl ───────────────────────────────────

  private async getPrimaryEndpoint(): Promise<{
    url: string
    hostname: string
    port: number
    protocol: 'http' | 'https'
  } | null> {
    const ep = await this.resolveEndpoint()
    if (!ep) return null
    return {
      url: ep.url,
      hostname: ep.hostname,
      port: ep.port,
      protocol: ep.protocol,
    }
  }

  private async getStatus(): Promise<{
    connected: boolean
    endpoint: { url: string; hostname: string; port: number; protocol: 'http' | 'https' } | null
    error?: string
  }> {
    try {
      const endpoint = await this.getPrimaryEndpoint()
      return {
        connected: this.active !== null && endpoint !== null,
        endpoint,
      }
    } catch (err) {
      return {
        connected: false,
        endpoint: null,
        error: err instanceof TailscaleCliError ? err.message : String(err),
      }
    }
  }

  private async listEndpoints(): Promise<
    ReadonlyArray<{
      id: string
      label: string
      url: string
      hostname: string
      port: number
      protocol: 'http' | 'https'
      mode?: string
      sourcePort?: number
    }>
  > {
    const ep = await this.resolveEndpoint()
    return ep ? [ep] : []
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private async applyRule(
    rule: {
      mode: IngressMode
      sourcePort: number
      targetPath: string
      upstreamScheme: UpstreamScheme
    },
    enabled: boolean,
  ): Promise<void> {
    const opts: {
      port: number
      enabled: boolean
      targetPath?: string
      upstreamScheme: UpstreamScheme
    } = {
      port: rule.sourcePort,
      enabled,
      upstreamScheme: rule.upstreamScheme,
      ...(rule.targetPath && rule.targetPath !== '/' ? { targetPath: rule.targetPath } : {}),
    }
    this.ctx.logger.info(`applyRule: ${rule.mode}`, {
      meta: { ...opts, mode: rule.mode },
      tags: { topic: 'tailscale-ingress', phase: 'apply-rule', verb: rule.mode },
    })
    if (rule.mode === 'funnel') {
      await this.cli.funnel(opts)
    } else {
      await this.cli.serve(opts)
    }
    this.ctx.logger.info(`applyRule: ${rule.mode} done`, {
      tags: { topic: 'tailscale-ingress', phase: 'apply-rule-done', verb: rule.mode },
    })
  }

  /**
   * Build the canonical endpoint from the active ingress + the
   * mesh-network MagicDNS hostname. Cold-start safe: when the host
   * isn't joined yet we return `null` rather than a half-formed URL
   * with no hostname.
   */
  private async resolveEndpoint(): Promise<ResolvedEndpoint | null> {
    const live = this.active
    if (!live) return null
    const meshStatus = await this.fetchMeshStatus().catch(() => null)
    if (!meshStatus || !meshStatus.joined) return null
    const host = meshStatus.magicDnsHostname
    if (!host) return null
    const path = live.targetPath && live.targetPath !== '/' ? live.targetPath : ''
    return {
      id: `${live.mode}-${live.sourcePort}${path}`,
      label: `${live.mode === 'funnel' ? 'Funnel' : 'Serve'} :${live.sourcePort}${path}`,
      mode: live.mode,
      sourcePort: live.sourcePort,
      url: `https://${host}${path}`,
      hostname: host,
      port: 443,
      protocol: 'https',
    }
  }

  /**
   * Wait for `mesh-network` (the tailscale-client provider) to be
   * mounted AND report joined. Throws an actionable error otherwise.
   *
   * IMPORTANT: we route the check through the API surface
   * (`api.meshNetwork.getStatus.query({ addonId: 'tailscale-client' })`),
   * NOT through `ctx.capabilities.getCollectionEntries`. The latter
   * only sees providers registered in THIS process's local
   * CapabilityRegistry — and tailscale-client runs in a separate
   * `hub/tailscale-client` group runner. The API surface is
   * cross-process via Moleculer, so it can find the provider wherever
   * it lives.
   *
   * `mesh-network` is a `collection` cap (Tailscale + Headscale +
   * ZeroTier could all implement it in parallel), so we pin to
   * `tailscale-client` via the `addonId` filter — without it the API
   * would route to whichever provider registered first and we'd risk
   * emitting `tailscale serve` against e.g. a Headscale daemon that
   * doesn't know that verb.
   */
  private async requireClientJoined(): Promise<MeshStatusView> {
    let status: MeshStatusView
    try {
      status = await this.fetchMeshStatus({ addonId: 'tailscale-client' })
    } catch (err) {
      throw new Error(
        'tailscale-ingress: tailscale-client provider not registered — install + start the @camstack/addon-tailscale-client addon first.',
        { cause: err },
      )
    }
    if (!status.joined) {
      throw new Error(
        'tailscale-ingress: tailnet not joined — open the Mesh Networks page and click "Connect to Tailscale" first.',
      )
    }
    return status
  }

  /**
   * Rebuild `this.cli` to drive the tailscale-client's daemon. When
   * the client runs in `onboard` mode it spawned a private
   * `tailscaled`; the mesh status then carries `daemonSocket` +
   * `daemonCliPath` and we MUST route serve/funnel through that
   * socket — the system daemon is a different node with a different
   * mesh identity. Host mode leaves both unset → default CLI.
   */
  private syncCliToDaemon(status: MeshStatusView): void {
    const cliLogger = this.ctx.logger.child('tailscale-cli')
    if (status.daemonSocket) {
      this.ctx.logger.info('start: routing CLI to onboard daemon', {
        meta: { daemonSocket: status.daemonSocket, daemonCliPath: status.daemonCliPath },
        tags: { topic: 'tailscale-ingress', phase: 'daemon-route' },
      })
      this.cli = new TailscaleCli({
        logger: cliLogger,
        socketPath: status.daemonSocket,
        ...(status.daemonCliPath ? { binPath: status.daemonCliPath } : {}),
      })
    } else {
      this.cli = new TailscaleCli({ logger: cliLogger })
    }
  }

  private async fetchMeshStatus(filter?: {
    addonId?: string
    nodeId?: string
  }): Promise<MeshStatusView> {
    const api = this.ctx.api as {
      meshNetwork?: {
        getStatus: {
          query: (input?: { addonId?: string; nodeId?: string }) => Promise<MeshStatusView>
        }
      }
    }
    if (!api.meshNetwork?.getStatus?.query) {
      throw new Error('tailscale-ingress: mesh-network cap not exposed on the api surface')
    }
    return await api.meshNetwork.getStatus.query(filter)
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'tailscale-ingress',
          title: 'Tailscale Ingress',
          titleKey: 'tailscale:globalSettings.s_tailscale-ingress.title',
          description:
            '⚠️ Requires the Tailscale Client addon installed AND the host joined to a tailnet — open System → Mesh Networks → Connect first. Expose the hub via Tailscale Serve (in-tailnet HTTPS) or Funnel (publicly reachable on the internet).',
          descriptionKey: 'tailscale:globalSettings.s_tailscale-ingress.description',
          columns: 1,
          fields: [
            this.field({
              type: 'select',
              key: 'mode',
              label: 'Mode',
              labelKey: 'tailscale:globalSettings.s_tailscale-ingress.mode.label',
              description:
                'Serve = in-tailnet only (requires the visitor to be on the same tailnet). Funnel = publicly reachable on the internet.',
              descriptionKey: 'tailscale:globalSettings.s_tailscale-ingress.mode.description',
              default: DEFAULT_CONFIG.mode,
              options: [
                {
                  value: 'serve',
                  label: 'Serve (private, in-tailnet)',
                  labelKey: 'tailscale:globalSettings.s_tailscale-ingress.mode.o_serve.label',
                },
                {
                  value: 'funnel',
                  label: 'Funnel (public internet)',
                  labelKey: 'tailscale:globalSettings.s_tailscale-ingress.mode.o_funnel.label',
                },
              ],
            }),
            this.field({
              type: 'number',
              key: 'sourcePort',
              label: 'Source port',
              labelKey: 'tailscale:globalSettings.s_tailscale-ingress.sourcePort.label',
              description: 'Local port to expose. Use 4443 to forward the hub HTTPS backend.',
              descriptionKey: 'tailscale:globalSettings.s_tailscale-ingress.sourcePort.description',
              default: DEFAULT_CONFIG.sourcePort,
              placeholder: '4443',
              min: 1,
              max: 65535,
            }),
            this.field({
              type: 'text',
              key: 'targetPath',
              label: 'Target path (optional)',
              labelKey: 'tailscale:globalSettings.s_tailscale-ingress.targetPath.label',
              description: 'Public-side mount path. Leave empty for root.',
              descriptionKey: 'tailscale:globalSettings.s_tailscale-ingress.targetPath.description',
              default: DEFAULT_CONFIG.targetPath,
              placeholder: '/',
            }),
            this.field({
              type: 'select',
              key: 'upstreamScheme',
              label: 'Upstream scheme',
              labelKey: 'tailscale:globalSettings.s_tailscale-ingress.upstreamScheme.label',
              description:
                'How Tailscale reaches the local hub. The hub listens HTTPS with a self-signed cert by default — keep "https+insecure". Use "http" ONLY if the hub runs with tls.enabled: false (a plain "http" rule against the TLS listener returns 502).',
              descriptionKey:
                'tailscale:globalSettings.s_tailscale-ingress.upstreamScheme.description',
              default: DEFAULT_CONFIG.upstreamScheme,
              options: [
                {
                  value: 'https+insecure',
                  label: 'HTTPS, self-signed (default)',
                  labelKey:
                    'tailscale:globalSettings.s_tailscale-ingress.upstreamScheme.o_https_insecure.label',
                },
                {
                  value: 'https',
                  label: 'HTTPS, valid cert',
                  labelKey:
                    'tailscale:globalSettings.s_tailscale-ingress.upstreamScheme.o_https.label',
                },
                {
                  value: 'http',
                  label: 'HTTP (only if hub TLS disabled)',
                  labelKey:
                    'tailscale:globalSettings.s_tailscale-ingress.upstreamScheme.o_http.label',
                },
              ],
            }),
          ],
        },
      ],
    })
  }

  protected async onConfigChanged(): Promise<void> {
    // When the ingress params change while running, tear down. The operator
    // re-applies via the Remote Access Start button (which the orchestrator
    // routes back into this addon's `start()`).
    if (this.active === null) return
    await this.stop()
  }
}

export default TailscaleIngressAddon
