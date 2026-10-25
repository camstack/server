/**
 * Tailscale (client) addon — joins the host to a Tailscale tailnet
 * via the `tailscale` CLI.
 *
 * Capabilities registered:
 *   • `mesh-network` — `getStatus` / `join` / `leave` / `logout` /
 *     `listPeers` / `startLogin` / `testConnection`.
 *     Mesh endpoint reporting goes through `getStatus().endpoints`.
 *
 * No custom admin page — the operator-facing UI is the generic
 * `/system/mesh-networks` page driven entirely by the cap + addon
 * settings schema. Serve / Funnel ingresses are owned by a SEPARATE
 * addon (`@camstack/addon-tailscale-ingress`) which depends on this
 * one being installed + the host being joined.
 *
 * `tailscaled` itself is NOT bundled — operators install it from
 * tailscale.com/download. Binary missing = a clean error surface.
 *
 * Auto-rejoin (#174):
 *   On boot, after the CLI probe, we read the persisted `authKey`
 *   (used by the headless / Advanced flow) and check `tailscale status`.
 *   If the daemon reports `BackendState !== 'Running'` AND the operator
 *   has a non-empty `authKey` stashed, we run `tailscale up --auth-key=…`
 *   silently. The retry uses a 5/15/30/60/60 minute backoff capped at
 *   5 attempts; a successful join resets the counter. We never rejoin
 *   when `BackendState === 'NoState'` (first-time install: would race
 *   the operator) or when a redirect-login is in flight.
 */
import type {
  ConfigUISchema,
  IMeshNetworkProvider,
  MeshPeer,
  MeshStatus,
  NetworkAccessStatus,
  NetworkEndpoint,
  ProviderRegistration,
} from '@camstack/types'
import {
  BaseAddon,
  BOOT_RECOVERY_BACKOFF_MS,
  EventCategory,
  meshNetworkCapability,
  networkAccessCapability,
} from '@camstack/types'

import { TailscaleCli, TailscaleCliError, type TailscaleStatusJson } from './tailscale-cli.js'
import { TailscaledDaemon } from './tailscaled-daemon.js'

interface TailscaleConfig {
  /** Pre-auth key from admin.tailscale.com → Settings → Keys. Used by
   *  `join` and reapplied on boot if the host is not yet joined. */
  readonly authKey: string
  /** Hostname this device advertises in the tailnet. Empty = let the
   *  daemon pick from the OS hostname. */
  readonly hostname: string

  // ── Routing (tailscale set --accept-routes / --advertise-routes / ...)
  /** Accept subnet routes other peers advertise. Off by default —
   *  enable to consume e.g. a peer's `192.168.10.0/24` route. */
  readonly acceptRoutes: boolean
  /** Accept DNS resolvers configured in the tailnet. */
  readonly acceptDns: boolean
  /** CIDRs this host advertises as a subnet router. Comma-separated
   *  list joined by the form-builder (e.g. `"192.168.10.0/24,10.0.0.0/8"`). */
  readonly advertisedRoutes: string
  /** ACL tags this host advertises (e.g. `tag:server,tag:camera-host`). */
  readonly advertisedTags: string
  /** Peer ID to route all egress traffic through. Empty disables. */
  readonly exitNodeId: string

  // ── Security / Access
  /** Block all incoming traffic from peers (`tailscale set --shields-up`). */
  readonly shieldsUp: boolean
  /** Run the daemon's Tailscale SSH server on this host. */
  readonly ssh: boolean

  // ── Daemon source
  /**
   * Which `tailscaled` the addon drives:
   *   - `host`: use the system-installed Tailscale (the CLI auto-
   *     resolves the binary, talks to the OS `tailscaled` on its
   *     default socket). Requires Tailscale installed on the machine.
   *   - `onboard`: the addon downloads the static Tailscale bundle and
   *     runs its OWN `tailscaled` in userspace-networking mode with a
   *     private socket + state dir. No system Tailscale needed; the
   *     hub gets a dedicated mesh identity isolated from anything else
   *     on the host.
   */
  readonly clientMode: 'host' | 'onboard'
}

/**
 * Fallback hub HTTPS port used when the `server` config section can't
 * be read from the addon ctx (e.g. running detached in a test harness).
 * Mirrors the boot default in `server/backend/src/boot/boot-config.ts`
 * (`server.port: 4443`) and the `CAMSTACK_PORT` env override the boot
 * loader applies. The normal path reads the resolved port via
 * `ctx.settings.getSection('server')` — see `resolveHubPort`.
 */
const DEFAULT_HUB_PORT = 4443

/**
 * Auto-rejoin backoff (#174), on the SHARED boot-recovery schedule.
 *
 * It is armed from `initialize()` (`setImmediate(() => void this.tryAutoRejoin())`),
 * so its first attempt races the rest of the node's boot — a `tailscaled` that
 * has not finished coming up looks exactly like a peer that is gone. It used to
 * wait five minutes before trying again; the two seconds-scale attempts in
 * `BOOT_RECOVERY_BACKOFF_MS` cover that window, and the long tail is unchanged.
 * The chain still stops at the cap, until a manual join (which resets the
 * counter) or an addon restart.
 */
const AUTO_REJOIN_BACKOFF_MS = BOOT_RECOVERY_BACKOFF_MS

export class TailscaleClientAddon extends BaseAddon<TailscaleConfig> {
  /**
   * The Tailscale CLI wrapper. `null` only in the degraded state where
   * the addon loaded but `clientMode: 'onboard'` failed to start its
   * managed daemon — see `onboardError`. Always read it through
   * `requireCli()` so a degraded addon fails loudly with the real
   * reason instead of a `TypeError`.
   */
  private cli: TailscaleCli | null = null
  /** Used by the orchestrator + UI labels. */
  readonly displayName = 'Tailscale Client'
  readonly kind = 'tailscale-client' as const

