/**
 * These tests encode a rule that was shipped BACKWARDS for one deploy, so they
 * are written to fail if anyone re-pins the enumeration.
 *
 * The tempting reasoning: `broker` is a collection cap, an unpinned call can be
 * answered by the wrong provider, therefore pin everything. True for an
 * ID-KEYED call — `getBrokerConfig({id})` unpinned really does return `null`
 * from a provider that does not own the id. False for `list`, whose contract is
 * already a fan-out UNION across every registered provider.
 *
 * Pinning `list` made the read depend on `provider-homeassistant` being
 * REGISTERED at call time, and that provider registers its capabilities only at
 * the very end of its `initialize()`. Through the whole boot window the export
 * half got `BAD_REQUEST: Capability "broker" has no provider with addonId
 * "provider-homeassistant"` instead of "no Home Assistant brokers yet" — which
 * took the operator's hub from "one instance, switched off" to "no instance at
 * all" (2026-08-09).
 *
 * The fake answers per-provider, the way the real cap does, so a regression to
 * a pinned read is caught by behaviour and not only by argument-shape.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  type BrokerListQuery,
  HA_BROKER_KIND,
  HA_PROVIDER_ADDON_ID,
  type HaBroker,
  listHomeAssistantBrokers,
} from '../ha-broker-source.js'

const HOMEMATIC: HaBroker = {
  id: 'hm_001',
  name: 'Casa',
  kind: 'homematic',
  addonId: 'provider-homematic',
}

const HOME_ASSISTANT: HaBroker = {
  id: 'ha_001',
  name: 'Casa',
  kind: HA_BROKER_KIND,
  addonId: HA_PROVIDER_ADDON_ID,
}

/**
 * The live routing, both branches:
 *  - unpinned  → the UNION across every registered provider (what the hub's
 *    cap router does for an array-output collection method);
 *  - pinned    → that provider alone, and a REFUSAL when it is not registered
 *    (the D98 behaviour: an unresolvable pin is never answered by a sibling).
 *
 * `registered` models which providers are up at this instant.
 */
function createBrokerCap(registered: readonly string[]): {
  query: BrokerListQuery
  calls: unknown[]
} {
  const all: readonly HaBroker[] = [HOMEMATIC, HOME_ASSISTANT]
  const calls: unknown[] = []
  const query: BrokerListQuery = async (input) => {
    calls.push(input)
    const live = all.filter((b) => registered.includes(b.addonId))
    if (input.addonId !== undefined) {
      if (!registered.includes(input.addonId)) {
        throw new Error(
          `Capability "broker" has no provider with addonId "${input.addonId}". ` +
            `Valid addonId(s): ${registered.join(', ')}.`,
        )
      }
      return live.filter((b) => b.addonId === input.addonId)
    }
    return live
  }
  return { query, calls }
}

const BOTH_UP = ['provider-homematic', HA_PROVIDER_ADDON_ID]
/** The Home Assistant provider is mid-boot: declared, not yet registered. */
const HA_STILL_BOOTING = ['provider-homematic']

describe('listHomeAssistantBrokers', () => {
  it('finds the Home Assistant broker in the union, alongside a foreign provider', async () => {
    const cap = createBrokerCap(BOTH_UP)
    await expect(listHomeAssistantBrokers(cap.query)).resolves.toEqual([HOME_ASSISTANT])
  })

  it('does NOT pin the enumeration — a pin cannot resolve during the provider’s own boot', async () => {
    const cap = createBrokerCap(BOTH_UP)
    await listHomeAssistantBrokers(cap.query)
    expect(cap.calls).toEqual([{}])
  })

  it('degrades to an empty list while the provider is still registering, instead of throwing', async () => {
    // The regression that shipped: pinned, this threw BAD_REQUEST and the
    // export addon reported "no brokers" where it had previously known one.
    // Unpinned it is simply an empty union, and the next reconcile repairs.
    const cap = createBrokerCap(HA_STILL_BOOTING)
    await expect(listHomeAssistantBrokers(cap.query)).resolves.toEqual([])
  })

  it('drops a foreign broker the union legitimately contains', async () => {
    const query = vi.fn<BrokerListQuery>().mockResolvedValue([HOME_ASSISTANT, HOMEMATIC])
    await expect(listHomeAssistantBrokers(query)).resolves.toEqual([HOME_ASSISTANT])
  })
})
