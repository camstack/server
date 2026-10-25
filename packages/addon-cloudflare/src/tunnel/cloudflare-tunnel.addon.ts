import { userError } from '@camstack/types'
import type { AddonInitResult } from '@camstack/types'
import { BaseAddon, networkAccessCapability } from '@camstack/types'
import type { z } from 'zod'
import * as path from 'node:path'
import { CloudflareTunnelService, type CloudflareTunnelConfig } from './cloudflare-tunnel'
import { ensureCloudflared } from './ensure-cloudflared'
import { removeTokenFile, tokenFileIn } from './cloudflared-invocation'
import { CloudflareApi } from './cloudflare-api'
import { cloudflareTunnelActions, type CloudflareTunnelActions } from './cloudflare-actions'
import { shouldAutoStartTunnel } from './auto-start'

// Re-export under the conventional name so the kernel addon-loader can
// discover the catalog directly off the entry module (the manifest's
// `entry` points at this file, NOT `index.ts`, so a re-export there
// would be invisible to the hub).
export { cloudflareTunnelActions as customActions } from './cloudflare-actions'

/**
 * Cloudflare Tunnel — exposes CamStack via Cloudflare's network.
 *
 * Two flows, both driven by a single `start()` button on the Remote
 * Access page:
 *
 *  • Quick (`mode='quick'`) — `start()` spawns `cloudflared tunnel --url
 *    https://localhost:<port>` (the hub origin is HTTPS/self-signed, so
 *    `--no-tls-verify` is added); cloudflared invents a random
 *    `*.trycloudflare.com` URL and we surface it back to the operator.
 *
 *  • Custom (`mode='custom'`) — operator fills API token + zone +
 *    hostname in settings, then hits `start()`. The addon (server-side)
 *    auto-provisions: creates / reuses the tunnel, writes the CNAME,
 *    persists the JWT, then spawns `cloudflared tunnel run --token <jwt>`.
 *    Subsequent starts skip the provisioning step (token is cached).
 *
 * `listZones` is exposed as a customAction so the settings form's
 * `addon-action-select` zone picker can populate options live.
 */
export class CloudflareTunnelAddon extends BaseAddon<CloudflareTunnelConfig> {
  /** The named-tunnel JWT the addon provisions itself — kept in the keychain (D787). */
  protected override readonly secretStatePaths = ['customTunnelToken']
  private service: CloudflareTunnelService | null = null

  constructor() {
    // ALL config keys must appear here — `BaseAddon.resolveConfig`
    // only re-reads keys present in `defaults`, anything else stays
    // stuck on its constructor value regardless of what's on disk.
    // Custom-mode fields default to empty strings so the type guard
    // in `handleStart` ("token / zoneId / hostname missing") doubles
    // as a "filled by operator?" check.
    super({
      mode: 'quick',
      localPort: 0, // 0 = auto-detect from CAMSTACK_PORT / PORT env at start
      localPortMode: 'default' as 'default' | 'custom',
      localHost: '', // empty = auto-detect from local-network cap at start
      // TLS handling on the cloudflared→origin hop. Camstack's hub runs
      // HTTPS with a self-signed cert, so `noTLSVerify=true` is the
      // sensible default — operators with a properly-issued cert on the
      // origin can disable it.
      noTLSVerify: true,
      // Optional SNI to send during the TLS handshake to the origin.
      // Empty = match the URL host (the LAN IP). Useful when the origin
      // cert is issued for a specific hostname (e.g. `camstack.local`).
      originServerName: '',
      // Optional Host header override sent to the origin. Empty = pass
      // the public-facing hostname through. Needed when the origin
      // routes by Host header (rare for camstack).
      httpHostHeader: '',
      customApiToken: '',
      customAccountId: '',
      customTunnelId: '',
      customTunnelToken: '',
      customZoneId: '',
      customZoneName: '',
      customDnsRecordId: '',
      customHostname: 'camstack',
      debugLogging: false,
      protocol: 'auto' as 'auto' | 'http2' | 'quic',
    })
  }

  /**
   * Resolve the local hub HTTPS port the tunnel must front. Order:
   *   1. Explicit `localPort` in addon config (> 0) — operator override.
   *   2. `CAMSTACK_PORT` env (set by the bootstrap config manager).
   *   3. `PORT` env (legacy / .env fallback).
   *   4. 4443 — CamStack hub backend HTTPS default.
   */
  private resolveLocalPort(): number {
    // `localPortMode === 'custom'` is the only path that honours
    // `this.config.localPort`. Default mode auto-resolves regardless of
    // whatever value sits in `localPort` (stale data from older forms).
    if (
      this.config.localPortMode === 'custom' &&
      this.config.localPort &&
      this.config.localPort > 0
    ) {
      return this.config.localPort
    }
    const camstack = Number.parseInt(process.env['CAMSTACK_PORT'] ?? '', 10)
    if (Number.isFinite(camstack) && camstack > 0) return camstack
    const port = Number.parseInt(process.env['PORT'] ?? '', 10)
    if (Number.isFinite(port) && port > 0) return port
    return 4443
  }

