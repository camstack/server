/**
 * mesh-network — collection cap for mesh-VPN providers.
 *
 * Different shape from `network-access` (public tunnels):
 *
 *   • `network-access` exposes ONE public URL the operator hands to
 *     external clients. start/stop spawns a single edge process.
 *
 *   • `mesh-network` joins the host into a private mesh (Tailscale,
 *     Headscale, ZeroTier). The result is one or more *private*
 *     endpoints (mesh IP `100.x.x.x`, MagicDNS hostname) reachable
 *     only by peers on the same mesh. Optionally, providers that
 *     support it (Tailscale Funnel / Serve) also expose a public
 *     ingress for select ports.
 *
 * Per-provider access from the admin UI uses this collection cap's
 * generic per-`addonId` routing (every method accepts an optional
 * `addonId`) — there is no singleton facade cap.
 */
import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * A reachable endpoint on the mesh. A single provider may expose
 * multiple (mesh IP + MagicDNS hostname + Funnel public URL).
 */
const MeshEndpointSchema = z.object({
  /** Stable identifier within the provider (e.g. `mesh-ipv4`, `magicdns`, `funnel`). */
  id: z.string(),
  /** Operator-facing label (e.g. "Mesh IPv4", "MagicDNS"). */
  label: z.string(),
  /**
   * Where the endpoint is reachable from:
   *   - `mesh`: only peers on the same mesh (Tailscale tailnet, …)
   *   - `public`: open internet (Funnel, public-tunnel pass-through)
   */
  scope: z.enum(['mesh', 'public']),
  /** Full base URL (e.g. `https://camstack.tail-abc.ts.net`). */
  url: z.string(),
  /** Hostname portion (for SAN cert checks + display). */
  hostname: z.string(),
  /** Port (`443` for Funnel/Serve, anything for raw mesh IP). */
  port: z.number(),
  /** Always `http` or `https`. */
  protocol: z.enum(['http', 'https']),
})

export type MeshEndpoint = z.infer<typeof MeshEndpointSchema>

export const MeshPeerSchema = z.object({
  /** Stable peer id assigned by the mesh control plane. */
  id: z.string(),
  /** Hostname / device name as shown in the mesh dashboard. */
  hostname: z.string(),
  /** MagicDNS / mesh DNS name (e.g. `peer-foo.tail-abc.ts.net`). Empty when the provider doesn't support DNS or peer-side resolution is disabled. */
  magicDns: z.string(),
  /** Mesh IPv4 / IPv6 addresses combined. Multiple when dual-stacked. */
  addresses: z.array(z.string()).readonly(),
  /** Operating system reported by the peer (informational). */
  os: z.string().optional(),
  /** Whether this peer is currently reachable. */
  online: z.boolean(),
  /** Last-seen timestamp (epoch ms). 0 when never seen. */
  lastSeenMs: z.number(),
  /** True for the row representing the current host. */
  isSelf: z.boolean(),
  /**
   * Connection mode to this peer:
   *   - `direct`: NAT-traversed P2P (UDP punched)
   *   - `relay`: traffic relayed through provider edge (Tailscale DERP)
   *   - `idle`: peer reachable but no recent traffic / handshake
   */
  connection: z.enum(['direct', 'relay', 'idle']),
  /** DERP region / relay node identifier when `connection: relay`. Null otherwise. */
  relay: z.string().nullable(),
  /** Last successful handshake timestamp (epoch ms). 0 when never. */
  lastHandshakeMs: z.number(),
  /** Bytes received from this peer since the daemon started. */
  rxBytes: z.number(),
  /** Bytes transmitted to this peer since the daemon started. */
  txBytes: z.number(),
  /** ACL tags this peer carries (e.g. `["tag:server"]`). Empty when human-owned. */
  tags: z.array(z.string()).readonly(),
  /** True when the peer advertises itself as an exit-node candidate. */
  exitNodeOption: z.boolean(),
  /** Subnet routes the peer advertises (e.g. `["192.168.10.0/24"]`). */
  advertisedRoutes: z.array(z.string()).readonly(),
  /** Owner account login (e.g. `foo@example.com`). Null for tagged peers. */
  userLogin: z.string().nullable(),
  /** Pre-auth key / machine-key expiry (epoch ms). Null when keys don't expire. */
  keyExpiry: z.number().nullable(),
})

