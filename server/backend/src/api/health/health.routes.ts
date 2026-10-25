/**
 * Health endpoints — fast probe surface for monitoring (k8s, uptime,
 * external watchdogs).
 *
 * Routes:
 *   - GET /health                 → hub self-health (in-memory registry ONLY, no RPC)
 *   - GET /health/agents          → online agent node IDs (in-memory registry ONLY, no RPC)
 *   - GET /health/agents/:nodeId  → forward to agent's `$agent.health`
 *   - GET /health/cluster         → hub + every online agent in one shot
 *
 * `/health` and `/health/agents` are served purely from the hub's in-memory
 * Moleculer node registry (`listNodeLiveness`) and NEVER fan out to agent
 * nodes — a frozen/ghost agent cannot slow them. This is what makes `/health`
 * safe as the admin-ui's 4s hub-liveness probe (#26): the old path went
 * through `listNodes()` which RPCs `$agent.status`/`$process.list` at 5s/node.
 * `/health/agents/:nodeId` and `/health/cluster` are the (intentional)
 * forwarding surfaces backed by the `$agent.health` Moleculer action, so
 * monitors talking to the hub and monitors talking directly to an agent
 * (`http://<agent>:4444/health`) see identical payloads.
 */

import type {
  AgentHealth,
  AgentHealthError,
  ClusterHealth,
  HubHealth,
  HubHealthRunners,
  NodeLiveness,
  RunnerBootCheck,
} from '@camstack/types'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { releaseIdentityFrom } from '../../core/release-identity.js'
import { isRunnerBootCheckDegraded } from '../../core/runner-health/runner-boot-check.js'
import { isSessionGradeJwtPayload, readSessionCookieFromHeader } from '../../auth/session-cookie.js'

/**
 * Narrow structural view of `AgentRegistryService` — only what the health
 * surface needs. Deliberately does NOT expose `listNodes()`: that method
 * fans `$agent.status`/`$process.list` out to every node (5s timeout per
 * ghost) and must never sit under `/health`, the admin-ui's 4s hub-only
 * liveness probe (#26). Keeps `buildHubHealth` unit-testable with a plain
 * fake (no casts, no class instantiation).
 */
export interface HealthAgentRegistry {
  listNodeLiveness(): readonly NodeLiveness[]
}

/**
 * Narrow structural view of `MoleculerService` — only the broker call the
 * forwarding endpoints (`/health/agents/:nodeId`, `/health/cluster`) use.
 * Structural so route-level tests need no cast / class instantiation.
 */
export interface HealthBrokerCaller {
  readonly broker: {
    call(
      action: string,
      params: Record<string, unknown>,
      opts: { nodeID: string; timeout: number },
    ): Promise<unknown>
  }
}

interface HealthRoutesDeps {
  readonly moleculer: HealthBrokerCaller
  readonly agentRegistry: HealthAgentRegistry
  readonly hubVersion: string
  /**
   * Product release (image / desktop app), from `CAMSTACK_PRODUCT_VERSION`.
   * Absent in a dev workspace. Not `hubVersion` — that is the server package.
   */
  readonly productVersion?: string | null
  /**
   * Readiness probe: returns false until the tRPC router is fully registered.
   * When false the hub is in degraded mode (the API routes 404) — `/health`
   * reflects this with `ok:false` + HTTP 503 so the Docker HEALTHCHECK and
   * external monitors actually catch a degraded boot (e.g. the stale-seed
   * crash that left tRPC unregistered).
   */
  readonly isReady: () => boolean
  /** Bearer/cookie JWT verifier (AuthService.verifyToken) — gates the
   *  detailed health surfaces; throws on invalid/expired. */
  readonly verifyToken: (token: string) => unknown
  /** The runner boot check (D877) - surfaced as `runners` on `/health`; `ok` is not touched. */
  readonly runnerBootCheck?: () => RunnerBootCheck | undefined
}

interface ProcessLike {
  uptime(): number
  pid: number
  cpuUsage(previous?: NodeJS.CpuUsage): NodeJS.CpuUsage
  memoryUsage(): NodeJS.MemoryUsage
}

const AGENT_HEALTH_TIMEOUT_MS = 3_000

function nowIso(): string {
  return new Date().toISOString()
}

/** Deps subset needed to compute hub self-health (no Moleculer). */
export type HubHealthDeps = Pick<
  HealthRoutesDeps,
  'agentRegistry' | 'hubVersion' | 'isReady' | 'runnerBootCheck'
>

