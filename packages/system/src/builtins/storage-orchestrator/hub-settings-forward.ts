/**
 * The data door with the HUB behind it — an agent's `settings-store` provider.
 *
 * ## Why this exists
 *
 * Persistence is the hub's. An agent runs no `data-store-provider` engine
 * (see `resolveAgentInfraCapabilities` in `server/backend/src/agent/`), so the
 * `settings-store` door the storage-orchestrator registers on an agent has
 * nothing local behind it. Rather than refuse — which would strand the four
 * infra addons that boot inside agent-main (`hub-forwarder`, `native-metrics`,
 * `platform-probe`, the orchestrator itself) with a `ctx.settings` that throws
 * on every read — the door FORWARDS into the hub's own routing.
 *
 * This is not a new transport. It is the same `$hub-cap-fwd.forward` a forked
 * addon on an agent has always used to reach a hub-hosted cap
 * (`kernel/transport/hub-cap-forward.ts` names `settings-store` in its own
 * header); agent-main's infra addons simply never had it, because they resolve
 * `ctx.api.settingsStore` through `localProviderLink` against the process's own
 * provider registry — which is exactly the local door.
 *
 * ## The payload crosses untouched
 *
 * The engine composes its table name from `namespace` + `collection` **out of
 * the payload**. A forwarder that injected, defaulted or stripped a namespace
 * would silently rename every table on the hub. Every method here is the same
 * forward, and the args are the caller's object verbatim — the same rule
 * `data-store-dispatch.ts` states for the local path, for the same reason.
 *
 * ## No second key space
 *
 * Per-node scoping already exists, one layer up, and it is per FIELD:
 * `BaseAddon` persists a `perNode: true` schema field as `<key>@<nodeId>`
 * inside the addon's settings (`packages/types/src/addon/
 * per-node-store.ts`). The agent therefore reads and writes the SAME rows the
 * hub's copy of that addon reads — `addon-settings` `<addonId>.<field>` (D870) — and
 * the two agree by construction. Introducing a second, addon-level
 * `(nodeId, addonId)` row here would be a second authority over one fact,
 * which is the shape [D224](../../../../../docs/decisions/adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
 * forbids: the hub's copy would keep writing the bare row and nothing would
 * reconcile them.
 *
 * ## A hub NEVER forwards
 *
 * {@link nodeOwnsItsDataStore} gates construction. A hub that built one would
 * route its own door back into itself through `$hub-cap-fwd`, which resolves
 * `settings-store` to… this. The gate reads the same env var, with the same
 * default, as `settingsStoreIsAuthoritativeHere` — unset means hub, because
 * that is what the launcher defaults to.
 *
 * ## When the hub is down
 *
 * Every method REJECTS. It never answers "empty": `ctx.settings`' read path
 * (`addon-context-factory.ts`) distinguishes a MISS from a FAILURE precisely
 * so a failed read cannot make the next read-modify-write persist the patch
 * alone and destroy every field the patch does not mention. An empty answer
 * would be indistinguishable from an empty store; a rejection is not. The
 * operator's rule for this node is the same one that already governs it —
 * without the hub an agent has no work — so a rejection is the whole of the
 * degraded behaviour, and it is loud.
 */

import {
  type IClusterBroker,
  type IScopedLogger,
  type ISettingsStoreProvider,
  settingsStoreCapability,
} from '@camstack/types'
import {
  HUB_CAP_FWD_ACTION,
  type HubCapForwardParams,
} from '../../kernel/transport/hub-cap-forward.js'

/**
 * The envelope `$hub-cap-fwd.forward` takes. Structurally
 * `HubCapForwardParams` minus the routing hints this door never sets: a
 * settings call carries no `deviceId`, pins no node (the hub's store is THE
 * store) and asks for no native provider.
 */
export interface HubForwardEnvelope {
  readonly capName: string
  readonly method: string
  readonly args: unknown
}

/**
 * How a forward reaches the hub. Generic in the result so the provider's
 * per-method return types flow through without a cast — the transport is the
 * documented type boundary, exactly as it is for the generated cap routers'
 * remote proxies.
 */