  /**
   * Ask the `local-network` cap for the preferred LAN address. Fallback
   * is `127.0.0.1` when the cap is unreachable / not yet mounted.
   * Cached for the duration of one provisioning call.
   */
  private async resolveLocalHost(): Promise<string> {
    try {
      const api = this.ctx.api as {
        localNetwork?: {
          getPreferred?: { query: () => Promise<{ address: string } | null> }
        }
      }
      const preferred = await api.localNetwork?.getPreferred?.query()
      if (preferred?.address) return preferred.address
    } catch (err) {
      this.ctx.logger.warn('local-network getPreferred failed — falling back to localhost', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tunnel', phase: 'localhost-fallback' },
      })
    }
    return '127.0.0.1'
  }

  /**
   * Resolve the `cloudflared` binary path once per addon lifetime (PATH install,
   * or a copy downloaded + cached under `<dataDir>/bin`). Memoized so the
   * (possible) download happens at most once, on the first tunnel start.
   */
  private cloudflaredBinPromise?: Promise<string>
  private resolveCloudflared(): Promise<string> {
    this.cloudflaredBinPromise ??= ensureCloudflared({
      binDir: path.join(this.ctx.dataDir, 'bin'),
      logger: this.ctx.logger,
    })
    return this.cloudflaredBinPromise
  }

  /** Owner-only dir for the named-tunnel token file (D783). */
  private tokenFileDir(): string {
    return path.join(this.ctx.dataDir, 'run')
  }

  // `local-network` runs in-process on the hub while this addon may
  // be forked. We don't push the FQDN directly — `local-network`
  // subscribes to `NetworkTunnelStarted/Stopped` events on the bus
  // (the service already emits them) and tracks the hostname there.

  protected async onInitialize(): Promise<AddonInitResult<CloudflareTunnelActions>> {
    // One-shot migration — earlier builds let operators point the tunnel
    // at the Vite admin-ui dev port (3001). Vite blocks unknown hosts so
    // the public domain returned "Cloudflare Tunnel error". Reset
    // back to "auto" (=`resolveLocalPort()` → CAMSTACK_PORT / 4443) so
    // the next start syncs the correct hub backend port.
    if (this.config.localPort === 3001) {
      this.ctx.logger.warn('Resetting stale localPort=3001 (Vite admin-ui dev port) → 0 (auto)', {
        tags: { topic: 'tunnel', phase: 'localport-migration' },
      })
      await this.updateGlobalSettings({ localPort: 0 }).catch(() => undefined)
    }
    // A token file can outlive a hard kill (OOM, SIGKILL) of the previous
    // process; nothing is running yet, so drop it before anything spawns.
    removeTokenFile(tokenFileIn(this.tokenFileDir()))
    const localHost = await this.resolveLocalHost()
    this.service = new CloudflareTunnelService(
      { ...this.config, localPort: this.resolveLocalPort(), localHost },
      this.ctx.logger,
      this.ctx.eventBus,
      () => this.resolveCloudflared(),
      this.tokenFileDir(),
    )
    this.ctx.logger.info('Cloudflare Tunnel addon initialized', {
      meta: { mode: this.config.mode, hasCustomToken: !!this.config.customTunnelToken },
    })

    // Wrap the service so `start()` runs custom-mode provisioning lazily
    // when the operator hits the Start button — single entry point, no
    // separate "Enable" affordance. `getStatus`/`stop` pass through.
    const provider = {
      start: () => this.handleStart(),
      stop: () => this.requireService().stop(),
      getStatus: () => this.requireService().getStatus(),
    }

    // Auto-start the tunnel at boot when the addon already has a
    // running-capable config (custom mode + token persisted). Without
    // this, an addon restart (deploy, config change that respawns the
    // runner) leaves the tunnel down until the operator manually re-hits
    // Start — and a config-change like flipping `debugLogging` is then a
    // no-op because `onConfigChanged` sees `wasRunning: false`.
    if (this.isRunCapable()) {
      // Fire-and-forget: any failure is already logged inside handleStart,
      // and we don't want to block `onInitialize` on a tunnel handshake.
      void this.handleStart().catch((err) => {
        this.ctx.logger.warn('boot auto-start failed (will retry on next config change)', {
          meta: { error: err instanceof Error ? err.message : String(err) },
          tags: { topic: 'tunnel', phase: 'auto-start-error' },
        })
      })
    } else if (!this.settingsStoreReady) {
      this.ctx.logger.warn(
        'boot auto-start skipped — settings store did not answer; defaults are not an operator choice',
        { tags: { topic: 'tunnel', phase: 'auto-start-skipped' } },
      )
    }

    return {
      providers: [{ capability: networkAccessCapability, provider }],
      customActions: cloudflareTunnelActions,
      actionHandlers: {
        validateToken: async (input) => this.validateToken(input),
        listZones: async (input) => this.listZones(input),
        enableCustom: async (input) => this.enableCustom(input),
        disableCustom: async () => this.disableCustom(),
        pruneStaleTunnels: async (input) => this.pruneStaleTunnels(input),
        listLocalAddresses: async () => this.listLocalAddresses(),
      },
    }
  }

  /** True when the persisted config has everything `start()` needs to
   *  spawn cloudflared without operator interaction. Used by the boot
   *  auto-start and by `onConfigChanged` to decide whether a change
   *  warrants a respawn even when no instance was previously running. */
  private isRunCapable(): boolean {
    return shouldAutoStartTunnel({
      settingsStoreReady: this.settingsStoreReady,
      mode: this.config.mode,
      hasCustomToken: !!this.config.customTunnelToken,
      hasCustomHostname: !!this.config.customHostname,
    })
  }

  protected async onShutdown(): Promise<void> {
    if (this.service) {
      await this.service.stop().catch(() => undefined)
      this.service = null
    }
  }

  protected async onConfigChanged(): Promise<void> {
    // Rebuild the service against the new config so `start()` picks up
    // the latest mode + persisted custom-tunnel state, then respawn the
    // tunnel whenever the config is run-capable — even when this addon
    // instance didn't have a running cloudflared yet (e.g. immediately
    // after a deploy). Without that, flipping a runtime-affecting flag
    // like `debugLogging` right after a restart silently no-ops because
    // `wasRunning: false`. Tunnel lifecycle events (`NetworkTunnelStarted`
    // / `Stopped`) keep firing so the local-network cap's public-FQDN
    // tracker stays in sync.
    if (this.service) {
      await this.service.stop().catch(() => undefined)
    }
    const localHost = await this.resolveLocalHost()
    this.service = new CloudflareTunnelService(
      { ...this.config, localPort: this.resolveLocalPort(), localHost },
      this.ctx.logger,
      this.ctx.eventBus,
      () => this.resolveCloudflared(),
      this.tokenFileDir(),
    )
    if (this.isRunCapable()) {
      this.ctx.logger.info('config changed — (re-)spawning tunnel', {
        meta: { mode: this.config.mode, debugLogging: this.config.debugLogging },
        tags: { topic: 'tunnel', phase: 'config-reload' },
      })
      try {
        await this.handleStart()
      } catch (err) {
        this.ctx.logger.error('config-reload restart failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
          tags: { topic: 'tunnel', phase: 'config-reload-error' },
        })
      }
    }
  }

  // ── network-access provider wrapper ────────────────────────────────

  /**
   * Start the tunnel, provisioning custom mode first if needed. This is
   * the single button the orchestrator (Remote Access page) calls; the
   * addon decides whether the underlying spawn is quick or token-based.
   */
  private async handleStart() {
    // Re-provision when:
    //  • token missing (first time), OR
    //  • the persisted hostname isn't a FQDN yet (migration from the
    //    pre-FQDN schema — operator's existing config had `camstack`
    //    instead of `camstack.example.com`). Cloudflare's ingress
    //    rule matches the literal hostname so a non-FQDN stays
    //    permanently unreachable until re-provision.
    const needsReprovision =
      this.config.mode === 'custom' &&
      (!this.config.customTunnelToken || !this.config.customHostname.includes('.'))
    if (needsReprovision) {
      this.ctx.logger.info('start: custom mode needs (re)provisioning', {
        meta: {
          hasToken: !!this.config.customTunnelToken,
          hostname: this.config.customHostname,
        },
        tags: { topic: 'tunnel', phase: 'auto-provision' },
      })
      const token = this.config.customApiToken
      const zoneId = this.config.customZoneId
      const hostname = this.config.customHostname
      if (!token || !zoneId || !hostname) {
        const missing = [!token && 'API token', !zoneId && 'zone', !hostname && 'hostname']
          .filter(Boolean)
          .join(', ')
        const err = userError(
          'cloudflare.custom-needs-settings',
          { missing: String(missing) },
          `Custom tunnel needs: ${missing}. Fill the settings above first.`,
        )
        this.ctx.logger.error('start: custom mode config incomplete', {
          meta: { missing },
          tags: { topic: 'tunnel', phase: 'auto-provision-incomplete' },
        })
        throw err
      }
      await this.enableCustom({
        token,
        zoneId,
        hostname,
        localPortMode: this.config.localPort && this.config.localPort > 0 ? 'custom' : 'default',
        localPort: this.config.localPort || undefined,
      })
    } else if (
      this.config.mode === 'custom' &&
      this.config.customApiToken &&
      this.config.customAccountId &&
      this.config.customTunnelId
    ) {
      // Idempotent sync: re-PUT the ingress config on every start so
      // operator-side edits (localPort change, protocol upgrade,
      // re-deploy of admin UI on a different port) take effect on the
      // NEXT start without forcing the operator to re-run "Enable
      // Custom" by hand. Skips tunnel/DNS provisioning (already exists).
      await this.syncCustomIngress().catch((err) => {
        // Sync is best-effort: if the API call fails (token revoked,
        // network blip), the tunnel still starts against whatever
        // Cloudflare currently has. The operator can re-run Enable
        // Custom from the UI to recover.
        this.ctx.logger.warn(
          'start: ingress sync failed — continuing with previously-stored ingress',
          {
            meta: { error: err instanceof Error ? err.message : String(err) },
            tags: { topic: 'tunnel', phase: 'sync-ingress-failed' },
          },
        )
      })
    }
    return this.requireService().start()
  }

  /**
   * Build the `originRequest` block applied to the cloudflared→origin
   * hop. Reads operator-configurable TLS overrides from the addon
   * config — `noTLSVerify` defaults to true for camstack's self-signed
   * hub cert; the other two are optional escape hatches.
   */
  private buildOriginRequest(): {
    noTLSVerify?: boolean
    originServerName?: string
    httpHostHeader?: string
  } {
    const out: { noTLSVerify?: boolean; originServerName?: string; httpHostHeader?: string } = {}
    if (this.config.noTLSVerify === true) out.noTLSVerify = true
    if (this.config.originServerName) out.originServerName = this.config.originServerName
    if (this.config.httpHostHeader) out.httpHostHeader = this.config.httpHostHeader
    return out
  }

  /**
   * Re-PUT the tunnel ingress config from the current addon settings
   * + resolved local host/port. Called on every start so changes to
   * `localPort` / `localHost` / protocol policy (HTTPS + noTLSVerify
   * for self-signed) propagate without operator action.
   */
  private async syncCustomIngress(): Promise<void> {
    const token = this.config.customApiToken
    const accountId = this.config.customAccountId
    const tunnelId = this.config.customTunnelId
    if (!token || !accountId || !tunnelId) return
    const api = new CloudflareApi(token)
    const localHost = await this.resolveLocalHost()
    const targetPort =
      this.config.localPort && this.config.localPort > 0
        ? this.config.localPort
        : this.resolveLocalPort()
    const fqdn = this.config.customHostname
    await api.putTunnelConfiguration(accountId, tunnelId, [
      {
        hostname: fqdn,
        service: `https://${localHost}:${targetPort}`,
        originRequest: this.buildOriginRequest(),
      },
      { service: 'http_status:404' },
    ])
    this.ctx.logger.info('start: ingress synced', {
      meta: { hostname: fqdn, localHost, localPort: targetPort, mode: 'sync' },
      tags: { topic: 'tunnel', phase: 'sync-ingress-ok' },
    })
  }

  private requireService(): CloudflareTunnelService {
    if (!this.service) throw new Error('Cloudflare tunnel service not initialized')
    return this.service
  }

  // ── Action handlers ────────────────────────────────────────────────

  private async validateToken(
    input: z.infer<CloudflareTunnelActions['validateToken']['input']>,
  ): Promise<z.infer<CloudflareTunnelActions['validateToken']['output']>> {
    this.ctx.logger.info('validateToken: probing API token', {
      tags: { topic: 'tunnel', phase: 'validate-token' },
    })
    const api = new CloudflareApi(input.token)
    try {
      const account = await api.getAccount()
      this.ctx.logger.info('validateToken: token OK', {
        meta: { accountId: account.id, accountName: account.name },
        tags: { topic: 'tunnel', phase: 'validate-token-ok' },
      })
      return { ok: true, accountId: account.id, accountName: account.name }
    } catch (err) {
      this.ctx.logger.error('validateToken: probe failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tunnel', phase: 'validate-token-error' },
      })
      throw err
    }
  }

  /**
   * Surface the local-network cap's interface list to the form-builder
   * `addon-action-select` field so the operator can pin which address
   * the tunnel ingress should target (Docker sidecar, multi-NIC host,
   * etc). Empty `value` represents "auto — fall back to
   * local-network.getPreferred()".
   */
  private async listLocalAddresses(): Promise<{
    addresses: readonly { value: string; label: string; labelKey?: string; description: string }[]
  }> {
    try {
      const api = this.ctx.api as {
        localNetwork?: {
          list: {
            query: () => Promise<{
              interfaces: ReadonlyArray<{
                name: string
                address: string
                kind: string
                family: string
                preferred: boolean
                internal: boolean
              }>
            }>
          }
        }
      }
      const res = await api.localNetwork?.list?.query()
      const interfaces = res?.interfaces ?? []
      const options = interfaces
        // Drop internal/link-local — they're useless for tunnel ingress.
        .filter((i) => !i.internal && !i.address.startsWith('169.254.') && i.family === 'IPv4')
        .map((i) => ({
          value: i.address,
          label: `${i.name} — ${i.address}`,
          description: `${i.kind}${i.preferred ? ' · auto-preferred' : ''}`,
        }))
      // Prepend an explicit "auto" option so operators can opt back into
      // the heuristic without manually clearing the field.
      return {
        addresses: [
          {
            value: '',
            label: 'Auto (use local-network preferred)',
            labelKey: 'cloudflare:listLocalAddresses.o_.label',
            description: 're-evaluated on every start',
          },
          ...options,
        ],
      }
    } catch (err) {
      this.ctx.logger.warn('listLocalAddresses: local-network cap unreachable', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tunnel', phase: 'list-local-addresses-error' },
      })
      return {
        addresses: [
          {
            value: '',
            label: 'Auto (use local-network preferred)',
            labelKey: 'cloudflare:listLocalAddresses.o_.label',
            description: 'fallback',
          },
        ],
      }
    }
  }

  private async listZones(
    input: z.infer<CloudflareTunnelActions['listZones']['input']>,
  ): Promise<z.infer<CloudflareTunnelActions['listZones']['output']>> {
    this.ctx.logger.info('listZones: fetching zones', {
      tags: { topic: 'tunnel', phase: 'list-zones' },
    })
    const token = input.token ?? this.config.customApiToken
    if (token.length === 0)
      throw userError(
        'cloudflare.zone-token-missing',
        undefined,
        'listZones: no Cloudflare API token is set',
      )
    const api = new CloudflareApi(token)
    try {
      const zones = await api.listZones()
      this.ctx.logger.info('listZones: returned zones', {
        meta: { count: zones.length },
        tags: { topic: 'tunnel', phase: 'list-zones-ok' },
      })
      return { zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })) }
    } catch (err) {
      this.ctx.logger.error('listZones: fetch failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tunnel', phase: 'list-zones-error' },
      })
      throw err
    }
  }

  /**
   * Server-managed custom-tunnel provisioning. Idempotent — reuses an
   * existing 'camstack' tunnel by name and treats "DNS record already
   * exists" as success. Persists tunnel id + JWT + DNS record id back
   * into the addon config so subsequent `start()` calls skip provisioning.
   *
   * Kept exposed as a customAction (rather than purely internal) for
   * scripting / manual re-provisioning from external clients; the UI
   * now drives provisioning via the `start()` Start button instead.
   */
  private async enableCustom(
    input: z.infer<CloudflareTunnelActions['enableCustom']['input']>,
  ): Promise<z.infer<CloudflareTunnelActions['enableCustom']['output']>> {
    this.ctx.logger.info('enableCustom: starting', {
      meta: { hostname: input.hostname, zoneId: input.zoneId, localPort: input.localPort },
      tags: { topic: 'tunnel', phase: 'enable-start' },
    })
    const api = new CloudflareApi(input.token)

    try {
      // Resolve zone name so we can build a fully-qualified hostname.
      // Cloudflare's DNS API accepts a short name and prepends the zone
      // on its side; but for the persisted endpoint URL + the tunnel
      // ingress hostname we need the FQDN, otherwise we display
      // "https://camstack" instead of "https://camstack.example.com".
      const zones = await api.listZones()
      const zone = zones.find((z) => z.id === input.zoneId)
      if (!zone) {
        throw userError(
          'cloudflare.zone-not-visible',
          { zoneId: String(input.zoneId) },
          `Selected zone ${input.zoneId} is not visible to this token`,
        )
      }
      const subdomain = input.hostname.trim()
      // Strip a possibly-pasted full FQDN suffix (e.g. operator wrote
      // "camstack.example.com"); resulting subdomain matches DNS rules.
      const subBare = subdomain.endsWith(`.${zone.name}`)
        ? subdomain.slice(0, -1 - zone.name.length)
        : subdomain
      const fqdn = subBare === '@' || subBare === '' ? zone.name : `${subBare}.${zone.name}`
      this.ctx.logger.info('enableCustom: resolved FQDN', {
        meta: { subBare, zoneName: zone.name, fqdn },
        tags: { topic: 'tunnel', phase: 'enable-fqdn' },
      })

      const account = await api.getAccount()
      this.ctx.logger.info('enableCustom: account resolved', {
        meta: { accountId: account.id, accountName: account.name },
        tags: { topic: 'tunnel', phase: 'enable-account' },
      })

      // If we already have a CNAME persisted (from a prior run) AND
      // the operator is now provisioning a *different* hostname/zone,
      // tear the old CNAME down — keep the tunnel itself (it gets
      // repointed at the new hostname below).
      if (
        this.config.customDnsRecordId &&
        this.config.customZoneId &&
        this.config.customHostname &&
        this.config.customHostname.toLowerCase() !== fqdn.toLowerCase()
      ) {
        this.ctx.logger.info('enableCustom: removing previous DNS record (hostname changed)', {
          meta: { from: this.config.customHostname, to: input.hostname },
          tags: { topic: 'tunnel', phase: 'enable-dns-cleanup' },
        })
        try {
          await api.deleteDnsRecord(this.config.customZoneId, this.config.customDnsRecordId)
        } catch (err) {
          this.ctx.logger.warn('enableCustom: previous DNS cleanup failed (continuing)', {
            meta: { error: err instanceof Error ? err.message : String(err) },
            tags: { topic: 'tunnel', phase: 'enable-dns-cleanup-failed' },
          })
        }
      }

      // Reuse or create the `camstack` tunnel.
      const TUNNEL_NAME = 'camstack'
      let tunnel = await api.findTunnelByName(account.id, TUNNEL_NAME)
      if (tunnel) {
        this.ctx.logger.info('enableCustom: reusing existing tunnel by name', {
          meta: { tunnelId: tunnel.id, name: tunnel.name },
          tags: { topic: 'tunnel', phase: 'enable-tunnel-reused' },
        })
        const token = await api.getTunnelToken(account.id, tunnel.id)
        tunnel = { ...tunnel, token }
      } else {
        tunnel = await api.createTunnel(account.id, TUNNEL_NAME)
        this.ctx.logger.info('enableCustom: tunnel created', {
          meta: { tunnelId: tunnel.id, name: tunnel.name },
          tags: { topic: 'tunnel', phase: 'enable-tunnel-created' },
        })
      }

      const localHost = await this.resolveLocalHost()
      // Auto-resolve to the hub backend HTTPS port unless the operator
      // pinned a custom one — camstack runs on HTTPS with a self-signed
      // cert, so emit `https://...` + `noTLSVerify: true`.
      const useDefault = (input.localPortMode ?? 'default') === 'default'
      const targetPort = useDefault || !input.localPort ? this.resolveLocalPort() : input.localPort
      await api.putTunnelConfiguration(account.id, tunnel.id, [
        {
          hostname: fqdn,
          service: `https://${localHost}:${targetPort}`,
          originRequest: this.buildOriginRequest(),
        },
        { service: 'http_status:404' },
      ])
      this.ctx.logger.info('enableCustom: tunnel ingress configured', {
        meta: {
          hostname: fqdn,
          localHost,
          localPort: targetPort,
          mode: useDefault ? 'default' : 'custom',
        },
        tags: { topic: 'tunnel', phase: 'enable-ingress' },
      })

      let dns
      const expectedCname = `${tunnel.id}.cfargotunnel.com`
      try {
        dns = await api.createDnsRecord(input.zoneId, {
          type: 'CNAME',
          name: fqdn,
          content: expectedCname,
          proxied: true,
        })
        this.ctx.logger.info('enableCustom: DNS record created', {
          meta: { recordId: dns.id, hostname: fqdn },
          tags: { topic: 'tunnel', phase: 'enable-dns-created' },
        })
      } catch (err) {
        if (err instanceof Error && /already exists/i.test(err.message)) {
          // Conflict — a CNAME for `fqdn` is already in the zone, but
          // it may point at a STALE tunnel id (root cause of CF error
          // 1033 after a tunnel-recreate). Look it up + repair when
          // mismatched, rather than blindly assuming it's correct.
          const existing = await api.findDnsRecord(input.zoneId, fqdn).catch(() => null)
          if (existing) {
            const stale = existing.type !== 'CNAME' || existing.content !== expectedCname
            if (stale) {
              this.ctx.logger.warn(
                'enableCustom: stale DNS record detected — rewriting to current tunnel id',
                {
                  meta: {
                    recordId: existing.id,
                    hostname: fqdn,
                    was: existing.content,
                    now: expectedCname,
                  },
                  tags: { topic: 'tunnel', phase: 'enable-dns-repair' },
                },
              )
              dns = await api.updateDnsRecord(input.zoneId, existing.id, {
                type: 'CNAME',
                content: expectedCname,
                proxied: true,
              })
            } else {
              dns = existing
              this.ctx.logger.info(
                'enableCustom: DNS record already points at this tunnel — keeping it',
                {
                  meta: { recordId: existing.id, hostname: fqdn },
                  tags: { topic: 'tunnel', phase: 'enable-dns-current' },
                },
              )
            }
          } else {
            this.ctx.logger.warn(
              'enableCustom: DNS conflict but record not findable — token may lack DNS:Read',
              {
                meta: { hostname: fqdn },
                tags: { topic: 'tunnel', phase: 'enable-dns-existing' },
              },
            )
            dns = { id: '', name: fqdn, content: '', type: 'CNAME' as const }
          }
        } else {
          throw err
        }
      }

      const patch: Partial<CloudflareTunnelConfig> = {
        mode: 'custom',
        // Persist `0` for default-mode so future restarts go through
        // `resolveLocalPort()` instead of pinning to the once-resolved
        // value (which would drift if CAMSTACK_PORT changes).
        localPort: useDefault ? 0 : (input.localPort ?? 0),
        customAccountId: account.id,
        customTunnelId: tunnel.id,
        customTunnelToken: tunnel.token,
        customZoneId: input.zoneId,
        customZoneName: zone.name,
        customDnsRecordId: dns.id,
        customHostname: fqdn,
      }
      await this.updateGlobalSettings(patch)

      this.ctx.logger.info('enableCustom: complete', {
        meta: { tunnelId: tunnel.id, hostname: fqdn },
        tags: { topic: 'tunnel', phase: 'enable-complete' },
      })
      return { ok: true, tunnelId: tunnel.id, hostname: fqdn }
    } catch (err) {
      this.ctx.logger.error('enableCustom: failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tunnel', phase: 'enable-error' },
      })
      throw err
    }
  }

  /**
   * Audit + cleanup tool for the well-known Cloudflare Error 1033
   * failure mode: a previous tunnel was deleted (manually from the
   * dashboard, or by a crashed enableCustom run that recreated under
   * a fresh id) but the DNS CNAME still points at the OLD id. The
   * tunnel id mismatch makes Cloudflare's edge return 1033.
   *
   * Strategy:
   *   1. Look up every `camstack`-named tunnel in the account.
   *   2. Keep the currently persisted `customTunnelId` as the active
   *      tunnel; mark every other id as stale.
   *   3. Delete every stale tunnel via the API.
   *   4. If the persisted CNAME points to a stale id, rewrite it to
   *      the active id.
   *
   * Safe to run multiple times: the deletes are idempotent (Cloudflare
   * returns 404 → we swallow it), and the DNS patch is a no-op when
   * the CNAME already matches.
   */
  private async pruneStaleTunnels(
    input: z.infer<CloudflareTunnelActions['pruneStaleTunnels']['input']>,
  ): Promise<z.infer<CloudflareTunnelActions['pruneStaleTunnels']['output']>> {
    const api = new CloudflareApi(input.token)
    const account = await api.getAccount()
    const activeId = this.config.customTunnelId || null
    const tunnels = await api.listTunnels(account.id, { name: 'camstack' })
    const stale = tunnels.filter((t) => t.id !== activeId)

    this.ctx.logger.info('pruneStaleTunnels: scan complete', {
      meta: { total: tunnels.length, activeId, staleCount: stale.length },
      tags: { topic: 'tunnel', phase: 'prune-scan' },
    })

    const deletedTunnelIds: string[] = []
    for (const t of stale) {
      try {
        await api.deleteTunnel(account.id, t.id)
        deletedTunnelIds.push(t.id)
        this.ctx.logger.info('pruneStaleTunnels: deleted stale tunnel', {
          meta: { tunnelId: t.id, name: t.name },
          tags: { topic: 'tunnel', phase: 'prune-delete' },
        })
      } catch (err) {
        this.ctx.logger.warn('pruneStaleTunnels: failed to delete tunnel — continuing', {
          meta: { tunnelId: t.id, error: err instanceof Error ? err.message : String(err) },
          tags: { topic: 'tunnel', phase: 'prune-delete-failed' },
        })
      }
    }

    // DNS repair: if a CNAME exists for the persisted hostname and points
    // at a now-deleted (or simply wrong) tunnel id, rewrite it to the
    // active tunnel id. Only attempt when we actually have an active id
    // + the persisted zone id is set.
    let dnsRepaired = false
    if (activeId && this.config.customZoneId && this.config.customHostname) {
      const fqdn = this.config.customHostname.includes('.')
        ? this.config.customHostname
        : `${this.config.customHostname}.${this.config.customZoneName}`
      const existing = await api.findDnsRecord(this.config.customZoneId, fqdn).catch(() => null)
      const expected = `${activeId}.cfargotunnel.com`
      if (existing && (existing.type !== 'CNAME' || existing.content !== expected)) {
        try {
          await api.updateDnsRecord(this.config.customZoneId, existing.id, {
            type: 'CNAME',
            content: expected,
            proxied: true,
          })
          dnsRepaired = true
          this.ctx.logger.info('pruneStaleTunnels: rewrote stale CNAME', {
            meta: { hostname: fqdn, was: existing.content, now: expected },
            tags: { topic: 'tunnel', phase: 'prune-dns-repair' },
          })
        } catch (err) {
          this.ctx.logger.warn('pruneStaleTunnels: failed to rewrite CNAME', {
            meta: { hostname: fqdn, error: err instanceof Error ? err.message : String(err) },
            tags: { topic: 'tunnel', phase: 'prune-dns-repair-failed' },
          })
        }
      }
    }

    return {
      deletedTunnelIds,
      activeTunnelId: activeId,
      dnsRepaired,
    }
  }

  private async disableCustom(): Promise<
    z.infer<CloudflareTunnelActions['disableCustom']['output']>
  > {
    const reset: Partial<CloudflareTunnelConfig> = {
      mode: 'quick',
      localHost: '',
      customAccountId: '',
      customTunnelId: '',
      customZoneId: '',
      customZoneName: '',
      customDnsRecordId: '',
      customHostname: 'camstack',
    }
    this.ctx.logger.info('disableCustom: reset to quick mode', {
      tags: { topic: 'tunnel', phase: 'disable' },
    })
    await this.updateGlobalSettings(reset)
    // '' keeps a keychain secret (D787); forgetting the tokens is explicit.
    await this.clearSecrets(['customTunnelToken', 'customApiToken'])
    return { ok: true }
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'mode',
          title: 'Tunnel Mode',
          titleKey: 'cloudflare:globalSettings.s_mode.title',
          // Auto-save every change — Start (single entry point) reads
          // persisted config; no Save button means no "filled the form
          // but forgot to commit" footguns.
          immediate: true,
          fields: [
            this.field({
              type: 'select',
              key: 'mode',
              label: 'Mode',
              labelKey: 'cloudflare:globalSettings.s_mode.mode.label',
              description:
                'Quick: random *.trycloudflare.com URL, no account. Custom: server-managed named tunnel on your own domain (requires a Cloudflare account + API token). Hit Start on the Remote Access page to launch — Custom mode auto-provisions on first start. The local hub port is auto-detected from CAMSTACK_PORT / PORT env.',
              descriptionKey: 'cloudflare:globalSettings.s_mode.mode.description',
              default: 'quick',
              options: [
                {
                  value: 'quick',
                  label: 'Quick Tunnel',
                  labelKey: 'cloudflare:globalSettings.s_mode.mode.o_quick.label',
                  description: 'Temporary public URL, no account required',
                },
                {
                  value: 'custom',
                  label: 'Custom Domain',
                  labelKey: 'cloudflare:globalSettings.s_mode.mode.o_custom.label',
                  description: 'Persistent tunnel on your own zone',
                },
              ],
            }),
            {
              type: 'addon-action-select' as const,
              key: 'localHost',
              label: 'Local Address',
              labelKey: 'cloudflare:globalSettings.s_mode.localHost.label',
              description:
                'Which local host address cloudflared should forward traffic to. "Auto" follows the local-network preferred interface — pin a specific address only when running multi-NIC or Docker sidecar setups.',
              descriptionKey: 'cloudflare:globalSettings.s_mode.localHost.description',
              // `''` = "Auto (use local-network preferred)" — first option
              // the `listLocalAddresses` handler prepends. Pinning a
              // default here means a freshly-installed addon doesn't
              // accidentally show the first probed IP as if the operator
              // had selected it.
              default: '',
              addonId: 'cloudflare-tunnel',
              action: 'listLocalAddresses',
              mapOption: {
                value: 'value',
                label: 'label',
                description: 'description',
              },
              emptyResultsMessage:
                'No local addresses available — fix the local-network cap first.',
            },
          ],
        },
        {
          id: 'custom',
          title: 'Custom Domain Setup',
          titleKey: 'cloudflare:globalSettings.s_custom.title',
          immediate: true,
          fields: [
            {
              type: 'info' as const,
              key: 'customHelp',
              label: 'How to get an API token',
              labelKey: 'cloudflare:globalSettings.s_custom.customHelp.label',
              format: 'html' as const,
              content:
                'Create a token at ' +
                '<a href="https://dash.cloudflare.com/profile/api-tokens">' +
                'dash.cloudflare.com/profile/api-tokens</a>:' +
                '<ul>' +
                '<li>Click <strong>Create Token</strong> → use the <em>Custom token</em> template.</li>' +
                '<li>Permissions: <code>Account → Cloudflare Tunnel → Edit</code> AND ' +
                '<code>Zone → DNS → Edit</code>.</li>' +
                '<li>Account Resources: <code>Include → your account</code>. ' +
                'Zone Resources: <code>Include → the zone</code> you want.</li>' +
                '<li>Continue → Create → copy the token, paste it below.</li>' +
                '</ul>',
              variant: 'info' as const,
              showWhen: { field: 'mode', equals: 'custom' },
            },
            this.field({
              type: 'password',
              key: 'customApiToken',
              label: 'Cloudflare API Token',
              labelKey: 'cloudflare:globalSettings.s_custom.customApiToken.label',
              description: 'Used to provision + manage the tunnel.',
              descriptionKey: 'cloudflare:globalSettings.s_custom.customApiToken.description',
              showToggle: true,
              showWhen: { field: 'mode', equals: 'custom' },
            }),
            {
              type: 'addon-action-select' as const,
              key: 'customZoneId',
              label: 'Zone',
              labelKey: 'cloudflare:globalSettings.s_custom.customZoneId.label',
              description: 'Pick the Cloudflare zone (root domain) the tunnel will sit on.',
              descriptionKey: 'cloudflare:globalSettings.s_custom.customZoneId.description',
              addonId: 'cloudflare-tunnel',
              action: 'listZones',
              paramsFromForm: { token: 'customApiToken' },
              refreshOn: ['customApiToken'],
              mapOption: {
                value: 'id',
                label: 'name',
                description: 'status',
              },
              emptyParamsMessage: 'Paste your API token above first.',
              emptyResultsMessage: 'Token has no zones with DNS:Edit permission.',
              showWhen: { field: 'mode', equals: 'custom' },
            },
            this.field({
              type: 'text',
              key: 'customHostname',
              label: 'Sub-domain',
              labelKey: 'cloudflare:globalSettings.s_custom.customHostname.label',
              description:
                'Sub-domain to prepend to the selected zone (e.g. "camstack" → camstack.yourdomain.com). Use "@" or empty for the apex.',
              descriptionKey: 'cloudflare:globalSettings.s_custom.customHostname.description',
              default: 'camstack',
              placeholder: 'camstack',
              showWhen: { field: 'mode', equals: 'custom' },
            }),
            this.field({
              type: 'select',
              key: 'localPortMode',
              label: 'Local port',
              labelKey: 'cloudflare:globalSettings.s_custom.localPortMode.label',
              description:
                'Default: the addon resolves the hub backend port automatically (CAMSTACK_PORT, fallback 4443 HTTPS). Pick "Custom" only when you need to forward to a non-default service.',
              descriptionKey: 'cloudflare:globalSettings.s_custom.localPortMode.description',
              default: 'default',
              options: [
                {
                  value: 'default',
                  label: 'Default (auto-detect hub port)',
                  labelKey: 'cloudflare:globalSettings.s_custom.localPortMode.o_default.label',
                  description: 'Recommended — follows CAMSTACK_PORT env / 4443',
                },
                {
                  value: 'custom',
                  label: 'Custom port',
                  labelKey: 'cloudflare:globalSettings.s_custom.localPortMode.o_custom.label',
                  description: 'Pin to a specific port — must serve HTTPS',
                },
              ],
              showWhen: { field: 'mode', equals: 'custom' },
            }),
            this.field({
              type: 'number',
              key: 'localPort',
              label: 'Port',
              labelKey: 'cloudflare:globalSettings.s_custom.localPort.label',
              description:
                'Local HTTPS port cloudflared forwards to. Must accept https:// requests (the addon adds noTLSVerify to handle the self-signed cert).',
              descriptionKey: 'cloudflare:globalSettings.s_custom.localPort.description',
              default: 0,
              placeholder: '4443',
              min: 1,
              max: 65535,
              showWhen: { field: 'localPortMode', equals: 'custom' },
            }),
            this.field({
              type: 'boolean',
              key: 'noTLSVerify',
              label: 'Skip TLS verification',
              labelKey: 'cloudflare:globalSettings.s_custom.noTLSVerify.label',
              description:
                'Cloudflared accepts the origin TLS cert without checking the CA chain. Required when the hub serves HTTPS with a self-signed cert (default for camstack).',
              descriptionKey: 'cloudflare:globalSettings.s_custom.noTLSVerify.description',
              default: true,
              showWhen: { field: 'mode', equals: 'custom' },
            }),
            this.field({
              type: 'text',
              key: 'originServerName',
              label: 'SNI override (optional)',
              labelKey: 'cloudflare:globalSettings.s_custom.originServerName.label',
              description:
                'Server Name Indication sent during the TLS handshake. Leave empty unless the origin cert is issued for a specific hostname different from the LAN address.',
              descriptionKey: 'cloudflare:globalSettings.s_custom.originServerName.description',
              default: '',
              placeholder: 'camstack.local',
              showWhen: { field: 'mode', equals: 'custom' },
            }),
            this.field({
              type: 'text',
              key: 'httpHostHeader',
              label: 'Host header override (optional)',
              labelKey: 'cloudflare:globalSettings.s_custom.httpHostHeader.label',
              description:
                'Force a specific Host header on requests forwarded to the origin. Leave empty to pass the public hostname through.',
              descriptionKey: 'cloudflare:globalSettings.s_custom.httpHostHeader.description',
              default: '',
              placeholder: 'camstack.local',
              showWhen: { field: 'mode', equals: 'custom' },
            }),
            {
              type: 'addon-action-button' as const,
              key: 'pruneStaleTunnelsAction',
              label: 'Clean up stale tunnels',
              labelKey: 'cloudflare:globalSettings.s_custom.pruneStaleTunnelsAction.label',
              description:
                'Runs an audit on the Cloudflare account: lists every "camstack"-named tunnel, deletes any that aren\'t the currently-active one, and rewrites the public CNAME if it points at a stale tunnel id. Use when the public domain returns "Cloudflare Tunnel error 1033".',
              descriptionKey:
                'cloudflare:globalSettings.s_custom.pruneStaleTunnelsAction.description',
              addonId: 'cloudflare-tunnel',
              action: 'pruneStaleTunnels',
              paramsFromForm: { token: 'customApiToken' },
              buttonLabel: 'Run cleanup',
              confirmMessage:
                'This will DELETE every camstack-named tunnel in your account except the active one, and rewrite the public CNAME. Continue?',
              variant: 'danger' as const,
              successMessage:
                'Cleanup done. Deleted {deletedTunnelIds} stale tunnel(s); DNS repaired: {dnsRepaired}.',
              showWhen: { field: 'mode', equals: 'custom' },
            },
          ],
        },
        {
          id: 'diagnostics',
          title: 'Diagnostics',
          titleKey: 'cloudflare:globalSettings.s_diagnostics.title',
          immediate: true,
          fields: [
            {
              type: 'info' as const,
              key: 'debugHelp',
              label: 'When to use',
              labelKey: 'cloudflare:globalSettings.s_diagnostics.debugHelp.label',
              format: 'html' as const,
              variant: 'warning' as const,
              content:
                'Enable to capture per-request lifecycle from cloudflared (CF edge → tunnel → origin), QUIC/HTTP2 stream timing, and protocol errors. Use to diagnose latency or stuck requests in the Lambda → tunnel → hub path. ' +
                "<strong>Toggle automatically respawns cloudflared</strong> (the tunnel drops for ~1s). Logs land in the addon's log stream — filter by <code>topic=tunnel</code>. " +
                'Leave OFF outside active debugging — output is verbose (KBs/s) and can leak request headers.',
            },
            this.field({
              type: 'boolean',
              key: 'debugLogging',
              label: 'Debug logging',
              labelKey: 'cloudflare:globalSettings.s_diagnostics.debugLogging.label',
              description:
                'Pass --loglevel debug --transport-loglevel debug to cloudflared. Respawns the tunnel.',
              descriptionKey: 'cloudflare:globalSettings.s_diagnostics.debugLogging.description',
              default: false,
            }),
            this.field({
              type: 'select',
              key: 'protocol',
              label: 'Transport protocol',
              labelKey: 'cloudflare:globalSettings.s_diagnostics.protocol.label',
              description:
                'Force the cloudflared ↔ Cloudflare-edge transport. Auto = cloudflared default (usually QUIC). HTTP/2 = fall back to TCP+TLS with HTTP/2 multiplexing, useful when QUIC stream-stall causes individual requests to queue for seconds under burst. Respawns the tunnel.',
              descriptionKey: 'cloudflare:globalSettings.s_diagnostics.protocol.description',
              default: 'auto',
              options: [
                {
                  value: 'auto',
                  label: 'Auto (cloudflared default)',
                  labelKey: 'cloudflare:globalSettings.s_diagnostics.protocol.o_auto.label',
                  description: 'Usually picks QUIC',
                },
                {
                  value: 'http2',
                  label: 'HTTP/2 (TCP)',
                  labelKey: 'cloudflare:globalSettings.s_diagnostics.protocol.o_http2.label',
                  description: 'Workaround for QUIC stream stalls under burst',
                },
                {
                  value: 'quic',
                  label: 'QUIC (HTTP/3, UDP)',
                  labelKey: 'cloudflare:globalSettings.s_diagnostics.protocol.o_quic.label',
                  description: 'Force explicit QUIC',
                },
              ],
            }),
          ],
        },
      ],
    })
  }
}