export async function buildHubHealth(
  deps: HubHealthDeps,
  proc: ProcessLike = process,
): Promise<HubHealth> {
  // Fan-out-free: in-memory registry snapshot only, never a per-node RPC (#26).
  const nodes = deps.agentRegistry.listNodeLiveness()
  const remote = nodes.filter((n) => !n.isHub)
  const offlineNodes = remote.filter((n) => !n.isOnline)
  const total = remote.length
  const online = total - offlineNodes.length
  const check = deps.runnerBootCheck?.()
  const runners: HubHealthRunners | undefined =
    check === undefined
      ? undefined
      : {
          degraded: isRunnerBootCheckDegraded(check),
          expected: check.expected,
          running: check.running,
          failed: check.failed.length,
          refused: check.refused.length,
          missing: check.missing.length,
          checkedAtMs: check.checkedAtMs,
        }
  const memUsage = proc.memoryUsage()
  const totalMem = memUsage.heapTotal + memUsage.external + memUsage.arrayBuffers
  const memoryPercent = totalMem > 0 ? Math.round((memUsage.heapUsed / totalMem) * 100) : 0
  return {
    ok: deps.isReady(),
    nodeId: 'hub',
    version: deps.hubVersion,
    uptimeSeconds: Math.round(proc.uptime()),
    pid: proc.pid,
    agents: {
      total,
      online,
      offline: offlineNodes.length,
      // Named so health consumers (admin-ui connection banner) can say
      // WHICH node is degraded, not only how many.
      offlineIds: offlineNodes.map((n) => n.id),
    },
    cpuPercent: 0,
    memoryPercent,
    checkedAt: nowIso(),
    ...(runners !== undefined ? { runners } : {}),
  }
}

async function fetchAgentHealth(
  deps: HealthRoutesDeps,
  nodeId: string,
): Promise<AgentHealth | AgentHealthError> {
  try {
    const result = (await deps.moleculer.broker.call(
      '$agent.health',
      {},
      { nodeID: nodeId, timeout: AGENT_HEALTH_TIMEOUT_MS },
    )) as AgentHealth
    return result
  } catch (err) {
    return {
      ok: false,
      nodeId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * True when the request carries a valid SESSION-grade credential: a Bearer
 * JWT or the httpOnly session cookie. Health details expose topology
 * (agent ids, versions, pids) — public probes get only `{ok}`.
 * Pure over (headers, verifier) so the spec exercises it directly.
 */
export function isAuthorizedHealthRequest(
  headers: { readonly authorization?: string; readonly cookie?: string },
  verifyToken: (token: string) => unknown,
): boolean {
  const bearer = headers.authorization?.startsWith('Bearer ')
    ? headers.authorization.slice('Bearer '.length)
    : null
  const cookieToken = readSessionCookieFromHeader(headers.cookie)
  for (const token of [bearer, cookieToken]) {
    if (!token) continue
    try {
      if (isSessionGradeJwtPayload(verifyToken(token))) return true
    } catch {
      /* invalid/expired — try the next credential */
    }
  }
  return false
}

export function registerHealthRoutes(fastify: FastifyInstance, deps: HealthRoutesDeps): void {
  const authorized = (req: { headers: Record<string, unknown> }): boolean =>
    isAuthorizedHealthRequest(
      {
        ...(typeof req.headers.authorization === 'string'
          ? { authorization: req.headers.authorization }
          : {}),
        ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
      },
      deps.verifyToken,
    )

  // PUBLIC versions only — the login footer and the sidebar. Not topology:
  // `/health` stays liveness-only for that reason.
  fastify.get('/api/release-identity', async () => {
    return releaseIdentityFrom({
      productVersionEnv: deps.productVersion ?? undefined,
      serverVersion: deps.hubVersion,
    })
  })

  // PUBLIC probe: liveness only. Everything beyond `ok` (version, uptime,
  // pid, agent topology) moved to the AUTHENTICATED /health/details — a
  // public endpoint must not enumerate the deployment.
  fastify.get('/health', async (_req, reply: FastifyReply): Promise<{ ok: boolean }> => {
    const ok = deps.isReady()
    if (!ok) reply.status(503)
    return { ok }
  })

  // AUTHENTICATED detailed health — the payload /health used to return.
  fastify.get('/health/details', async (req, reply: FastifyReply): Promise<HubHealth | void> => {
    if (!authorized(req)) return reply.status(401).send({ ok: false, error: 'unauthorized' })
    const health = await buildHubHealth(deps)
    if (!health.ok) reply.status(503)
    return health
  })

  fastify.get('/health/agents', async (req, reply: FastifyReply) => {
    if (!authorized(req)) return reply.status(401).send({ ok: false, error: 'unauthorized' })
    const nodes = deps.agentRegistry.listNodeLiveness()
    return { agents: nodes.filter((n) => !n.isHub && n.isOnline).map((n) => n.id) }
  })

  fastify.get<{ Params: { nodeId: string } }>(
    '/health/agents/:nodeId',
    async (req, reply: FastifyReply) => {
      if (!authorized(req)) return reply.status(401).send({ ok: false, error: 'unauthorized' })
      const { nodeId } = req.params
      if (!nodeId) {
        return reply.status(400).send({ ok: false, error: 'nodeId required' })
      }
      const result = await fetchAgentHealth(deps, nodeId)
      if (!result.ok) {
        return reply.status(503).send(result)
      }
      return result
    },
  )

  fastify.get(
    '/health/cluster',
    async (req, reply: FastifyReply): Promise<ClusterHealth | void> => {
      if (!authorized(req)) return reply.status(401).send({ ok: false, error: 'unauthorized' })
      const hub = await buildHubHealth(deps)
      // Enumeration only (fan-out-free); the $agent.health fan-out below is intentional.
      const nodes = deps.agentRegistry.listNodeLiveness()
      const remote = nodes.filter((n) => !n.isHub && n.isOnline)
      const agents = await Promise.all(remote.map((n) => fetchAgentHealth(deps, n.id)))
      const ok = hub.ok && agents.every((a) => a.ok)
      return { ok, hub, agents, checkedAt: nowIso() }
    },
  )
}
