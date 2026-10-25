/**
 * local-network — hub-only singleton.
 *
 * Enumerates the host's network interfaces and ranks them so that:
 *
 *  • Addons that need a "where do we listen / point a tunnel at" answer
 *    (cloudflare-tunnel, ngrok, RTSP restream, cluster join URL, TLS
 *    cert SAN) consume `getPreferred()` instead of hard-coding
 *    `localhost`. Critical for docker-sidecar setups where the addon
 *    process needs the container's eth0 (not 127.0.0.1).
 *
 *  • The SDK (mobile / web client) consumes `getConnectionEndpoints()`
 *    to receive an ordered list of candidate base URLs it should race
 *    on connect — LAN IPv4 and stable LAN IPv6 first (lowest latency
 *    when on the same network), then public hostname (if a tunnel is
 *    up). The SDK can race them with short timeouts and stick with the
 *    winner for the session.
 *
 * Why hub-only: agents are not directly addressable by the operator's
 * clients — they reverse-connect to the hub. Exposing their interfaces
 * via the same surface would leak internal topology with no upside.
 *
 * Implementation in `@camstack/system/builtins/local-network/`.
 */
import { z } from 'zod'
import { HUB_ADDRESS_ROLES } from './hub-address.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/** Coarse classification derived from the interface name + IP range. */
const InterfaceKindEnum = z.enum([
  'lan', // wired ethernet (en0, eth0, ...)
  'wifi', // wireless (en1, wlan*, ...)
  'docker', // docker0 / br-* / veth*
  'vpn', // tun*, utun*, wg*, tap*
  'loopback', // lo, lo0
  'other', // anything we can't classify confidently
])

const LocalInterfaceSchema = z.object({
  /** Interface name as reported by the OS (e.g. `en0`, `eth0`, `lo0`). */
  name: z.string(),
  family: z.enum(['IPv4', 'IPv6']),
  address: z.string(),
  /** CIDR shorthand (e.g. `192.168.10.10/24`). Empty when OS doesn't expose. */
  cidr: z.string(),
  /** OS netmask. Stable across calls so the SDK can hash on it. */
  netmask: z.string(),
  /** True for `127.0.0.1`/`::1`. Returned for completeness but never preferred. */
  internal: z.boolean(),
  /** Hardware MAC (empty for loopback / virtual interfaces). */
  mac: z.string(),
  /** Derived classification — see `InterfaceKindEnum`. */
  kind: InterfaceKindEnum,
  /**
   * `true` for the auto-selected outbound interface. Exactly zero or
   * one entry has this set per call; the SDK picks this one for the
   * first connection attempt.
   */
  preferred: z.boolean(),
  /**
   * Heuristic flag: `true` when the address looks usable for clients
   * (RFC 1918 / public IPv4, IPv6 ULA / GUA), `false` for link-local
   * / loopback / multicast / docker / vpn / unknown ranges. Same
   * heuristic that drives `autoSeedAllowlist`.
   */
  plausible: z.boolean(),
  /**
   * Human-readable rationale for non-plausible entries (e.g. "IPv6
   * link-local — only reachable on the same link"). Empty string for
   * plausible entries. The UI surfaces this verbatim as the tooltip
   * on the "Unlikely usable" badge so the backend stays the single
   * source of truth — front-end consumers don't re-derive the reason.
   */
  plausibleReason: z.string(),
})

const ListResultSchema = z.object({
  interfaces: z.array(LocalInterfaceSchema).readonly(),
  /** Wall-clock timestamp at which the snapshot was probed. */
  probedAt: z.number(),
})

const PreferredSchema = LocalInterfaceSchema.nullable()

/**
 * Candidate base URL for the SDK to race on connect. Order matters —
 * the SDK should attempt these top-to-bottom with a short per-candidate
 * timeout (e.g. 1500ms) and cache the winner for the session.
 */
