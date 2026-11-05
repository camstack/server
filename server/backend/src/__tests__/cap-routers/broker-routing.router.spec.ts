/**
 * Routing regression spec for the `broker` system-collection cap (a bus since D1013).
 *
 * `broker` is `scope:'system', mode:'collection'`. Two addons register a `broker` provider, each
 * owning a DISJOINT id set (mqtt-broker owns `mqtt_*`, provider-homeassistant owns `ha_*`). The
 * id-keyed methods (`getBrokerConfig`) fall through to `providers[0]` unless the caller passes the
 * `{ addonId }` selector, which routes to the OWNING provider. A provider answers `null` (not a
 * throw) for an id it does not own, so the no-addonId fallback degrades gracefully.
 *
 * The brokers themselves are listed through `integration-instances`, not here.
 */
import { describe, it, expect } from 'vitest'
import type { IBrokerProvider } from '@camstack/types'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

/** A mock `broker` provider that owns a fixed id set and answers null for any other id. */
function makeProvider(ownedIds: readonly string[]): IBrokerProvider {
  const owns = (id: string): boolean => ownedIds.includes(id)
  return {
    getBrokerConfig: async ({ id }) => (owns(id) ? { url: id } : null),
    publish: async () => null,
    subscribe: async () => ({ subscriptionId: 's' }),
    unsubscribe: async () => {
      // no-op
    },
    getState: async () => null,
    getStatus: async () => ({ brokerCount: ownedIds.length, connectedCount: ownedIds.length }),
  }
}

/** The collection selector the generated mount builds: addonId → that provider, else the first. */
function makeSelector(): (addonId?: string) => IBrokerProvider | null {
  const mqtt = makeProvider(['mqtt_1'])
  const ha = makeProvider(['ha_1'])
  const byAddonId: Record<string, IBrokerProvider> = { mqtt, ha }
  return (addonId?: string): IBrokerProvider | null =>
    addonId !== undefined ? (byAddonId[addonId] ?? null) : mqtt
}

describe('broker cap — addonId ownership routing', () => {
  it('getBrokerConfig({id:ha_1}, addonId:ha) routes to the HA provider (not mqtt-broker)', async () => {
    const selector = makeSelector()
    const router = buildCapRouterForTest('broker', (_ctx, addonId) => selector(addonId))

    const outcome = await invokeProcedure(router, 'getBrokerConfig', makeCtx('admin'), {
      id: 'ha_1',
      addonId: 'ha',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toEqual({ url: 'ha_1' })
  })

  it('getBrokerConfig({id:ha_1}) WITHOUT addonId returns null gracefully (first provider does not own it)', async () => {
    const selector = makeSelector()
    const router = buildCapRouterForTest('broker', (_ctx, addonId) => selector(addonId))

    const outcome = await invokeProcedure(router, 'getBrokerConfig', makeCtx('admin'), {
      id: 'ha_1',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toBeNull()
  })
})
