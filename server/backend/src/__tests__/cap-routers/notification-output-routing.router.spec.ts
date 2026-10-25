/**
 * Routing regression spec for the `notification-output` system-collection cap.
 *
 * The bug (confirmed live): `notification-output` is
 * `scope:'system', mode:'collection'`. Multiple addons register a provider —
 * `notifiers` (full CRUD), `provider-homeassistant` (full CRUD), and
 * `advanced-notifier` (a PARTIAL `ConsoleOutput` that implements only `send`,
 * NOT the target CRUD). The generated collection mount fans out only the
 * ARRAY-output methods (`listTargetKinds` / `listTargets` / `discoverTargets`);
 * every single-object mutation (`upsertTarget` / `deleteTarget` / …) fell
 * through to `providers[0]`. When the first-registered provider is the partial
 * `ConsoleOutput`, `upsertTarget` hits a provider that doesn't implement it →
 * `child-cap-dispatch: method 'upsertTarget' not found on provider
 * 'notification-output'`. Even against a COMPLETE first provider it would
 * misroute (a HA target upserted into the notifiers store).
 *
 * The fix: single-object collection mutations route to their OWNING provider
 * via an addonId. The router prefers the explicit top-level `{ addonId }`
 * selector (the `broker`-cap precedent), and — when the caller omits it —
 * recovers the routing addonId the mutation payload ALREADY carries
 * (`Target.addonId`, stamped by each provider) via `extractNestedAddonId`.
 * ARRAY methods keep their union fan-out and are NEVER rerouted.
 *
 * This spec drives the LIVE runtime router (`buildCapRouterForTest`) with a
 * selector that mirrors the real registry resolution (addonId → provider, else
 * a first-provider aggregate whose array methods are fanned). The FIRST
 * provider is the partial one, reproducing the exact live topology.
 */
import { describe, it, expect } from 'vitest'
import type { Target, TargetKind, SendResult } from '@camstack/types'
import { concatCollection } from '../../api/trpc/cap-mount-helpers.js'
import { makeCtx, invokeProcedure, buildCapRouterForTest } from './harness.js'

/** The array-output surface every provider shares (fanned into the catalog). */
interface NotifCatalogProvider {
  listTargetKinds: (input: unknown) => Promise<readonly TargetKind[]>
  listTargets: (input: unknown) => Promise<readonly Target[]>
}

/** A full provider — catalog surface + single-object CRUD. */
interface FullNotifProvider extends NotifCatalogProvider {
  upsertTarget: (input: { target: Target }) => Promise<Target>
  deleteTarget: (input: { targetId: string }) => Promise<void>
  send: (input: { targetId: string }) => Promise<SendResult>
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
 * upsert/delete so a test can prove which provider actually served the call.
 */
function makeFullProvider(
  addonId: string,
  kind: string,
): {
  provider: FullNotifProvider
  upserts: Target[]
  deletes: string[]
} {
  const upserts: Target[] = []
  const deletes: string[] = []
  const provider: FullNotifProvider = {
    listTargetKinds: async () => [makeKind(addonId, kind)],
    listTargets: async () => [],
    upsertTarget: async ({ target }) => {
      const stored: Target = { ...target, addonId }
      upserts.push(stored)
      return stored
    },
    deleteTarget: async ({ targetId }) => {
      deletes.push(targetId)
    },
    send: async () => ({ success: true }),
  }
  return { provider, upserts, deletes }
}

/**
 * The PARTIAL `advanced-notifier` provider — the legacy `ConsoleOutput`. It
 * implements ONLY `send`; it has NO `upsertTarget` / `deleteTarget` and no
 * catalog methods (a missing array method contributes `[]` to the fan-out).
 * Any CRUD call that reaches it throws — asserting the router NEVER routes a
 * mutation here.
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
} {
  const partial = makePartialProvider()
  const notifiers = makeFullProvider('notifiers', 'webhook')
  const byAddonId: Record<string, object> = { notifiers: notifiers.provider }
  const providers: readonly NotifCatalogProvider[] = [
    partial as unknown as NotifCatalogProvider,
    notifiers.provider,
  ]
  const select = (addonId?: string): object | null => {
    if (addonId !== undefined) return byAddonId[addonId] ?? null
    const first = providers[0]
    return {
      ...first,
      listTargetKinds: concatCollection(providers, 'listTargetKinds'),
      listTargets: concatCollection(providers, 'listTargets'),
    }
  }
  return { select, notifiers }
}

const sampleTarget: Target = {
  id: 'wh_1',
  name: 'My Webhook',
  kind: 'webhook',
  addonId: 'notifiers',
  enabled: true,
  config: { url: 'http://example.com/hook' },
}

describe('notification-output cap — single-object mutation routing', () => {
  it('upsertTarget WITHOUT a top-level addonId routes to the OWNING provider via the payload addonId (not the partial first provider)', async () => {
    const { select, notifiers } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    const outcome = await invokeProcedure(router, 'upsertTarget', makeCtx('admin'), {
      target: sampleTarget,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Served by the notifiers provider — proven by its recorded upsert.
    expect(notifiers.upserts.map((t) => t.id)).toEqual(['wh_1'])
    expect((outcome.value as Target).addonId).toBe('notifiers')
  })

  it('upsertTarget WITH an explicit top-level addonId selector routes to the owner', async () => {
    const { select, notifiers } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    const outcome = await invokeProcedure(router, 'upsertTarget', makeCtx('admin'), {
      addonId: 'notifiers',
      target: sampleTarget,
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(notifiers.upserts.map((t) => t.id)).toEqual(['wh_1'])
  })

  it('deleteTarget (id-only payload) routes to the owner via the top-level addonId selector', async () => {
    const { select, notifiers } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    const outcome = await invokeProcedure(router, 'deleteTarget', makeCtx('admin'), {
      addonId: 'notifiers',
      targetId: 'wh_1',
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(notifiers.deletes).toEqual(['wh_1'])
  })

  it('listTargetKinds fans out (UNION across providers) and is never rerouted', async () => {
    const { select } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    const outcome = await invokeProcedure(router, 'listTargetKinds', makeCtx('admin'), {})

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const kinds = outcome.value as TargetKind[]
    // Only the full provider contributes a kind; the partial one contributes [].
    expect(kinds.map((k) => k.addonId)).toEqual(['notifiers'])
  })

  it('an ARRAY method carrying a stray nested addonId still fans out (array fan-out is not rerouted)', async () => {
    const { select } = makeSelector()
    const router = buildCapRouterForTest('notification-output', (_ctx, addonId) => select(addonId))

    // A nested `{ addonId }` in a list input must NOT collapse the union onto
    // one provider — the isArrayOutputSchema gate keeps addonId undefined here.
    const outcome = await invokeProcedure(router, 'listTargets', makeCtx('admin'), {
      bogus: { addonId: 'notifiers' },
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(Array.isArray(outcome.value)).toBe(true)
  })
})