const ConnectionEndpointSchema = z.object({
  /** Operator-facing label (e.g. "LAN — en0", "Public tunnel"). */
  label: z.string(),
  /** Fully-formed base URL with scheme + host + port. */
  baseUrl: z.string(),
  /** Network-level hint for the SDK — picks a small icon, sorts within
   *  a tier. Coarse categorisation (LAN vs public vs loopback). */
  kind: z.enum([
    'lan-ipv4', // private RFC1918 / link-local IPv4
    'lan-ipv6', // private IPv6
    'public', // tunnel / external FQDN
    'loopback', // 127.0.0.1 — last-resort fallback
    // The CamStack app link (`https://camstack.zentik.app`, D709) — NOT a hub
    // address and never raced: a viewer link built on it opens the native
    // app (or the hosted viewer) and carries the hub as `hub=`. Emitted only
    // when the caller passes `includeAppLink: true` (the Network page).
    'app-link',
    // An operator-entered CUSTOM address (Network page) — a hub address the
    // hub cannot detect (NAT, a reverse proxy, a VPN). It carries its own port,
    // serves exactly the roles it is flagged with and never takes part in an
    // automatic pick. The palette carries the ones flagged `appConnections`, so a
    // client filtering it by `getViewerEndpoints().resolved` races them.
    'custom',
  ]),
  /**
   * Originating-interface kind — `lan`/`wifi`/`docker`/`vpn`/`other`/
   * `loopback`/`public`. Lets the UI render an accurate badge (e.g. a
   * VPN address gets a "VPN" tag instead of being lumped under
   * "lan-ipv4"). `'public'` for the tunnel hostname.
   */
  interfaceKind: z.enum(['lan', 'wifi', 'docker', 'vpn', 'other', 'loopback', 'public']),
  /**
   * Mirrors `LocalInterface.plausible` — false for endpoints derived
   * from non-plausible interfaces (VPN, docker, link-local, …). The
   * UI uses it to mark "Unlikely usable" without re-deriving from
   * the address shape.
   */
  plausible: z.boolean(),
  /** Same as `LocalInterface.plausibleReason` — empty when plausible. */
  plausibleReason: z.string(),
  /**
   * Suggested priority for racing — lower = try first. Stable across
   * calls so the client can sort even if the cap returns a new
   * ordering between polls.
   */
  priority: z.number(),
  /**
   * `false` = the address changes on its own (a Quick tunnel, re-issued on
   * every respawn). Automatic role resolution skips it (D860); an explicit
   * operator flag still honours it. Absent = stable.
   */
  stable: z.boolean().optional(),
})

/**
 * Where the advertised local port came from. Ordered most → least
 * authoritative, and the whole point of returning it: a client must be able to
 * tell a FACT about the hub's socket from an echo of its own guess.
 */
const LocalPortSourceEnum = z.enum([
  /** The hub's live `server.port` (the boot loader merges `CAMSTACK_PORT` into
   *  it). Authoritative — this IS the listening socket. */
  'server-config',
  /** `CAMSTACK_PORT` read straight off the environment, because the config
   *  section was unreachable. Still a server-side fact. */
  'server-env',
  /** The `port` the CALLER passed, echoed because the hub could not determine
   *  its own. Not a fact about the hub — a client must treat local URLs built
   *  on it as unverified, exactly as it must against a hub too old to answer. */
  'caller-hint',
  /** Nothing was knowable; the compiled-in boot default. */
  'default',
])

/** The port every LAN/loopback `baseUrl` in the same result was built with. */
const AdvertisedLocalPortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  source: LocalPortSourceEnum,
})
export type AdvertisedLocalPort = z.infer<typeof AdvertisedLocalPortSchema>

const GetConnectionEndpointsResultSchema = z.object({
  endpoints: z.array(ConnectionEndpointSchema).readonly(),
  /**
   * The port the hub built the LAN/loopback URLs with, and where that number
   * came from.
   *
   * Returned rather than merely applied, because "the URL is right" and "the
   * client can KNOW the URL is right" are different properties. A client that
   * only sees a corrected URL cannot distinguish a hub that fixed the port from
   * a hub that echoed the port the client sent, so it cannot decide whether to
   * race the candidate or discard it. With `source` it can: anything but
   * `caller-hint` is the hub's own socket.
   *
   * Absent on hubs predating this field — a client that finds it missing is
   * talking to an echoing hub and must degrade exactly as it does for
   * `caller-hint`.
   */
  localPort: AdvertisedLocalPortSchema,
})

/**
 * The address flagged for notification taps (`notificationTaps`). `baseUrl: null` = AUTO, which
 * since D709 is the CamStack app link; `resolved` reports the effective value,
 * so the UI can show it either way.
 */
