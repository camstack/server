/**
 * local-network — hub-only system cap implementation.
 *
 * Wraps `os.networkInterfaces()` with:
 *   - Coarse kind classification (lan/wifi/docker/vpn/loopback/other)
 *   - Auto-select heuristic for the outbound interface
 *   - Periodic poll (30s) + diff to emit `LocalNetworkChanged` events
 *     so subscribers can react to DHCP renewals, VPN connect, etc.
 *   - `getConnectionEndpoints()` — ranked URL list for SDK clients
 *
 * Does NOT poll the cloudflare-tunnel state directly; the public
 * tunnel hostname (if any) is provided by `network-access` consumers
 * via `NetworkTunnelStarted/Stopped` events on the bus, so the cap
 * stays free of cross-addon dependencies.
 */
import { readFileSync } from 'node:fs'
import * as os from 'node:os'

import type {
  AdvertisedLocalPort,
  ConfigUISchema,
  ConnectionEndpoint,
  HubAddressBook,
  HubAddresses,
  HubAddressFlags,
  HubAddressRole,
  HubAddressRoleResolution,
  HubAddressSnapshot,
  ILocalNetworkProvider,
  IMeshNetworkProvider,
  LocalInterface,
  MeshStatus,
  NotificationEndpoint,
  ProviderRegistration,
} from '@camstack/types'
import {
  BaseAddon,
  CAMSTACK_APP_LINK_ORIGIN,
  checkRoleAddress,
  errMsg,
  EventCategory,
  isAppLinkBase,
  isDefaultAppConnectionEndpoint,
  localNetworkCapability,
  NetworkTunnelStartedDataSchema,
  pickAppLinkHub,
  resolveAppConnections,
  resolveNotificationTapAddress,
  shortHostname,
  validateCustomAddress,
} from '@camstack/types'
import { applyLanHttp, DEFAULT_LAN_HTTP_PORT, readLanHttpState } from '../../http/lan-http-bind.js'
import {
  applyCertificateToListener,
  type CertOptions,
  ensureTlsCert,
  readExtraSans,
  readTlsAccessStatus,
  readTlsMode,
  regenerateCertificate,
  revertToGeneratedCertificate,
  servedHttpsLeafFingerprint,
  storeUploadedCertificate,
  useStoredUploadedCertificate,
  writeExtraSans,
} from '../../tls/index.js'
import {
  type AddressBookState,
  addressBookPatch,
  buildAddressBook,
  buildListenerOrigins,
  type CustomAddress,
  normalizeAddressBook,
  withCustomAddress,
  withoutCustomAddress,
  withRoleAutomatic,
  withRoleFlag,
  withAppConnectionCustomEndpoints,
  withLanHttpsCounterparts,
} from './address-book.js'
import {
  ipv6AllowlistMatches,
  ipv6ToHex32,
  parseProcIfInet6,
  shouldAdvertiseIpv6,
} from './ipv6-lan.js'
import { HubMdnsAdvertiser, internalUrlOf } from './hub-mdns.js'
import { createCiaoPublisher } from './hub-mdns-ciao.js'
import { parseLocalHostname } from './local-hostname.js'

/** What a change to the address book may consult. */
interface AddressChangeContext {
  readonly detectedUrls: ReadonlySet<string>
  /** The automatic app-connections set (both schemes), for a toggle while automatic. */
  readonly autoApp: readonly string[]
}

/**
 * Cached mesh-reachable endpoint, learned from the `mesh-network`
 * provider via the `MeshNetworkChanged` event-tail + pull-reconcile.
 * `null` when no mesh provider is joined / reachable.
 */
interface MeshEndpointCache {
  /** Preferred mesh host — MagicDNS name when available, else raw mesh IP. */
  readonly host: string
  /** Hub HTTPS port the mesh endpoint targets. */
  readonly port: number
}

/**
 * Forked `mesh-network` provider addon ids `local-network` pull-reconciles
 * against. `mesh-network` is a COLLECTION cap, so a hub builtin's local
 * registry can't enumerate forked providers — we resolve each by addonId
 * via `getProviderByAddon`. New mesh providers (Headscale, ZeroTier) add
 * their id here.
 */
const MESH_PROVIDER_ADDON_IDS = ['tailscale-client'] as const

interface RawIface {
  readonly name: string
  readonly family: 'IPv4' | 'IPv6'
  readonly address: string
  readonly cidr: string
  readonly netmask: string
  readonly internal: boolean
  readonly mac: string
}

const POLL_INTERVAL_MS = 30_000
/** Drop rotated IPv6 / dead extras from the persisted allowlist. */
export const ALLOWLIST_RECONCILE_INTERVAL_MS: number = 60 * 60 * 1000

/**
 * Compiled-in boot default — mirrors `CONFIG_DEFAULTS.server.port` in
 * `server/backend/src/boot/boot-config.ts`. Used only when neither the live
 * config section, the env, nor the caller says anything.
 */
const DEFAULT_HUB_PORT = 4443

/** The three places a hub listen port can be learned, most authoritative first. */
export interface ListenPortSources {
  /** `server.port` from the hub's live config section; null when unreadable. */
  readonly configured: number | null
  /** `CAMSTACK_PORT` off the environment; null when unset / unparseable. */
  readonly env: number | null
  /** The port the CALLER passed. A guess about our socket, not a fact. */
  readonly callerHint: number | null
}

interface LocalNetworkConfig {
  /** Empty = "auto" (every non-loopback / non-link-local address
   *  participates). Non-empty restricts the candidate set to only
   *  those operator-pinned addresses. */
  readonly allowedAddresses: readonly string[]
  /** Sentinel — `true` after the first-boot auto-seed runs. Lets the
   *  addon distinguish "fresh install, never touched" (false → seed
   *  with LAN/Wi-Fi addresses) from "operator explicitly cleared the
   *  allowlist" (true + empty → respect operator's choice). */
  readonly bootSeeded: boolean
  /**
   * Role flag `notificationTaps` (D709, D734): the ONE address a notification
   * TAP opens. Empty = automatic (the CamStack app link). Stored VERBATIM
   * rather than as an index into the candidate list — interfaces come and go,
   * and an index would silently re-point after a reboot. See `address-book.ts`.
   */
  readonly notificationTapUrl: string
  /** Role flag `appConnections`: the addresses the apps try. Empty = automatic. */
  readonly appConnectionUrls: readonly string[]
  /** Operator-entered custom addresses (`address-book.ts`). Parsed on read. */
  readonly customAddresses: readonly CustomAddress[]
  /** LAN HTTP listener. Default true — native apps skip the private cert. */
  readonly httpEnabled: boolean
  /** Dedicated HTTP port. Must not equal the HTTPS listen port. */
  readonly httpPort: number
  /** Operator-declared DNS name advertised instead of the raw LAN IP. Empty = none. */
  readonly localHostname: string
  /**
   * Role flag `internal`: the ONE address agents and LAN devices download
   * from. Empty = automatic.
   */
  readonly internalUrl: string
  /**
   * Role flag `publicEndpoint`: the ONE address every off-LAN URL is built on
   * (sign-in, OAuth2, passkeys, notification buttons / media / admin links).
   * Empty = automatic.
   */
  readonly publicEndpointUrl: string
  /**
   * Advertise this hub over mDNS (`_camstack._tcp`, D838) so `camstack login`
   * finds it. On by default; needs UDP 5353 multicast to reach the LAN.
   */
  readonly mdnsAdvertise: boolean
}