  // ── Auto-rejoin state (#174) ──────────────────────────────────────
  /** Index into AUTO_REJOIN_BACKOFF_MS for the next retry. Resets on success. */
  private rejoinAttempt = 0
  /** Timer handle for the next pending rejoin tick. `null` = idle. */
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Set while `startLogin` is in flight. The auto-rejoin loop skips when
   * truthy so a silent `up --auth-key` doesn't collide with the
   * browser-redirect login session.
   */
  private loginInFlight = false

  /** Onboard daemon — non-null only while `clientMode === 'onboard'`. */
  private daemon: TailscaledDaemon | null = null
  /** Socket + CLI path of the onboard daemon — null in host mode.
   *  Surfaced on `getStatus` so tailscale-ingress can drive the same daemon. */
  private onboardHandle: { socketPath: string; cliPath: string } | null = null
  /**
   * Set when `clientMode: 'onboard'` was selected but the managed
   * `tailscaled` failed to start. The addon STAYS LOADED — it still
   * registers `mesh-network`, so the Mesh page and the settings form
   * render — but every CLI-backed action fails with this reason and
   * `getStatus` reports it. We never fall back to the host daemon:
   * failing loud-but-visible is the contract, so the operator can read
   * the error and switch `clientMode` back to `host`. `null` = healthy.
   */
  private onboardError: string | null = null

  constructor() {
    super({
      authKey: '',
      hostname: '',
      acceptRoutes: false,
      acceptDns: true,
      advertisedRoutes: '',
      advertisedTags: '',
      exitNodeId: '',
      shieldsUp: false,
      ssh: false,
      clientMode: 'host',
    })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const cliLogger = this.ctx.logger.child('tailscale-cli')

    // Fresh init — clear degraded-state markers from a prior run.
    // `restartAddon` re-invokes onInitialize on the SAME instance, so a
    // stale `onboardError` (or `onboardHandle`) from an earlier onboard
    // attempt would otherwise make `getStatus` keep reporting the old
    // failure even after the operator switched clientMode back to 'host'.
    this.onboardError = null
    this.onboardHandle = null
    this.cli = null

    // Onboard mode: download + spawn a private tailscaled, then point
    // the CLI at its socket + downloaded binary. Host mode: the CLI
    // auto-resolves the system binary + default socket.
    //
    // NO fallback host→onboard or onboard→host. The operator picked a
    // mode deliberately; silently driving the system daemon when they
    // asked for an isolated onboard one (or vice versa) operates on
    // the WRONG mesh identity. If onboard can't start we let the
    // error propagate — the addon enters the failed state, the
    // AddonHealthMonitor surfaces it, and the operator sees exactly
    // what broke instead of a working-but-wrong client.
    if (this.config.clientMode === 'onboard') {
      this.daemon = new TailscaledDaemon(
        this.ctx.deps,
        this.ctx.dataDir ?? 'camstack-data',
        this.ctx.logger.child('tailscaled'),
      )
      try {
        const handle = await this.daemon.start()
        this.cli = new TailscaleCli({
          logger: cliLogger,
          binPath: handle.cliPath,
          socketPath: handle.socketPath,
        })
        this.onboardHandle = { socketPath: handle.socketPath, cliPath: handle.cliPath }
        this.ctx.logger.info('onboard tailscaled started', {
          meta: { socketPath: handle.socketPath },
        })
      } catch (err) {
        this.daemon = null
        const reason = err instanceof Error ? err.message : String(err)
        this.onboardError = reason
        // DO NOT throw. A throwing onInitialize unregisters every
        // capability and leaves the addon invisible-broken — the
        // operator can't even reach the settings form to recover. We
        // keep the addon loaded: `mesh-network` is registered below,
        // `getStatus` surfaces this error, and the operator can switch
        // clientMode back to 'host'. We still do NOT fall back to the
        // host daemon — failing loud-but-visible is the contract.
        this.ctx.logger.error(
          'onboard tailscaled failed to start — addon stays loaded in a degraded state',
          {
            meta: { error: reason },
            tags: { topic: 'tailscale', phase: 'onboard-failed' },
          },
        )
      }
    } else {
      this.cli = new TailscaleCli({ logger: cliLogger })
    }

    // Best-effort daemon probe at boot so the operator sees a clear
    // error in the logs if `tailscaled` isn't installed yet, rather
    // than a cryptic "command not found" on first action.
    let cliReachable = false
    if (this.cli !== null) {
      try {
        const v = await this.cli.version()
        cliReachable = true
        this.ctx.logger.info('Tailscale CLI ready', { meta: { version: v } })
      } catch (err) {
        this.ctx.logger.warn(
          'Tailscale CLI not found — install from https://tailscale.com/download',
          {
            meta: { error: err instanceof Error ? err.message : String(err) },
            tags: { topic: 'tailscale', phase: 'cli-missing' },
          },
        )
      }
    }

    // Auto-rejoin on boot (#174). Deferred to the next tick so provider
    // registration completes first — the rejoin attempt logs through the
    // addon's scoped logger which is already wired up at this point.
    if (cliReachable) {
      setImmediate(() => {
        void this.tryAutoRejoin()
      })
    }

    // Ensure we clean up a pending backoff timer when the addon is torn
    // down (restartAddon, host shutdown, etc.).
    this.ctx.addDisposer(() => {
      if (this.rejoinTimer !== null) {
        clearTimeout(this.rejoinTimer)
        this.rejoinTimer = null
      }
    })

    // Defensive `= {}` defaults: when a method is invoked through the
    // capability bridge with no input (or an empty input that Moleculer
    // serializes to undefined across the transport), the destructure
    // would otherwise throw "Cannot destructure property X of undefined".
    // The cap input schemas already make every field optional or empty —
    // the wrappers just need to tolerate the absent-input case.
    const meshProvider: IMeshNetworkProvider = {
      getStatus: () => this.getStatus(),
      join: ({ authKey, hostname } = { authKey: '' }) =>
        this.join({ authKey, ...(hostname ? { hostname } : {}) }),
      startLogin: ({ hostname } = {}) => this.startLogin(hostname ? { hostname } : {}),
      leave: () => this.leave(),
      logout: () => this.logout(),
      listPeers: () => this.listPeers(),
      testConnection: ({ authKey } = {}) => this.testConnection(authKey),
    }

    const networkAccessProvider = this.buildNetworkAccessProvider()

    return [
      { capability: meshNetworkCapability, provider: meshProvider },
      { capability: networkAccessCapability, provider: networkAccessProvider },
    ]
  }