const NotificationEndpointSchema = z.object({
  /** The operator's explicit choice, or null for AUTO. */
  baseUrl: z.string().nullable(),
  /**
   * The effective flagged address: the explicit choice, else (AUTO) the
   * CamStack app link `https://camstack.zentik.app` (D709). A pre-D709 hub
   * answered the public tunnel / mesh here, or null.
   */
  resolved: z.string().nullable(),
  /**
   * The hub origin an app link carries as `hub=` (D709): the hub's best
   * public HTTPS address — the tunnel, then the mesh (Tailscale MagicDNS) —
   * picked from this cap's own palette by `pickAppLinkHub`. `null` when the
   * hub advertises neither; the app link is then minted without `hub=`.
   * Absent on a pre-D709 hub.
   */
  appLinkHub: z.string().nullable(),
})
export type NotificationEndpoint = z.infer<typeof NotificationEndpointSchema>

/**
 * The URLs the SDK / viewer should race for API access. `baseUrls` empty =
 * AUTO (every LAN IPv4 + the public tunnel). `resolved` is what that choice
 * currently expands to, so the UI can show the effective set either way.
 */
const ViewerEndpointsSchema = z.object({
  /** The operator's explicit race set, or empty for AUTO. */
  baseUrls: z.array(z.string()).readonly(),
  /** What the ranking currently resolves to (may be empty if nothing is up). */
  resolved: z.array(z.string()).readonly(),
})
export type ViewerEndpoints = z.infer<typeof ViewerEndpointsSchema>

/**
 * DEPRECATED compatibility shape of `getHubAddresses` (D729 amendment, kept
 * for addons built against it): `cluster` is the `internal` role, `browser`
 * the `publicEndpoint` role; `override` is the flagged address.
 */
const HubAddressSnapshotSchema = z.object({
  override: z.string().nullable(),
  resolved: z.string().nullable(),
  source: z.enum(['override', 'auto', 'none']),
})

const HubAddressesSchema = z.object({
  cluster: HubAddressSnapshotSchema,
  browser: HubAddressSnapshotSchema,
})
export type HubAddresses = z.infer<typeof HubAddressesSchema>
export type HubAddressSnapshot = z.infer<typeof HubAddressSnapshotSchema>

/**
 * What an address is used for (`hub-address.ts`, D734). `appConnections` is
 * many-valued; `notificationTaps`, `publicEndpoint` and `internal` are carried
 * by at most one address.
 */
export const HubAddressRoleSchema = z.enum(HUB_ADDRESS_ROLES)

const RoleSourceSchema = z.enum(['flagged', 'auto', 'none'])

/** One single-valued role: the flagged address, the one in use, and why. */
const HubAddressRoleResolutionSchema = z.object({
  /** The address carrying the flag, or null = automatic. */
  flagged: z.string().nullable(),
  /** The address in use, or null when nothing qualifies (never loopback). */
  resolved: z.string().nullable(),
  source: RoleSourceSchema,
})

const HubAppConnectionsResolutionSchema = z.object({
  /** The addresses flagged `appConnections`, or empty = automatic. */
  flagged: z.array(z.string()).readonly(),
  /** What the apps race right now. */
  resolved: z.array(z.string()).readonly(),
  source: RoleSourceSchema,
})

/**
 * One row of the Network page's Addresses table: a detected endpoint, an
 * operator-entered custom address, or the CamStack app link — flagged the
 * same way. A URL that is both detected and entered is ONE row.
 */
const HubAddressRowSchema = ConnectionEndpointSchema.extend({
  /** In the hub's detected palette right now. */
  detected: z.boolean(),
  /** Entered by the operator (removable). */
  custom: z.boolean(),
  /** The roles explicitly flagged on this address. */
  flags: z.array(HubAddressRoleSchema).readonly(),
  /** The roles this address serves right now — flagged or automatic. */
  inUse: z.array(HubAddressRoleSchema).readonly(),
  /** The roles this address may be flagged with. */
  eligible: z.array(HubAddressRoleSchema).readonly(),
})
export type HubAddressRow = z.infer<typeof HubAddressRowSchema>