export type MeshPeer = z.infer<typeof MeshPeerSchema>

export const MeshStatusSchema = z.object({
  /** True when the host is joined and the daemon reports healthy. */
  joined: z.boolean(),
  /** Local mesh IPv4 (e.g. `100.x.x.x` for Tailscale). Empty when not joined. */
  meshIp: z.string(),
  /** MagicDNS / mesh hostname (e.g. `camstack.tail-abc.ts.net`). Empty if not configured. */
  magicDnsHostname: z.string(),
  /** Number of peers visible to this host (excluding self). */
  peerCount: z.number(),
  /** Every endpoint this provider exposes for the current host. */
  endpoints: z.array(MeshEndpointSchema).readonly(),
  /** Last error from the daemon, when not joined. */
  error: z.string().optional(),

  // ── Account / tenant identity (generic across providers) ────────
  /**
   * Tenant / tailnet / network display name (Tailscale = tailnet
   * domain, Headscale = namespace, ZeroTier = network name). Empty
   * pre-join. Per-provider semantics, common slot.
   */
  tenantName: z.string(),
  /**
   * Mesh DNS suffix when the provider exposes peer-resolvable DNS
   * (Tailscale MagicDNS, Headscale MagicDNS, …). Empty when the
   * provider doesn't ship DNS (e.g. ZeroTier).
   */
  magicDnsSuffix: z.string(),
  /**
   * Authenticated user / account login bound to this host. Null when
   * the provider authenticates with a long-lived network token rather
   * than a user account (e.g. ZeroTier API token).
   */
  userLogin: z.string().nullable(),
  /**
   * Provider control-plane URL (Tailscale SaaS `https://login.tailscale.com`,
   * self-hosted Headscale, ZeroTier Central, …). Empty when not
   * applicable (rare).
   */
  controlPlaneUrl: z.string(),
  /**
   * Machine-key / node-key expiry (epoch ms). Null when the provider
   * doesn't rotate keys for the bound host. Operator-facing surface
   * for "your access expires on …" banners.
   */
  keyExpiry: z.number().nullable(),

  // ── Onboard-daemon handoff (Tailscale, generic slot) ────────────
  /**
   * When the provider runs its OWN mesh daemon (e.g. the Tailscale
   * client addon in `onboard` mode spawns a private `tailscaled`),
   * this carries the local control-socket path. Companion addons that
   * must drive the SAME daemon — chiefly `tailscale-ingress` for
   * Serve/Funnel — read it to point their CLI at the right socket
   * instead of the system default. Empty when the provider uses the
   * host's system daemon (or doesn't have the concept).
   */
  daemonSocket: z.string().optional(),
  /**
   * Path to the mesh CLI binary the provider downloaded for onboard
   * mode. Companion addons reuse it so they don't need a system
   * install when the operator chose a fully self-contained mesh.
   * Empty in host mode.
   */
  daemonCliPath: z.string().optional(),
})

export type MeshStatus = z.infer<typeof MeshStatusSchema>

// Provider-specific runtime flags (accept-routes, advertise-routes,
// shields-up, ssh, exit-node, etc.) intentionally NOT in the cap
// schema — they vary too much between Tailscale / Headscale / ZeroTier /
// Nebula. Each addon declares those via its own `getSettingsUISchema`
// (form-builder), which the generic Mesh page renders as a "Settings"
// tab below the addon's status / peers tabs.

/**
 * `mesh-network` — per-provider implementation. Tailscale registers
 * one (and only one) entry. Future Headscale / ZeroTier addons would
 * register their own entries.
 */