  // ── network-access impl ──────────────────────────────────────────

  /**
   * Map a single mesh endpoint (from `buildEndpoints`) to the
   * `NetworkEndpoint` shape expected by the `network-access` cap.
   * All mesh endpoints already carry `url`, `hostname`, `port`, and
   * `protocol: 'https'` — this is a straightforward field-pick.
   */
  private meshEndpointToNetwork(e: MeshStatus['endpoints'][number]): NetworkEndpoint {
    return {
      url: e.url,
      hostname: e.hostname,
      port: e.port,
      protocol: e.protocol,
    }
  }

  /**
   * Build the `network-access` provider that surfaces the Tailscale mesh
   * URL (MagicDNS preferred, mesh-IPv4 fallback) on the Remote Access page.
   *
   * The tailnet membership is managed entirely on the Mesh Networks page
   * (`mesh-network` cap). `start()` and `stop()` therefore surface a
   * helpful error rather than attempting to join/leave the tailnet —
   * the RemoteAccess page renders per-row errors so the operator sees
   * where to go.
   */
  private buildNetworkAccessProvider(): {
    getStatus: () => Promise<NetworkAccessStatus>
    getEndpoint: () => Promise<NetworkEndpoint | null>
    listEndpoints: () => Promise<
      readonly {
        id: string
        label: string
        url: string
        hostname: string
        port: number
        protocol: 'http' | 'https'
        mode?: string
        sourcePort?: number
      }[]
    >
    start: () => Promise<NetworkEndpoint>
    stop: () => Promise<void>
  } {
    const preferredEndpoint = (mesh: MeshStatus): NetworkEndpoint | null => {
      const magicdns = mesh.endpoints.find((e) => e.id === 'magicdns')
      const ipv4 = mesh.endpoints.find((e) => e.id === 'mesh-ipv4')
      const e = magicdns ?? ipv4 ?? null
      return e !== null ? this.meshEndpointToNetwork(e) : null
    }

    return {
      getStatus: async (): Promise<NetworkAccessStatus> => {
        const mesh = await this.getStatus()
        const endpoint = mesh.joined ? preferredEndpoint(mesh) : null
        return {
          connected: mesh.joined,
          endpoint,
          ...(mesh.error !== undefined ? { error: mesh.error } : {}),
        }
      },

      getEndpoint: async (): Promise<NetworkEndpoint | null> => {
        const mesh = await this.getStatus()
        return mesh.joined ? preferredEndpoint(mesh) : null
      },

      listEndpoints: async () => {
        const mesh = await this.getStatus()
        if (!mesh.joined) return []
        return mesh.endpoints.map((e) => ({
          id: e.id,
          label: e.label,
          url: e.url,
          hostname: e.hostname,
          port: e.port,
          protocol: e.protocol,
        }))
      },

      start: async (): Promise<NetworkEndpoint> => {
        const mesh = await this.getStatus()
        if (!mesh.joined) {
          throw new Error(
            'Tailscale mesh is managed on System → Mesh Networks — join the tailnet there to expose this endpoint.',
          )
        }
        const endpoint = preferredEndpoint(mesh)
        if (endpoint === null) {
          throw new Error(
            'Tailscale mesh is joined but no endpoint is available yet — check the Mesh Networks page.',
          )
        }
        return endpoint
      },

      stop: async (): Promise<void> => {
        throw new Error(
          'The Tailscale mesh endpoint is managed on System → Mesh Networks — leave the tailnet there.',
        )
      },
    }
  }

  // ── mesh-network impl ────────────────────────────────────────────

  /**
   * Return the live CLI, or throw a clear error when the addon is in
   * the degraded onboard-failed state. Every mutating mesh action goes
   * through this so a degraded addon fails with the real reason — and
   * a pointer to the fix — instead of a bare `TypeError`.
   */
  private requireCli(): TailscaleCli {
    if (this.cli === null) {
      throw new Error(
        `tailscale-client: the mesh daemon is unavailable — ${this.onboardError ?? 'CLI not initialised'}. ` +
          `Open the addon settings and set clientMode to 'host', or fix the onboard daemon.`,
      )
    }
    return this.cli
  }

