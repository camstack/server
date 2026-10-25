/**
 * Agent HTTP server -- lightweight Fastify instance for agent status,
 * process management, config editing, and static UI serving.
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { z } from 'zod'
import type { ServiceBroker } from 'moleculer'
import {
  type AgentPairing,
  caFingerprintCompact,
  loadAgentHttps,
  UnlockTicketJtiStore,
  verifyAgentUiUnlockTicket,
} from '@camstack/system'
import { type SniffingListener, startSniffingListener } from './agent-sniffing-listener.js'
import {
  isAuthorizedAgentRequest,
  authInputOf,
  isPairingProtocolRequest,
  isUnlockInfoRequest,
  isUnlockSessionRequest,
} from './agent-http-auth.js'
import { registerAgentPairingRoutes } from './agent-pairing-routes.js'
import { isAgentPaired, pinnedMeshCaCert } from './agent-pairing-store.js'
import { writeOwnerOnlyFileSync } from '@camstack/types/node'
import type { AgentUpdateControls } from './agent-update-routes.js'
import { registerAgentUpdateRoutes } from './agent-update-routes.js'
import type { HubRegistryNode } from './derive-hub-url.js'
import { deriveHubUrlFromHubAddress, pickIpv4 } from './derive-hub-url.js'
import { addonsFromStatus, joinAddonRuntime, processesFromList } from './agent-addon-runtime.js'
import { createHubsFinder, type HubsFinder } from './hubs-found.js'
import { PRODUCT_VERSION_ENV, releaseIdentityFrom } from '../core/release-identity.js'

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/** The hub an agent is paired with: where it is and the CA it pinned (D857). */
export interface PairedHubInfo {
  readonly url: string | null
  readonly caFingerprint: string
}

/** The pinned CA's fingerprint, or `null` when none is pinned or the PEM cannot be read. */
export function describePairedHub(
  pinnedCa: string | null,
  hubHttpsOrigin: string | null,
): PairedHubInfo | null {
  if (pinnedCa === null) return null
  try {
    return {
      url: hubHttpsOrigin,
      caFingerprint: caFingerprintCompact(pinnedCa),
    }
  } catch {
    return null
  }
}

/**
 * Discriminated hub connection state surfaced by the agent status API.
 *
 * - `connected`      — hub node is in the Moleculer registry (available).
 * - `unpaired`       — this agent holds no mesh certificate: a hub must pair it (D857).
 * - `unconfigured`   — paired but no hub address configured and no hub connected.
 * - `disconnected`   — direct address configured but hub not in registry.
 * - `certificate-rejected` — the hub refused `$hub.registerNode` because it does not accept
 *   this agent's certificate (revoked, or issued by another CA): pair it again (D857).
 *
 * `registering` (transport up but registerNode not yet acked) is not
 * currently deterministic from the broker registry alone — it would require
 * a tighter integration with the retry loop. Omitted until a clean signal
 * exists; the brief gap is invisible at 3 s poll rate.
 */
export type HubConnectionState =
  | 'connected'
  | 'unpaired'
  | 'unconfigured'
  | 'disconnected'
  | 'certificate-rejected'

/** How this agent reaches the hub: `tls` once mesh mTLS material is loaded, else `clear`. */
export type AgentMeshTransport = 'tls' | 'clear'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The agent's logger for the certificate paths (the boot logger the bootstrap already has). */
export interface AgentHttpLog {
  info(message: string, extras?: { meta?: Record<string, unknown> }): void
  warn(message: string, extras?: { meta?: Record<string, unknown> }): void
  error(message: string, extras?: { meta?: Record<string, unknown> }): void
}