export const meshNetworkCapability = {
  name: 'mesh-network',
  scope: 'system',
  mode: 'collection',
  providerKind: 'mesh',
  methods: {
    /** Return the current join state + endpoints + peer count. Cheap
     *  poll-target — admin UI hits this every few seconds. */
    getStatus: method(z.void(), MeshStatusSchema),

    /**
     * Join the host to the provider's mesh using a one-time auth key
     * (generated by the operator in the provider's admin dashboard).
     * Implementations should be idempotent — re-calling with the same
     * key while already joined is a no-op + success.
     */
    join: method(
      z.object({
        /** Provider-specific auth key. For Tailscale this is the
         *  `tskey-auth-*` token from admin.tailscale.com. */
        authKey: z.string().min(8),
        /** Optional hostname override the host should advertise. */
        hostname: z.string().optional(),
      }),
      z.object({ joined: z.literal(true) }),
      { kind: 'mutation' },
    ),

    /**
     * Start an interactive browser-redirect login flow.
     *
     * The provider spawns its daemon's join command without a pre-auth
     * key, captures the verification URL the daemon prints, and returns
     * it. The admin UI opens the URL in a new tab; the user completes
     * authentication in the provider's web console and the background
     * process self-terminates. The caller then polls `getStatus()` until
     * `joined: true`.
     *
     * Mirrors the `tailscale up` (no `--auth-key`) flow.
     */
    startLogin: method(
      z.object({
        /** Optional hostname override the host should advertise once joined. */
        hostname: z.string().optional(),
      }),
      z.object({
        /** Authentication URL the operator should open in a browser. */
        loginUrl: z.string(),
      }),
      { kind: 'mutation' },
    ),

    /** Leave the mesh. After this the meshIp/magicDnsHostname/etc.
     *  vanish until the next `join`. The bound account stays — a
     *  subsequent `join` reuses it without prompting for a new login. */
    leave: method(z.void(), z.object({ left: z.literal(true) }), { kind: 'mutation' }),

    /**
     * Sign out of the mesh account entirely. Distinct from `leave`:
     * `leave` only takes the host off-mesh (`tailscale down`) while the
     * account binding survives, so the next `join` reconnects silently.
     * `logout` (`tailscale logout`) wipes the daemon's stored
     * credentials — the next `startLogin` MUST go through a fresh
     * browser-redirect flow to bind a new account.
     */
    logout: method(z.void(), z.object({ loggedOut: z.literal(true) }), { kind: 'mutation' }),

    /** Enumerate every peer the daemon currently knows about. */
    listPeers: method(
      z.void(),
      z.object({
        peers: z.array(MeshPeerSchema).readonly(),
      }),
    ),

    /**
     * Probe the mesh daemon / API for a sanity check WITHOUT joining.
     * Operator-facing "test connection" button: validates the auth key
     * + reaches the control plane and reports back what would happen
     * on join.
     *
     * Tailscale: dry-runs `tailscale up --auth-key=… --reset` against
     * an idempotency probe; for an already-joined node it just returns
     * the current status.
     */
    testConnection: method(
      z.object({
        /** Optional auth key — when provided, probes the key validity
         *  against the provider's API. Omit when already joined to
         *  just ping the daemon. */
        authKey: z.string().optional(),
      }),
      z.object({
        ok: z.boolean(),
        /** Provider-side identifier resolved by the probe (tailnet
         *  name for Tailscale, network id for ZeroTier, etc.). */
        tenant: z.string().optional(),
        /** Daemon binary version, when reachable. */
        daemonVersion: z.string().optional(),
        /** Human-readable error when `ok: false`. */
        error: z.string().optional(),
      }),
      { kind: 'mutation' },
    ),

    // Provider-specific runtime knobs (accept-routes / advertise-routes /
    // shields-up / ssh / exit-node, …) live on the addon's own
    // `getSettingsUISchema` (form-builder), NOT here. Different mesh
    // providers (Tailscale, Headscale, ZeroTier, Nebula) have very
    // different config surfaces — picking one shape and forcing all
    // implementations to honour it would either lose options or
    // misrepresent them. The Mesh page renders the addon's settings
    // schema as a "Settings" tab next to the generic Status / Peers
    // tabs driven by this cap.
  },
} as const satisfies CapabilityDefinition

export type IMeshNetworkProvider = InferProvider<typeof meshNetworkCapability>
