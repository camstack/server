/**
 * Hub-side `$readiness` Moleculer service. Exposes a single
 * `getSnapshot` action that returns the hub's current `ReadinessRegistry`
 * state as a plain array of `ReadinessRecord` objects.
 *
 * Every worker / remote agent hydrates its local registry from this
 * snapshot on first `$node.connected` — this eliminates the boot-time
 * race where `broker.broadcast` fires before the remote joined the
 * cluster. Live deltas continue to flow through the normal
 * `system.ready-state` event bridge.
 *
 * The service name is prefixed with `$` so it doesn't appear in the
 * addon / capability graph. Callers invoke it via
 * `broker.call('$readiness.getSnapshot')`.
 */
import type { ServiceSchema } from 'moleculer'
import type { IReadinessRegistry, IReadinessRegistryRecord } from '@camstack/types'

/**
 * Service name AGENTS register their own readiness snapshot under.
 *
 * Deliberately NOT `$readiness`: agents call `$readiness.getSnapshot`
 * UNQUALIFIED to reach the hub's authoritative registry, and Moleculer
 * prefers a local service for an unqualified call — an agent registering
 * `$readiness` would shadow the hub and hydrate from itself. The hub
 * pulls `$agent-readiness.getSnapshot` with an explicit `{ nodeID }` on
 * every agent (re)connect + periodically, closing the reverse leg of the
 * D8 snapshot-reconcile (the hub otherwise learns agent readiness only
 * from lossy cross-node event broadcasts).
 */
export const AGENT_READINESS_SERVICE_NAME = '$agent-readiness'

export interface ReadinessServiceDeps {
  readonly getSnapshot: () => readonly IReadinessRegistryRecord[]
  /** Service name override — default `$readiness` (the hub-authoritative instance). */
  readonly name?: string
}

export function createReadinessService(deps: ReadinessServiceDeps): ServiceSchema {
  return {
    name: deps.name ?? '$readiness',
    actions: {
      getSnapshot: {
        handler() {
          return deps.getSnapshot()
        },
      },
    },
  }
}

export function createReadinessServiceForRegistry(
  registry: IReadinessRegistry,
  name?: string,
): ServiceSchema {
  return createReadinessService({
    getSnapshot: () => registry.getSnapshotForTransport(),
    ...(name !== undefined ? { name } : {}),
  })
}