export interface AgentHttpConfig {
  readonly log?: AgentHttpLog
  readonly port: number
  readonly nodeId: string
  readonly dataDir: string
  readonly configPath: string
  /** Called when the UI requests a reconnect (hub address / mesh material changed). */
  readonly onReconnect?: () => Promise<void>
  /**
   * Optional getter for the current hub connection state. When provided,
   * the status endpoint uses this to surface a richer discriminated state
   * instead of the legacy boolean `hubConnected`. The bootstrap wires this
   * to expose `certificate-rejected` which is not derivable from the broker
   * registry alone.
   */
  readonly getHubConnectionState?: () => HubConnectionState
  /**
   * Whether the RUNNING broker dials the hub over mTLS (material loaded) —
   * wired by the bootstrap. Without it the status falls back to whether
   * `agent.json` holds mesh material.
   */
  readonly getMeshTransport?: () => AgentMeshTransport
  /**
   * Framework + addon update surface (`/api/agent/server-update*`,
   * `/api/agent/addon-updates`). Injected by the agent bootstrap, which owns
   * the `AgentUpdateService` and the addons dir. Omitted in tests and on
   * builds without an update engine — the routes then answer
   * `{ available: false, reason }` so the UI states WHY instead of rendering
   * a dead button.
   */
  readonly updateControls?: AgentUpdateControls
  /**
   * Running `@camstack/server` version. The product release is read from
   * `CAMSTACK_PRODUCT_VERSION` and is not this value (D943).
   */
  readonly serverVersion?: string | null
  /** Test seam for the hubs-on-this-network scan (no multicast, no network). */
  readonly hubsFinder?: HubsFinder
  /**
   * Pairing (D857): when present, the pairing protocol routes are mounted and the agent is
   * "paired" exactly while `agent.json` holds mesh material.
   */
  readonly pairing?: AgentPairing
  /** Leave the hub: erase the mesh material and reconnect unpaired (D857). */
  readonly onForgetHub?: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A candidate agent-ui `dist/` dir plus the owning package's version. */
export interface UiDistCandidate {
  readonly dir: string
  readonly version: string | null
}

/** Dotted-numeric version compare; `null` sorts lowest. */
export function compareVersions(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0)
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Read an agent-ui package dir (`<base>/package.json` + `<base>/dist/index.html`)
 * into a candidate. Returns `null` when the dist is absent/unusable.
 */
export function readUiDistCandidate(baseDir: string): UiDistCandidate | null {
  const dir = path.join(baseDir, 'dist')
  if (!fs.existsSync(path.join(dir, 'index.html'))) return null
  let version: string | null = null
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(baseDir, 'package.json'), 'utf-8')) as {
      readonly version?: unknown
    }
    version = typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    version = null
  }
  return { dir, version }
}

/**
 * Pick between the dataDir-installed copy and the app-bundled copy: the
 * NEWER version wins; on a tie the installed copy wins (it is the one
 * `camstack deploy` updates).
 *
 * Rationale: bootstrap addon install is seed-only (first boot), so a
 * packaged desktop app that ships a newer agent-ui in its resources would
 * otherwise keep serving the UI frozen at whatever version was first
 * installed (observed live: an app at v1.1.27 serving the v1.1.1 UI).
 *
 * This is the ONE runtime reader of `CAMSTACK_BUNDLED_ADDONS_DIR` that reads a
 * package OUT of it (the rest only seed from it, or use it to locate the
 * Electron Resources root). It reads the bundled copy in place and serves it
 * over `@fastify/static` — so which dir that variable names is load-bearing
 * here, not just at first boot.
 */
export function pickUiDist(
  installed: UiDistCandidate | null,
  bundled: UiDistCandidate | null,
): string | null {
  if (installed && bundled) {
    return compareVersions(bundled.version, installed.version) > 0 ? bundled.dir : installed.dir
  }
  return installed?.dir ?? bundled?.dir ?? null
}

