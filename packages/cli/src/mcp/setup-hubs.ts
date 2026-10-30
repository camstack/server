/**
 * `setup_discover_hubs`, `setup_connect` and `setup_add_node`. Hub-less: the
 * only credential read is the CLI's own session cache, never a password, and
 * TLS verification is never switched off.
 */
import * as https from 'node:https'
import {
  createHubAgent,
  explainTlsFailure,
  HubAddressError,
  hubCaFileForServer,
  loadSession,
  normalizeHubAddress,
  resolveHubTls,
  type HubTlsConfig,
} from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { findHubs, type HubCandidate } from '../discovery/hub-finder.js'
import { installGuide, type InstallGuideResult } from './setup-install.js'
import type { InstallGuideInput } from './setup-install-rules.js'

const DEFAULT_DISCOVER_TIMEOUT_MS = 2_500
const MAX_DISCOVER_TIMEOUT_MS = 15_000
const HEALTH_TIMEOUT_MS = 5_000
const LOGIN = (server: string): string => `run \`camstack login ${server}\` in a terminal`

export type HealthOutcome =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false
      readonly error: string
      readonly tlsHint: string | null
    }

export type HealthProbe = (url: string, tls: HubTlsConfig) => Promise<HealthOutcome>

export interface SetupDeps {
  /** Where `camstack login` keeps its cache; tests point it at a temp directory. */
  readonly sessionDir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly findHubs?: (timeoutMs: number) => Promise<readonly HubCandidate[]>
  readonly health?: HealthProbe
}

/** GET `<url>/health` with the pinned CA when there is one; verification stays on. */
export const httpsHealth: HealthProbe = (url, tls) =>
  new Promise((resolve) => {
    const req = https.get(
      `${url}/health`,
      { agent: createHubAgent(tls), timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        res.resume()
        resolve({ ok: true, status: res.statusCode ?? 0 })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', (err) => {
      resolve({
        ok: false,
        error: err.message,
        tlsHint: explainTlsFailure(url, err),
      })
    })
  })

export interface DiscoveredHub {
  readonly host: string
  readonly port: number
  readonly name: string | null
  readonly version: string | null
  readonly sources: readonly string[]
}

export interface DiscoverHubsResult {
  readonly status: 'ok'
  readonly hubs: readonly DiscoveredHub[]
  readonly next: string
}

export async function discoverHubsTool(
  timeoutMs: number | undefined,
  deps: SetupDeps,
): Promise<DiscoverHubsResult> {
  const wait = Math.min(timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS, MAX_DISCOVER_TIMEOUT_MS)
  const finder =
    deps.findHubs ??
    ((ms: number) =>
      findHubs({
        mdnsTimeoutMs: ms,
        ...(deps.sessionDir !== undefined ? { sessionDir: deps.sessionDir } : {}),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
      }))
  const found = await finder(wait)
  const hubs = found.map((h) => ({
    host: h.host,
    port: h.port,
    name: h.nodeId,
    version: h.version,
    sources: h.sources,
  }))
  return {
    status: 'ok',
    hubs,
    next:
      hubs.length === 0
        ? 'no hub answered: install one with setup_install_guide, or pass its address to setup_connect'
        : 'pass the host of the hub you want to setup_connect',
  }
}

export interface ConnectResult {
  readonly status: 'invalid-address' | 'unreachable' | 'reachable'
  readonly server: string
  readonly message?: string
  readonly health?: { readonly status: number }
  readonly tls?: {
    readonly caPinned: boolean
    readonly caFile: string
    readonly hint: string | null
  }
  readonly session?: {
    readonly exists: boolean
    readonly username: string | null
  }
  readonly next?: string
}

function pinnedTls(url: string, deps: SetupDeps): { tls: HubTlsConfig; caFile: string } {
  const caFile = hubCaFileForServer(url, deps.sessionDir)
  try {
    return {
      tls: resolveHubTls(url, deps.env ?? process.env, deps.sessionDir),
      caFile,
    }
  } catch {
    return { tls: {}, caFile }
  }
}

