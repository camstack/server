/**
 * The data door's dispatcher — the `settings-store` provider the storage
 * orchestrator registers, forwarding every call to the
 * `data-store-provider` engine behind it ([D44](../../../../../docs/decisions/adr-0044.md)).
 *
 * It is a ROUTER, not a translator. The two cap surfaces are deliberately
 * identical, so every method here is the same forward, and the payload
 * crosses untouched. That matters more than it looks: the engine composes
 * its table name from `namespace` + `collection` **out of the payload**,
 * so a dispatcher that injected, defaulted or stripped a namespace would
 * silently rename every table in the database.
 *
 * Extracted from the addon so the forwarding is unit-testable without
 * booting a `BaseAddon` — the same reason `provider-discovery.ts` exists.
 */
import type { IDataStoreProvider, ISettingsStoreProvider } from '@camstack/types'

/** How the dispatcher reaches the registered engines, read per call. */
export type GetDataStoreEngines = () => readonly IDataStoreProvider[]

/**
 * How the dispatcher reaches the node that owns the store when THIS node
 * does not — an agent, whose persistence is the hub's
 * (`createHubSettingsForward`). Read per call for the same reason
 * `getEngines` is: the broker reconnects, and a snapshot taken at
 * construction time would go stale exactly when the hub came back.
 *
 * `null` (and an omitted getter) means "there is no remote" — a hub, where a
 * remote could only be this very door, reached back through `$hub-cap-fwd`.
 */
export type GetRemoteDataStore = () => ISettingsStoreProvider | null

/**
 * Pick the target to serve a call.
 *
 * A LOCAL engine always wins: the remote is a fallback for a node that has
 * none, never a policy. Two cases are refused rather than guessed:
 *
 *  - **none registered, and no remote** — resolving to a no-op would make
 *    every read answer `undefined` and every write disappear, which reads
 *    exactly like an empty database;
 *  - **more than one engine** — there is no routing rule yet. The `engine`
 *    hint on `declareCollection` is what will choose, and until it exists a
 *    silent pick would send a collection to whichever engine happened to
 *    register first. A remote does not rescue this: the ambiguity is local.
 */
function resolveEngine(
  getEngines: GetDataStoreEngines,
  getRemote: GetRemoteDataStore | undefined,
): ISettingsStoreProvider {
  const engines = getEngines()
  if (engines.length === 0) {
    const remote = getRemote?.() ?? null
    if (remote) return remote
    throw new Error(
      'settings-store: no data-store-provider engine is registered — the data door has nothing behind it',
    )
  }
  if (engines.length > 1) {
    throw new Error(
      `settings-store: ${engines.length} data-store-provider engines are registered and there is no routing rule yet — declare the engine on the collection first`,
    )
  }
  const engine = engines[0]
  if (!engine) {
    throw new Error('settings-store: data-store-provider collection yielded an empty entry')
  }
  return engine
}

/**
 * Build the `settings-store` provider that fronts the registered engines,
 * with an optional remote behind it for a node that registers none.
 *
 * `getEngines` and `getRemote` are read on every call, never captured:
 * engines register during boot and a runner respawn replaces the instance, so
 * a snapshot taken at construction time would go stale exactly when an addon
 * crashed and came back.
 */
export function createDataStoreDispatch(
  getEngines: GetDataStoreEngines,
  getRemote?: GetRemoteDataStore,
): ISettingsStoreProvider {
  // `async` on every method is load-bearing, not stylistic: `resolveEngine`
  // throws, and a synchronous throw out of a promise-shaped API skips every
  // caller's `.catch()` and surfaces as an unhandled exception on whatever
  // stack happened to be running. The methods must REJECT.
  const engine = async (): Promise<ISettingsStoreProvider> => resolveEngine(getEngines, getRemote)
  return {
    get: async (input) => (await engine()).get(input),
    set: async (input) => (await engine()).set(input),
    query: async (input) => (await engine()).query(input),
    insert: async (input) => (await engine()).insert(input),
    upsert: async (input) => (await engine()).upsert(input),
    insertMany: async (input) => (await engine()).insertMany(input),
    upsertMany: async (input) => (await engine()).upsertMany(input),
    transact: async (input) => (await engine()).transact(input),
    update: async (input) => (await engine()).update(input),
    delete: async (input) => (await engine()).delete(input),
    deleteWhere: async (input) => (await engine()).deleteWhere(input),
    updateWhere: async (input) => (await engine()).updateWhere(input),
    count: async (input) => (await engine()).count(input),
    aggregate: async (input) => (await engine()).aggregate(input),
    histogram: async (input) => (await engine()).histogram(input),
    isEmpty: async (input) => (await engine()).isEmpty(input),
    declareCollection: async (input) => (await engine()).declareCollection(input),
  }
}
