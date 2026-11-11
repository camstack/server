import type { IScopedLogger } from '@camstack/types'
import type { ExploreResourcesInput, ExploreResourcesOutput } from './custom-actions.js'
import type { HomeComApiClient, HomeComSystemSnapshot } from './homecom-api-client.js'
import { exploreHomeComResources } from './homecom-resource-explorer.js'

export interface HomeComExploreDeps {
  /** Integration ids with a connected client. */
  readonly listConnected: () => readonly string[]
  readonly getClient: (integrationId: string) => HomeComApiClient | null
  readonly getGatewayId: (integrationId: string) => string | null
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

export type HomeComExploreRefusal = 'already-running' | 'not-connected' | 'ambiguous'

/** The action refused before it walked anything; `reason` says why. */
export class HomeComExploreRefusedError extends Error {
  readonly reason: HomeComExploreRefusal
  constructor(reason: HomeComExploreRefusal, message: string) {
    super(message)
    this.name = 'HomeComExploreRefusedError'
    this.reason = reason
  }
}

export type HomeComExploreAction = (input: ExploreResourcesInput) => Promise<ExploreResourcesOutput>

function pickIntegration(input: ExploreResourcesInput, connected: readonly string[]): string {
  if (input.integrationId !== undefined) return input.integrationId
  if (connected.length === 1 && connected[0] !== undefined) return connected[0]
  if (connected.length === 0) {
    throw new HomeComExploreRefusedError('not-connected', 'No HomeCom integration is connected.')
  }
  throw new HomeComExploreRefusedError(
    'ambiguous',
    `Several HomeCom integrations are connected; name one with integrationId (${connected.join(', ')}).`,
  )
}

/**
 * The `exploreResources` action: a read-only walk of one integration's gateway. One walk
 * per integration at a time — a second call while one runs is refused, never queued.
 */
export function createHomeComExploreAction(deps: HomeComExploreDeps): HomeComExploreAction {
  const running = new Set<string>()
  return async (input) => {
    const integrationId = pickIntegration(input, deps.listConnected())
    if (running.has(integrationId)) {
      throw new HomeComExploreRefusedError(
        'already-running',
        `A resource walk is already running for HomeCom integration ${integrationId}.`,
      )
    }
    const client = deps.getClient(integrationId)
    if (client === null) {
      throw new HomeComExploreRefusedError(
        'not-connected',
        `HomeCom integration ${integrationId} is not connected.`,
      )
    }
    running.add(integrationId)
    try {
      return await walk(input, integrationId, client, deps)
    } finally {
      running.delete(integrationId)
    }
  }
}

async function walk(
  input: ExploreResourcesInput,
  integrationId: string,
  client: HomeComApiClient,
  deps: HomeComExploreDeps,
): Promise<ExploreResourcesOutput> {
  const result = await exploreHomeComResources({
    read: (path) => client.readResource(path),
    ...(input.root !== undefined ? { root: input.root } : {}),
    ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
    ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  })
  const gatewayId = deps.getGatewayId(integrationId)
  if (result.droppedReferences > 0) {
    deps.logger.warn('HomeCom resource walk dropped references that are not a walkable path', {
      tags: { integrationId },
      meta: {
        gatewayId,
        droppedReferences: result.droppedReferences,
        samples: result.droppedSamples,
      },
    })
  }
  deps.logger.info('HomeCom resource tree explored', {
    tags: { integrationId },
    meta: {
      gatewayId,
      root: result.root,
      visited: result.resources.length,
      stoppedBy: result.stoppedBy,
      unvisited: result.unvisited,
      droppedReferences: result.droppedReferences,
      ...result.summary,
    },
  })
  return { integrationId, gatewayId, ...result }
}

export interface HomeComExploreWiring {
  readonly registry: { list(): readonly string[] }
  readonly connections: {
    getClient(integrationId: string): HomeComApiClient | null
    getSnapshot(integrationId: string): HomeComSystemSnapshot | null
  }
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

/** The addon's deps: registered integrations that hold a live client; gateway from the snapshot. */
export function homeComExploreDeps(wiring: HomeComExploreWiring): HomeComExploreDeps {
  return {
    listConnected: () =>
      wiring.registry.list().filter((id) => wiring.connections.getClient(id) !== null),
    getClient: (id) => wiring.connections.getClient(id),
    getGatewayId: (id) => wiring.connections.getSnapshot(id)?.gateway.gatewayId ?? null,
    logger: wiring.logger,
  }
}
