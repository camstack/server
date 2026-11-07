/**
 * Routing regression spec for the `notification-output` system-collection cap.
 *
 * `notification-output` is `scope:'system', mode:'collection'`. Several addons
 * register a provider — `notifiers`, `provider-homeassistant`, and
 * `advanced-notifier` (a PARTIAL `ConsoleOutput` that implements only `send`).
 * The generated collection mount fans out only the ARRAY-output methods
 * (`listTargetKinds` / `discoverTargets`); every single-object method
 * (`testTarget` / `probeTargetConfig` / `send`) fell through to `providers[0]`.
 * When the first-registered provider is the partial `ConsoleOutput`,
 * `testTarget` hits a provider that doesn't implement it →
 * `child-cap-dispatch: method 'testTarget' not found on provider
 * 'notification-output'`. Even against a COMPLETE first provider it would
 * misroute (a HA target tested against the notifiers store).
 *
 * The fix: single-object collection calls route to their OWNING provider via
 * an addonId. The router prefers the explicit top-level `{ addonId }` selector
 * (the `broker`-cap precedent), and — when the caller omits it — recovers the
 * routing addonId the payload ALREADY carries one level down
 * (`config.addonId`) via `extractNestedAddonId`. ARRAY methods keep their union
 * fan-out and are NEVER rerouted.
 *
 * This spec drives the LIVE runtime router (`buildCapRouterForTest`) with a
 * selector that mirrors the real registry resolution (addonId → provider, else
 * a first-provider aggregate whose array methods are fanned). The FIRST
 * provider is the partial one, reproducing the exact live topology.
 */
import { describe, it, expect } from 'vitest'
import type {
  DiscoveredTarget,
  ProbeTargetConfigResult,
  SendResult,
  TargetKind,
} from '@camstack/types'
import { concatCollection } from '../../api/trpc/cap-mount-helpers.js'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

/** The array-output surface every provider shares (fanned into the catalog). */
interface NotifCatalogProvider {
  listTargetKinds: (input: unknown) => Promise<readonly TargetKind[]>
  discoverTargets: (input: unknown) => Promise<readonly DiscoveredTarget[]>
}

/** A full provider — catalog surface + the single-object methods. */
interface FullNotifProvider extends NotifCatalogProvider {
  testTarget: (input: { targetId: string }) => Promise<SendResult>
  probeTargetConfig: (input: {
    kind: string
    config: Record<string, unknown>
  }) => Promise<ProbeTargetConfigResult>
}

function makeKind(addonId: string, kind: string): TargetKind {
  return {
    kind,
    label: kind,
    icon: 'bell',
    addonId,
    configSchema: { sections: [] },
    supportsDiscovery: false,
    caps: {
      attachments: { mediaTypes: [], mode: 'url', max: 0 },
      actions: 0,
      levels: [],
      format: ['text'],
      clickUrl: false,
      sound: false,
      ttl: false,
      bodyMaxLen: 1024,
    },
  }
}

/**
 * A COMPLETE `notification-output` provider owning one addonId. Records every
 * test / probe so a test can prove which provider actually served the call.
 */
function makeFullProvider(
  addonId: string,
  kind: string,
): {
  provider: FullNotifProvider
  tests: string[]
  probes: string[]
} {
  const tests: string[] = []
  const probes: string[] = []
  const provider: FullNotifProvider = {
    listTargetKinds: async () => [makeKind(addonId, kind)],
    discoverTargets: async () => [{ kind, suggestedName: addonId, config: {} }],
    testTarget: async ({ targetId }) => {
      tests.push(targetId)
      return { success: true }
    },
    probeTargetConfig: async ({ kind: probedKind }) => {
      probes.push(probedKind)
      return { ok: true, resolvedUrl: '' }
    },
  }
  return { provider, tests, probes }
}

/**
 * The PARTIAL `advanced-notifier` provider — the legacy `ConsoleOutput`. It
 * implements ONLY `send`; it has NO `testTarget` / `probeTargetConfig` and no
 * catalog methods (a missing array method contributes `[]` to the fan-out).
 * Any single-object call that reaches it throws — asserting the router NEVER
 * routes one here.
 */
