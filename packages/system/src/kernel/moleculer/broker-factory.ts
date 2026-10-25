import { ServiceBroker, type Middleware } from 'moleculer'
import {
  DEFAULT_HUB_TLS_TCP_PORT,
  type MeshTlsMaterial,
  TlsTcpTransporter,
} from './mesh-mtls/index.js'

interface BrokerConfig {
  readonly nodeID: string
  readonly mode: 'hub' | 'agent' | 'test'
  readonly hubAddress?: string
  readonly logLevel?: string
  // No `secret` (D797). The cluster secret used to double as the Moleculer
  // NAMESPACE — which the TCP transporter never checks and UDP discovery
  // broadcasts in clear every 5 s, so it isolated nothing and leaked the
  // secret on the LAN. The secret now gates only `$hub.registerNode` (a hash,
  // never the value); the hub reads it from the keychain at call time.
  /**
   * TCP port the hub listens on for cluster traffic.
   * Agents connect to it via `urls: 'hub@host:port'` — there is no UDP
   * discovery (D826, D843).
   */
  readonly tcpPort?: number
  /**
   * Second hub listen port for mesh mTLS (Release A). Default 6443.
   * Clear traffic stays on {@link tcpPort}; enrolled agents dial this.
   */
  readonly tlsPort?: number
  /**
   * Explicit TCP port for the agent's own Moleculer reader to bind.
   * When omitted, the port is derived deterministically from `nodeID`
   * (see `deriveAgentListenPort`). Set this only to resolve a port
   * collision between two agents that happen to hash to the same port
   * on one host.
   */
  readonly agentListenPort?: number
  /**
   * Port an ENROLLED agent listens on for the hub's mutual-TLS dial (default
   * 6443). It is advertised to the hub in every gossip HELLO, so two
   * nodes on one host (a dev or test cluster) need not collide on 6443.
   */
  readonly agentTlsListenPort?: number
  /**
   * Broker middlewares (D802): the hub passes its mesh gate
   * (`createMeshAccessMiddleware`); an agent passes inbound access
   * (`AgentMeshAuthenticator` + the same middleware) and its outbound join
   * gate (`MeshJoinClient.middleware`). They must be given at construction —
   * Moleculer wraps action handlers when services register.
   */
  readonly middlewares?: readonly Middleware[]
  /**
   * Mesh mTLS material. On the hub, enables the TLS listener (may also be
   * attached later via {@link getBrokerTlsTransporter}). On an agent, dials
   * the hub's TLS port (6443) instead of clear 6000.
   */
  readonly meshTls?: MeshTlsMaterial
}

/** Default fixed TCP port for hub-agent cluster traffic. */
const DEFAULT_HUB_TCP_PORT = 6000

/**
 * Band of TCP ports an agent's Moleculer reader may bind to. Chosen high
 * enough to sit clear of the hub's fixed 6000 and typical service ports,
 * and well below the OS ephemeral range so a deterministically-chosen
 * port does not collide with short-lived outbound sockets.
 */
const AGENT_PORT_BASE = 20000
const AGENT_PORT_SPAN = 10000

/**
 * Derive a STABLE Moleculer reader port for an agent from its nodeID.
 *
 * Moleculer's TCP transporter keeps disconnected nodes in its
 * `NodeCatalog` (it never deletes them) and `processGossipHello` only
 * adopts a node's host/port when the node is unknown — a reconnecting
 * node's address is therefore never refreshed. With an OS-assigned
 * EPHEMERAL reader port (`port: 0`) every agent restart picks a new
 * port, so after a kill+restart under the SAME nodeID the hub (and every
 * forked group-runner that gossiped about the agent) keeps the DEAD port
 * and can never deliver the `GOSSIP_RESPONSE` carrying its INFO. The
 * agent then never re-discovers the hub's services and `ctx.api.*` calls
 * (e.g. the early `settings-store.get` in `bootCoreAddons`) poll service
 * discovery forever.
 *
 * Binding a port DERIVED FROM the nodeID makes the agent reconnect at the
 * SAME address every restart — exactly like the hub's fixed 6000 — so the
 * stale catalog entries everywhere still point at a live socket and
 * Moleculer's gossip seq self-healing completes the handshake. The nodeID
 * is the agent's persisted stable identity, so the port is stable too.
 */