const HubAddressBookSchema = z.object({
  rows: z.array(HubAddressRowSchema).readonly(),
  roles: z.object({
    appConnections: HubAppConnectionsResolutionSchema,
    notificationTaps: HubAddressRoleResolutionSchema,
    internal: HubAddressRoleResolutionSchema,
    publicEndpoint: HubAddressRoleResolutionSchema,
  }),
  /** The `hub=` an app link carries (D709), or null. */
  appLinkHub: z.string().nullable(),
  /**
   * Every origin a browser can really reach this hub at, in the scheme each
   * listener serves: `https://<lan>:<httpsPort>`, and `http://<lan>:<httpPort>`
   * while LAN HTTP is on, plus the public and custom addresses. Distinct from
   * `rows`, which show `http://` only while LAN HTTP is on. Never loopback,
   * never the app link. Absent on a hub older than D794's amendment.
   */
  listenerOrigins: z.array(z.string()).readonly().optional(),
})
export type HubAddressBook = z.infer<typeof HubAddressBookSchema>

const AllowedAddressesSchema = z.object({
  /**
   * Allowlist of interface addresses operators have explicitly opted
   * into for the connection-endpoint race. Empty array = "auto" — every
   * non-loopback / non-link-local interface participates. Set by the
   * Network Addresses admin page and persisted by the addon.
   */
  addresses: z.array(z.string()).readonly(),
})

const TlsStatusSchema = z.object({
  mode: z.enum(['generated', 'uploaded', 'disabled']),
  leafFingerprintSha256: z.string().nullable(),
  caFingerprintSha256: z.string().nullable(),
  validTo: z.string().nullable(),
  sans: z.array(z.string()),
  caCertPem: z.string().nullable(),
  reissueError: z.string().nullable(),
  restartRequired: z.boolean(),
  /** An uploaded certificate is served but no CA is kept for it and it is not publicly signed (D873). */
  caMissing: z.boolean(),
  /** Does the hub's own generated CA carry a critical name constraint? `null` while it has none. */
  localCaConstrained: z.boolean().nullable(),
  /** ISO time the generated CA was replaced by a constrained one; devices must re-download it. */
  caReplacedAt: z.string().nullable(),
  /** The uploaded certificate kept on disk, selectable again after "Revert to generated". */
  storedUpload: z
    .object({
      leafFingerprintSha256: z.string(),
      validTo: z.string(),
      hasCa: z.boolean(),
    })
    .nullable(),
})

