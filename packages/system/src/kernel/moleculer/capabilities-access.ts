import type { ServiceBroker } from 'moleculer'
import { serializeTypedArrays } from './typed-array-serde.js'
import { asBrokerLike } from './event-bus.js'
import type { BrokerRegistries } from './provider-registry.js'

/**
 * Build `ctx.capabilities` for a worker context.
 *
 * Broker mode (hub / agent / in-process addons): merges the local registry
 * (providers from THIS process) with cross-process discovery via the
 * Moleculer service registry — remote providers are returned as Proxy
 * objects that forward method calls back through `broker.call(...)`.
 * Synchronous on the read side because Moleculer's service registry is a
 * local in-memory mirror of cluster state (updated via gossip).
 *
 * UDS mode (broker-less forked child, Phase F1+F2): `broker` is `undefined`,
 * so `ctx.capabilities` is LOCAL-ONLY — it sees only providers registered in
 * THIS process. This matches the canonical contract (CLAUDE.md: "`ctx.capabilities`
 * is the LOCAL CapabilityRegistry of the calling addon's group runner"). For
 * cross-process access a UDS child uses `ctx.api`, which routes over UDS to
 * the parent's `onUnownedCall`.
 */
function buildCapabilitiesAccess(
  broker: ServiceBroker | undefined,
  localRegs: BrokerRegistries,
): import('@camstack/types').CapabilitiesAccess {
  const collectRemoteEntries = (capName: string): Array<readonly [string, unknown]> => {
    if (broker === undefined) return []
    const bkr = asBrokerLike(broker)
    const rawRegistry: unknown = Reflect.get(broker, 'registry')
    if (
      rawRegistry === null ||
      typeof rawRegistry !== 'object' ||
      !('getServiceList' in rawRegistry)
    ) {
      return []
    }
    const registry = rawRegistry as {
      getServiceList: (opts: Record<string, boolean>) => readonly {
        readonly name: string
        readonly nodeID: string
        readonly metadata?: Record<string, unknown>
        readonly actions?: Record<string, unknown>
      }[]
    }
    const services = registry.getServiceList({ onlyAvailable: true, withActions: true })
    const out: Array<readonly [string, unknown]> = []
    for (const svc of services) {
      const meta = svc.metadata
      if (!meta) continue
      const addonId = meta['addonId']
      const capabilities = meta['capabilities']
      if (typeof addonId !== 'string' || !Array.isArray(capabilities)) continue
      // Find the matching capability entry — gives us the method list.
      let matchedMethods: readonly string[] | null = null
      for (const c of capabilities) {
        if (typeof c === 'string') {
          if (c === capName) {
            matchedMethods = null
            break
          }
        } else if (c !== null && typeof c === 'object' && 'name' in c) {
          const entry = c as { name?: unknown; methods?: unknown }
          if (entry.name === capName) {
            matchedMethods = Array.isArray(entry.methods)
              ? entry.methods.filter((m): m is string => typeof m === 'string')
              : null
            break
          }
        }
      }
      if (
        matchedMethods === null &&
        !capabilities.some((c) => {
          if (typeof c === 'string') return c === capName
          if (c !== null && typeof c === 'object' && 'name' in c)
            return (c as { name?: unknown }).name === capName
          return false
        })
      )
        continue
      // Fallback method discovery: inspect the action namespace
      // (`<service>.<capName>.<method>`) when metadata didn't carry an
      // explicit list. Mirrors how Moleculer's bridge discovers methods.
      if (!matchedMethods || matchedMethods.length === 0) {
        const actions = svc.actions ?? {}
        const prefix = `${svc.name}.${capName}.`
        matchedMethods = Object.keys(actions)
          .filter((a) => a.startsWith(prefix))
          .map((a) => a.slice(prefix.length))
      }
      // Skip if this addon is registered locally — local impl wins and
      // would already appear in the local merge above.
      const byAddon = localRegs.byAddonId.get(capName)
      if (byAddon?.has(addonId) && svc.nodeID === bkr.nodeID) continue
      // Build a dispatch object exposing ONLY the cap's actual methods.
      // Anything else (e.g. `displayName` read by metadata-coercing
      // orchestrators) returns `undefined` so consumers don't mistake a
      // method-stub for a static field.
      const remoteEntry = createRemoteProviderProxy(
        broker,
        svc.name,
        capName,
        svc.nodeID,
        matchedMethods,
      )
      const registryKey = svc.nodeID === bkr.nodeID ? addonId : `${addonId}@${svc.nodeID}`
      out.push([registryKey, remoteEntry])
    }
    return out
  }

  const collectLocalEntries = (capName: string): Array<readonly [string, unknown]> => {
    const byAddon = localRegs.byAddonId.get(capName)
    if (!byAddon) return []
    return [...byAddon.entries()]
  }

  return {
    getCollection<T = unknown>(capName: string): readonly T[] | undefined {
      const local = collectLocalEntries(capName).map(([, p]) => p as T)
      const remote = collectRemoteEntries(capName).map(([, p]) => p as T)
      const merged = [...local, ...remote]
      return merged.length > 0 ? merged : undefined
    },
    getCollectionEntries<T = unknown>(
      capName: string,
    ): readonly (readonly [string, T])[] | undefined {
      const local = collectLocalEntries(capName) as Array<readonly [string, T]>
      const remote = collectRemoteEntries(capName) as Array<readonly [string, T]>
      const merged = [...local, ...remote]
      return merged.length > 0 ? merged : undefined
    },
    get<T = unknown>(capName: string): T | undefined {
      // Singleton lookup — local first, fall through to cluster.
      const local = localRegs.providers.get(capName)
      if (local && local.length > 0) return local[0] as T
      const remote = collectRemoteEntries(capName)
      const first = remote[0]
      return first ? (first[1] as T) : undefined
    },
  }
}
export { buildCapabilitiesAccess }

/**
 * Build a Proxy that forwards property reads to `broker.call(...)`.
 *
 * `serviceName.capName.method` is the Moleculer action path emitted by
 * `addon-service-factory.ts:144` for every cap method. The proxy is fully
 * dynamic — it doesn't require the cap definition to be importable in the
 * worker process; the orchestrator that consumes the collection calls only
 * the methods it knows about and the proxy dispatches them blindly.
 *
 * Returns `undefined` for `then`/`catch`/symbols so the proxy isn't
 * mistakenly identified as a thenable / iterable by structural-typing
 * consumers (e.g. `await maybeProxy` mustn't hang).
 */
function createRemoteProviderProxy(
  broker: ServiceBroker,
  serviceName: string,
  capName: string,
  nodeId: string,
  methods: readonly string[],
): Record<string, (input?: unknown) => Promise<unknown>> {
  const bkr = asBrokerLike(broker)
  // Materialise the method dispatchers as a real object (not a Proxy) so
  // consumers can `Object.keys()` + spread + introspect without surprise.
  // Properties not in `methods` return `undefined` via normal property
  // access — orchestrators that read static metadata fields (e.g.
  // `impl.displayName`) get a falsy and fall back to defaults.
  const dispatcher: Record<string, (input?: unknown) => Promise<unknown>> = Object.create(
    null,
  ) as Record<string, (input?: unknown) => Promise<unknown>>
  for (const method of methods) {
    dispatcher[method] = (input?: unknown): Promise<unknown> => {
      return bkr.call(`${serviceName}.${capName}.${method}`, serializeTypedArrays(input), {
        nodeID: nodeId,
        timeout: 30_000,
      })
    }
  }
  return dispatcher
}
