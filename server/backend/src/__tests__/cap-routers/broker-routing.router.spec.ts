/**
 * Routing regression spec for the `broker` system-collection cap.
 *
 * The bug: `broker` is `scope:'system', mode:'collection'`. Two addons
 * register a `broker` provider, each owning a DISJOINT id set
 * (mqtt-broker owns `mqtt_*`, provider-homeassistant owns `ha_*`). The
 * generated collection mount only fans out the array-output methods
 * (`list` / `listProviders`); every id-keyed method (`get` / `getSettings`
 * / `remove` / `testConnection` / …) falls through to `providers[0]`
 * (the FIRST-registered provider = mqtt-broker). So operating on an HA
 * broker `ha_1` hit mqtt-broker → "broker 'ha_1' not found".
 *
 * The fix: each broker carries its owning `addonId`; the admin UI threads
 * it back as the `{ addonId }` system-collection selector so the call
 * routes to the OWNING provider via `getProviderByAddonId`. Providers
 * also return `null` (not throw) for ids they don't own, so the
 * no-addonId fallback degrades gracefully.
 *
 * This spec exercises `broker router` with the SAME selector
 * the generated mount builds (registry-backed: addonId → provider, else
 * first-provider aggregate with array methods fanned out). It registers
 * two mock providers and asserts:
 *  - `list()` returns both, each tagged with its `addonId`.
 *  - `get({id:'ha_1'}, addonId:'ha')` routes to the HA provider.
 *  - `get({id:'ha_1'})` WITHOUT addonId returns null (graceful) — the
 *    HA-owned id isn't in providers[0]'s registry, so it doesn't throw.
 *  - `listProviders()` aggregates both providers' entries.
 */
import { describe, it, expect } from 'vitest'
import type { IBrokerProvider } from '@camstack/types'

// Derived from the `broker` cap's provider: the package root's `BrokerInfo`
// is the `mqtt-broker` cap's record, a different shape under the same name.
type BrokerInfo = NonNullable<Awaited<ReturnType<IBrokerProvider['get']>>>
type BrokerProviderInfo = Awaited<ReturnType<IBrokerProvider['listProviders']>>[number]
import { concatCollection } from '../../api/trpc/cap-mount-helpers.js'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

/**
 * A self-contained mock `broker` provider that owns a fixed set of
 * broker ids and self-tags every returned record with its `addonId`.
 * Returns `null` / no-op for ids it does NOT own (never throws) — the
 * exact graceful-degradation contract the real providers must honour.
 */
function makeProvider(addonId: string, ownedIds: readonly string[], kind: string): IBrokerProvider {
  const owns = (id: string): boolean => ownedIds.includes(id)
  const infoFor = (id: string): BrokerInfo => ({
    id,
    addonId,
    name: `${kind}-${id}`,
    kind,
    status: 'connected',
    info: {},
    lastCheckedAt: null,
    error: null,
  })
  return {
    list: async () => ownedIds.map(infoFor),
    get: async ({ id }) => (owns(id) ? infoFor(id) : null),
    listProviders: async (): Promise<BrokerProviderInfo[]> => [
      { addonId, kinds: [{ kind, label: kind }] },
    ],
    add: async () => ({ id: 'new' }),
    remove: async () => {
      // no-op for foreign ids (and owned ids in this mock)
    },
    testConnection: async ({ id }) =>
      owns(id) ? { ok: true, latencyMs: 1 } : { ok: false, error: 'unknown broker' },
    getSettings: async ({ id }) => (owns(id) ? { secret: id } : null),
    setSettings: async () => {
      // no-op
    },
    getBrokerConfig: async ({ id }) => (owns(id) ? { url: id } : null),
    getSettingsSchema: async ({ kind: k }) => (k === kind ? { form: kind } : null),
    testSettings: async () => ({ ok: true }),
    publish: async () => null,
    subscribe: async () => ({ subscriptionId: 's' }),
    unsubscribe: async () => {
      // no-op
    },
    getState: async () => null,
    getStatus: async () => ({ brokerCount: ownedIds.length, connectedCount: ownedIds.length }),
  }
}

/**
 * Mirror of the generated collection mount selector for `broker`
 * (`generated-cap-mounts.ts`): addonId → that provider directly; else a
 * first-provider aggregate whose array-output methods are
 * `concatCollection`-fanned. Two providers registered in order:
 * mqtt (owns `mqtt_1`) first, ha (owns `ha_1`) second.
 */
function makeSelector(): (addonId?: string) => IBrokerProvider | null {
  const mqtt = makeProvider('mqtt', ['mqtt_1'], 'mqtt')
  const ha = makeProvider('ha', ['ha_1'], 'home-assistant')
  const byAddonId: Record<string, IBrokerProvider> = { mqtt, ha }
  const providers: readonly IBrokerProvider[] = [mqtt, ha]
  return (addonId?: string): IBrokerProvider | null => {
    if (addonId !== undefined) return byAddonId[addonId] ?? null
    const first = providers[0]!
    return {
      ...first,
      list: concatCollection(providers, 'list') as IBrokerProvider['list'],
      listProviders: concatCollection(
        providers,
        'listProviders',
      ) as IBrokerProvider['listProviders'],
    }
  }
}

describe('broker cap — addonId ownership routing', () => {
  it('list() aggregates both providers, each broker tagged with its addonId', async () => {
    const selector = makeSelector()
    const router = buildCapRouterForTest('broker', (_ctx, addonId) => selector(addonId))

    const outcome = await invokeProcedure(router, 'list', makeCtx('admin'), {})

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const rows = outcome.value as BrokerInfo[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('mqtt_1')?.addonId).toBe('mqtt')
    expect(byId.get('ha_1')?.addonId).toBe('ha')
  })

  it('get({id:ha_1}, addonId:ha) routes to the HA provider (not mqtt-broker)', async () => {
    const selector = makeSelector()
    const router = buildCapRouterForTest('broker', (_ctx, addonId) => selector(addonId))

    const outcome = await invokeProcedure(router, 'get', makeCtx('admin'), {
      id: 'ha_1',
      addonId: 'ha',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const row = outcome.value as BrokerInfo | null
    expect(row).not.toBeNull()
    expect(row?.id).toBe('ha_1')
    expect(row?.addonId).toBe('ha')
  })

  it('get({id:ha_1}) WITHOUT addonId returns null gracefully (first provider does not own it)', async () => {
    const selector = makeSelector()
    const router = buildCapRouterForTest('broker', (_ctx, addonId) => selector(addonId))

    const outcome = await invokeProcedure(router, 'get', makeCtx('admin'), { id: 'ha_1' })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toBeNull()
  })

  it('testConnection({id:ha_1}, addonId:ha) routes to HA provider and succeeds', async () => {
    const selector = makeSelector()
    const router = buildCapRouterForTest('broker', (_ctx, addonId) => selector(addonId))

    const outcome = await invokeProcedure(router, 'testConnection', makeCtx('admin'), {
      id: 'ha_1',
      addonId: 'ha',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toEqual({ ok: true, latencyMs: 1 })
  })

  it('listProviders() aggregates both providers entries', async () => {
    const selector = makeSelector()
    const router = buildCapRouterForTest('broker', (_ctx, addonId) => selector(addonId))

    const outcome = await invokeProcedure(router, 'listProviders', makeCtx('admin'))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const entries = outcome.value as BrokerProviderInfo[]
    const addonIds = entries.map((e) => e.addonId).toSorted()
    expect(addonIds).toEqual(['ha', 'mqtt'])
  })
})