export type HubForwardCall = <TResult>(envelope: HubForwardEnvelope) => Promise<TResult>

/**
 * Does THIS node hold its own data store?
 *
 * Unset or `'hub'` means hub — the launcher's own default, mirrored from
 * `resolveNodeRole` (`server/backend/src/node-role.ts`) the same way
 * `settingsStoreIsAuthoritativeHere` mirrors it, and duplicated rather than
 * imported for the same reason: `@camstack/system` is a dependency OF the
 * backend, not the other way round.
 *
 * Anything else is an agent, and an agent's answer is the hub's store.
 */
export function nodeOwnsItsDataStore(env: NodeJS.ProcessEnv): boolean {
  const raw = (env['CAMSTACK_ROLE'] ?? '').trim().toLowerCase()
  return raw === '' || raw === 'hub'
}

/**
 * Build the `settings-store` provider that forwards to the hub.
 *
 * Every method is the same forward under the CAP name — never the engine
 * name. The hub routes `settings-store` to its own door, which then picks its
 * local engine; asking for `data-store-provider` would step around the door on
 * the far side and lose whatever the door is for.
 */
export function createHubSettingsForward(forward: HubForwardCall): ISettingsStoreProvider {
  const send = <TResult>(method: string, args: unknown): Promise<TResult> =>
    forward<TResult>({ capName: settingsStoreCapability.name, method, args })
  return {
    get: (input) => send('get', input),
    set: (input) => send('set', input),
    query: (input) => send('query', input),
    insert: (input) => send('insert', input),
    upsert: (input) => send('upsert', input),
    insertMany: (input) => send('insertMany', input),
    upsertMany: (input) => send('upsertMany', input),
    transact: (input) => send('transact', input),
    update: (input) => send('update', input),
    delete: (input) => send('delete', input),
    deleteWhere: (input) => send('deleteWhere', input),
    updateWhere: (input) => send('updateWhere', input),
    count: (input) => send('count', input),
    aggregate: (input) => send('aggregate', input),
    histogram: (input) => send('histogram', input),
    isEmpty: (input) => send('isEmpty', input),
    declareCollection: (input) => send('declareCollection', input),
  }
}

/**
 * How long an agent waits for the hub to answer a settings call before the
 * door rejects. Matches the agent's own `forwardToHub` budget in
 * `server/backend/src/agent/main.ts` — the same hop, over the same action, so
 * a shorter one here would only manufacture a timeout the transport did not
 * have.
 */
export const HUB_SETTINGS_FORWARD_TIMEOUT_MS = 60_000

/** What {@link resolveHubSettingsForward} needs. Narrow on purpose — fakeable. */
export interface HubSettingsForwardOptions {
  readonly env: NodeJS.ProcessEnv
  /** `undefined` in a forked worker or a test harness — no cluster to reach. */
  readonly broker: IClusterBroker | undefined
  readonly logger: Pick<IScopedLogger, 'info'>
}

/**
 * The whole decision, in one place: does this node's data door have the hub
 * behind it, and how does it get there?
 *
 * `null` means "no remote" and the door keeps its old behaviour — it refuses
 * when no engine is registered. That is the answer on a hub (which IS the
 * store) and in any process with no cluster broker.
 *
 * Extracted from the addon so the gate is unit-testable without booting a
 * `BaseAddon` — the same reason `data-store-dispatch.ts` and
 * `provider-discovery.ts` exist.
 */
export function resolveHubSettingsForward(
  options: HubSettingsForwardOptions,
): ISettingsStoreProvider | null {
  if (nodeOwnsItsDataStore(options.env)) return null
  const broker = options.broker
  if (!broker) return null
  options.logger.info(
    'storage-orchestrator: no local data-store engine on this node — the data door forwards to the hub',
  )
  return createHubSettingsForward(<TResult>(envelope: HubForwardEnvelope) =>
    broker.call<HubCapForwardParams, TResult>(
      HUB_CAP_FWD_ACTION,
      { capName: envelope.capName, method: envelope.method, args: envelope.args },
      { timeout: HUB_SETTINGS_FORWARD_TIMEOUT_MS },
    ),
  )
}