export function resolveUiDistDir(
  dataDir: string,
  // `CAMSTACK_BUNDLED_ADDONS_DIR` — a dir of package dirs keyed by SHORT name
  // (`<dir>/addon-agent-ui`), the same shape `AddonInstaller.findLocalPackage`
  // joins onto. On a packaged desktop that is the closure's own scope dir,
  // `Contents/Resources/node_modules/@camstack`; it was a second, hand-copied
  // `Contents/Resources/addons` tree until 2026-08-25.
  bundledAddonsDir?: string,
): string | null {
  // REMOVED 2026-09-17: a sibling `dist/` resolved out of the server closure,
  // `path.resolve(__dirname, '../../addon-agent-ui/dist')`, returned with
  // absolute priority before the installed copy was looked at. Its comment
  // claimed it was "always version-matched to the agent"; `pickUiDist` below
  // exists because it was not. It was the only runtime consumer on any role
  // that read an addon out of the closure, and an addon is loaded from the
  // addon root — see `scripts/check-addon-root-is-the-only-load-path.ts` (D518).

  const installed = readUiDistCandidate(path.join(dataDir, 'addons', '@camstack', 'addon-agent-ui'))
  const bundled = bundledAddonsDir
    ? readUiDistCandidate(path.join(bundledAddonsDir, 'addon-agent-ui'))
    : null
  const picked = pickUiDist(installed, bundled)
  if (picked) return picked

  const legacy = path.join(dataDir, 'agent-ui')
  if (fs.existsSync(path.join(legacy, 'index.html'))) return legacy
  return null
}

function readConfigFile(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {}
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** agent.json holds the agent's private mesh key (D857): owner-only on every OS. */
function writeConfigFile(configPath: string, data: Record<string, unknown>): void {
  writeOwnerOnlyFileSync(configPath, JSON.stringify(data, null, 2))
}

// Registry-node shape shared with the CAMSTACK_HUB_URL derivation
// (`deriveHubUrlFromRegistry`) so the UI's `resolvedHubAddress` and the
// exported env var read the exact same registry view.
type RegistryNode = HubRegistryNode

/** Live Moleculer registry snapshot — reused by agent-bootstrap's Option A. */
export function getRegistryNodes(broker: ServiceBroker): readonly RegistryNode[] {
  try {
    return broker.registry.getNodeList({ onlyAvailable: true }).map((node) => ({
      id: node.id,
      ...(node.hostname != null ? { hostname: node.hostname } : {}),
      ...(node.ipList != null ? { ipList: node.ipList } : {}),
    }))
  } catch {
    return []
  }
}

// `pickIpv4` moved to derive-hub-url.ts (single home shared with
// `deriveHubUrlFromRegistry`); re-exported here to preserve this module's API.
export { pickIpv4 }

/**
 * A human-readable, reachable address for the hub node as the agent actually
 * sees it in the Moleculer registry. Used to fill in the effective address
 * even in UDP-discovery mode where no address was manually configured.
 */
export function resolveHubEndpoint(nodes: readonly RegistryNode[]): string | null {
  const hub = nodes.find((n) => n.id === 'hub')
  if (!hub) return null
  return pickIpv4(hub.ipList) ?? hub.hostname ?? null
}

export interface DiscoveredNode {
  readonly id: string
  readonly hostname: string
  /**
   * Human label for the cluster list: hostname when it is not the opaque
   * node id, else the first non-loopback IPv4, else the id.
   */
  readonly displayName: string
  readonly isHub: boolean
}

/** A container id (12 hex) or full id (64 hex): a name nobody chose. */
export function isOpaqueHostname(hostname: string): boolean {
  return /^[0-9a-f]{12}$|^[0-9a-f]{64}$/.test(hostname)
}

/**
 * Prefer a name an operator can recognise over the bare Moleculer node id —
 * and over a container's id, which is what the hostname of a hub in Docker is.
 */
export function nodeDisplayName(node: RegistryNode): string {
  const hostname = typeof node.hostname === 'string' ? node.hostname.trim() : ''
  if (hostname.length > 0 && hostname !== node.id && !isOpaqueHostname(hostname)) return hostname
  const ip = pickIpv4(node.ipList)
  if (ip !== null) return ip
  return hostname.length > 0 ? hostname : node.id
}

/**
 * Map raw registry nodes (minus self) to the UI-facing shape: the hub carries
 * a human `displayName` (hostname or IPv4) so the UI never shows only `hub`.
 */
export function mapDiscoveredNodes(
  nodes: readonly RegistryNode[],
  selfId: string,
): readonly DiscoveredNode[] {
  return nodes
    .filter((n) => n.id !== selfId)
    .map((n) => {
      const hostname = n.hostname ?? n.id
      return {
        id: n.id,
        hostname,
        displayName: nodeDisplayName(n),
        isHub: n.id === 'hub',
      }
    })
}

/**
 * Derive the hub connection state from broker registry + config when no
 * external getter is wired. Does NOT detect `certificate-rejected` — that
 * requires the bootstrap to inject `getHubConnectionState`.
 */
function deriveHubConnectionState(
  nodes: readonly { id: string }[],
  hubAddressConfigured: boolean,
  paired: boolean,
): HubConnectionState {
  const hubInRegistry = nodes.some((n) => n.id === 'hub')
  if (hubInRegistry) return 'connected'
  if (!paired) return 'unpaired'
  if (!hubAddressConfigured) return 'unconfigured'
  return 'disconnected'
}

/**
 * Read the current effective config from the persisted file.
 * This is the single source of truth -- always reflects what the UI wrote.
 */
function getEffectiveConfig(
  configPath: string,
  nodeId: string,
): {
  name: string
  hubAddress: string | null
  paired: boolean
  hasMeshTls: boolean
} {
  const raw = readConfigFile(configPath)
  return {
    name: typeof raw.name === 'string' ? raw.name : nodeId,
    hubAddress: typeof raw.hubAddress === 'string' ? raw.hubAddress : null,
    paired: isAgentPaired(configPath),
    hasMeshTls: raw.meshTls !== null && typeof raw.meshTls === 'object',
  }
}

/**
 * The only keys `POST /api/agent/config` writes and `GET /api/agent/config` echoes. Everything
 * else in `agent.json` (the mesh key and chain, a swap in progress, the node id, an old `secret`)
 * is not reachable through this API, in either direction (D857).
 */
const EDITABLE_CONFIG_KEYS: readonly string[] = ['name', 'hubAddress', 'logLevel']

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set on the static UI bundle's routes: public, skipped by the agent auth gate. */
    publicAsset?: boolean
  }
}

