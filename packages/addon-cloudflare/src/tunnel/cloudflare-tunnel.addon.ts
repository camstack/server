import {
  type AddonInitResult,
  BaseAddon,
  type ConfigUISchema,
  type ProviderRegistration,
  RecordIntegrationInstances,
  RevConflictError,
  defineAddonMigrations,
  integrationInstancesCapability,
  isSecretMarker,
  networkAccessCapability,
  normalizeNodeId,
  userError,
} from '@camstack/types'
import type { z } from 'zod'
import * as path from 'node:path'
import { CloudflareTunnelService, type CloudflareTunnelConfig } from './cloudflare-tunnel'
import { ensureCloudflared } from './ensure-cloudflared'
import { removeTokenFile, tokenFileIn } from './cloudflared-invocation'
import { CloudflareApi } from './cloudflare-api'
import { cloudflareTunnelActions, type CloudflareTunnelActions } from './cloudflare-actions'
import { shouldAutoStartTunnel } from './auto-start'
import {
  ADDON_MIGRATIONS,
  type CloudflareTunnelCataloguePorts,
  type CloudflareTunnelRecordState,
} from './migrations/index'
import {
  CLOUDFLARE_TUNNEL_DEFAULT_BODY,
  CLOUDFLARE_TUNNEL_RECORD_ID,
  type CloudflareTunnelBody,
  cloudflareTunnelsKind,
} from './tunnel-record-kinds'
import { DEFAULT_NODE_ORIGIN, legacySettingsOf, nodeOriginOf, settingsOf } from './tunnel-settings'

// Re-export under the conventional name so the kernel addon-loader can
// discover the catalog directly off the entry module (the manifest's
// `entry` points at this file, NOT `index.ts`, so a re-export there
// would be invisible to the hub).
export { cloudflareTunnelActions as customActions } from './cloudflare-actions'

type CloudflareTunnelAddonConfig = Readonly<Record<string, unknown>>

