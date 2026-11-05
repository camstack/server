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
 * "no such resource". The connections themselves are an enumeration of ONE
 * provider's records (`integration-instances` has no union), so that read is pinned
 * and its refusal while the provider boots is handled by `listHomeAssistantBrokers`.
 * `scripts/check-collection-cap-pin.ts` enforces the split.
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

/** The registry kind of a Home Assistant connection (`kind.brokerKind` of its account kind). */
export const HA_BROKER_KIND = 'home-assistant'

/** The kind id of a Home Assistant connection among the provider's `integration-instances`. */
export const HA_ACCOUNT_INSTANCE_KIND = 'account'

/** A Home Assistant connection as the export half consumes it. */
export interface HaBroker {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly addonId: string
}

/** The part of an `integration-instances` record this module reads. */
export interface HaInstanceRecord {
  readonly id: string
  readonly name: string
  readonly kind?: string
  /** The connection's own switch; absent means on. */
  readonly enabled?: boolean | undefined
}

/** `ctx.api.integrationInstances.listInstances.query` narrowed to what this module needs. */
export type InstanceListQuery = (input: {
  readonly addonId: string
}) => Promise<readonly HaInstanceRecord[]>

/**
 * Every Home Assistant connection currently held, read from the provider's own
 * `integration-instances` (the connection is an instance of its `account` kind, D1013).
 *
 * The collection cap is pinned to the owning addon (an enumeration of ONE provider's records),
 * and the pin REFUSES while that provider is still registering. A refusal is "I do not know
 * yet", never "the operator deleted their instance": it answers an empty list and is reported
 * to `onUnavailable`, and the next reconcile repairs it (D49).
 */
export async function listHomeAssistantBrokers(
  query: InstanceListQuery,
  onUnavailable?: (error: unknown) => void,
): Promise<readonly HaBroker[]> {
  try {
    const records = await query({ addonId: HA_PROVIDER_ADDON_ID })
    return (
      records
        // An off connection is not a connection the export can push through.
        .filter((record) => record.kind === HA_ACCOUNT_INSTANCE_KIND && record.enabled !== false)
        .map((record) => ({
          id: record.id,
          name: record.name,
          kind: HA_BROKER_KIND,
          addonId: HA_PROVIDER_ADDON_ID,
        }))
    )
  } catch (err) {
    onUnavailable?.(err)
    return []
  }
}