export class LocalNetworkAddon extends BaseAddon<LocalNetworkConfig> {
  private pollTimer: NodeJS.Timeout | null = null
  private allowlistTimer: NodeJS.Timeout | null = null
  private allowlistReconcilePending = false
  private lastSnapshotKey = ''
  /** Optional public hostname tracked from `NetworkTunnelStarted`/
   *  `Stopped` events on the bus. */
  private publicHostname = ''
  /** False for a Quick tunnel: shown in the palette, never picked automatically (D860). */
  private publicHostnameStable = true
  /**
   * Mesh-reachable endpoint (Tailscale MagicDNS / 100.x), learned from
   * the `MeshNetworkChanged` event-tail and refreshed by a pull-reconcile
   * before each `getConnectionEndpoints` build (events are lossy — D8).
   * `null` when no mesh provider is joined.
   */
  private meshEndpoint: MeshEndpointCache | null = null
  private mdns: HubMdnsAdvertiser | null = null

  constructor() {
    super({
      allowedAddresses: [],
      bootSeeded: false,
      notificationTapUrl: '',
      appConnectionUrls: [],
      customAddresses: [],
      httpEnabled: true,
      httpPort: DEFAULT_LAN_HTTP_PORT,
      localHostname: '',
      internalUrl: '',
      publicEndpointUrl: '',
      mdnsAdvertise: true,
    })
  }

  /**
   * The detected palettes, with the mesh reconciled once: `https` (what
   * `internal` and `publicEndpoint` resolve over, and the app link's `hub=`)
   * and `http` (what the app-connections race resolves over).
   */
  private async palettes(): Promise<{
    readonly http: ConnectionEndpoint[]
    readonly https: ConnectionEndpoint[]
    /** The same palettes plus the HTTPS counterpart of each plain-HTTP LAN row (D859). */
    readonly httpWithTwins: ConnectionEndpoint[]
    readonly httpsWithTwins: ConnectionEndpoint[]
  }> {
    const port = (await this.resolveAdvertisedListenPort(null)).port
    await this.reconcileMeshEndpoint()
    const http = this.endpointsNow(false, false, 'http', port)
    const https = this.endpointsNow(false, false, 'https', port)
    return {
      http,
      https,
      httpWithTwins: withLanHttpsCounterparts(http, port),
      httpsWithTwins: withLanHttpsCounterparts(https, port),
    }
  }

  /** The stored address book, normalised against what is detected now. */
  private addressState(detected: readonly ConnectionEndpoint[]): AddressBookState {
    return normalizeAddressBook(this.config, new Set(detected.map((e) => e.baseUrl)))
  }

  /** The role flags alone — they do not depend on what is detected. */
  private storedFlags(): HubAddressFlags {
    return normalizeAddressBook(this.config, new Set()).flags
  }

  /** `getAddresses`: the Addresses table and every role's answer. */
  private async addressBook(scheme: 'http' | 'https'): Promise<HubAddressBook> {
    const { http, https, httpWithTwins, httpsWithTwins } = await this.palettes()
    const state = this.addressState([...httpWithTwins, ...httpsWithTwins])
    const httpsPort = (await this.resolveAdvertisedListenPort(null)).port
    return buildAddressBook(state, {
      rowsPalette: scheme === 'http' ? httpWithTwins : httpsWithTwins,
      httpsPalette: https,
      appLink: appLinkEndpoint(),
      appLinkHub: pickAppLinkHub(https),
      listenerOrigins: this.listenerOriginsNow(state, http, httpsPort),
    })
  }

  /**
   * Apply one change to the address book and persist it, normalised (a flag
   * naming an address in no row becomes a custom address in the same write).
   */
  private async changeAddressBook(
    change: (state: AddressBookState, ctx: AddressChangeContext) => AddressBookState,
  ): Promise<void> {
    const { httpWithTwins, httpsWithTwins } = await this.palettes()
    const detected = [...httpWithTwins, ...httpsWithTwins]
    const detectedUrls = new Set(detected.map((e) => e.baseUrl))
    const before = this.addressState(detected)
    const autoApp = [
      ...new Set(detected.filter(isDefaultAppConnectionEndpoint).map((e) => e.baseUrl)),
    ]
    const changed = change(before, { detectedUrls, autoApp })
    const after = normalizeAddressBook(
      { ...addressBookPatch(changed), customAddresses: changed.custom },
      detectedUrls,
    )
    await this.updateGlobalSettings(addressBookPatch(after))
    await this.mdns?.sync()
  }

  /** The deprecated `getHubAddresses` shape, from the role resolvers. */
  private async snapshotHubAddresses(): Promise<HubAddresses> {
    const { roles } = await this.addressBook('https')
    const legacy = (r: HubAddressRoleResolution): HubAddressSnapshot => ({
      override: r.flagged,
      resolved: r.resolved,
      source: r.source === 'flagged' ? 'override' : r.source,
    })
    return { cluster: legacy(roles.internal), browser: legacy(roles.publicEndpoint) }
  }

  /**
   * Flag / unflag `baseUrl` for `role`, or (`baseUrl: null`) return the role
   * to automatic. Validated: the address must be a row (detected, custom, or
   * the app link for `notificationTaps`), never loopback, and
   * `publicEndpoint` on plain http only when accepted. A refusal stores nothing.
   */
  private async setRole(
    role: HubAddressRole,
    baseUrl: string | null,
    enabled: boolean,
    acceptInsecureHttp: boolean,
  ): Promise<void> {
    if (baseUrl === null || (baseUrl.trim() === '' && role !== 'appConnections')) {
      await this.changeAddressBook((state) => withRoleAutomatic(state, role))
      this.ctx.logger.info('local-network: address role set to automatic', { meta: { role } })
      return
    }
    let target = baseUrl.trim()
    if (enabled) {
      const check = checkRoleAddress(role, target, { acceptInsecureHttp })
      if (!check.ok) throw new Error(check.reason)
      target = check.baseUrl
    }
    await this.changeAddressBook((state, ctx) => {
      const known =
        isAppLinkBase(target) ||
        ctx.detectedUrls.has(target) ||
        state.custom.some((c) => c.baseUrl === target)
      // The deprecated `setNotificationEndpoint` always accepted a typed
      // address; the normalisation below makes it a custom address. Every
      // other role must name a row.
      if (enabled && !known && role !== 'notificationTaps') {
        throw new Error(`${target} is not in the address list — add it as a custom address first.`)
      }
      return withRoleFlag(state, role, target, enabled, ctx.autoApp)
    })
    this.ctx.logger.info('local-network: address role set', {
      meta: { role, baseUrl: target, enabled },
    })
  }

  private async notificationEndpointSnapshot(): Promise<NotificationEndpoint> {
    const resolution = resolveNotificationTapAddress(this.storedFlags())
    const port = (await this.resolveAdvertisedListenPort(null)).port
    return {
      baseUrl: resolution.flagged,
      resolved: resolution.resolved,
      appLinkHub: pickAppLinkHub(await this.buildAdvertisedEndpoints(false, false, 'https', port)),
    }
  }

