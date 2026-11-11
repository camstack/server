import type { IScopedLogger } from '@camstack/types'
import type { ExploreResourcesInput, ExploreResourcesOutput } from './custom-actions.js'
import type { HomeComApiClient } from './homecom-api-client.js'
import { exploreHomeComResources } from './homecom-resource-explorer.js'

export interface HomeComExploreDeps {
  /** Integration ids with a connected client. */
  readonly listConnected: () => readonly string[]
  readonly getClient: (integrationId: string) => HomeComApiClient | null
  readonly getGatewayId: (integrationId: string) => string | null
  readonly logger: Pick<IScopedLogger, 'info'>
  readonly sleep?: (ms: number) => Promise<void>
}

function pickIntegration(input: ExploreResourcesInput, connected: readonly string[]): string {
  if (input.integrationId !== undefined) return input.integrationId
  if (connected.length === 1 && connected[0] !== undefined) return connected[0]
  if (connected.length === 0) throw new Error('No HomeCom integration is connected.')
  throw new Error(
    `Several HomeCom integrations are connected; name one with integrationId (${connected.join(', ')}).`,
  )
}

/** The `exploreResources` action: a read-only walk of one integration's gateway. */
export async function runHomeComExplore(
  input: ExploreResourcesInput,
  deps: HomeComExploreDeps,
): Promise<ExploreResourcesOutput> {
  const integrationId = pickIntegration(input, deps.listConnected())
  const client = deps.getClient(integrationId)
  if (client === null) {
    throw new Error(`HomeCom integration ${integrationId} is not connected.`)
  }
  const result = await exploreHomeComResources({
    read: (path) => client.readResource(path),
    ...(input.root !== undefined ? { root: input.root } : {}),
    ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
  })
  const gatewayId = deps.getGatewayId(integrationId) ?? ''
  deps.logger.info('HomeCom resource tree explored', {
    tags: { integrationId },
    meta: {
      gatewayId,
      root: result.root,
      visited: result.resources.length,
      stoppedBy: result.stoppedBy,
      unvisited: result.unvisited,
      ...result.summary,
    },
  })
  return {
    integrationId,
    gatewayId,
    root: result.root,
    stoppedBy: result.stoppedBy,
    unvisited: result.unvisited,
    summary: result.summary,
    resources: result.resources,
  }
}