function makePartialProvider(): { send: (input: { targetId: string }) => Promise<SendResult> } {
  return {
    send: async () => ({ success: true }),
  }
}

/**
 * Mirror of the runtime collection resolution for `notification-output`
 * (`cap-router-runtime.ts` `resolveCollectionProvider`): an addonId selects
 * that provider directly; else a first-provider aggregate whose array-output
 * methods are `concatCollection`-fanned across every provider. The PARTIAL
 * provider is registered FIRST — the exact live topology that crashed.
 */
function makeSelector(): {
  select: (addonId?: string) => object | null
  notifiers: ReturnType<typeof makeFullProvider>
  homeAssistant: ReturnType<typeof makeFullProvider>
} {
  const partial = makePartialProvider()
  const notifiers = makeFullProvider('notifiers', 'webhook')
  const homeAssistant = makeFullProvider('provider-homeassistant', 'ha-notify')
  const byAddonId: Record<string, object> = {
    notifiers: notifiers.provider,
    'provider-homeassistant': homeAssistant.provider,
  }
  const providers: readonly NotifCatalogProvider[] = [
    partial as unknown as NotifCatalogProvider,
    notifiers.provider,
    homeAssistant.provider,
  ]
  const select = (addonId?: string): object | null => {
    if (addonId !== undefined) return byAddonId[addonId] ?? null
    const first = providers[0]
    return {
      ...first,
      listTargetKinds: concatCollection(providers, 'listTargetKinds'),
      discoverTargets: concatCollection(providers, 'discoverTargets'),
    }
  }
  return { select, notifiers, homeAssistant }
}

describe('notification-output cap — single-object call routing', () => {
  it('testTarget WITH a top-level addonId selector routes to the owner, not the partial first provider', async () => {
    const { select, notifiers, homeAssistant } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    const outcome = await invokeProcedure(router, 'testTarget', makeCtx('admin'), {
      addonId: 'notifiers',
      targetId: 'wh_1',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(notifiers.tests).toEqual(['wh_1'])
    expect(homeAssistant.tests).toEqual([])
  })

  it('testTarget names the OTHER owner and only that owner serves it', async () => {
    const { select, notifiers, homeAssistant } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    const outcome = await invokeProcedure(router, 'testTarget', makeCtx('admin'), {
      addonId: 'provider-homeassistant',
      targetId: 'ha_1',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(homeAssistant.tests).toEqual(['ha_1'])
    expect(notifiers.tests).toEqual([])
  })

  it('probeTargetConfig WITHOUT a top-level addonId recovers the owner from the payload one level down', async () => {
    const { select, notifiers, homeAssistant } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    const outcome = await invokeProcedure(router, 'probeTargetConfig', makeCtx('admin'), {
      kind: 'webhook',
      config: { addonId: 'notifiers', url: 'http://example.com/hook' },
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(notifiers.probes).toEqual(['webhook'])
    expect(homeAssistant.probes).toEqual([])
  })

  it('listTargetKinds fans out (UNION across providers) and is never rerouted', async () => {
    const { select } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    const outcome = await invokeProcedure(router, 'listTargetKinds', makeCtx('admin'), {})

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const kinds = outcome.value as TargetKind[]
    // Only the full providers contribute a kind; the partial one contributes [].
    expect(kinds.map((k) => k.addonId)).toEqual(['notifiers', 'provider-homeassistant'])
  })

  it('an ARRAY method carrying a stray nested addonId still fans out (array fan-out is not rerouted)', async () => {
    const { select } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    // A nested `{ addonId }` in a list input must NOT collapse the union onto
    // one provider — the isArrayOutputSchema gate keeps addonId undefined here.
    const outcome = await invokeProcedure(router, 'discoverTargets', makeCtx('admin'), {
      kind: 'webhook',
      config: { addonId: 'notifiers' },
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const found = outcome.value as DiscoveredTarget[]
    expect(found.map((d) => d.suggestedName)).toEqual(['notifiers', 'provider-homeassistant'])
  })
})