  private async getStatus(): Promise<MeshStatus> {
    // Degraded state: onboard daemon failed to start. Report the reason
    // through the status payload — the Mesh page renders it as an error
    // banner — rather than throwing (getStatus is a poll target).
    if (this.onboardError !== null) {
      return {
        joined: false,
        meshIp: '',
        magicDnsHostname: '',
        peerCount: 0,
        endpoints: [],
        error:
          `onboard tailscaled unavailable — ${this.onboardError}. ` +
          `Set clientMode to 'host' in the addon settings to use the system Tailscale.`,
        tenantName: '',
        magicDnsSuffix: '',
        userLogin: null,
        controlPlaneUrl: '',
        keyExpiry: null,
      }
    }
    try {
      const s = await this.requireCli().status()
      const joined = s.BackendState === 'Running'
      const meshIp = s.Self?.TailscaleIPs?.[0] ?? ''
      // DNSName comes as "camstack.tail-abc.ts.net." with trailing dot.
      const magicDnsHostname = (s.Self?.DNSName ?? '').replace(/\.$/, '')
      const peerCount = s.Peer ? Object.keys(s.Peer).length : 0
      const port = await this.resolveHubPort()
      const endpoints = this.buildEndpoints(s, meshIp, magicDnsHostname, port)
      // Broadcast the reachable mesh host so `local-network` can fold it
      // into its connection-endpoint list (lossy event — `local-network`
      // ALSO pull-reconciles via getStatus on `$node.connected`, D8).
      this.emitMeshNetworkChanged(joined, meshIp, magicDnsHostname, port)
      // Resolve the bound user-login via the `User` map. `Self.UserID`
      // indexes into `User` whose entries carry a `LoginName`. Pre-2024
      // tailscale CLI ships this; later builds also do.
      const userLogin =
        s.Self?.UserID !== undefined && s.User
          ? (s.User[String(s.Self.UserID)]?.LoginName ?? null)
          : null
      const status: MeshStatus = {
        joined,
        meshIp,
        magicDnsHostname,
        peerCount,
        endpoints,
        tenantName: s.CurrentTailnet?.Name ?? '',
        magicDnsSuffix: s.CurrentTailnet?.MagicDNSSuffix ?? s.MagicDNSSuffix ?? '',
        userLogin,
        controlPlaneUrl: s.ControlURL ?? '',
        keyExpiry: s.Self?.KeyExpiry ? Date.parse(s.Self.KeyExpiry) || null : null,
        // Onboard handoff — present only when this addon spawned its
        // own tailscaled. tailscale-ingress reads these to drive the
        // same daemon for Serve/Funnel.
        ...(this.onboardHandle !== null
          ? {
              daemonSocket: this.onboardHandle.socketPath,
              daemonCliPath: this.onboardHandle.cliPath,
            }
          : {}),
      }
      return status
    } catch (err) {
      return {
        joined: false,
        meshIp: '',
        magicDnsHostname: '',
        peerCount: 0,
        endpoints: [],
        error: err instanceof TailscaleCliError ? err.message : String(err),
        tenantName: '',
        magicDnsSuffix: '',
        userLogin: null,
        controlPlaneUrl: '',
        keyExpiry: null,
      }
    }
  }

  private buildEndpoints(
    s: TailscaleStatusJson,
    meshIp: string,
    magicDnsHostname: string,
    port: number,
  ): MeshStatus['endpoints'] {
    const out: MeshStatus['endpoints'][number][] = []
    // Prefer the MagicDNS name first — TLS to a raw 100.x IP mismatches
    // the hub's SAN cert, while the MagicDNS hostname resolves to the
    // mesh IP AND matches the cert. Only emitted when MagicDNS is enabled
    // (suffix present → non-empty `magicDnsHostname`); otherwise the
    // mesh-ipv4 entry stays the sole (cert-mismatching) fallback.
    if (magicDnsHostname) {
      out.push({
        id: 'magicdns',
        label: 'MagicDNS',
        scope: 'mesh',
        url: `https://${magicDnsHostname}:${port}`,
        hostname: magicDnsHostname,
        port,
        protocol: 'https',
      })
    }
    if (meshIp) {
      out.push({
        id: 'mesh-ipv4',
        label: 'Mesh IPv4',
        scope: 'mesh',
        // Hub serves HTTPS on `port`; the raw 100.x address won't match
        // the cert SAN (hence MagicDNS ranks first) but stays reachable
        // for clients that skip cert verification or pin the IP.
        url: `https://${meshIp}:${port}`,
        hostname: meshIp,
        port,
        protocol: 'https',
      })
    }
    void s // reserved for future status-derived endpoints
    return out
  }

  /**
   * Resolve the hub's HTTPS port. The boot loader merges the
   * `CAMSTACK_PORT` env override into the persisted `server` config
   * section (`server/backend/src/boot/boot-config.ts`), so reading the
   * `server` section gives the authoritative live port — NO new setting.
   * Falls back to `CAMSTACK_PORT`-or-4443 only when the ctx can't reach
   * the section (detached test harness with no `settings` API).
   */
  private async resolveHubPort(): Promise<number> {
    const envPort = Number(process.env['CAMSTACK_PORT'])
    const fallback = Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_HUB_PORT
    if (!this.ctx.settings) return fallback
    try {
      const server = await this.ctx.settings.getSection('server')
      const raw = server['port']
      const parsed = typeof raw === 'number' ? raw : Number(raw)
      return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
    } catch (err) {
      this.ctx.logger.debug('tailscale: could not read server.port — using fallback', {
        meta: { error: err instanceof Error ? err.message : String(err), fallback },
        tags: { topic: 'tailscale', phase: 'port-fallback' },
      })
      return fallback
    }
  }

  /**
   * Emit the mesh-reachable host so `local-network` can surface the
   * MagicDNS / 100.x endpoint in its connection-endpoint list without a
   * cross-package import. Telemetry-grade (lossy by D8): `local-network`
   * pull-reconciles from this provider's `getStatus` on `$node.connected`.
   * When not joined we emit an empty host so the consumer clears its
   * cached mesh endpoint (leave / daemon-down / not-yet-joined).
   */
  private emitMeshNetworkChanged(
    joined: boolean,
    meshIp: string,
    magicDnsHostname: string,
    port: number,
  ): void {
    if (!this.ctx.eventBus) return
    // Prefer MagicDNS (cert-matching) over the raw mesh IP.
    const host = joined ? magicDnsHostname || meshIp : ''
    this.ctx.eventBus.emit({
      id: `mesh-network-changed-${Date.now()}`,
      timestamp: new Date(),
      source: { type: 'addon', id: this.ctx.id },
      category: EventCategory.MeshNetworkChanged,
      data: { host, port, protocol: 'https' },
    })
  }

  private async join(input: { authKey: string; hostname?: string }): Promise<{ joined: true }> {
    this.ctx.logger.info('tailscale: joining tailnet', {
      meta: { hasHostname: !!input.hostname },
      tags: { topic: 'tailscale', phase: 'join' },
    })
    await this.requireCli().up({
      authKey: input.authKey,
      ...(input.hostname ? { hostname: input.hostname } : {}),
    })
    await this.updateGlobalSettings({
      authKey: input.authKey,
      hostname: input.hostname ?? this.config.hostname,
    })
    // Manual join succeeded — reset the auto-rejoin backoff so a later
    // controlled-leave + key-rotation doesn't have to wait an hour.
    this.resetAutoRejoinBackoff()
    this.ctx.logger.info('tailscale: joined', {
      tags: { topic: 'tailscale', phase: 'joined' },
    })
    return { joined: true as const }
  }

