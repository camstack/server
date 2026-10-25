import { describe, it, expect, vi } from 'vitest'
import type { LocalChildRegistry, AddonCallInput } from '@camstack/system'
import { AddonCallGateway, type AddonCallGatewayDeps } from '../addon-call-gateway'

/**
 * Co-location correctness: the gateway must route an addon-level call to the
 * addon's RUNNER child id (its `execution.group` when grouped, else its own
 * id), NOT blindly assume `childId === addonId`. For today's ungrouped addons
 * the resolver is the identity so behaviour is byte-for-byte unchanged; for a
 * grouped addon the child id is the group and the call must still reach it.
 */

interface FakeChildRegistry {
  isChildKnown: (childId: string) => boolean
  callAddonOnChild: (childId: string, input: AddonCallInput) => Promise<unknown>
}

function makeGateway(
  opts: {
    knownChildIds: readonly string[]
    resolveChildId: (addonId: string) => string
    onHub?: boolean
  },
  spies: { callAddonOnChild: FakeChildRegistry['callAddonOnChild'] },
): AddonCallGateway {
  const fakeRegistry: FakeChildRegistry = {
    isChildKnown: (childId) => opts.knownChildIds.includes(childId),
    callAddonOnChild: spies.callAddonOnChild,
  }
  const deps: AddonCallGatewayDeps = {
    hubNodeId: 'hub',
    resolveNode: () => (opts.onHub === false ? 'agent-1' : 'hub'),
    getChildRegistry: () => fakeRegistry as unknown as LocalChildRegistry,
    resolveChildId: opts.resolveChildId,
    broker: { registry: {}, call: async () => undefined },
  }
  return new AddonCallGateway(deps)
}

describe('AddonCallGateway — childId resolution (co-location)', () => {
  it('ungrouped addon: identity resolver → classify hub-local-child, routes to addon id (unchanged)', async () => {
    const callAddonOnChild = vi.fn(async () => ({ ok: true }))
    const gw = makeGateway(
      { knownChildIds: ['auth-oidc'], resolveChildId: (id) => id },
      { callAddonOnChild },
    )
    expect(gw.classify('auth-oidc')).toEqual({ kind: 'hub-local-child' })
    await gw.callForked('auth-oidc', { target: 'routes' })
    expect(callAddonOnChild).toHaveBeenCalledWith('auth-oidc', {
      target: 'routes',
      addonId: 'auth-oidc',
    })
  })

  it('grouped addon: child id is the group — classify hub-local-child even though addon id is NOT a known child', async () => {
    const callAddonOnChild = vi.fn(async () => ({ ok: true }))
    // The runner registers under the GROUP id `auth`; the addon id `auth-oidc`
    // is not itself a child. Pre-fix this misclassified as `in-process`.
    const gw = makeGateway(
      {
        knownChildIds: ['auth'],
        resolveChildId: (id) => (id.startsWith('auth-') ? 'auth' : id),
      },
      { callAddonOnChild },
    )
    expect(gw.classify('auth-oidc')).toEqual({ kind: 'hub-local-child' })
  })

  it('grouped addon: callForked dispatches to the group child id but keeps the real addon id in the payload', async () => {
    const callAddonOnChild = vi.fn(async () => ({ ok: true }))
    const gw = makeGateway(
      {
        knownChildIds: ['auth'],
        resolveChildId: (id) => (id.startsWith('auth-') ? 'auth' : id),
      },
      { callAddonOnChild },
    )
    await gw.callForked('auth-webauthn', { target: 'settings', method: 'getGlobalSettings' })
    expect(callAddonOnChild).toHaveBeenCalledWith('auth', {
      target: 'settings',
      method: 'getGlobalSettings',
      addonId: 'auth-webauthn',
    })
  })
})
