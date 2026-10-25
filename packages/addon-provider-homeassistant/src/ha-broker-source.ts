/**
 * The export half's ONLY read of the `broker` registry — and the record of why
 * it is NOT pinned, which is the opposite of what this file said for one deploy.
 *
 * ── What a pin would buy, and why it cannot be paid for here ───────────────
 * `broker` is a `mode:'collection'` capability: several addons register a
 * provider, each owning a DISJOINT set of brokers (`provider-homematic` owns
 * `hm_*`, `provider-homeassistant` owns `ha_*`). For an ID-KEYED method that is
 * decisive, and the export half's `getBrokerConfig` call IS pinned for exactly
 * that reason — measured on the live hub:
 *
 *   broker.getBrokerConfig { id: 'ha_001' }                          → null
 *   broker.getBrokerConfig { id: 'ha_001', addonId: 'provider-…' }   → the config
 *
 * `list` is different, and the difference is not cosmetic. Pinning it makes the
 * read depend on `provider-homeassistant` being REGISTERED at the moment of the
 * call — and that provider registers its capabilities only at the very END of
 * its `initialize()`, after restoring every HA device. Pinned, the export half
 * hard-fails through that whole window with
 *
 *   BAD_REQUEST: Capability "broker" has no provider with addonId
 *                "provider-homeassistant"
 *
 * which is strictly worse than the union: unpinned, `list` is fanned across
 * every registered provider, so it returns `ha_001` as soon as the provider is
 * up and simply omits it while it is not. Shipped pinned on 2026-08-09 and it
 * took the operator from "one instance, switched off" to "no instance at all".
 *
 * ── The rule this leaves behind ────────────────────────────────────────────
 * Pin a call that NAMES a resource (`{ id }`, `{ brokerId }`) — only one
 * provider can answer it and a wrong answer is `null`, indistinguishable from
 * "no such resource". Do NOT pin an enumeration: its contract is already the
 * union, and a pin converts a provider's absence from "returns fewer rows" into
 * "throws". `scripts/check-collection-cap-pin.ts` enforces exactly that split.
 *
 * ── The other half of the lesson: never pin a cap you provide yourself ─────
 * The provider half's own `broker.*` calls (subscribe / getState / publish)
 * must stay unpinned too, and for a sharper reason: they run DURING
 * `registry.restore()`, i.e. before `initialize()` returns the provider that
 * would satisfy the pin. Pinning them deadlocks the addon's own boot — the cap
 * cannot register until restore finishes, and restore cannot finish until the
 * cap resolves. In-process they need no pin anyway: `localProviderLink`
 * short-circuits any cap the calling process already provides.
 */

/** The addon that owns the import direction, and every `ha_*` broker. */
export const HA_PROVIDER_ADDON_ID = 'provider-homeassistant'

/** The `BrokerInfo.kind` tag the Home Assistant provider stamps. */
export const HA_BROKER_KIND = 'home-assistant'

/** The subset of `BrokerInfo` the export half consumes. */
export interface HaBroker {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly addonId: string
}

/** `ctx.api.broker.list.query` narrowed to what this module needs. */
export type BrokerListQuery = (input: {
  readonly kind?: string
  readonly addonId?: string
}) => Promise<readonly HaBroker[]>

/**
 * Every Home Assistant broker currently registered, cluster-wide.
 *
 * Unpinned by design (see the module docblock) and filtered by `kind`, which is
 * the contract check that matters: whatever mix of providers answered the
 * union, only `home-assistant` brokers are ever exported to over Home
 * Assistant's transport.
 */
export async function listHomeAssistantBrokers(
  query: BrokerListQuery,
): Promise<readonly HaBroker[]> {
  const brokers = await query({})
  return brokers.filter((broker) => broker.kind === HA_BROKER_KIND)
}