function deriveAgentListenPort(nodeID: string): number {
  // FNV-1a — small, deterministic, well-distributed for short strings.
  let hash = 0x811c9dc5
  for (let i = 0; i < nodeID.length; i++) {
    hash ^= nodeID.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return AGENT_PORT_BASE + (Math.abs(hash) % AGENT_PORT_SPAN)
}

/**
 * Whether Moleculer's TCP transporter should address peer nodes by their OS
 * hostname (`os.hostname()`) or by IP. `getNodeAddress` (moleculer
 * transporters/tcp.js) returns `node.hostname` when this is true (the
 * library default), else `node.ipList[0]`.
 *
 * Default TRUE: in the common all-on-one-machine topology the OS hostname
 * resolves to loopback (`::1`/`127.0.0.1`), so hostname addressing keeps
 * sibling nodes talking over loopback — fast and reliable. Addressing by IP
 * is worse here: `getIpList()` excludes loopback, so a same-machine peer
 * advertises its LAN IP and connections route out to the router and
 * `ETIMEDOUT`. The one hazard is a transient unresolvable hostname (macOS
 * falling back to `<name>.localdomain` when `HostName` is unset and DHCP
 * advertises `domain=localdomain`) — pin the hostname to loopback (e.g. an
 * `/etc/hosts` entry) to neutralise it. Set
 * `CAMSTACK_MOLECULER_USE_HOSTNAME=false` to force IP addressing for
 * cross-machine deployments that route by IP rather than DNS name.
 */
function resolveUseHostname(): boolean {
  return process.env['CAMSTACK_MOLECULER_USE_HOSTNAME'] !== 'false'
}

function createBroker(config: BrokerConfig): ServiceBroker {
  const { nodeID, mode, logLevel = 'warn', tcpPort = DEFAULT_HUB_TCP_PORT } = config
  const useHostname = resolveUseHostname()
  // The transporter/transit/gossip loggers are pinned to 'error'; everything
  // else follows the node's log level.
  const infraLevel = 'error'
  const wildcardLevel = logLevel

  if (mode === 'test') {
    return new ServiceBroker({
      nodeID,
      transporter: 'Fake',
      logger: false,
      metrics: { enabled: false },
    })
  }

  const metricsConfig = {
    enabled: true,
    reporter: [
      { type: 'Event' as const, options: { eventName: '$metrics.snapshot', interval: 5 } },
    ],
  }

  if (mode === 'hub') {
    // D826: hub mesh is TLS-only on `tlsPort` once the mesh CA is ready — no
    // clear `tcpPort` listener and no UDP discovery on the hub.
    const transporter = new TlsTcpTransporter({
      port: tcpPort,
      tlsPort: config.tlsPort ?? DEFAULT_HUB_TLS_TCP_PORT,
      maxPacketSize: 10 * 1024 * 1024,
      useHostname,
      hubTlsOnly: true,
      udpDiscovery: false,
      debug: false,
      ...(config.meshTls !== undefined ? { meshTls: config.meshTls } : {}),
    })
    return new ServiceBroker({
      nodeID,
      serializer: 'MsgPack',
      // Moleculer's BrokerOptions.transporter union omits TCP subclasses.
      // @ts-expect-error Release A: TlsTcpTransporter is a TcpTransporter subclass.
      transporter,
      ...(config.middlewares !== undefined ? { middlewares: [...config.middlewares] } : {}),
      logger: {
        type: 'Console',
        options: {
          level: {
            BROKER: infraLevel,
            TRANSPORTER: infraLevel,
            TRANSIT: infraLevel,
            REGISTRY: infraLevel,
            DISCOVERER: infraLevel,
            '**': wildcardLevel,
          },
        },
      },
      metrics: metricsConfig,
    })
  }

  // agent mode
  const transport = createAgentTransport(config)
  return new ServiceBroker({
    nodeID,
    serializer: 'MsgPack',
    // Moleculer's BrokerOptions.transporter union omits TCP subclasses.
    // @ts-expect-error Release A: TlsTcpTransporter is a TcpTransporter subclass.
    transporter: transport.transporter,
    ...(config.middlewares !== undefined ? { middlewares: [...config.middlewares] } : {}),
    logger: {
      type: 'Console',
      options: {
        level: {
          BROKER: infraLevel,
          TRANSPORTER: infraLevel,
          TRANSIT: infraLevel,
          REGISTRY: infraLevel,
          DISCOVERER: infraLevel,
          '**': wildcardLevel,
        },
      },
    },
    metrics: metricsConfig,
  })
}

/** What an agent's transport is made of: always the mTLS transporter (D857). */
interface AgentTransport {
  readonly kind: 'tls'
  readonly transporter: TlsTcpTransporter
}

/**
 * The transport of an agent broker, from its config. An agent with no hub address dials nobody
 * and stays `unconfigured` until one is set (the agent UI lists the hubs found over mDNS, D839).
 * There is no UDP discovery to fall back on (D843).
 *
 * The reader binds a STABLE port derived from the nodeID (not an OS-ephemeral `port: 0`). See
 * `deriveAgentListenPort` - this is what makes a same-nodeID kill+restart reconnect cleanly:
 * Moleculer never refreshes a known node's address, so the agent must return at the same address
 * it left from.
 *
 * Shared by `createBroker` (the first transport) and the in-place reconnect
 * (`broker-transport-swap.ts`, the next one): one builder, so a reconnect cannot dial differently
 * from a boot.
 */
function createAgentTransport(config: BrokerConfig): AgentTransport {
  const { nodeID, hubAddress, tcpPort = DEFAULT_HUB_TCP_PORT } = config
  const useHostname = resolveUseHostname()
  const agentListenPort = config.agentListenPort ?? deriveAgentListenPort(nodeID)
  const hubDialPort =
    config.meshTls !== undefined ? (config.tlsPort ?? DEFAULT_HUB_TLS_TCP_PORT) : tcpPort

  // The agent never serves a clear reader, paired or not (D857): an unpaired agent has no
  // certificate, so its transporter reaches nobody and accepts no packet; a paired one dials
  // the hub over mTLS, listens for the hub's mTLS dial only and has no other mesh peer (D848).
  // A plain Moleculer TCP reader on 0.0.0.0 would hand any LAN host a msgpack REQUEST.
  const urls = hubAddress !== undefined ? normalizeHubUrl(hubAddress, hubDialPort) : undefined
  return {
    kind: 'tls',
    transporter: new TlsTcpTransporter({
      port: agentListenPort,
      tlsPort: config.agentTlsListenPort ?? DEFAULT_HUB_TLS_TCP_PORT,
      peerTlsPort: hubDialPort,
      hubOnlyPeers: true,
      maxPacketSize: 10 * 1024 * 1024,
      useHostname,
      debug: false,
      ...(config.meshTls !== undefined ? { meshTls: config.meshTls } : {}),
      udpDiscovery: false,
      ...(urls !== undefined ? { urls } : {}),
    }),
  }
}

function normalizeHubUrl(raw: string, defaultPort: number): string {
  // Moleculer TCP transporter expects `host:port/nodeID`.
  // Accept friendly inputs: "host", "host:port", "host:port/nodeID",
  //   "nodeID@host", "nodeID@host:port".
  const atSplit = raw.includes('@') ? raw.split('@') : null
  const nodeIdFromAt = atSplit ? atSplit[0] : null
  const rest = atSplit ? atSplit[1]! : raw

  const slashSplit = rest.includes('/') ? rest.split('/') : null
  const hostPort = slashSplit ? slashSplit[0]! : rest
  const nodeIdFromSlash = slashSplit ? slashSplit[1] : null

  const nodeId = nodeIdFromSlash ?? nodeIdFromAt ?? 'hub'
  const hasPort = /:\d+$/.test(hostPort)
  const finalHostPort = hasPort ? hostPort : `${hostPort}:${defaultPort}`
  return `${finalHostPort}/${nodeId}`
}

/** The hub's {@link TlsTcpTransporter}, or null when the broker is not mesh-TLS. */
function getBrokerTlsTransporter(broker: ServiceBroker): TlsTcpTransporter | null {
  const tx = (broker as { transit?: { tx?: unknown } }).transit?.tx
  return tx instanceof TlsTcpTransporter ? tx : null
}

export {
  createAgentTransport,
  createBroker,
  deriveAgentListenPort,
  getBrokerTlsTransporter,
  normalizeHubUrl,
}
export type { AgentTransport, BrokerConfig }