/** Value types of the editable keys; unknown keys pass through to the allow-list refusal above. */
const ConfigPatchSchema = z.looseObject({
  name: z.string().max(100).nullable().optional(),
  hubAddress: z.string().max(300).nullable().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
})

/** Clock skew allowed between the hub that issued a ticket and this agent's boot instant. */
const TICKET_BOOT_SKEW_MS = 2 * 60_000

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createAgentHttpServer(
  getBroker: () => ServiceBroker,
  config: AgentHttpConfig,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  // No CORS: the agent's page is served by the agent itself, so every legitimate caller is
  // same-origin. `Access-Control-Allow-Origin: *` would let any web page read this API (D857).

  // -- Auth gate (port-4444 hardening, mirrors the hub's /health work) --
  // Loopback (the agent's own page, the Electron renderer, in-container probes) always passes - a
  // loopback peer behind a proxy does not (forwarding header). A remote caller needs a session minted
  // from a hub unlock ticket (D821, D857). The pairing protocol routes are reachable by anyone, each
  // authorized by what it carries. `POST /api/agent/session` redeems an unlock ticket without a prior
  // session.
  /**
   * Tab sessions from hub unlock tickets. A session is bound to the mesh CA that vouched for it (by
   * fingerprint) and dies the moment that changes: forgetting the hub or pairing with another one
   * ends every session (D857).
   */
  const unlockSessions = new Map<string, { readonly exp: number; readonly binding: string }>()
  let unlockJtis = new UnlockTicketJtiStore()
  let jtiBinding: string | null = null
  const bootMs = Date.now()
  /** What vouches for a session now: the pinned CA, else nothing. */
  const caBinding = (): string | null => {
    const ca = pinnedMeshCaCert(config.configPath)
    return ca === null ? null : `ca:${caFingerprintCompact(ca)}`
  }
  const sessionOk = (token: string): boolean => {
    const entry = unlockSessions.get(token)
    if (entry === undefined) return false
    if (entry.exp <= Date.now()) {
      unlockSessions.delete(token)
      return false
    }
    if (caBinding() !== entry.binding) {
      unlockSessions.delete(token)
      return false
    }
    return true
  }
  // The gate decides on the route the ROUTER matched (`routeOptions.url`, the pattern), never on the
  // raw URL: Fastify percent-decodes the path before matching, so `/%61pi/agent/restart` reaches the
  // `/api/agent/restart` handler. Deny by default: only an explicit public route, a static UI asset
  // (marked below) or a 404 (served by the not-found handler, which exposes nothing) skips the check.
  app.addHook('onRequest', async (req, reply) => {
    if (req.is404) return
    if (req.routeOptions.config?.publicAsset === true) return
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const matched = req.routeOptions.url ?? ''
    if (method === 'GET' && matched === '/health') return
    if (isPairingProtocolRequest(method, matched)) return
    if (isUnlockSessionRequest(method, matched)) return
    if (isUnlockInfoRequest(method, matched)) return
    const authInput = authInputOf(req)
    if (isAuthorizedAgentRequest(authInput, sessionOk)) return
    return reply.status(401).send({ ok: false, error: 'unauthorized' })
  })

  if (config.pairing !== undefined) {
    registerAgentPairingRoutes(app, {
      pairing: config.pairing,
      onForgetHub: config.onForgetHub ?? (async () => undefined),
      log: (message) => config.log?.info(message),
    })
  }

  // -- Health ---------------------------------------------------------
  // PUBLIC probe: liveness only — `{ok}`, no nodeId/version/topology (a
  // public endpoint must not enumerate the deployment; same policy as the
  // hub's /health). The detailed shape lives on `$agent.health` (Moleculer
  // action) for the hub, and on the AUTHENTICATED /health/details below
  // for external monitors.
  app.get('/health', async (_req, reply) => {
    try {
      await getBroker().call('$agent.health')
      return { ok: true }
    } catch {
      return reply.status(503).send({ ok: false })
    }
  })

  // AUTHENTICATED detailed health — the payload /health used to return.
  app.get('/health/details', async (_req, reply) => {
    try {
      const result = await getBroker().call('$agent.health')
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(503).send({
        ok: false,
        nodeId: config.nodeId,
        error: message,
      })
    }
  })

  // -- Agent status (enriched with connection state) ------------------

  app.get('/api/agent/status', async () => {
    const broker = getBroker()
    const eff = getEffectiveConfig(config.configPath, config.nodeId)
    const nodes = getRegistryNodes(broker)
    const hubConnected = nodes.some((n) => n.id === 'hub')
    const hubConnectionState: HubConnectionState = config.getHubConnectionState
      ? config.getHubConnectionState()
      : deriveHubConnectionState(nodes, Boolean(eff.hubAddress), eff.paired)
    const meshTransport: AgentMeshTransport = config.getMeshTransport
      ? config.getMeshTransport()
      : eff.hasMeshTls
        ? 'tls'
        : 'clear'
    // The address the agent actually reaches the hub at (from the Moleculer
    // registry) — lets the UI show the real endpoint even under UDP discovery
    // where `eff.hubAddress` is null.
    const resolvedHubAddress = resolveHubEndpoint(nodes)
    // HTTPS origin the agent UI uses for "Continue with hub" unlock (D821).
    const hubHttpsOrigin =
      (eff.hubAddress !== null ? deriveHubUrlFromHubAddress(eff.hubAddress) : undefined) ??
      (resolvedHubAddress !== null ? deriveHubUrlFromHubAddress(resolvedHubAddress) : undefined) ??
      null
    // Version of the Electron wrapper (injected by the desktop app); absent
    // when the agent runs headless / in Docker.
    const appVersion = process.env['CAMSTACK_AGENT_APP_VERSION'] ?? null
    const identity = releaseIdentityFrom({
      productVersionEnv: process.env[PRODUCT_VERSION_ENV],
      serverVersion: config.serverVersion ?? null,
    })
    const discoveredNodes = mapDiscoveredNodes(nodes, broker.nodeID)
    // The hub this agent is paired with, for the agent UI's "Paired with" card (D857).
    const pairedHub = describePairedHub(pinnedMeshCaCert(config.configPath), hubHttpsOrigin)

    try {
      const status = (await broker.call('$agent.status')) as Record<string, unknown>
      return {
        ...status,
        name: eff.name,
        hubAddress: eff.hubAddress,
        resolvedHubAddress,
        hubHttpsOrigin,
        appVersion,
        productVersion: identity.productVersion,
        serverVersion: identity.serverVersion,
        hubConnected,
        hubConnectionState,
        paired: eff.paired,
        pairedHub,
        meshTransport,
        discoveredNodes,
      }
    } catch {
      return {
        nodeId: config.nodeId,
        name: eff.name,
        hubAddress: eff.hubAddress,
        resolvedHubAddress,
        hubHttpsOrigin,
        appVersion,
        productVersion: identity.productVersion,
        serverVersion: identity.serverVersion,
        hubConnected,
        hubConnectionState,
        paired: eff.paired,
        pairedHub,
        meshTransport,
        discoveredNodes,
        addons: [],
        localIps: [],
      }
    }
  })

  // -- Unlock info (public; Continue-with-hub needs hub origin while locked) --

  app.get('/api/agent/unlock-info', async () => {
    const eff = getEffectiveConfig(config.configPath, config.nodeId)
    const nodes = getRegistryNodes(getBroker())
    const resolvedHubAddress = resolveHubEndpoint(nodes)
    const hubHttpsOrigin =
      (eff.hubAddress !== null ? deriveHubUrlFromHubAddress(eff.hubAddress) : undefined) ??
      (resolvedHubAddress !== null ? deriveHubUrlFromHubAddress(resolvedHubAddress) : undefined) ??
      null
    return {
      paired: eff.paired,
      nodeId: config.nodeId,
      hubHttpsOrigin,
    }
  })

  // -- Unlock session (hub admin ticket → tab Bearer; D821) -----------

  app.post<{ Body: { ticket?: string } }>('/api/agent/session', async (req, reply) => {
    // The ticket is signed by the mesh CA this agent pinned at pairing (D857).
    const pinnedCa = pinnedMeshCaCert(config.configPath)
    if (pinnedCa === null) {
      return reply.status(400).send({ ok: false, error: 'agent is not paired' })
    }
    const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket.trim() : ''
    if (ticket.length === 0) {
      return reply.status(400).send({ ok: false, error: 'ticket required' })
    }
    // Nothing issued before this process started is accepted: the one-use ledger is in memory.
    const payload = verifyAgentUiUnlockTicket(pinnedCa, ticket, {
      expectedNodeId: config.nodeId,
      notBeforeMs: bootMs - TICKET_BOOT_SKEW_MS,
    })
    const binding = caBinding()
    if (payload === null || binding === null) {
      return reply.status(401).send({ ok: false, error: 'invalid or expired unlock ticket' })
    }
    // A new vouching CA or secret starts a new ledger.
    if (jtiBinding !== binding) {
      unlockJtis = new UnlockTicketJtiStore()
      jtiBinding = binding
    }
    if (!unlockJtis.consume(payload.jti, payload.exp)) {
      return reply.status(401).send({ ok: false, error: 'unlock ticket already used' })
    }
    const token = randomBytes(32).toString('base64url')
    // Session outlives the ticket so the tab keeps working after redeem.
    const sessionExp = Date.now() + 8 * 60 * 60_000
    unlockSessions.set(token, { exp: sessionExp, binding })
    return { ok: true, token, expiresAt: sessionExp }
  })

  // -- Processes ------------------------------------------------------

  app.get('/api/agent/processes', async () => {
    try {
      return await getBroker().call('$process.list')
    } catch {
      return []
    }
  })

  // -- Addons joined with their runners (D841) ---------------------------

  app.get('/api/agent/addon-runtime', async () => {
    const broker = getBroker()
    const [status, list] = await Promise.all([
      broker.call('$agent.status').catch(() => null),
      broker.call('$process.list').catch(() => []),
    ])
    return joinAddonRuntime(addonsFromStatus(status), processesFromList(list))
  })

  // -- Addon restart --------------------------------------------------

  app.post<{ Body: { addonId: string } }>('/api/agent/addon/restart', async (req, reply) => {
    const addonId = req.body?.addonId
    if (!addonId) return reply.status(400).send({ error: 'addonId required' })
    return getBroker().call('$agent.restart', { addonId })
  })

  // -- Process restart ------------------------------------------------

  app.post<{ Body: { name: string } }>('/api/agent/process/restart', async (req, reply) => {
    const name = req.body?.name
    if (!name) return reply.status(400).send({ error: 'name required' })
    return getBroker().call('$process.restart', { name })
  })

  // -- Config read (always from file -- single source of truth) -------

  app.get('/api/agent/config', async () => {
    const persisted = readConfigFile(config.configPath)
    const eff = getEffectiveConfig(config.configPath, config.nodeId)
    return {
      nodeId: config.nodeId,
      name: eff.name,
      hubAddress: eff.hubAddress,
      paired: eff.paired,
      hasMeshTls: eff.hasMeshTls,
      ...Object.fromEntries(
        Object.entries(persisted).filter(([k]) => EDITABLE_CONFIG_KEYS.includes(k)),
      ),
    }
  })

  // -- Config write (merge-patch + persist) ---------------------------

  // Fastify (not Express) natively awaits async route handlers and serializes
  // the returned value / catches rejections, so an async handler is correct here.
  // eslint-disable-next-line oxc/no-async-endpoint-handlers
  app.post<{ Body: Record<string, unknown> }>('/api/agent/config', async (req, reply) => {
    // Allow-list (D857): the mesh material only ever comes from a pairing, and the node id never
    // changes. Any other key is refused whole - nothing is written.
    const parsed = ConfigPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: 'Invalid config values' })
    }
    const body = parsed.data
    const refused = Object.keys(body).filter((k) => !EDITABLE_CONFIG_KEYS.includes(k))
    if (refused.length > 0) {
      return reply.status(400).send({
        success: false,
        error: `Not editable here: ${refused.join(', ')}. Editable: ${EDITABLE_CONFIG_KEYS.join(', ')}`,
      })
    }
    const patch = Object.fromEntries(Object.entries(body))
    const existing = readConfigFile(config.configPath)
    writeConfigFile(config.configPath, { ...existing, ...patch })

    // Apply name change immediately (no reconnect needed)
    if (typeof patch.name === 'string' && patch.name.trim()) {
      try {
        await getBroker().call('$agent.rename', { name: patch.name.trim() })
        console.log(`[Agent] Name changed to "${patch.name.trim()}"`)
      } catch {
        /* best-effort */
      }
    }

    // Only flag reconnect when a connection-affecting field actually CHANGED. The form posts
    // every visible field on every Save, so a present `hubAddress` alone is not a change.
    const needsReconnect =
      Object.prototype.hasOwnProperty.call(patch, 'hubAddress') &&
      patch['hubAddress'] !== existing['hubAddress']

    return { success: true, restartRequired: needsReconnect }
  })

  // -- Agent reconnect (applies a new hub address / mesh material) -----

  app.post('/api/agent/restart', async () => {
    if (!config.onReconnect) {
      return { success: false, message: 'Reconnect not available' }
    }
    console.log('[Agent] Reconnect requested from UI')
    void config.onReconnect().catch((err: unknown) => {
      console.error('[Agent] Reconnect failed:', err)
    })
    return { success: true, message: 'Agent reconnecting...' }
  })

  // -- Updates (framework local; addon roster read-only) --------------
  // Registered AFTER the onRequest hook above, so every path it mounts is
  // gated by the same loopback-or-bearer rule as the rest of `/api/`.
  registerAgentUpdateRoutes(app, config.updateControls ?? {})

  // -- Hubs found on this network (D839) ------------------------------
  // The cached list is free; the refresh browses mDNS for a few seconds. The
  // UI asks on demand (opening the edit form, "Search again"), never on its
  // status poll.
  const hubsFinder: HubsFinder =
    config.hubsFinder ??
    createHubsFinder({
      getConfiguredHubAddress: () =>
        getEffectiveConfig(config.configPath, config.nodeId).hubAddress,
      log: (message) => console.warn(`[Agent] ${message}`),
    })
  app.get('/api/agent/hubs-found', async () => hubsFinder.snapshot())
  app.post('/api/agent/hubs-found/refresh', async () => hubsFinder.refresh())

  // -- Discovered nodes -----------------------------------------------

  app.get('/api/agent/discovered-nodes', async () => {
    const b = getBroker()
    const nodes = getRegistryNodes(b)
    return mapDiscoveredNodes(nodes, b.nodeID)
  })

  // -- Static file serving (agent-ui) ---------------------------------

  const uiDir = resolveUiDistDir(config.dataDir, process.env['CAMSTACK_BUNDLED_ADDONS_DIR'])
  if (uiDir) {
    const fastifyStatic = await import('@fastify/static')
    // Every route the static plugin mounts is the public UI bundle: tag them for the auth gate.
    let mountingAssets = true
    app.addHook('onRoute', (route) => {
      if (mountingAssets) route.config = { ...route.config, publicAsset: true }
    })
    await app.register(fastifyStatic.default, {
      root: uiDir,
      prefix: '/',
      wildcard: false,
      // MUST stay true: the SPA-fallback below uses `reply.sendFile`, which
      // only exists when the plugin decorates Reply. With `false` every
      // fallback request 500'd with "reply.sendFile is not a function".
      decorateReply: true,
    })
    mountingAssets = false

    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/health')) {
        return reply.status(404).send({ error: 'Not found' })
      }
      // Never serve index.html to an asset request: a stale index.html
      // referencing missing hashed assets must fail VISIBLY (404 in the
      // renderer console) instead of feeding HTML to a module script,
      // which renders as a silent blank page.
      if (req.url.startsWith('/assets/')) {
        console.warn(`[Agent] UI asset not found (stale index.html?): ${req.url}`)
        return reply.status(404).send({ error: 'Asset not found' })
      }
      return reply.type('text/html').sendFile('index.html')
    })

    console.log(`[Agent] UI served from: ${uiDir}`)
  }

  return app
}