  private async snapshotViewerEndpoints(): Promise<{
    baseUrls: readonly string[]
    resolved: readonly string[]
  }> {
    const palette = await this.buildAdvertisedEndpoints(
      false,
      false,
      'http',
      (await this.resolveAdvertisedListenPort(null)).port,
    )
    const resolution = resolveAppConnections(palette, this.storedFlags())
    return { baseUrls: resolution.flagged, resolved: resolution.resolved }
  }

  /**
   * Palette shown to clients: LAN IPv4, stable LAN IPv6, public, mesh, and
   * the custom addresses flagged `appConnections` (`kind: 'custom'`). The app
   * HTTP/WS race is a subset (`selectAppConnectionEndpoints`) — IPv6 stays in this
   * list because ICE/WebRTC gathers it regardless.
   */
  private async buildAdvertisedEndpoints(
    includeLoopback: boolean,
    ipv4Only: boolean,
    scheme: 'http' | 'https',
    httpsPort: number,
  ): Promise<ConnectionEndpoint[]> {
    await this.reconcileMeshEndpoint()
    const detected = withLanHttpsCounterparts(
      this.endpointsNow(includeLoopback, ipv4Only, scheme, httpsPort),
      httpsPort,
    )
    return withAppConnectionCustomEndpoints(detected, this.addressState(detected))
  }

  /**
   * Where the listeners answer, whatever the rows advertise: the HTTPS
   * listener's origin per allowlisted LAN address, the HTTP one while it is
   * on (`http` is the palette that already carries those rows).
   */
  private listenerOriginsNow(
    state: AddressBookState,
    http: readonly ConnectionEndpoint[],
    httpsPort: number,
  ): readonly string[] {
    const httpListening = this.config.httpEnabled !== false && readLanHttpState().listening
    const hostname = this.config.localHostname || null
    const localNameOrigins =
      hostname === null
        ? []
        : [
            `https://${hostname}:${httpsPort}`,
            ...(httpListening ? [`http://${hostname}:${this.resolvedHttpPort()}`] : []),
          ]
    return buildListenerOrigins({
      overHttps: this.endpointsNow(false, false, 'https', httpsPort, false),
      overHttp: httpListening ? http : [],
      custom: state.custom,
      localNameOrigins,
    })
  }

