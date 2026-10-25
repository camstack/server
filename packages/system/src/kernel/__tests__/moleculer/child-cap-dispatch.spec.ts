import { describe, it, expect } from 'vitest'
import {
  CAP_METHOD_NOT_IMPLEMENTED,
  createChildCapDispatch,
} from '../../moleculer/child-cap-dispatch.js'
import type { ChildCapDispatchDeps } from '../../moleculer/child-cap-dispatch.js'

// ---------------------------------------------------------------------------
// Fake provider helpers
// ---------------------------------------------------------------------------

type FakeProvider = Record<string, (args: unknown) => unknown>

function makeDeviceDeps(
  capName: string,
  deviceId: number,
  provider: FakeProvider,
): ChildCapDispatchDeps {
  return {
    getSingletonProvider: () => null,
    getDeviceProvider: (cn, did) => (cn === capName && did === deviceId ? provider : null),
    isCollectionListMethod: () => false,
    isProviderOptionalMethod: () => false,
  }
}

function makeSingletonDeps(capName: string, provider: FakeProvider): ChildCapDispatchDeps {
  return {
    getSingletonProvider: (cn) => (cn === capName ? provider : null),
    getDeviceProvider: () => null,
    isCollectionListMethod: () => false,
    isProviderOptionalMethod: () => false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createChildCapDispatch', () => {
  it('(a) device-scoped call: resolves provider via getDeviceProvider and invokes method with full args', async () => {
    const received: unknown[] = []
    const provider: FakeProvider = {
      move: (args) => {
        received.push(args)
        return { moved: true }
      },
    }
    const deps = makeDeviceDeps('ptz', 42, provider)
    const dispatch = createChildCapDispatch(deps)

    const args = { deviceId: 42, x: 1, y: 2 }
    const result = await dispatch({ capName: 'ptz', method: 'move', args, deviceId: 42 })

    expect(result).toEqual({ moved: true })
    // The FULL args object (including deviceId) must be passed to the method
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(args)
  })

  it('(b) singleton call: resolves provider via getSingletonProvider and invokes method', async () => {
    const received: unknown[] = []
    const provider: FakeProvider = {
      getStatus: (args) => {
        received.push(args)
        return { status: 'ok' }
      },
    }
    const deps = makeSingletonDeps('metrics', provider)
    const dispatch = createChildCapDispatch(deps)

    const args = { filter: 'cpu' }
    const result = await dispatch({ capName: 'metrics', method: 'getStatus', args })

    expect(result).toEqual({ status: 'ok' })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(args)
  })

  it('(c) no provider found (device) → rejects with error mentioning capName and deviceId', async () => {
    const deps: ChildCapDispatchDeps = {
      getSingletonProvider: () => null,
      getDeviceProvider: () => null,
      isCollectionListMethod: () => false,
      isProviderOptionalMethod: () => false,
    }
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({ capName: 'motion-zones', method: 'getZones', args: { deviceId: 7 }, deviceId: 7 }),
    ).rejects.toThrow(/motion-zones/)

    await expect(
      dispatch({ capName: 'motion-zones', method: 'getZones', args: { deviceId: 7 }, deviceId: 7 }),
    ).rejects.toThrow(/7/)
  })

  it('(d) no provider found (singleton) → rejects with error mentioning capName', async () => {
    const deps: ChildCapDispatchDeps = {
      getSingletonProvider: () => null,
      getDeviceProvider: () => null,
      isCollectionListMethod: () => false,
      isProviderOptionalMethod: () => false,
    }
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({ capName: 'network-access', method: 'start', args: {} }),
    ).rejects.toThrow(/network-access/)
  })

  it('(e) method missing on resolved provider → rejects with error mentioning method name', async () => {
    const provider: FakeProvider = { getStatus: () => ({}) }
    const deps = makeSingletonDeps('metrics', provider)
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({ capName: 'metrics', method: 'nonExistentMethod', args: {} }),
    ).rejects.toThrow(/nonExistentMethod/)
  })

  it('(f) provider method throws → same error propagates to the caller', async () => {
    const boom = new Error('provider exploded')
    const provider: FakeProvider = {
      doThing: () => {
        throw boom
      },
    }
    const deps = makeSingletonDeps('some-cap', provider)
    const dispatch = createChildCapDispatch(deps)

    await expect(dispatch({ capName: 'some-cap', method: 'doThing', args: {} })).rejects.toThrow(
      'provider exploded',
    )
  })

  it('(f-async) provider method returns rejected promise → rejection propagates', async () => {
    const provider: FakeProvider = {
      asyncOp: () => Promise.reject(new Error('async boom')),
    }
    const deps = makeSingletonDeps('async-cap', provider)
    const dispatch = createChildCapDispatch(deps)

    await expect(dispatch({ capName: 'async-cap', method: 'asyncOp', args: {} })).rejects.toThrow(
      'async boom',
    )
  })

  it('(g) singleton cap call carrying a deviceId arg: falls back to the singleton provider', async () => {
    // `pipeline-runner` is a SINGLETON cap whose methods (attachCamera,
    // getCameraMetrics, …) carry `deviceId` as a METHOD ARGUMENT, not a
    // provider-routing key. There is no per-device provider, so the
    // dispatcher must fall back to the singleton instead of 404-ing on
    // the device lookup. (Regression: this previously threw and forced
    // the orchestrator's attachCamera onto the broker path, which hung.)
    const received: unknown[] = []
    const provider: FakeProvider = {
      attachCamera: (args) => {
        received.push(args)
        return { success: true }
      },
    }
    const deps = makeSingletonDeps('pipeline-runner', provider)
    const dispatch = createChildCapDispatch(deps)

    const args = { deviceId: 5, detectionMode: 'on-motion' }
    const result = await dispatch({
      capName: 'pipeline-runner',
      method: 'attachCamera',
      args,
      deviceId: 5,
    })

    expect(result).toEqual({ success: true })
    // The full args object (including deviceId) is forwarded to the method.
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(args)
  })

  it('(h) device-scoped provider is still preferred over a singleton when both resolve', async () => {
    // Guard the ordering: a genuine per-device provider must win over any
    // singleton fallback for the same capName + deviceId.
    const calls: string[] = []
    const deviceProvider: FakeProvider = {
      op: () => {
        calls.push('device')
        return 'device'
      },
    }
    const singletonProvider: FakeProvider = {
      op: () => {
        calls.push('singleton')
        return 'singleton'
      },
    }
    const deps: ChildCapDispatchDeps = {
      getSingletonProvider: (cn) => (cn === 'dual' ? singletonProvider : null),
      getDeviceProvider: (cn, did) => (cn === 'dual' && did === 7 ? deviceProvider : null),
      isCollectionListMethod: () => false,
      isProviderOptionalMethod: () => false,
    }
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({ capName: 'dual', method: 'op', args: { deviceId: 7 }, deviceId: 7 }),
    ).resolves.toBe('device')
    expect(calls).toEqual(['device'])
  })

  // ── (i) provider selection by addonId — grouped runners ─────────────────
  // A grouped runner (`execution.group`) can host TWO providers of the SAME
  // collection cap (e.g. `network-access` from cloudflare-tunnel AND
  // tailscale-ingress in the `net-access` group). The dispatcher must hand
  // the addonId hint to `getSingletonProvider` so the child resolves the
  // provider the hub picked — not one-per-capName.

  function makeMultiProviderDeps(
    capName: string,
    byAddon: ReadonlyMap<string, FakeProvider>,
  ): ChildCapDispatchDeps {
    return {
      getSingletonProvider: (cn, addonId) => {
        if (cn !== capName) return null
        if (addonId !== undefined && byAddon.has(addonId)) return byAddon.get(addonId) ?? null
        const first = byAddon.values().next()
        return first.done ? null : first.value
      },
      getDeviceProvider: () => null,
      isCollectionListMethod: () => false,
      isProviderOptionalMethod: () => false,
    }
  }

  it('(i) out-of-band call.addonId selects the matching co-located provider', async () => {
    const calls: string[] = []
    const mk = (id: string): FakeProvider => ({
      getStatus: () => {
        calls.push(id)
        return { from: id }
      },
    })
    const deps = makeMultiProviderDeps(
      'network-access',
      new Map([
        ['cloudflare-tunnel', mk('cloudflare-tunnel')],
        ['tailscale-ingress', mk('tailscale-ingress')],
      ]),
    )
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({
        capName: 'network-access',
        method: 'getStatus',
        args: {},
        addonId: 'tailscale-ingress',
      }),
    ).resolves.toEqual({ from: 'tailscale-ingress' })
    expect(calls).toEqual(['tailscale-ingress'])
  })

  it('(i-args) falls back to an addonId still present IN the args (sibling unowned calls)', async () => {
    const mk = (id: string): FakeProvider => ({ getStatus: () => ({ from: id }) })
    const deps = makeMultiProviderDeps(
      'network-access',
      new Map([
        ['cloudflare-tunnel', mk('cloudflare-tunnel')],
        ['tailscale-ingress', mk('tailscale-ingress')],
      ]),
    )
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({
        capName: 'network-access',
        method: 'getStatus',
        args: { addonId: 'tailscale-ingress' },
      }),
    ).resolves.toEqual({ from: 'tailscale-ingress' })
  })

  it('(i-fallback) no addonId hint → the sole/first provider handles the call', async () => {
    const mk = (id: string): FakeProvider => ({ getStatus: () => ({ from: id }) })
    const deps = makeMultiProviderDeps(
      'network-access',
      new Map([['cloudflare-tunnel', mk('cloudflare-tunnel')]]),
    )
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({ capName: 'network-access', method: 'getStatus', args: {} }),
    ).resolves.toEqual({ from: 'cloudflare-tunnel' })
  })

  // ── (j–l) COLLECTION cap list-method graceful skip ──────────────────────
  // A `mode:'collection'` cap's array-returning method (`listTargets`, …) is
  // unioned at the hub across every registered provider. A provider that only
  // implements PART of the surface (e.g. `addon-advanced-notifier` implements
  // `send` but not `listTargets`) must contribute `[]`, never surface
  // "method 'listTargets' not found". Across the UDS boundary the hub's
  // per-provider proxy fabricates a callable for every property, so the skip
  // must happen on the child that owns the real provider — right here.

  function makeCollectionDeps(
    capName: string,
    provider: FakeProvider,
    listMethods: readonly string[],
  ): ChildCapDispatchDeps {
    return {
      getSingletonProvider: (cn) => (cn === capName ? provider : null),
      getDeviceProvider: () => null,
      isCollectionListMethod: (cn, method) => cn === capName && listMethods.includes(method),
      isProviderOptionalMethod: () => false,
    }
  }

  function makeOptionalDeps(
    capName: string,
    provider: FakeProvider,
    optionalMethods: readonly string[],
  ): ChildCapDispatchDeps {
    return {
      getSingletonProvider: (cn) => (cn === capName ? provider : null),
      getDeviceProvider: () => null,
      isCollectionListMethod: () => false,
      isProviderOptionalMethod: (cn, method) => cn === capName && optionalMethods.includes(method),
    }
  }

  it('a method declared optionalMethod refuses by NAME, not as an internal error', async () => {
    // `videoclips.getPlaybackOptions` at the recorder's `analytics` source: a
    // time WINDOW with no file behind it, so the absence is a fact about that
    // source. The hub's own `callSource` guard cannot see it — the UDS proxy
    // fabricates a callable for every property — so the child must say it,
    // and the token is what the hub matches to answer NOT_IMPLEMENTED.
    // Measured on the live hub 2026-09-24: this threw INTERNAL_SERVER_ERROR
    // on every player open over our own clips.
    const provider: FakeProvider = { listClips: () => [] }
    const deps = makeOptionalDeps('videoclips', provider, ['getPlaybackOptions'])
    await expect(
      createChildCapDispatch(deps)({
        capName: 'videoclips',
        method: 'getPlaybackOptions',
        args: {},
      }),
    ).rejects.toThrow(CAP_METHOD_NOT_IMPLEMENTED)
  })

  it('a method that is simply MISSING still reads as a bug', async () => {
    // The distinction is the whole point: a typo and an honest absence must
    // not produce the same message, or the named refusal buys nothing.
    const provider: FakeProvider = { listClips: () => [] }
    const deps = makeOptionalDeps('videoclips', provider, ['getPlaybackOptions'])
    await expect(
      createChildCapDispatch(deps)({
        capName: 'videoclips',
        method: 'getPlaybakOptions',
        args: {},
      }),
    ).rejects.toThrow(/not found on provider/)
  })

  it('(j) collection list-method absent on a partial provider → resolves to [] (no throw)', async () => {
    // Partial provider: implements the dispatch side (`send`) but NOT the
    // catalog side (`listTargets`) — exactly the advanced-notifier shape.
    const provider: FakeProvider = { send: () => ({ success: true }) }
    const deps = makeCollectionDeps('notification-output', provider, [
      'listTargets',
      'listTargetKinds',
      'discoverTargets',
    ])
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({ capName: 'notification-output', method: 'listTargets', args: {} }),
    ).resolves.toEqual([])
  })

  it('(k) collection list-method present on the provider → returns the provider array', async () => {
    // The implementing provider (e.g. `addon-notifiers`) still contributes its
    // real rows — the graceful skip only kicks in when the method is absent.
    const rows = [{ id: 't1' }, { id: 't2' }]
    const provider: FakeProvider = { listTargets: () => rows }
    const deps = makeCollectionDeps('notification-output', provider, ['listTargets'])
    const dispatch = createChildCapDispatch(deps)

    await expect(
      dispatch({ capName: 'notification-output', method: 'listTargets', args: {} }),
    ).resolves.toEqual(rows)
  })

  it('(l) collection fan-out with zero implementers → union is [] (per-provider skip flattens)', async () => {
    // Model the hub-side fan-out: two registered providers, NEITHER implements
    // `listTargets`. Each child dispatch returns [] (graceful), the hub flattens
    // → []. Contrast with a singleton cap (below) where absence is a real bug.
    const providerA: FakeProvider = { send: () => ({ success: true }) }
    const providerB: FakeProvider = { testTarget: () => ({ success: true }) }
    const listMethods = ['listTargets']
    const mkDeps = (p: FakeProvider): ChildCapDispatchDeps => ({
      getSingletonProvider: () => p,
      getDeviceProvider: () => null,
      isCollectionListMethod: (_cn, m) => listMethods.includes(m),
      isProviderOptionalMethod: () => false,
    })
    const dispatchA = createChildCapDispatch(mkDeps(providerA))
    const dispatchB = createChildCapDispatch(mkDeps(providerB))

    const perProvider = await Promise.all([
      dispatchA({ capName: 'notification-output', method: 'listTargets', args: {} }),
      dispatchB({ capName: 'notification-output', method: 'listTargets', args: {} }),
    ])
    const union = perProvider.flat()
    expect(union).toEqual([])
  })

  it('(m) a SINGLETON cap missing a method still throws (not silently emptied)', async () => {
    // `isCollectionListMethod` returns false for singleton caps, so a genuinely
    // missing method surfaces as the real "method not found" bug.
    const provider: FakeProvider = { getStatus: () => ({}) }
    const deps = makeCollectionDeps('notification-output', provider, ['listTargets'])
    const dispatch = createChildCapDispatch(deps)

    // `send` is NOT a collection list-method → predicate false → still throws.
    await expect(
      dispatch({ capName: 'notification-output', method: 'send', args: {} }),
    ).rejects.toThrow(/send/)
  })
})