// ---------------------------------------------------------------------------
// Start helper
// ---------------------------------------------------------------------------

/**
 * Start the agent API on its port, which also speaks TLS (D856): the first byte
 * of a connection picks the protocol, so there is no second port. Resolves with
 * the listener (to hot-swap the certificate), or `null` when it failed to start.
 */
export async function startAgentHttpServer(
  getBroker: () => ServiceBroker,
  config: AgentHttpConfig,
): Promise<SniffingListener | null> {
  try {
    const app = await createAgentHttpServer(getBroker, config)
    await app.ready()
    const material = loadAgentHttps(config.dataDir, (reason) =>
      config.log?.error('The HTTPS bundle on disk is unusable - serving plain HTTP only', {
        meta: { reason },
      }),
    )
    const listener = await startSniffingListener({
      httpServer: app.server,
      port: config.port,
      host: '0.0.0.0',
      material: material === null ? null : { keyPem: material.keyPem, certPem: material.certPem },
      ...(config.log !== undefined ? { log: config.log } : {}),
      onTlsRefused: () =>
        config.log?.warn(
          'A TLS client reached the agent port but no HTTPS certificate is installed yet - closed',
        ),
    })
    config.log?.info('Agent HTTP server listening', {
      meta: { port: config.port, https: material !== null },
    })
    return listener
  } catch (err) {
    console.warn(`[Agent] HTTP server failed to start on port ${config.port}:`, err)
    return null
  }
}