export const localNetworkCapability = {
  name: 'local-network',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** Return the current interface snapshot. */
    list: method(z.void(), ListResultSchema),

    /**
     * Auto-selected outbound interface. Heuristic:
     *   1. Skip internal / link-local / 169.254.*.
     *   2. Prefer LAN/wifi (real Ethernet) over docker/vpn.
     *   3. IPv4 wins over IPv6 (compat with legacy consumers).
     *   4. Tie-break on lowest CIDR mask (most-specific subnet).
     * Returns `null` only when the host has zero non-loopback addresses.
     * Honours `getAllowedAddresses()` — if the operator pinned an
     * allowlist, only those addresses are candidates.
     */
    getPreferred: method(z.void(), PreferredSchema),

    /**
     * Ordered candidate base URLs (the palette the Network tab shows).
     * Includes LAN IPv4, stable LAN IPv6, the public tunnel, and mesh when
     * joined. Loopback is off by default. The SDK races the subset from
     * `getViewerEndpoints`, not this full list — IPv6 stays here because
     * WebRTC ICE gathers dual-stack regardless of the HTTP race. Honours
     * `getAllowedAddresses()` when set — addresses outside the allowlist
     * are dropped (the public tunnel is still included as an escape hatch).
     *
     * **The port is the hub's, not the caller's** (D62 — a function's fact
     * belongs to whoever already owns it). This method used to take a `port`
     * and echo it onto every LAN and loopback URL it advertised, which made
     * every client a second authority on a socket only the hub binds. A viewer
     * configured with a port-less public URL (`https://camstack.example.top`)
     * infers 443 from the scheme, asks with 443, and was handed
     * `https://192.168.10.9:443` for a hub listening on 4443. That candidate
     * cannot ever answer, and losing its race reads in the log exactly like
     * "the LAN was tried and it was slower" — so an operator sitting on his own
     * WiFi stayed on the public tunnel for weeks, with the LAN candidate born
     * dead on every single connect.
     *
     * The hub now resolves its own listen port and reports it as `localPort`,
     * with the SOURCE of the number, so a client can tell a fact from an echo.
     *
     * Out of scope on purpose: a LAN URL that is not the hub's own socket (a
     * reverse proxy in front of it on another port) is not this method's to
     * invent either — pin it with `setNotificationEndpoint` / a configured
     * origin, which is an operator statement rather than a guess.
     */
    getConnectionEndpoints: method(
      z.object({
        /**
         * LEGACY HINT — do not send from new code. Kept optional so clients
         * written against the echoing contract keep working; the hub uses it
         * only when it cannot read its own port, and says so via
         * `localPort.source === 'caller-hint'`.
         */
        port: z.number().int().min(1).max(65535).optional(),
        /** Include `http(s)://127.0.0.1:<port>` as the lowest-priority
         *  candidate. Default `false` — loopback is not a client route. */
        includeLoopback: z.boolean().optional(),
        /** Skip IPv6 entries. Default `false` — the palette includes stable
         *  LAN IPv6 (ICE/WebRTC uses dual-stack regardless). Pass `true` to
         *  hide them. The viewer HTTP/WS race is `getViewerEndpoints`. */
        ipv4Only: z.boolean().optional(),
        /** Scheme to emit for LAN/loopback URLs. Default `'http'`.
         *  Pass `'https'` when the caller is itself loaded over HTTPS
         *  to avoid mixed-content blocks in the browser. The public
         *  tunnel always emits `https://` regardless. */
        scheme: z.enum(['http', 'https']).optional(),
        /** Append the CamStack app link entry (`kind: 'app-link'`, D709) —
         *  an address notification taps can be flagged with, not a hub
         *  route. Default `false`: racers and rankers never see it. */
        includeAppLink: z.boolean().optional(),
      }),
      GetConnectionEndpointsResultSchema,
    ),

    /**
     * The `notificationTaps` role (D734): where TAPPING a notification opens.
     * `baseUrl: null` means AUTO, which is the CamStack app link (D709): taps
     * go through `https://camstack.zentik.app/…?hub=<appLinkHub>` and open the
     * app. Any hub address the palette lists can be flagged instead; then a
     * tap opens that address. Only the tap: action buttons, attachment /
     * media links and admin links follow the `publicEndpoint` role
     * (`getAddresses().roles.publicEndpoint`), never this one.
     *
     * Why an explicit marker: the automatic ranking cannot know which of
     * several reachable addresses the RECIPIENT can actually open. A link is
     * consumed on someone's phone, off the LAN, possibly hours later — and a
     * link nobody can open is worse than no link, because the notification
     * arrives advertising media that 404s.
     */
    getNotificationEndpoint: method(z.void(), NotificationEndpointSchema),

    /**
     * @deprecated Use `setAddressRole({ role: 'notificationTaps', … })`. It
     * writes the same `notificationTaps` flag, with the same validation. `baseUrl: null` restores automatic; an
     * address that is not detected becomes a custom address.
     */
    setNotificationEndpoint: method(
      z.object({ baseUrl: z.string().nullable() }),
      NotificationEndpointSchema,
      { kind: 'mutation' },
    ),

    /**
     * The `appConnections` role as shipped apps read it: the flagged addresses
     * (detected or custom), or empty for AUTO — every LAN IPv4 address plus
     * the public tunnel, never IPv6, mesh, loopback or a custom address.
     * `resolved` is the set as it stands right now; the custom ones in it are
     * also in `getConnectionEndpoints`, which the apps filter by it.
     */
    getViewerEndpoints: method(z.void(), ViewerEndpointsSchema),

    /**
     * @deprecated Use `setAddressRole({ role: 'appConnections', … })`. It
     * replaces the same `appConnections` flags.
     * Empty `baseUrls` restores automatic.
     */
    setViewerEndpoints: method(
      z.object({ baseUrls: z.array(z.string()).readonly() }),
      ViewerEndpointsSchema,
      { kind: 'mutation' },
    ),

    /**
     * The Network page's Addresses table and every role's answer — the ONE
     * reading of "which address is this hub reached at, for what": detected
     * endpoints and custom addresses with their role flags, and per role the
     * flagged address, the one in use and whether it is automatic. Agent
     * deliveries and LAN devices read `roles.internal`; sign-in, OAuth2 and
     * the notification centre's buttons / media / admin links read
     * `roles.publicEndpoint`; nothing ranks the palette itself. `scheme` is
     * the one the caller shows LAN rows in (as `getConnectionEndpoints`);
     * `internal` and `publicEndpoint` are always resolved over the HTTPS
     * palette.
     */
    getAddresses: method(
      z.object({ scheme: z.enum(['http', 'https']).optional() }).optional(),
      HubAddressBookSchema,
    ),

    /**
     * Add a custom address. Validated: an http(s) origin with a host, no
     * credentials, no path, never loopback — an invalid one is refused with
     * the reason and nothing is stored. Adding an address that already exists
     * only updates its label.
     */
    addCustomAddress: method(
      z.object({ baseUrl: z.string(), label: z.string().max(80) }),
      HubAddressBookSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Remove a custom address. Its role flags go with it (those roles turn automatic). */
    removeCustomAddress: method(z.object({ baseUrl: z.string() }), HubAddressBookSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Flag (`enabled: true`) or unflag an address for a role. For a
     * single-valued role, flagging moves the flag off every other address.
     * `baseUrl: null` returns the role to automatic. The address must be a row
     * of the table (detected, custom, or the app link for `notificationTaps`);
     * `publicEndpoint` on a plain-http address is refused unless
     * `acceptInsecureHttp`, and never takes the app link.
     */
    setAddressRole: method(
      z.object({
        role: HubAddressRoleSchema,
        baseUrl: z.string().nullable(),
        enabled: z.boolean(),
        acceptInsecureHttp: z.boolean().optional(),
      }),
      HubAddressBookSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * @deprecated Read `getAddresses().roles.internal` / `.publicEndpoint`.
     * Kept so an addon built against the D729 amendment keeps resolving:
     * `cluster` = the `internal` role, `browser` = the `publicEndpoint` role.
     */
    getHubAddresses: method(z.void(), HubAddressesSchema),

    /**
     * Read the operator's allowlist. Empty = "auto" (no filter). Used
     * by the admin UI's address selector to seed its checkbox state.
     */
    getAllowedAddresses: method(z.void(), AllowedAddressesSchema),

    /**
     * Replace the allowlist atomically. Persisted via the addon store
     * (kernel-managed) so it survives restarts. Pass `[]` to revert to
     * auto mode.
     */
    setAllowedAddresses: method(AllowedAddressesSchema, z.object({ success: z.literal(true) }), {
      kind: 'mutation',
    }),

    /**
     * Re-run the boot heuristic over the current interface snapshot
     * and atomically replace the allowlist with the result. Useful
     * after a major network change (new dock, new VPN, IP rebound)
     * when the operator wants to wipe their manual edits and start
     * over from the auto-detected best matches.
     */
    resetAllowlistToBestMatch: method(z.void(), AllowedAddressesSchema, { kind: 'mutation' }),

    /**
     * Live TLS material for the Network → Local access certificate card.
     * LAN HTTP / hostname are addon settings (`globalSettingsSchema`), not
     * a second store — this query is status, not configuration.
     */
    getTlsStatus: method(z.void(), TlsStatusSchema),

    /** Issue a new leaf under the existing local CA. Disabled in uploaded mode. */
    regenerateCertificate: method(z.object({ reason: z.string().optional() }), TlsStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /**
     * Replace the served material with operator-supplied PEMs. A certificate that does not lead
     * to a public CA must come with its CA certificate, validated and kept for Download CA (D873).
     */
    uploadCertificate: method(
      z.object({
        certPem: z.string().min(1),
        keyPem: z.string().min(1),
        caPem: z.string().optional(),
      }),
      TlsStatusSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    /** The local CA PEM, or empty when there is none to download. */
    downloadCa: method(z.void(), z.object({ pem: z.string() })),

    /**
     * Serve the kept upload again after "Revert to generated" (D873). Refused when none is kept.
     */
    useStoredUploadedCertificate: method(z.void(), TlsStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Return to the generated local CA. The uploaded certificate stays stored (D873). */
    revertToGeneratedCertificate: method(z.void(), TlsStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'hub-only' },
} as const satisfies CapabilityDefinition

export type ILocalNetworkProvider = InferProvider<typeof localNetworkCapability>
export type LocalInterface = z.infer<typeof LocalInterfaceSchema>
export type ConnectionEndpoint = z.infer<typeof ConnectionEndpointSchema>