  /**
   * Spawn `tailscale up` (no `--auth-key`) and return the login URL
   * printed by the daemon. The child process keeps running until the
   * operator authenticates in their browser — at which point it
   * self-terminates. Caller polls `getStatus()` for `joined: true`.
   */
  private async startLogin(input: { hostname?: string }): Promise<{ loginUrl: string }> {
    this.ctx.logger.info('tailscale: starting interactive login', {
      meta: { hasHostname: !!input.hostname },
      tags: { topic: 'tailscale', phase: 'login-start' },
    })
    // Block the silent-rejoin loop while a redirect-login session is
    // open — see the `loginInFlight` gate in `tryAutoRejoin`.
    this.loginInFlight = true
    try {
      const handle = await this.requireCli().startInteractiveLogin(
        input.hostname ? { hostname: input.hostname } : {},
      )
      // Persist the optional hostname override so it survives the
      // browser round-trip if the user reloads admin UI before the
      // daemon reports joined.
      if (input.hostname && input.hostname !== this.config.hostname) {
        await this.updateGlobalSettings({
          authKey: this.config.authKey,
          hostname: input.hostname,
        })
      }
      this.ctx.logger.info('tailscale: login URL ready', {
        tags: { topic: 'tailscale', phase: 'login-url' },
      })
      // Clear the inFlight flag once the URL is returned; the page polls
      // `getStatus()` to detect completion, but from this addon's POV
      // the next auto-rejoin tick may safely run if the user abandons.
      this.loginInFlight = false
      return { loginUrl: handle.loginUrl }
    } catch (err) {
      this.loginInFlight = false
      throw err
    }
  }

  private async leave(): Promise<{ left: true }> {
    this.ctx.logger.info('tailscale: leaving tailnet', {
      tags: { topic: 'tailscale', phase: 'leave' },
    })
    await this.requireCli().down()
    // Don't clear authKey from config — operator can rejoin without
    // re-pasting.
    return { left: true as const }
  }

  /**
   * Wipe the daemon's account binding (`tailscale logout`). The next
   * `startLogin` will require a fresh browser-redirect flow because
   * the daemon has no cached credentials to silently re-authenticate
   * with. We also clear the persisted `authKey` so the auto-rejoin
   * loop doesn't immediately re-bind using the old key after the
   * daemon transitions to `NeedsLogin`.
   */
  private async logout(): Promise<{ loggedOut: true }> {
    this.ctx.logger.info('tailscale: signing out of account', {
      tags: { topic: 'tailscale', phase: 'logout' },
    })
    await this.requireCli().logout()
    // Drop the stored auth key — otherwise the next `getStatus` /
    // boot tick would auto-rejoin headlessly using the old key,
    // defeating the operator's intent to switch accounts.
    if (this.config.authKey) {
      // '' keeps a keychain secret (D787); forgetting the key is explicit.
      await this.clearSecrets(['authKey'])
    }
    return { loggedOut: true as const }
  }

  /**
   * Test the daemon + auth key WITHOUT committing to a join.
   */
  private async testConnection(authKey?: string): Promise<{
    ok: boolean
    tenant?: string
    daemonVersion?: string
    error?: string
  }> {
    let daemonVersion: string | undefined
    try {
      daemonVersion = await this.requireCli().version()
    } catch (err) {
      return {
        ok: false,
        error: `tailscaled CLI not reachable: ${err instanceof Error ? err.message : String(err)}. Install Tailscale on the host.`,
      }
    }

    let tenant: string | undefined
    try {
      const status = await this.requireCli().status()
      if (status.MagicDNSSuffix) {
        tenant = status.MagicDNSSuffix
      }
    } catch {
      /* ignore — daemon may not yet be running */
    }

    if (authKey !== undefined) {
      const trimmed = authKey.trim()
      if (!trimmed) {
        return {
          ok: false,
          ...(tenant ? { tenant } : {}),
          ...(daemonVersion ? { daemonVersion } : {}),
          error: 'Auth key is empty.',
        }
      }
      if (!trimmed.startsWith('tskey-auth-') && !trimmed.startsWith('tskey-client-')) {
        return {
          ok: false,
          ...(tenant ? { tenant } : {}),
          ...(daemonVersion ? { daemonVersion } : {}),
          error:
            'Auth key does not look like a Tailscale key (expected prefix `tskey-auth-` or `tskey-client-`).',
        }
      }
    }

    return {
      ok: true,
      ...(tenant ? { tenant } : {}),
      ...(daemonVersion ? { daemonVersion } : {}),
    }
  }