/**
 * Cloudflare Tunnel — exposes CamStack via Cloudflare's network.
 *
 * The connection is ONE `tunnels` record named after the addon, edited on the Remote Access
 * page through `integration-instances` (D985, D996); where the tunnel forwards to is a node
 * setting of the `network-access` cap (D986). The migrations of `./migrations` moved the old
 * settings; while one was tolerated the old keys are still read.
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
export class CloudflareTunnelAddon extends BaseAddon<CloudflareTunnelAddonConfig> {
  private service: CloudflareTunnelService | null = null
  private instances: RecordIntegrationInstances<CloudflareTunnelBody> | null = null
  /**
   * What the tunnel runs on: the record's body plus this node's origin. Until the record exists
   * (a tolerated migration, a fresh install) it is the old settings, or the defaults.
   */
  private settings: CloudflareTunnelConfig = settingsOf(
    { name: '', ...CLOUDFLARE_TUNNEL_DEFAULT_BODY },
    DEFAULT_NODE_ORIGIN,
  )
  /** The instance's own switch; an absent record reads as on (a fresh install starts quick). */
  private enabled = true
  /** Whether the settings were read at all: a read that did not answer is no operator choice. */
  private settingsLoaded = false
  private secretsWarned = false

  constructor() {
    // The addon keeps no setting of its own: the tunnel is a record and where it forwards to is
    // a node setting (D986).
    super({})
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
    // `this.settings.localPort`. Default mode auto-resolves regardless of
    // whatever value sits in `localPort` (stale data from older forms).
    if (
      this.settings.localPortMode === 'custom' &&
      this.settings.localPort &&
      this.settings.localPort > 0
    ) {
      return this.settings.localPort
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
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('cloudflare-tunnel needs ctx.records — check execution.placement (hub-only)')
    }
    await records.declare({ tunnels: cloudflareTunnelsKind })
    this.instances = new RecordIntegrationInstances(records, cloudflareTunnelsKind, {
      description: {
        role: 'services',
        instanceMode: 'single',
        kind: 'tunnels',
        canTest: false,
      },
      formSchema: () => this.tunnelForm(),
      initialBody: (name) => ({ ...CLOUDFLARE_TUNNEL_DEFAULT_BODY, name }),
      configured: (body) =>
        body.mode === 'quick' ||
        (body.customHostname.length > 0 && (body.customTunnelToken ?? '') !== ''),
      onChanged: async (id) => {
        if (id === CLOUDFLARE_TUNNEL_RECORD_ID) await this.reload()
      },
    })
    // The addon moves the old settings first, then serves the record.
    await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts()))
    await this.refresh()
    // A token file can outlive a hard kill (OOM, SIGKILL) of the previous
    // process; nothing is running yet, so drop it before anything spawns.
    removeTokenFile(tokenFileIn(this.tokenFileDir()))
    const localHost = await this.resolveLocalHost()
    this.service = new CloudflareTunnelService(
      { ...this.settings, localPort: this.resolveLocalPort(), localHost },
      this.ctx.logger,
      this.ctx.eventBus,
      () => this.resolveCloudflared(),
      this.tokenFileDir(),
    )
    this.ctx.logger.info('Cloudflare Tunnel addon initialized', {
      meta: {
        mode: this.settings.mode,
        hasCustomToken: !!this.settings.customTunnelToken,
      },
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
    // no-op because `reload` sees `wasRunning: false`.
    if (this.isRunCapable()) {
      // Fire-and-forget: any failure is already logged inside handleStart,
      // and we don't want to block `onInitialize` on a tunnel handshake.
      void this.handleStart().catch((err) => {
        this.ctx.logger.warn('boot auto-start failed (will retry on next config change)', {
          meta: { error: err instanceof Error ? err.message : String(err) },
          tags: { topic: 'tunnel', phase: 'auto-start-error' },
        })
      })
    } else if (!this.settingsLoaded) {
      this.ctx.logger.warn(
        'boot auto-start skipped — the settings did not answer; defaults are not an operator choice',
        { tags: { topic: 'tunnel', phase: 'auto-start-skipped' } },
      )
    }

    const providers: ProviderRegistration[] = [
      { capability: networkAccessCapability, provider },
      {
        capability: integrationInstancesCapability,
        provider: this.instances.toProvider(),
      },
    ]
    return {
      providers,
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
      settingsStoreReady: this.settingsLoaded && this.enabled,
      mode: this.settings.mode,
      hasCustomToken: !!this.settings.customTunnelToken,
      hasCustomHostname: !!this.settings.customHostname,
    })
  }

  protected async onShutdown(): Promise<void> {
    if (this.service) {
      await this.service.stop().catch(() => undefined)
      this.service = null
    }
  }

  /** A write to a node row of the old store (the origin) is a change of the tunnel too. */
  protected async onConfigChanged(): Promise<void> {
    await this.reload()
  }

  private reloads = 0

  private async reload(): Promise<void> {
    this.reloads += 1
    await this.refresh()
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
      { ...this.settings, localPort: this.resolveLocalPort(), localHost },
      this.ctx.logger,
      this.ctx.eventBus,
      () => this.resolveCloudflared(),
      this.tokenFileDir(),
    )
    if (this.isRunCapable()) {
      this.ctx.logger.info('config changed — (re-)spawning tunnel', {
        meta: {
          mode: this.settings.mode,
          debugLogging: this.settings.debugLogging,
        },
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
      this.settings.mode === 'custom' &&
      (!this.settings.customTunnelToken || !this.settings.customHostname.includes('.'))
    if (needsReprovision) {
      this.ctx.logger.info('start: custom mode needs (re)provisioning', {
        meta: {
          hasToken: !!this.settings.customTunnelToken,
          hostname: this.settings.customHostname,
        },
        tags: { topic: 'tunnel', phase: 'auto-provision' },
      })
      const token = this.settings.customApiToken
      const zoneId = this.settings.customZoneId
      const hostname = this.settings.customHostname
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
        localPortMode:
          this.settings.localPort && this.settings.localPort > 0 ? 'custom' : 'default',
        localPort: this.settings.localPort || undefined,
      })
    } else if (
      this.settings.mode === 'custom' &&
      this.settings.customApiToken &&
      this.settings.customAccountId &&
      this.settings.customTunnelId
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
    const out: {
      noTLSVerify?: boolean
      originServerName?: string
      httpHostHeader?: string
    } = {}
    if (this.settings.noTLSVerify === true) out.noTLSVerify = true
    if (this.settings.originServerName) out.originServerName = this.settings.originServerName
    if (this.settings.httpHostHeader) out.httpHostHeader = this.settings.httpHostHeader
    return out
  }

  /**
   * Re-PUT the tunnel ingress config from the current addon settings
   * + resolved local host/port. Called on every start so changes to
   * `localPort` / `localHost` / protocol policy (HTTPS + noTLSVerify
   * for self-signed) propagate without operator action.
   */
  private async syncCustomIngress(): Promise<void> {
    const token = this.settings.customApiToken
    const accountId = this.settings.customAccountId
    const tunnelId = this.settings.customTunnelId
    if (!token || !accountId || !tunnelId) return
    const api = new CloudflareApi(token)
    const localHost = await this.resolveLocalHost()
    const targetPort =
      this.settings.localPort && this.settings.localPort > 0
        ? this.settings.localPort
        : this.resolveLocalPort()
    const fqdn = this.settings.customHostname
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
    addresses: readonly {
      value: string
      label: string
      labelKey?: string
      description: string
    }[]
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
    const token = input.token ?? this.settings.customApiToken
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
      return {
        zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.status })),
      }
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
      meta: {
        hostname: input.hostname,
        zoneId: input.zoneId,
        localPort: input.localPort,
      },
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
        this.settings.customDnsRecordId &&
        this.settings.customZoneId &&
        this.settings.customHostname &&
        this.settings.customHostname.toLowerCase() !== fqdn.toLowerCase()
      ) {
        this.ctx.logger.info('enableCustom: removing previous DNS record (hostname changed)', {
          meta: { from: this.settings.customHostname, to: input.hostname },
          tags: { topic: 'tunnel', phase: 'enable-dns-cleanup' },
        })
        try {
          await api.deleteDnsRecord(this.settings.customZoneId, this.settings.customDnsRecordId)
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

      await this.applyConnection(
        {
          mode: 'custom',
          customAccountId: account.id,
          customTunnelId: tunnel.id,
          customTunnelToken: tunnel.token,
          customZoneId: input.zoneId,
          customZoneName: zone.name,
          customDnsRecordId: dns.id,
          customHostname: fqdn,
        },
        {
          // Persist `0` for default-mode so future restarts go through
          // `resolveLocalPort()` instead of pinning to the once-resolved
          // value (which would drift if CAMSTACK_PORT changes).
          localPort: useDefault ? 0 : (input.localPort ?? 0),
          localPortMode: useDefault ? 'default' : 'custom',
        },
      )

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
    const activeId = this.settings.customTunnelId || null
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
          meta: {
            tunnelId: t.id,
            error: err instanceof Error ? err.message : String(err),
          },
          tags: { topic: 'tunnel', phase: 'prune-delete-failed' },
        })
      }
    }

    // DNS repair: if a CNAME exists for the persisted hostname and points
    // at a now-deleted (or simply wrong) tunnel id, rewrite it to the
    // active tunnel id. Only attempt when we actually have an active id
    // + the persisted zone id is set.
    let dnsRepaired = false
    if (activeId && this.settings.customZoneId && this.settings.customHostname) {
      const fqdn = this.settings.customHostname.includes('.')
        ? this.settings.customHostname
        : `${this.settings.customHostname}.${this.settings.customZoneName}`
      const existing = await api.findDnsRecord(this.settings.customZoneId, fqdn).catch(() => null)
      const expected = `${activeId}.cfargotunnel.com`
      if (existing && (existing.type !== 'CNAME' || existing.content !== expected)) {
        try {
          await api.updateDnsRecord(this.settings.customZoneId, existing.id, {
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
            meta: {
              hostname: fqdn,
              error: err instanceof Error ? err.message : String(err),
            },
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
    this.ctx.logger.info('disableCustom: reset to quick mode', {
      tags: { topic: 'tunnel', phase: 'disable' },
    })
    // `null` removes a secret from the record and its keychain entry; forgetting the tokens is
    // explicit.
    await this.applyConnection(
      {
        mode: 'quick',
        customAccountId: '',
        customTunnelId: '',
        customZoneId: '',
        customZoneName: '',
        customDnsRecordId: '',
        customHostname: 'camstack',
        customTunnelToken: null,
        customApiToken: null,
      },
      { localHost: '' },
    )
    return { ok: true }
  }

  /** The node this addon runs on, as the scoped-settings rows name it. */
  private localNode(): string {
    return normalizeNodeId(this.ctx.kernel?.localNodeId)
  }

  /**
   * Write what the operator decided: the record fields first, then this node's origin rows.
   * The rows write reloads the tunnel itself when it changed anything; when it did not, the
   * reload is done here, so a respawn happens exactly once.
   */
  private async applyConnection(
    fields: Readonly<Record<string, unknown>>,
    origin: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const records = this.ctx.records
    if (records === undefined) throw new Error('records are not available')
    const handle = records.kind(cloudflareTunnelsKind)
    if ((await handle.get(CLOUDFLARE_TUNNEL_RECORD_ID)) === null) {
      try {
        await handle.put(
          {
            id: CLOUDFLARE_TUNNEL_RECORD_ID,
            data: {
              ...CLOUDFLARE_TUNNEL_DEFAULT_BODY,
              name: CLOUDFLARE_TUNNEL_RECORD_ID,
            },
          },
          { ifRev: 0 },
        )
      } catch (err: unknown) {
        // A concurrent first write created it: patch on top of it.
        if (!(err instanceof RevConflictError)) throw err
      }
    }
    await handle.patch(CLOUDFLARE_TUNNEL_RECORD_ID, fields)
    const node = this.localNode()
    const before = this.reloads
    // Bare keys and the node: the base stores each as `<key>@<node>` (they are the node hook's keys).
    await this.updateGlobalSettings(origin, node)
    if (this.reloads === before) await this.reload()
  }

  /**
   * Read what the tunnel runs on: the record and this node's origin; the old keys while no record
   * exists. A read that did not answer changes nothing (D49).
   */
  private async refresh(): Promise<void> {
    if (this.instances === null) return
    try {
      const row = await this.instances.readResolved(CLOUDFLARE_TUNNEL_RECORD_ID)
      if (row?.secrets === 'unavailable') {
        // A locked keychain is a failed read of the tokens: keep what the tunnel has.
        if (!this.secretsWarned) {
          this.secretsWarned = true
          this.ctx.logger.warn(
            'cloudflare-tunnel: the keychain is locked; the tunnel keeps its previous configuration',
            { tags: { topic: 'tunnel', phase: 'keychain-locked' } },
          )
        }
        return
      }
      this.secretsWarned = false
      const store = await this.resolveGlobalStore()
      const node = this.localNode()
      const origin = nodeOriginOf(store, node)
      if (origin.staleDevPort) {
        // Earlier builds let operators point the tunnel at the Vite admin-ui dev port, whose
        // host check answered "Cloudflare Tunnel error". It is read as automatic.
        this.ctx.logger.warn('localPort 3001 (Vite admin-ui dev port) is read as automatic', {
          tags: { topic: 'tunnel', phase: 'localport-stale' },
        })
      }
      this.settings = row === null ? legacySettingsOf(store, node) : settingsOf(row.body, origin)
      this.enabled = row === null ? true : row.enabled
      this.settingsLoaded = this.settingsStoreReady
    } catch (err: unknown) {
      this.ctx.logger.warn('cloudflare-tunnel: the settings could not be read; keeping the last', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tunnel', phase: 'settings-read-failed' },
      })
    }
  }

  /** The ports of the connection migrations: the old settings in, the record out. */
  private migrationPorts(): CloudflareTunnelCataloguePorts {
    const records = this.ctx.records
    if (records === undefined) throw new Error('records are not available')
    const handle = records.kind(cloudflareTunnelsKind)
    return {
      readStored: async (): Promise<Readonly<Record<string, unknown>>> => {
        const stored = await this.resolveGlobalStore()
        // A token that is still a marker was not resolved: abort before anything is written.
        if (
          isSecretMarker(stored['customApiToken']) ||
          isSecretMarker(stored['customTunnelToken'])
        ) {
          throw new Error('the old Cloudflare tunnel tokens could not be resolved')
        }
        return stored
      },
      readRawStored: async () => this.resolveGlobalStore(),
      warn: (message: string) => {
        this.ctx.logger.warn(message)
      },
      readRecord: async (): Promise<CloudflareTunnelRecordState | null> => {
        const row = await handle.getResolved(CLOUDFLARE_TUNNEL_RECORD_ID)
        if (row === null) return null
        return {
          hostname: row.data.customHostname,
          apiToken: row.data.customApiToken ?? '',
          tunnelToken: row.data.customTunnelToken ?? '',
        }
      },
      putRecord: async (body: CloudflareTunnelBody): Promise<'created' | 'exists'> => {
        if ((await handle.get(CLOUDFLARE_TUNNEL_RECORD_ID)) !== null) return 'exists'
        try {
          await handle.put({ id: CLOUDFLARE_TUNNEL_RECORD_ID, data: body }, { ifRev: 0 })
        } catch (err: unknown) {
          if (err instanceof RevConflictError) return 'exists'
          throw err
        }
        return 'created'
      },
      clearOldSecrets: async (keys) => {
        await this.clearSecrets(keys)
      },
    }
  }

  protected override scopedSettingsCapabilities(): readonly string[] {
    return ['network-access']
  }

  protected async nodeSettingsSchema(cap: string): Promise<ConfigUISchema | null> {
    if (cap !== 'network-access') return null
    return this.schema({
      sections: [
        {
          id: 'origin',
          title: 'Local origin',
          titleKey: 'cloudflare:globalSettings.s_custom.title',
          fields: [
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
          ],
        },
      ],
    })
  }

  private tunnelForm(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'mode',
          title: 'Tunnel Mode',
          titleKey: 'cloudflare:globalSettings.s_mode.title',
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
          ],
        },
        {
          id: 'custom',
          title: 'Custom Domain Setup',
          titleKey: 'cloudflare:globalSettings.s_custom.title',
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