export async function connectTool(server: string, deps: SetupDeps): Promise<ConnectResult> {
  let url: string
  try {
    url = normalizeHubAddress(server)
  } catch (err) {
    const message = err instanceof HubAddressError ? err.message : String(err)
    return { status: 'invalid-address', server, message }
  }
  const { tls, caFile } = pinnedTls(url, deps)
  const outcome = await (deps.health ?? httpsHealth)(url, tls)
  const caPinned = tls.ca !== undefined
  const session = loadSession(url, deps.sessionDir)
  const sessionInfo = {
    exists: session !== null,
    username: session?.username ?? null,
  }
  if (!outcome.ok) {
    return {
      status: 'unreachable',
      server: url,
      message: outcome.error,
      tls: { caPinned, caFile, hint: outcome.tlsHint },
      session: sessionInfo,
      next:
        outcome.tlsHint === null
          ? 'check the host, that the hub is running, and that port 4443 is reachable'
          : `the hub answers but its certificate is not trusted: ${LOGIN(url)}; login pins the CA (never disable verification)`,
    }
  }
  return {
    status: 'reachable',
    server: url,
    health: { status: outcome.status },
    tls: { caPinned, caFile, hint: null },
    session: sessionInfo,
    next: session === null ? LOGIN(url) : 'a session exists: the ops tools can use it',
  }
}

const DiscoveredAgentsSchema = z.object({
  agents: z.array(
    z.object({
      nodeId: z.string(),
      host: z.string(),
      port: z.number(),
      version: z.string().nullable(),
      name: z.string().nullable(),
      state: z.enum(['unpaired', 'pending', 'paired']),
    }),
  ),
})
export type DiscoveredAgents = z.infer<typeof DiscoveredAgentsSchema>['agents']

export const PAIRING_STEPS: readonly string[] = [
  'Pairing is started from the HUB (D857): admin UI, Cluster > Nodes > Agents found on the network. Pick the agent, or add it by address (host and port 4444).',
  'Both screens now show six digits. Type the digits shown on the OTHER screen, on BOTH sides: the hub operator types the code the agent shows, and the agent operator confirms on the agent.',
  'The agent installs its certificate only after its own operator confirmed. Nothing here (and no tool of this MCP) confirms a pairing for you.',
  'The agent then appears under Cluster > Nodes.',
]

export interface AddNodeResult {
  readonly guide: InstallGuideResult
  readonly pairing: readonly string[]
  readonly agentsOnNetwork:
    | { readonly status: 'ok'; readonly agents: DiscoveredAgents }
    | { readonly status: 'no-session'; readonly action: string }
    | { readonly status: 'unavailable'; readonly error: string }
}

export async function addNodeTool(
  input: Omit<InstallGuideInput, 'role'>,
  ctx: McpContext,
): Promise<AddNodeResult> {
  const guide = await installGuide({ ...input, role: 'agent' }, ctx.fetch)
  const outcome = await ctx.hub()
  if (!outcome.ok) {
    return {
      guide,
      pairing: PAIRING_STEPS,
      agentsOnNetwork: { status: 'no-session', action: outcome.action },
    }
  }
  try {
    const raw = await outcome.connection.client.call('GET', 'agentPairing.listDiscoveredAgents', {})
    const parsed = DiscoveredAgentsSchema.safeParse(raw)
    return {
      guide,
      pairing: PAIRING_STEPS,
      agentsOnNetwork: parsed.success
        ? { status: 'ok', agents: parsed.data.agents }
        : {
            status: 'unavailable',
            error: 'the hub answered in an unexpected shape',
          },
    }
  } catch (err) {
    return {
      guide,
      pairing: PAIRING_STEPS,
      agentsOnNetwork: {
        status: 'unavailable',
        error: err instanceof Error ? err.message : String(err),
      },
    }
  }
}