  private async listPeers(): Promise<{ peers: readonly MeshPeer[] }> {
    const s = await this.requireCli().status()
    const peers: MeshPeer[] = []
    // `HostName` is the OS-reported hostname — multiple machines that
    // never had their hostname customised (HomeAssistant, Pi-hole, …)
    // all report the same string. Tailscale disambiguates them in
    // `DNSName` by tacking a suffix on the leading label
    // (`homeassistant` vs `homeassistant-vincenzo`). Use the leading
    // DNS label when available so the admin UI never shows two rows
    // that look identical; fall back to HostName otherwise.
    const preferredPeerName = (peer: { HostName: string; DNSName?: string }): string => {
      const dnsLabel = (peer.DNSName ?? '').replace(/\.$/, '').split('.')[0] ?? ''
      return dnsLabel.length > 0 ? dnsLabel : peer.HostName
    }
    const resolveLogin = (userId: number | undefined): string | null => {
      if (userId === undefined || !s.User) return null
      return s.User[String(userId)]?.LoginName ?? null
    }
    const parseIso = (iso: string | undefined): number => {
      if (!iso) return 0
      const t = Date.parse(iso)
      return Number.isFinite(t) ? t : 0
    }
    /**
     * Map `tailscale status --json` peer entry to the generic
     * `MeshPeer` shape. The mapping is straightforward except for
     * `connection` which the JSON doesn't surface directly — we
     * derive it from `Active` + `Relay`:
     *   • `Active: true` + non-empty `Relay` → 'relay' (DERP route)
     *   • `Active: true` + empty `Relay` → 'direct' (UDP-punched)
     *   • else → 'idle'
     */
    const deriveConnection = (peer: {
      Active?: boolean
      Relay?: string
    }): MeshPeer['connection'] => {
      if (!peer.Active) return 'idle'
      return peer.Relay ? 'relay' : 'direct'
    }
    if (s.Self) {
      peers.push({
        id: s.Self.ID,
        hostname: preferredPeerName(s.Self),
        magicDns: (s.Self.DNSName ?? '').replace(/\.$/, ''),
        addresses: s.Self.TailscaleIPs ?? [],
        ...(s.Self.OS !== undefined ? { os: s.Self.OS } : {}),
        online: s.Self.Online,
        lastSeenMs: Date.now(),
        isSelf: true,
        connection: deriveConnection(s.Self),
        relay: s.Self.Relay && s.Self.Relay.length > 0 ? s.Self.Relay : null,
        lastHandshakeMs: parseIso(s.Self.LastHandshake),
        rxBytes: s.Self.RxBytes ?? 0,
        txBytes: s.Self.TxBytes ?? 0,
        tags: s.Self.Tags ?? [],
        exitNodeOption: s.Self.ExitNodeOption ?? false,
        advertisedRoutes: s.Self.PrimaryRoutes ?? [],
        userLogin: resolveLogin(s.Self.UserID),
        keyExpiry: s.Self.KeyExpiry ? parseIso(s.Self.KeyExpiry) || null : null,
      })
    }
    for (const p of Object.values(s.Peer ?? {})) {
      peers.push({
        id: p.ID,
        hostname: preferredPeerName(p),
        magicDns: (p.DNSName ?? '').replace(/\.$/, ''),
        addresses: p.TailscaleIPs ?? [],
        ...(p.OS !== undefined ? { os: p.OS } : {}),
        online: p.Online,
        lastSeenMs: parseIso(p.LastSeen),
        isSelf: false,
        connection: deriveConnection(p),
        relay: p.Relay && p.Relay.length > 0 ? p.Relay : null,
        lastHandshakeMs: parseIso(p.LastHandshake),
        rxBytes: p.RxBytes ?? 0,
        txBytes: p.TxBytes ?? 0,
        tags: p.Tags ?? [],
        exitNodeOption: p.ExitNodeOption ?? false,
        advertisedRoutes: p.PrimaryRoutes ?? [],
        userLogin: resolveLogin(p.UserID),
        keyExpiry: p.KeyExpiry ? parseIso(p.KeyExpiry) || null : null,
      })
    }
    return { peers }
  }

  // ── Auto-rejoin loop (#174) ───────────────────────────────────────

  /**
   * Single pass of the auto-rejoin probe. Called once on boot and then
   * on the backoff timer. Internal contract:
   *   - reads `BackendState` via the CLI
   *   - skips when CLI unreachable / NoState / Running / no authKey /
   *     login-redirect in flight
   *   - otherwise runs `tailscale up --auth-key=<stored>` and resets
   *     the backoff index on success
   *   - on failure / continued non-Running state schedules the next
   *     attempt with the configured backoff
   */
  private async tryAutoRejoin(): Promise<void> {
    if (this.rejoinTimer !== null) {
      // Already scheduled. Should never happen but be defensive.
      return
    }
    if (this.loginInFlight) {
      this.ctx.logger.info('auto-rejoin: skipping — redirect login in flight', {
        tags: { topic: 'tailscale', phase: 'auto-rejoin-skip' },
      })
      this.scheduleNextAutoRejoin()
      return
    }
    if (!this.config.authKey) {
      // Nothing to rejoin with. The operator either hasn't pasted a key
      // yet OR is using the browser-redirect flow — both are valid.
      return
    }
    let state: TailscaleStatusJson['BackendState'] | null
    try {
      const s = await this.requireCli().status()
      state = s.BackendState
    } catch (err) {
      this.ctx.logger.warn('auto-rejoin: status probe failed — CLI unreachable, skipping', {
        meta: { error: err instanceof Error ? err.message : String(err) },
        tags: { topic: 'tailscale', phase: 'auto-rejoin-cli-missing' },
      })
      // Do NOT schedule a retry when the CLI is missing — the operator
      // needs to install tailscaled first; spamming the timer wouldn't
      // help. The next boot will probe again.
      return
    }
    if (state === 'Running') {
      // Already joined; reset the counter so a later transition out of
      // Running starts at the 5min step.
      this.resetAutoRejoinBackoff()
      return
    }
    if (state === 'NoState') {
      // Daemon hasn't been initialized yet — first-time install.
      // Don't try to inject a key here; the operator should drive the
      // first join from the UI so they see any failure surface.
      this.ctx.logger.info('auto-rejoin: skipping — daemon NoState (first-time install)', {
        tags: { topic: 'tailscale', phase: 'auto-rejoin-no-state' },
      })
      return
    }
    // BackendState is NeedsLogin / NeedsMachineAuth / Starting / Stopped:
    // any of these are safe to retry with the stored key.
    this.ctx.logger.info('auto-rejoin: attempting silent rejoin', {
      meta: { state, attempt: this.rejoinAttempt + 1 },
      tags: { topic: 'tailscale', phase: 'auto-rejoin-attempt' },
    })
    try {
      await this.requireCli().up({
        authKey: this.config.authKey,
        ...(this.config.hostname ? { hostname: this.config.hostname } : {}),
      })
      this.ctx.logger.info('auto-rejoin: succeeded', {
        tags: { topic: 'tailscale', phase: 'auto-rejoin-ok' },
      })
      this.resetAutoRejoinBackoff()
    } catch (err) {
      this.ctx.logger.warn('auto-rejoin: tailscale up failed — will retry on backoff', {
        meta: {
          error: err instanceof Error ? err.message : String(err),
          nextAttempt: this.rejoinAttempt + 1,
        },
        tags: { topic: 'tailscale', phase: 'auto-rejoin-error' },
      })
      this.scheduleNextAutoRejoin()
    }
  }