  /** The DETECTED palette from the cached interface/tunnel/mesh state. */
  private endpointsNow(
    includeLoopback: boolean,
    ipv4Only: boolean,
    scheme: 'http' | 'https',
    httpsPort: number,
    advertiseLanHttp = true,
  ): ConnectionEndpoint[] {
    const interfaces = applyAllowlist(this.enumerate(), this.config.allowedAddresses)
    const httpState = readLanHttpState()
    return buildEndpoints(
      interfaces,
      httpsPort,
      includeLoopback,
      ipv4Only,
      this.publicHostname,
      scheme,
      this.meshEndpoint,
      advertiseLanHttp
        ? {
            enabled: this.config.httpEnabled !== false,
            listening: httpState.listening,
            httpPort: this.resolvedHttpPort(),
            httpsPort,
            localHostname: this.config.localHostname || null,
          }
        : null,
      this.publicHostnameStable,
    )
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    // First-boot auto-seed: on fresh installs, pre-populate the
    // allowlist with addresses from interfaces classified as `lan` or
    // `wifi`. Operators usually want those participating; docker/vpn
    // entries stay opt-in. Loopback is not a client route.
    if (!this.config.bootSeeded) {
      const seed = autoSeedAllowlist(this.enumerate())
      await this.updateGlobalSettings({ allowedAddresses: seed, bootSeeded: true })
      this.ctx.logger.info('local-network: first-boot auto-seed', {
        meta: { addresses: seed },
      })
    }
    await this.persistReconciledAllowlist()

    const provider: ILocalNetworkProvider = {
      list: async () => ({
        interfaces: this.enumerate(),
        probedAt: Date.now(),
      }),
      getPreferred: async () =>
        pickPreferred(applyAllowlist(this.enumerate(), this.config.allowedAddresses)),
      getConnectionEndpoints: async (input) => {
        const includeLoopback = input.includeLoopback ?? false
        const scheme = input.scheme ?? 'http'
        const localPort = await this.resolveAdvertisedListenPort(input.port ?? null)
        if (input.port !== undefined && input.port !== localPort.port) {
          this.ctx.logger.info('local-network: caller port hint overridden', {
            meta: { hint: input.port, advertised: localPort.port, source: localPort.source },
          })
        }
        const endpoints = await this.buildAdvertisedEndpoints(
          includeLoopback,
          input.ipv4Only ?? false,
          scheme,
          localPort.port,
        )
        return {
          endpoints: input.includeAppLink === true ? [appLinkEndpoint(), ...endpoints] : endpoints,
          localPort,
        }
      },
      getNotificationEndpoint: async () => this.notificationEndpointSnapshot(),
      setNotificationEndpoint: async ({ baseUrl }) => {
        await this.setRole('notificationTaps', baseUrl, true, false)
        return this.notificationEndpointSnapshot()
      },
      getViewerEndpoints: async () => this.snapshotViewerEndpoints(),
      setViewerEndpoints: async ({ baseUrls }) => {
        const appConnections = [...new Set(baseUrls.filter((u) => u.length > 0))]
        await this.changeAddressBook((state) => ({
          ...state,
          flags: { ...state.flags, appConnections },
        }))
        this.ctx.logger.info('local-network: app connections set', {
          meta: { count: appConnections.length, auto: appConnections.length === 0 },
        })
        return this.snapshotViewerEndpoints()
      },
      getAddresses: async (input) => this.addressBook(input?.scheme ?? 'https'),
      addCustomAddress: async ({ baseUrl, label }) => {
        const check = validateCustomAddress(baseUrl)
        if (!check.ok) throw new Error(check.reason)
        const entry: CustomAddress = { baseUrl: check.baseUrl, label: label.trim() }
        await this.changeAddressBook((state) => withCustomAddress(state, entry))
        this.ctx.logger.info('local-network: custom address added', {
          meta: { baseUrl: entry.baseUrl, label: entry.label },
        })
        return this.addressBook('https')
      },
      removeCustomAddress: async ({ baseUrl }) => {
        await this.changeAddressBook((state) => withoutCustomAddress(state, baseUrl))
        this.ctx.logger.info('local-network: custom address removed', { meta: { baseUrl } })
        return this.addressBook('https')
      },
      setAddressRole: async ({ role, baseUrl, enabled, acceptInsecureHttp }) => {
        await this.setRole(role, baseUrl, enabled, acceptInsecureHttp === true)
        return this.addressBook('https')
      },
      getHubAddresses: async () => this.snapshotHubAddresses(),
      getAllowedAddresses: async () => ({ addresses: this.config.allowedAddresses }),
      resetAllowlistToBestMatch: async () => {
        const seed = autoSeedAllowlist(this.enumerate())
        await this.updateGlobalSettings({ allowedAddresses: seed, bootSeeded: true })
        this.ctx.logger.info('local-network: allowlist reset to auto-seed', {
          meta: { count: seed.length },
        })
        return { addresses: seed }
      },
      setAllowedAddresses: async ({ addresses }) => {
        // Validate against the current snapshot — drop anything that
        // doesn't actually exist on this host. Prevents an admin from
        // saving a typo'd address that would then silently filter out
        // every real candidate.
        const known = new Set(this.enumerate().map((i) => i.address))
        const cleaned: readonly string[] = [...new Set(addresses)].filter((a) => known.has(a))
        await this.updateGlobalSettings({ allowedAddresses: cleaned })
        this.ctx.logger.info('local-network: allowlist updated', {
          meta: { count: cleaned.length, dropped: addresses.length - cleaned.length },
        })
        return { success: true as const }
      },
      getTlsStatus: async () => this.snapshotTls(),
      regenerateCertificate: async (_input) => {
        const extraSans = [...readExtraSans(this.tlsDataDir())]
        await regenerateCertificate(this.tlsDataDir(), { extraSans, ...(await this.caHubName()) })
        this.putCertificateOnListener('regenerate')
        return this.snapshotTls()
      },
      uploadCertificate: async ({ certPem, keyPem, caPem }) => {
        await storeUploadedCertificate(this.tlsDataDir(), { certPem, keyPem, caPem })
        this.putCertificateOnListener('upload')
        return this.snapshotTls()
      },
      useStoredUploadedCertificate: async () => {
        await useStoredUploadedCertificate(this.tlsDataDir())
        this.putCertificateOnListener('upload')
        return this.snapshotTls()
      },
      downloadCa: async () => {
        const pem = this.snapshotTls().caCertPem ?? ''
        return { pem }
      },
      revertToGeneratedCertificate: async () => {
        const extraSans = [...readExtraSans(this.tlsDataDir())]
        await revertToGeneratedCertificate(this.tlsDataDir(), {
          extraSans,
          ...(await this.caHubName()),
        })
        this.putCertificateOnListener('revert')
        return this.snapshotTls()
      },
    }

    // Seed the snapshot key so the first poll doesn't fire a false
    // change event on boot.
    this.lastSnapshotKey = snapshotKey(this.enumerate())

    this.pollTimer = setInterval(() => this.detectChanges(), POLL_INTERVAL_MS)
    this.pollTimer.unref?.()
    this.allowlistTimer = setInterval(() => {
      void this.persistReconciledAllowlist()
    }, ALLOWLIST_RECONCILE_INTERVAL_MS)
    this.allowlistTimer.unref?.()

    // Track the active public hostname by tailing the network-access
    // lifecycle events that every tunnel provider already emits. We
    // can't import cross-package so the parsing stays defensive.
    this.ctx.eventBus?.subscribe({ category: EventCategory.NetworkTunnelStarted }, (event) => {
      const parsed = NetworkTunnelStartedDataSchema.safeParse(event.data ?? {})
      if (parsed.success) {
        const data = parsed.data
        try {
          const hostname = new URL(data.url).hostname
          // Ignore the pre-FQDN placeholders the tunnel emits before
          // cloudflared's stdout reports the real *.trycloudflare.com.
          if (hostname && !hostname.endsWith('.placeholder') && !hostname.startsWith('pending.')) {
            this.setPublicHostname(hostname, data.stable !== false)
          }
        } catch {
          // Malformed URL — leave the cached hostname as-is.
        }
      }
    })
    this.ctx.eventBus?.subscribe({ category: EventCategory.NetworkTunnelStopped }, () =>
      this.setPublicHostname(''),
    )

    // Track the mesh-reachable host (Tailscale MagicDNS / 100.x) by
    // tailing the `MeshNetworkChanged` event a `mesh-network` provider
    // emits on join / leave / IP change — mirrors the tunnel-hostname
    // pattern above. Cross-package import-free; the cache is also
    // pull-reconciled before each endpoint build (events are lossy — D8).
    this.ctx.eventBus?.subscribe({ category: EventCategory.MeshNetworkChanged }, (event) => {
      const data = (event.data ?? {}) as { host?: unknown; port?: unknown }
      const host = typeof data.host === 'string' ? data.host : ''
      const port = typeof data.port === 'number' ? data.port : 0
      this.setMeshEndpoint(host && port > 0 ? { host, port } : null)
    })

    this.ctx.logger.info('local-network initialized', {
      meta: { interfaceCount: this.enumerate().length },
    })

    try {
      await this.applyLanAccessFromSettings()
    } catch (err: unknown) {
      this.ctx.logger.warn('local-network: LAN HTTP not applied at boot', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }

    await this.applyMdnsAdvertisement()

    return [{ capability: localNetworkCapability, provider }]
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'local-access',
          title: 'LAN HTTP',
          titleKey: 'server:globalSettings.s_local-access.title',
          description:
            'Native apps on this Wi-Fi use http:// and skip the private certificate. The tunnel and this admin UI stay on HTTPS. Turn off once a publicly-trusted certificate covers the LAN name.',
          descriptionKey: 'server:globalSettings.s_local-access.description',
          columns: 1,
          fields: [
            this.field({
              type: 'boolean',
              key: 'httpEnabled',
              label: 'Enable HTTP on the LAN',
              labelKey: 'server:globalSettings.s_local-access.httpEnabled.label',
              style: 'switch',
              default: true,
            }),
            this.field({
              type: 'number',
              key: 'httpPort',
              label: 'HTTP port',
              labelKey: 'server:globalSettings.s_local-access.httpPort.label',
              description: 'Dedicated listener. Must not equal the HTTPS port (4443 by default).',
              descriptionKey: 'server:globalSettings.s_local-access.httpPort.description',
              min: 1,
              max: 65535,
              step: 1,
              default: DEFAULT_LAN_HTTP_PORT,
              showWhen: { field: 'httpEnabled', equals: true },
            }),
            this.field({
              type: 'boolean',
              key: 'mdnsAdvertise',
              label: 'Announce this hub on the LAN (mDNS)',
              labelKey: 'server:globalSettings.s_local-access.mdnsAdvertise.label',
              description:
                'Lets `camstack login` find the hub without an address. Advertises only the HTTPS address, never a secret. Needs UDP 5353 multicast to reach the LAN (host networking or a dedicated container IP).',
              descriptionKey: 'server:globalSettings.s_local-access.mdnsAdvertise.description',
              style: 'switch',
              default: true,
            }),
            this.field({
              type: 'text',
              key: 'localHostname',
              label: 'Local hostname',
              labelKey: 'server:globalSettings.s_local-access.localHostname.label',
              description:
                'Advertised to the viewer instead of the raw LAN IP, and added to the certificate SAN. Requires this name to resolve on the LAN (router DNS, mDNS, or a hosts file). Leave empty to keep using the IP.',
              descriptionKey: 'server:globalSettings.s_local-access.localHostname.description',
              maxLength: 253,
              placeholder: 'camstack.lan',
            }),
          ],
        },
      ],
    })
  }

  protected override async onConfigChanged(): Promise<void> {
    await this.applyLanAccessFromSettings()
    await this.applyMdnsAdvertisement()
  }

  /**
   * Start, re-announce or stop the hub's mDNS service (D838). Never throws:
   * the advertiser logs its own failures and boot goes on.
   */
  private async applyMdnsAdvertisement(): Promise<void> {
    if (this.config.mdnsAdvertise === false) {
      await this.mdns?.stop()
      return
    }
    if (this.mdns === null) {
      this.mdns = new HubMdnsAdvertiser({
        publisher: createCiaoPublisher(),
        logger: this.ctx.logger,
        nodeId: this.ctx.kernel.localNodeId ?? 'hub',
        version: null,
        readInternalUrl: async () => internalUrlOf(await this.addressBook('https')),
      })
    }
    await this.mdns.start()
  }

  protected async onShutdown(): Promise<void> {
    await this.mdns?.stop()
    this.mdns = null
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.allowlistTimer) {
      clearInterval(this.allowlistTimer)
      this.allowlistTimer = null
    }
  }

  /**
   * Other hub addons (e.g. cloudflare-tunnel) signal the active public
   * FQDN by emitting `NetworkTunnelStarted` on the bus — handled in
   * `onInitialize`. This setter exists for tests + future direct
   * callers; cleared by passing an empty string.
   */
  setPublicHostname(hostname: string, stable = true): void {
    if (this.publicHostname === hostname && this.publicHostnameStable === stable) return
    this.publicHostname = hostname
    this.publicHostnameStable = stable
    this.ctx.logger.info('local-network: public hostname updated', {
      meta: { hostname: hostname || '(cleared)', stable },
    })
  }

  /**
   * Replace the cached mesh endpoint. Set from the `MeshNetworkChanged`
   * event-tail + the pull-reconcile; exposed for tests + future direct
   * callers. Pass `null` to clear (mesh left / no provider joined).
   */
  setMeshEndpoint(endpoint: MeshEndpointCache | null): void {
    const prev = this.meshEndpoint
    const same = prev?.host === endpoint?.host && prev?.port === endpoint?.port
    if (same) return
    this.meshEndpoint = endpoint
    this.ctx.logger.info('local-network: mesh endpoint updated', {
      meta: { host: endpoint?.host || '(cleared)', port: endpoint?.port ?? 0 },
    })
  }

  /**
   * Refresh the cached mesh endpoint from the authoritative forked
   * `mesh-network` provider(s). `mesh-network` is a COLLECTION cap on a
   * forked addon, so the hub builtin can't see it via `ctx.api` /
   * `getCollectionEntries` — we resolve each provider by addonId through
   * the hub-side `capabilityRegistry.getProviderByAddon` resolver (the
   * same mechanism `device-manager` uses for cross-process exporter
   * contributions). Best-effort: a provider that's absent / errors /
   * not joined simply contributes nothing.
   */
  private async reconcileMeshEndpoint(): Promise<void> {
    const registry = this.ctx.kernel.capabilityRegistry
    if (!registry) return
    for (const addonId of MESH_PROVIDER_ADDON_IDS) {
      const provider = registry.getProviderByAddon<IMeshNetworkProvider>('mesh-network', addonId)
      if (!provider) continue
      try {
        const status: MeshStatus = await provider.getStatus()
        if (!status.joined) {
          this.setMeshEndpoint(null)
          continue
        }
        // Prefer MagicDNS (cert-matching) over the raw 100.x IP.
        const host = status.magicDnsHostname || status.meshIp
        // Pull the hub port off the provider's stamped mesh endpoints
        // (Part 1) so the two sources can't drift; fall back to the
        // magicdns/mesh-ipv4 entry's port.
        const stamped =
          status.endpoints.find((e) => e.id === 'magicdns') ??
          status.endpoints.find((e) => e.id === 'mesh-ipv4')
        const port = stamped?.port ?? 0
        this.setMeshEndpoint(host && port > 0 ? { host, port } : null)
        // First joined provider wins — a host joins exactly one mesh.
        return
      } catch (err: unknown) {
        this.ctx.logger.debug('local-network: mesh reconcile skipped', {
          meta: { addonId, error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  private resolvedHttpPort(): number {
    const port = this.config.httpPort
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_LAN_HTTP_PORT
  }

  private tlsDataDir(): string {
    return this.ctx.nodeDataDir ?? this.ctx.dataDir
  }

  /**
   * The hub's name (D861) for a local root this action may CREATE (an existing root is
   * never renamed). Hub only: on an agent the hub's name would mislabel the agent's own
   * material, so it gets the plain name. A failed read falls back to the machine
   * hostname (what the hub shows when unnamed) and says so: a certificate action must
   * not fail over a label.
   */
  private async caHubName(): Promise<Pick<CertOptions, 'hubName'>> {
    if ((this.ctx.kernel.localNodeId ?? 'hub') !== 'hub') return {}
    try {
      return { hubName: (await this.ctx.api.system.info.query()).serverName.name }
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'local-network: server name unreadable - naming the CA after the hostname',
        {
          meta: { error: errMsg(err) },
        },
      )
      return { hubName: shortHostname(os.hostname()) }
    }
  }

  private snapshotTls() {
    const status = readTlsAccessStatus(this.tlsDataDir(), servedHttpsLeafFingerprint())
    return { ...status, sans: [...status.sans] }
  }

  /**
   * Hot-swap the HTTPS listener onto the pair now on disk. A failure is not
   * thrown — the files are already written and the status reports
   * `restartRequired` from the served-vs-disk fingerprints — but it is logged:
   * a certificate change that did not reach the listener must say so.
   */
  private putCertificateOnListener(action: 'regenerate' | 'upload' | 'revert' | 'hostname'): void {
    const outcome = applyCertificateToListener(this.tlsDataDir())
    if (outcome.kind === 'reloaded') {
      this.ctx.logger.info('local-network: HTTPS listener now serves the new certificate', {
        meta: { action, leafFingerprintSha256: outcome.servedLeafFingerprint },
      })
      return
    }
    this.ctx.logger.warn('local-network: certificate changed on disk but NOT on the listener', {
      meta: {
        action,
        reason: outcome.kind,
        ...(outcome.kind === 'failed' ? { error: outcome.error } : {}),
      },
    })
  }

  /**
   * Bind or unbind the LAN HTTP sibling from the addon's own settings, and
   * keep the leaf SAN in sync with `localHostname`. This is the settings
   * side-effect path — there is no second persist API.
   */
  private async applyLanAccessFromSettings(): Promise<void> {
    const parsed = parseLocalHostname(this.config.localHostname ?? '')
    if (!parsed.ok) throw new Error(parsed.error)
    const hostname = parsed.value ?? ''
    const httpsPort = (await this.resolveAdvertisedListenPort(null)).port
    const httpPort = this.resolvedHttpPort()
    if (this.config.httpEnabled !== false && httpPort === httpsPort) {
      throw new Error(`HTTP port ${httpPort} cannot equal the HTTPS listen port`)
    }
    await applyLanHttp({
      enabled: this.config.httpEnabled !== false,
      port: httpPort,
      host: '0.0.0.0',
    })
    if (hostname !== '') {
      writeExtraSans(this.tlsDataDir(), [hostname])
      if (readTlsMode(this.tlsDataDir()) === 'generated') {
        // Runs at init too, before `system.info` is up: the hostname, as at boot.
        const ensured = await ensureTlsCert(this.tlsDataDir(), {
          extraSans: [hostname],
          hubName: shortHostname(os.hostname()),
        })
        if (ensured.generated) this.putCertificateOnListener('hostname')
      }
    } else {
      writeExtraSans(this.tlsDataDir(), [])
    }
  }

  /**
   * The port this hub is actually listening on, plus the provenance of the
   * number. The boot loader merges the `CAMSTACK_PORT` env override into the
   * persisted `server` section (`server/backend/src/boot/boot-config.ts`), so
   * reading that section gives the authoritative live port — no new setting,
   * and the same source `tailscale-client` already stamps its mesh endpoints
   * from, so the two cannot drift.
   */
  private async resolveAdvertisedListenPort(
    callerHint: number | null,
  ): Promise<AdvertisedLocalPort> {
    const envRaw = Number.parseInt(process.env['CAMSTACK_PORT'] ?? '', 10)
    return resolveAdvertisedPort({
      configured: await this.readConfiguredPort(),
      env: Number.isNaN(envRaw) ? null : envRaw,
      callerHint,
    })
  }

  /** `server.port` from the live config section, or null when unreadable. */
  private async readConfiguredPort(): Promise<number | null> {
    const settings = this.ctx.settings
    if (!settings) return null
    try {
      const server = await settings.getSection('server')
      const raw = server['port']
      if (typeof raw === 'number') return raw
      if (typeof raw === 'string') {
        const parsed = Number.parseInt(raw, 10)
        return Number.isNaN(parsed) ? null : parsed
      }
      return null
    } catch (err: unknown) {
      // Never silent: an unreadable section demotes every LAN candidate this
      // hub advertises from "verified" to "hint", and a client acts on that.
      this.ctx.logger.warn('local-network: could not read server.port', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  private enumerate(): readonly LocalInterface[] {
    return enumerateOsInterfaces(os.networkInterfaces(), readLinuxIpv6Flags())
  }

  /**
   * Replace rotated IPv6 and drop addresses that no longer exist, without
   * clearing operator extras that are still live (docker/vpn opt-in).
   */
  private async persistReconciledAllowlist(
    interfaces: readonly LocalInterface[] = this.enumerate(),
  ): Promise<void> {
    if (this.allowlistReconcilePending) return
    this.allowlistReconcilePending = true
    try {
      const next = reconcileAllowlist(this.config.allowedAddresses, interfaces)
      if (sameAddressSet(this.config.allowedAddresses, next)) return
      await this.updateGlobalSettings({ allowedAddresses: next, bootSeeded: true })
      this.ctx.logger.info('local-network: allowlist reconciled', {
        meta: { addresses: next },
      })
    } finally {
      this.allowlistReconcilePending = false
    }
  }

  private detectChanges(): void {
    const interfaces = this.enumerate()
    const key = snapshotKey(interfaces)
    if (key === this.lastSnapshotKey) return

    this.ctx.logger.info('local-network: interface set changed', {
      meta: { count: interfaces.length, key },
    })
    this.lastSnapshotKey = key

    void this.persistReconciledAllowlist(interfaces)
    void this.mdns?.sync()

    this.ctx.eventBus?.emit({
      id: `local-network-changed-${Date.now()}`,
      timestamp: new Date(),
      source: { type: 'core', id: 'local-network' },
      category: EventCategory.LocalNetworkChanged,
      data: { count: interfaces.length },
    })
  }
}

// ── Pure helpers (exported for tests + reusable by other consumers) ──

/**
 * Pick the port to advertise, and say where it came from.
 *
 * The caller's hint ranks BELOW everything the hub knows about itself and above
 * nothing but the compiled default — it is kept only so a client written
 * against the old echoing contract behaves exactly as it did before, and it is
 * labelled `caller-hint` so that client's successor can refuse to trust it.
 * Values outside the valid port range are dropped rather than advertised: a
 * malformed `server.port` must fall through to the next source, not produce a
 * URL nothing can bind.
 */
export function resolveAdvertisedPort(sources: ListenPortSources): AdvertisedLocalPort {
  const configured = validPort(sources.configured)
  if (configured !== null) return { port: configured, source: 'server-config' }
  const env = validPort(sources.env)
  if (env !== null) return { port: env, source: 'server-env' }
  const hint = validPort(sources.callerHint)
  if (hint !== null) return { port: hint, source: 'caller-hint' }
  return { port: DEFAULT_HUB_PORT, source: 'default' }
}

function validPort(value: number | null): number | null {
  if (value === null) return null
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null
}

/**
 * Lift `os.networkInterfaces()` into our `LocalInterface[]` shape with
 * kind classification + preferred flag. Pure — takes the raw result so
 * tests can feed synthetic data.
 */
interface OsNetworkInterfaceInfo {
  readonly family: string
  readonly address: string
  readonly cidr?: string | null
  readonly netmask: string
  readonly internal: boolean
  readonly mac: string
}

export function enumerateOsInterfaces(
  ifaces: NodeJS.Dict<readonly OsNetworkInterfaceInfo[]>,
  ipv6Flags?: ReadonlyMap<string, number>,
): readonly LocalInterface[] {
  const raw: RawIface[] = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    for (const a of addrs) {
      if (a.family !== 'IPv4' && a.family !== 'IPv6') continue
      raw.push({
        name,
        family: a.family,
        address: a.address,
        cidr: a.cidr ?? '',
        netmask: a.netmask,
        internal: a.internal,
        mac: a.mac,
      })
    }
  }

  const classified: LocalInterface[] = raw.map((r) => {
    const kind = classifyKind(r.name, r.address, r.internal)
    // "Plausible" = passes the RFC range gate AND comes from an
    // interface kind a client could realistically reach. Operators
    // can still pin a docker / vpn address — we just mark it visually
    // so the choice is intentional.
    const reachableKind = kind === 'lan' || kind === 'wifi'
    const hex = r.family === 'IPv6' ? ipv6ToHex32(r.address) : null
    const flags = hex !== null ? ipv6Flags?.get(hex) : undefined
    const rangeOk = isPlausibleAutoSeed(r.address, r.family)
    const stableV6 = r.family !== 'IPv6' || shouldAdvertiseIpv6(r.address, flags)
    const plausible = !r.internal && reachableKind && rangeOk && stableV6
    const plausibleReason = plausible
      ? ''
      : r.family === 'IPv6' && rangeOk && !stableV6
        ? 'IPv6 temporary / privacy address — rotates and is not advertised.'
        : explainNonPlausible({ kind, family: r.family, address: r.address, internal: r.internal })
    return {
      name: r.name,
      family: r.family,
      address: r.address,
      cidr: r.cidr,
      netmask: r.netmask,
      internal: r.internal,
      mac: r.mac,
      kind,
      preferred: false,
      plausible,
      plausibleReason,
    }
  })

  const preferred = pickPreferred(classified)
  return classified.map((iface) => ({
    ...iface,
    preferred:
      preferred !== null && iface.name === preferred.name && iface.address === preferred.address,
  }))
}

/**
 * Filter the interface list by the operator's allowlist. Empty
 * allowlist = no-op (every interface passes); otherwise only entries
 * whose `address` matches an allowlist entry remain. IPv6 matches the
 * allowlisted /64 so a rotated privacy address does not hide the live
 * GUA. Loopback is not an advertised client route and is not forced
 * through.
 */
export function applyAllowlist(
  interfaces: readonly LocalInterface[],
  allowed: readonly string[],
): readonly LocalInterface[] {
  if (allowed.length === 0) return interfaces
  return interfaces.filter(
    (i) => ipv6AllowlistMatches(i.address, allowed) || allowed.includes(i.address),
  )
}

/**
 * Rank interfaces and pick the auto-selected outbound one. See the
 * cap's `getPreferred` doc for the heuristic.
 */
export function pickPreferred(interfaces: readonly LocalInterface[]): LocalInterface | null {
  const candidates = interfaces.filter(
    (i) =>
      !i.internal &&
      i.family === 'IPv4' &&
      !i.address.startsWith('169.254.') && // RFC 3927 link-local
      i.kind !== 'loopback',
  )
  if (candidates.length === 0) return null

  const kindRank: Record<LocalInterface['kind'], number> = {
    lan: 1,
    wifi: 2,
    vpn: 3,
    docker: 4,
    other: 5,
    loopback: 99,
  }
  const sorted = [...candidates].toSorted((a, b) => {
    const ra = kindRank[a.kind]
    const rb = kindRank[b.kind]
    if (ra !== rb) return ra - rb
    // Tie-break on netmask length — `/24` beats `/16`.
    return prefixLen(b.netmask) - prefixLen(a.netmask)
  })
  return sorted[0] ?? null
}

/**
 * Build the ordered candidate URL list. Priority schema:
 *   0       — preferred LAN IPv4 (or local hostname)
 *   10+     — other LAN IPv4 and stable LAN IPv6
 *   100     — public tunnel hostname (always HTTPS)
 *   150     — mesh endpoint (Tailscale MagicDNS / 100.x, always HTTPS)
 *   1000    — loopback (last resort)
 *
 * The mesh endpoint ranks just below a true public funnel (a Funnel is
 * reachable by ANY client; the mesh needs the peer on the same tailnet)
 * but above loopback. LAN IPv6 sits in the LAN band with IPv4 so a
 * dual-stack client can win the race on IPv6 when it is faster.
 *
 * `scheme` controls loopback URLs and, when LAN HTTP is off, LAN URLs.
 * When {@link LanHttpAdvertisement} is enabled and listening, LAN (and
 * the local-hostname alias) switch to `http://…:httpPort` so a native
 * client can skip the private certificate. Public tunnel + mesh always
 * emit `https://`. Loopback stays on `scheme`/`port` — it is not a LAN
 * candidate.
 */
export interface LanHttpAdvertisement {
  readonly enabled: boolean
  readonly listening: boolean
  readonly httpPort: number
  readonly httpsPort: number
  readonly localHostname: string | null
}

/**
 * The CamStack app link as a palette entry (D709): the one address on the
 * Network page that is not this hub's. Flagging it for notifications (the
 * default) makes viewer taps open the native app, with the hub carried as
 * `hub=`. `kind: 'app-link'` keeps it out of every race and ranking; it is
 * only emitted on `includeAppLink: true`.
 */
export function appLinkEndpoint(): ConnectionEndpoint {
  return {
    label: 'CamStack app link',
    baseUrl: CAMSTACK_APP_LINK_ORIGIN,
    kind: 'app-link',
    interfaceKind: 'public',
    plausible: true,
    plausibleReason: '',
    priority: -1,
  }
}

export function buildEndpoints(
  interfaces: readonly LocalInterface[],
  port: number,
  includeLoopback: boolean,
  ipv4Only: boolean,
  publicHostname: string,
  scheme: 'http' | 'https' = 'http',
  meshEndpoint: MeshEndpointCache | null = null,
  lanHttp: LanHttpAdvertisement | null = null,
  publicHostnameStable = true,
): ConnectionEndpoint[] {
  const out: ConnectionEndpoint[] = []
  let priority = 0
  const preferred = pickPreferred(interfaces)
  const httpLan = lanHttp?.enabled === true && lanHttp.listening === true
  const lanScheme: 'http' | 'https' = httpLan ? 'http' : scheme
  const lanPort = httpLan ? lanHttp.httpPort : port

  const emit = (
    iface: LocalInterface,
    kind: ConnectionEndpoint['kind'],
    label: string,
    baseUrl: string,
    pri: number,
  ): void => {
    out.push({
      label,
      baseUrl,
      kind,
      interfaceKind: iface.kind,
      plausible: iface.plausible,
      plausibleReason: iface.plausibleReason,
      priority: pri,
    })
  }

  if (httpLan && lanHttp.localHostname) {
    out.push({
      label: 'Local name',
      baseUrl: `${lanScheme}://${lanHttp.localHostname}:${lanPort}`,
      kind: 'lan-ipv4',
      interfaceKind: 'lan',
      plausible: true,
      plausibleReason: '',
      priority: priority++,
    })
  }

  if (preferred) {
    emit(
      preferred,
      'lan-ipv4',
      `${formatKind(preferred.kind)} — ${preferred.name}`,
      `${lanScheme}://${preferred.address}:${lanPort}`,
      priority++,
    )
  }

  for (const iface of interfaces) {
    if (iface.internal || iface.family !== 'IPv4') continue
    if (iface.kind === 'loopback') continue
    if (preferred && iface.name === preferred.name && iface.address === preferred.address) continue
    if (iface.address.startsWith('169.254.')) continue
    emit(
      iface,
      'lan-ipv4',
      `${formatKind(iface.kind)} — ${iface.name}`,
      `${lanScheme}://${iface.address}:${lanPort}`,
      10 + priority++,
    )
  }

  if (!ipv4Only) {
    for (const iface of interfaces) {
      if (iface.internal || iface.family !== 'IPv6') continue
      if (iface.kind === 'loopback') continue
      if (iface.address.toLowerCase().startsWith('fe80:')) continue
      if (!iface.plausible) continue
      emit(
        iface,
        'lan-ipv6',
        `${formatKind(iface.kind)} — ${iface.name} (IPv6)`,
        `${lanScheme}://[${iface.address}]:${lanPort}`,
        10 + priority++,
      )
    }
  }

  if (publicHostname) {
    out.push({
      label: publicHostnameStable ? 'Public tunnel' : 'Public tunnel (temporary address)',
      baseUrl: `https://${publicHostname}`,
      kind: 'public',
      interfaceKind: 'public',
      plausible: true,
      plausibleReason: '',
      priority: 100,
      ...(publicHostnameStable ? {} : { stable: false }),
    })
  }

  if (meshEndpoint && meshEndpoint.host) {
    // Mesh (Tailscale MagicDNS / 100.x). Surfaced as the `'public'` kind
    // (a remote-reach base URL the SDK can race) with `interfaceKind:
    // 'vpn'` so the admin UI badges it distinctly — no cap-schema change,
    // no codegen. Always HTTPS: the hub terminates TLS and the MagicDNS
    // name matches its SAN cert (a raw 100.x would mismatch — that's why
    // the provider ranks MagicDNS first). Ranked at 150 — below a true
    // public funnel (100), above loopback.
    out.push({
      label: 'Mesh (Tailscale)',
      baseUrl: `https://${meshEndpoint.host}:${meshEndpoint.port}`,
      kind: 'public',
      interfaceKind: 'vpn',
      plausible: true,
      plausibleReason: '',
      priority: 150,
    })
  }

  if (includeLoopback) {
    out.push({
      label: 'Loopback',
      baseUrl: `${scheme}://127.0.0.1:${port}`,
      kind: 'loopback',
      interfaceKind: 'loopback',
      plausible: false,
      plausibleReason: 'Loopback — last-resort fallback when no other endpoint responds.',
      priority: 1000,
    })
  }

  return out.toSorted((a, b) => a.priority - b.priority)
}

/**
 * First-boot heuristic: which addresses should the allowlist start
 * with? Includes LAN + Wi-Fi IPv4 addresses + plausible IPv6:
 *
 *   - **IPv4**: skip link-local (`169.254.*`), keep the rest.
 *   - **IPv6**: skip link-local (`fe80::*`), unspecified, and
 *     multicast. Keep ULAs (`fc00::/7`) and Global Unicast (`2000::/3`).
 *     Privacy-extension temporary addresses are skipped when Linux flags
 *     mark them non-permanent (`plausible === false`).
 *
 * Skips docker/vpn/loopback/other entirely — those stay opt-in.
 */
export function autoSeedAllowlist(interfaces: readonly LocalInterface[]): string[] {
  return [
    ...new Set(
      interfaces
        .filter(
          (i) =>
            !i.internal &&
            (i.kind === 'lan' || i.kind === 'wifi') &&
            isPlausibleAutoSeed(i.address, i.family) &&
            (i.family !== 'IPv6' || i.plausible),
        )
        .map((i) => i.address),
    ),
  ]
}

/**
 * Per-interface tooltip text surfaced on the "Unlikely usable" badge.
 * Server-side so the UI doesn't re-derive the rationale (single source
 * of truth). Returns `''` for plausible entries; the addon overlays
 * this on the `LocalInterface.plausibleReason` field.
 */
export function explainNonPlausible(input: {
  readonly kind: LocalInterface['kind']
  readonly family: 'IPv4' | 'IPv6'
  readonly address: string
  readonly internal: boolean
}): string {
  if (input.internal) return 'Internal interface (loopback) — not reachable from clients.'
  if (input.kind === 'docker')
    return 'Docker bridge — only reachable from inside the container network.'
  if (input.kind === 'vpn') return 'VPN tunnel — only reachable while the VPN is connected.'
  if (input.kind === 'other')
    return 'Unrecognised interface kind — verify reachability before pinning.'
  if (input.family === 'IPv6') {
    const a = input.address.toLowerCase()
    if (a.startsWith('fe80:'))
      return 'IPv6 link-local — only reachable on the same link, not routed.'
    if (a.startsWith('ff')) return 'IPv6 multicast — not a unicast address.'
    if (a === '::' || a === '::1') return 'IPv6 loopback / unspecified — not a public address.'
    return 'IPv6 address outside the ULA / GUA ranges — verify before pinning.'
  }
  if (input.address.startsWith('169.254.'))
    return 'IPv4 link-local (RFC 3927) — only valid when DHCP fails.'
  return 'Address looks unusual for client traffic — verify before pinning.'
}

/**
 * Per-address gate used by `autoSeedAllowlist`. Exposed for tests so
 * we can pin every classification rule without standing up the addon.
 */
export function isPlausibleAutoSeed(address: string, family: 'IPv4' | 'IPv6'): boolean {
  if (family === 'IPv4') {
    if (address.startsWith('169.254.')) return false // RFC 3927 link-local
    return true
  }
  // IPv6 — normalise to lower-case once.
  const a = address.toLowerCase()
  if (a === '::' || a === '::1') return false
  if (a.startsWith('fe80:')) return false // link-local
  if (a.startsWith('ff')) return false // multicast (ff00::/8)
  // ULA (fc00::/7 → first hex group starts with `fc` or `fd`).
  if (/^f[cd][0-9a-f]{0,2}:/.test(a)) return true
  // GUA (2000::/3 → first nibble 2 or 3).
  if (/^[23][0-9a-f]{0,3}:/.test(a)) return true
  // Anything else (deprecated / experimental ranges) — leave opt-in.
  return false
}

export function classifyKind(
  name: string,
  address: string,
  internal: boolean,
): LocalInterface['kind'] {
  if (internal || name === 'lo' || name.startsWith('lo')) return 'loopback'
  const n = name.toLowerCase()
  if (n.startsWith('docker') || n.startsWith('br-') || n.startsWith('veth')) return 'docker'
  if (n.startsWith('tun') || n.startsWith('utun') || n.startsWith('wg') || n.startsWith('tap'))
    return 'vpn'
  if (n.startsWith('wlan') || n.startsWith('wlp') || n.startsWith('wlx')) return 'wifi'
  if (n.startsWith('eth') || /^en\d+$/.test(n)) {
    // macOS en1+ is typically wifi; en0 is wired. Default heuristic.
    if (process.platform === 'darwin' && /^en[1-9]\d*$/.test(n)) return 'wifi'
    return 'lan'
  }
  if (address === '127.0.0.1' || address === '::1') return 'loopback'
  return 'other'
}

/** Convert an IPv4/IPv6 netmask string to its prefix length (CIDR). */
export function prefixLen(netmask: string): number {
  if (!netmask) return 0
  if (netmask.includes(':')) {
    let bits = 0
    for (const group of netmask.split(':')) {
      if (!group) continue
      const n = parseInt(group, 16)
      if (!Number.isFinite(n)) break
      for (let mask = 0x8000; mask; mask >>= 1) {
        if (n & mask) bits++
        else return bits
      }
    }
    return bits
  }
  let bits = 0
  for (const part of netmask.split('.')) {
    const n = parseInt(part, 10)
    if (!Number.isFinite(n)) break
    for (let mask = 0x80; mask; mask >>= 1) {
      if (n & mask) bits++
      else return bits
    }
  }
  return bits
}

function snapshotKey(interfaces: readonly LocalInterface[]): string {
  return [...interfaces]
    .map((i) => `${i.name}|${i.family}|${i.address}|${i.netmask}`)
    .toSorted()
    .join('\n')
}

function formatKind(kind: LocalInterface['kind']): string {
  switch (kind) {
    case 'lan':
      return 'LAN'
    case 'wifi':
      return 'Wi-Fi'
    case 'vpn':
      return 'VPN'
    case 'docker':
      return 'Docker'
    case 'loopback':
      return 'Loopback'
    case 'other':
      return 'Other'
  }
}

/**
 * Rewrite a persisted allowlist against the live interface set:
 * current auto-seed (LAN/Wi-Fi, stable IPv6) plus still-live operator
 * extras (docker/vpn). Empty stays empty — that is "unrestricted".
 */
export function reconcileAllowlist(
  current: readonly string[],
  interfaces: readonly LocalInterface[],
): string[] {
  if (current.length === 0) return []
  const live = new Set(interfaces.map((i) => i.address))
  const seed = autoSeedAllowlist(interfaces)
  const seedSet = new Set(seed)
  const extras = current.filter((a) => live.has(a) && !seedSet.has(a) && !a.includes(':'))
  return [...new Set([...seed, ...extras])]
}

function sameAddressSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((addr) => set.has(addr))
}

function readLinuxIpv6Flags(): ReadonlyMap<string, number> | undefined {
  try {
    return parseProcIfInet6(readFileSync('/proc/net/if_inet6', 'utf8'))
  } catch {
    return undefined
  }
}

export {
  ipv6Prefix64Key,
  parseProcIfInet6,
  shouldAdvertiseIpv6,
} from './ipv6-lan.js'