  /** Reset the backoff index — used after a successful join (manual or auto). */
  private resetAutoRejoinBackoff(): void {
    this.rejoinAttempt = 0
    if (this.rejoinTimer !== null) {
      clearTimeout(this.rejoinTimer)
      this.rejoinTimer = null
    }
  }

  /** Queue the next attempt or stop retrying once we hit the cap. */
  private scheduleNextAutoRejoin(): void {
    if (this.rejoinAttempt >= AUTO_REJOIN_BACKOFF_MS.length) {
      this.ctx.logger.warn('auto-rejoin: cap reached — giving up until next boot or manual join', {
        meta: { attempts: this.rejoinAttempt },
        tags: { topic: 'tailscale', phase: 'auto-rejoin-cap-reached' },
      })
      return
    }
    const delay =
      AUTO_REJOIN_BACKOFF_MS[this.rejoinAttempt] ??
      AUTO_REJOIN_BACKOFF_MS[AUTO_REJOIN_BACKOFF_MS.length - 1] ??
      60 * 60_000
    this.rejoinAttempt += 1
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null
      void this.tryAutoRejoin()
    }, delay)
  }

  protected globalSettingsSchema(cap?: string): ConfigUISchema | null {
    if (cap === 'network-access') return null
    return this.schema({
      // Tab strip mirrors the canonical Tailscale CLI taxonomy:
      //   • General   — identity (hostname) + connect hints
      //   • Routing   — accept/advertise routes + DNS + exit-node
      //   • Security  — shields-up + SSH + headless auth-key
      tabs: [
        { id: 'general', label: 'General', icon: 'settings', order: 0 },
        { id: 'routing', label: 'Routing', icon: 'route', order: 10 },
        { id: 'security', label: 'Security', icon: 'shield', order: 20 },
      ],
      sections: [
        {
          id: 'identity',
          tab: 'general',
          title: 'Identity',
          titleKey: 'tailscale:globalSettings.s_identity.title',
          immediate: true,
          description:
            'How this host identifies itself on the tailnet. Click "Connect to Tailscale" on the Mesh page to start the browser-redirect login flow.',
          descriptionKey: 'tailscale:globalSettings.s_identity.description',
          fields: [
            {
              type: 'info' as const,
              key: 'tailscaleHelp',
              label: 'Prerequisites',
              labelKey: 'tailscale:globalSettings.s_identity.tailscaleHelp.label',
              format: 'html' as const,
              content:
                'Install <code>tailscaled</code> from ' +
                '<a href="https://tailscale.com/download">tailscale.com/download</a>.' +
                ' On macOS the GUI app ships the CLI inside the .app bundle.' +
                ' For Serve / Funnel ingress, install ' +
                '<code>@camstack/addon-tailscale-ingress</code> separately.',
              variant: 'info' as const,
            },
            this.field({
              type: 'select',
              key: 'clientMode',
              label: 'Tailscale daemon',
              labelKey: 'tailscale:globalSettings.s_identity.clientMode.label',
              description:
                'Host = drive the system-installed Tailscale (requires it installed + running on the machine). ' +
                'Onboard = the addon downloads its own Tailscale build and runs a dedicated tailscaled in ' +
                'userspace mode — no system install needed, isolated mesh identity for the hub. ' +
                'Changing this restarts the addon.',
              descriptionKey: 'tailscale:globalSettings.s_identity.clientMode.description',
              default: 'host',
              // The daemon source is wired up entirely in `onInitialize`
              // (onboard spawns `tailscaled`; host resolves the system
              // CLI). `onConfigChanged` cannot retrofit that — the addon
              // must re-initialise. `requiresRestart` makes BaseAddon's
              // `maybeAutoRestart` trigger `restartAddon` on save, which
              // is what the description above promises.
              requiresRestart: true,
              options: [
                {
                  value: 'host',
                  label: 'Host — use system Tailscale',
                  labelKey: 'tailscale:globalSettings.s_identity.clientMode.o_host.label',
                },
                {
                  value: 'onboard',
                  label: 'Onboard — addon-managed tailscaled',
                  labelKey: 'tailscale:globalSettings.s_identity.clientMode.o_onboard.label',
                },
              ],
            }),
            this.field({
              type: 'text',
              key: 'hostname',
              label: 'Device Hostname',
              labelKey: 'tailscale:globalSettings.s_identity.hostname.label',
              description:
                'Override the hostname advertised in the tailnet. Empty = use the OS hostname.',
              descriptionKey: 'tailscale:globalSettings.s_identity.hostname.description',
              placeholder: 'camstack-hub',
            }),
          ],
        },
        {
          id: 'routes',
          tab: 'routing',
          title: 'Subnet routing',
          titleKey: 'tailscale:globalSettings.s_routes.title',
          immediate: true,
          description:
            'Control which subnet routes flow between this host and the rest of the tailnet (`tailscale set --accept-routes` / `--advertise-routes`).',
          descriptionKey: 'tailscale:globalSettings.s_routes.description',
          fields: [
            this.field({
              type: 'boolean',
              key: 'acceptRoutes',
              label: 'Accept routes from peers',
              labelKey: 'tailscale:globalSettings.s_routes.acceptRoutes.label',
              description:
                'Install subnet routes other peers advertise (e.g. a peer router exposing `192.168.60.0/24`).',
              descriptionKey: 'tailscale:globalSettings.s_routes.acceptRoutes.description',
              default: false,
            }),
            this.field({
              type: 'text',
              key: 'advertisedRoutes',
              label: 'Advertise subnet routes',
              labelKey: 'tailscale:globalSettings.s_routes.advertisedRoutes.label',
              description:
                'Comma-separated CIDRs this host exposes to peers (e.g. `192.168.10.0/24,10.0.0.0/8`). Requires approval in the Tailscale admin console.',
              descriptionKey: 'tailscale:globalSettings.s_routes.advertisedRoutes.description',
              placeholder: '192.168.10.0/24',
            }),
            this.field({
              type: 'text',
              key: 'advertisedTags',
              label: 'Advertise ACL tags',
              labelKey: 'tailscale:globalSettings.s_routes.advertisedTags.label',
              description:
                'Comma-separated tags this host declares (e.g. `tag:server,tag:camera-host`). Must be allowed by the tailnet policy.',
              descriptionKey: 'tailscale:globalSettings.s_routes.advertisedTags.description',
              placeholder: 'tag:server',
            }),
          ],
        },
        {
          id: 'dns-exit',
          tab: 'routing',
          title: 'DNS & exit node',
          titleKey: 'tailscale:globalSettings.s_dns-exit.title',
          immediate: true,
          description:
            'How this host resolves names + whether all egress traffic routes through a peer.',
          descriptionKey: 'tailscale:globalSettings.s_dns-exit.description',
          fields: [
            this.field({
              type: 'boolean',
              key: 'acceptDns',
              label: 'Accept tailnet DNS',
              labelKey: 'tailscale:globalSettings.s_dns-exit.acceptDns.label',
              description:
                'Use DNS resolvers the tailnet provides (MagicDNS + split-DNS). Disabling keeps the OS resolver.',
              descriptionKey: 'tailscale:globalSettings.s_dns-exit.acceptDns.description',
              default: true,
            }),
            this.field({
              type: 'text',
              key: 'exitNodeId',
              label: 'Exit node (peer id)',
              labelKey: 'tailscale:globalSettings.s_dns-exit.exitNodeId.label',
              description:
                'Route all internet egress through this peer. Empty to disable. Use the peer ID from the Peers tab.',
              descriptionKey: 'tailscale:globalSettings.s_dns-exit.exitNodeId.description',
              placeholder: '',
            }),
          ],
        },
        {
          id: 'access',
          tab: 'security',
          title: 'Access',
          titleKey: 'tailscale:globalSettings.s_access.title',
          immediate: true,
          description: 'Server-side access controls applied by the daemon.',
          descriptionKey: 'tailscale:globalSettings.s_access.description',
          fields: [
            this.field({
              type: 'boolean',
              key: 'shieldsUp',
              label: 'Shields up',
              labelKey: 'tailscale:globalSettings.s_access.shieldsUp.label',
              description:
                'Block ALL incoming connections from peers. Outgoing connections still work.',
              descriptionKey: 'tailscale:globalSettings.s_access.shieldsUp.description',
              default: false,
            }),
            this.field({
              type: 'boolean',
              key: 'ssh',
              label: 'Enable Tailscale SSH',
              labelKey: 'tailscale:globalSettings.s_access.ssh.label',
              description:
                "Run the daemon's SSH server on this host. Lets peers SSH in via MagicDNS without managing keys.",
              descriptionKey: 'tailscale:globalSettings.s_access.ssh.description',
              default: false,
            }),
          ],
        },
        {
          id: 'auth-advanced',
          tab: 'security',
          title: 'Headless / Auth key',
          titleKey: 'tailscale:globalSettings.s_auth-advanced.title',
          style: 'accordion',
          defaultCollapsed: true,
          immediate: true,
          description:
            'Use a pre-generated auth key from admin.tailscale.com → Settings → Keys for headless / CI flows where opening a browser is not possible. When set, the addon also auto-rejoins on boot if the daemon dropped offline (5/15/30/60/60 min backoff).',
          descriptionKey: 'tailscale:globalSettings.s_auth-advanced.description',
          fields: [
            this.field({
              type: 'password',
              key: 'authKey',
              label: 'Pre-auth key',
              labelKey: 'tailscale:globalSettings.s_auth-advanced.authKey.label',
              description:
                'tskey-auth-* token from the Tailscale admin console. Leave empty when using the browser-redirect flow.',
              descriptionKey: 'tailscale:globalSettings.s_auth-advanced.authKey.description',
              showToggle: true,
            }),
          ],
        },
      ],
    })
  }

  /**
   * Apply prefs changes immediately when the operator saves the form.
   * Only fires when the daemon is reachable; pre-join changes are
   * persisted in the addon's config blob and re-applied on the next
   * successful `up`.
   *
   * Each `tailscale set` invocation is short-running (~1-2s), and we
   * intentionally don't wrap the whole thing in a transaction —
   * partial application is better than rolling back the operator's
   * intent silently.
   */
  protected async onConfigChanged(): Promise<void> {
    try {
      await this.requireCli().setPrefs({
        acceptRoutes: this.config.acceptRoutes,
        acceptDns: this.config.acceptDns,
        shieldsUp: this.config.shieldsUp,
        ssh: this.config.ssh,
        ...(this.config.hostname ? { hostname: this.config.hostname } : {}),
        advertisedRoutes: this.config.advertisedRoutes
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        advertisedTags: this.config.advertisedTags
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        exitNodeId: this.config.exitNodeId,
      })
      this.ctx.logger.info('tailscale: applied config change', {
        tags: { topic: 'tailscale', phase: 'config-applied' },
      })
    } catch (err) {
      // Don't throw — the operator's save UI already returns 200 by the
      // time onConfigChanged runs. Surface the failure in logs so they
      // can spot it; the next form save retries everything.
      this.ctx.logger.warn(
        'tailscale: failed to apply config change to daemon — will retry on next save',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
          tags: { topic: 'tailscale', phase: 'config-error' },
        },
      )
    }
  }

  protected async onShutdown(): Promise<void> {
    // Tear down the onboard daemon if we spawned one. Host mode has
    // no process to kill — the system tailscaled keeps running.
    if (this.daemon !== null) {
      await this.daemon.stop().catch((err: unknown) => {
        this.ctx.logger.warn('onboard tailscaled stop failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
      this.daemon = null
    }
  }
}

export default TailscaleClientAddon
