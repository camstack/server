import { nodePin } from '@camstack/types'
import { createTRPCClient, type TRPCLink } from '@trpc/client'
import type { ServiceBroker } from 'moleculer'
import { describe, expect, it, vi } from 'vitest'
import {
  brokerTransportLink,
  type CapUsageObservation,
  type CapUsageObserver,
  type CapUsageObserverOptions,
  type LocalProviderResolver,
  localProviderLink,
  recordCapUsage,
  UNRESOLVED_PROVIDER_ADDON_ID,
} from '../moleculer/trpc-links'

// The tests drive the link chain through ad-hoc procedure paths
// (`modelConvert.convert`, …) that don't exist on a `createTRPCClient<never>`
// router type. This minimal proxy shape lets the dynamic `.query`/`.mutate`
// access typecheck without `any`.
type DynamicTrpcProcedure = {
  query: (...args: readonly unknown[]) => Promise<unknown>
  mutate: (...args: readonly unknown[]) => Promise<unknown>
}
interface DynamicTrpcClient {
  modelConvert: { convert: DynamicTrpcProcedure }
}

describe('localProviderLink — node pin must win over a co-located provider', () => {
  const provider = { convert: async (input: { v: number }) => ({ where: 'local', v: input.v }) }

  it('defers to the next link when the op is pinned to a DIFFERENT node', async () => {
    const resolver: LocalProviderResolver = {
      getByName: (name) => (name === 'model-convert' ? provider : null),
      localNodeId: 'hub/model-studio',
    }
    const link: TRPCLink<never> = localProviderLink(resolver)
    // Terminating link stands in for ipcParentLink/transport — proves the
    // pinned call escaped the in-process short-circuit.
    const terminating: TRPCLink<never> = () => () =>
      ({
        subscribe: (o: { next: (value: unknown) => void; complete: () => void }) => (
          o.next({ result: { type: 'data', data: { where: 'routed' } } }),
          o.complete(),
          { unsubscribe() {} }
        ),
      }) as unknown as ReturnType<ReturnType<TRPCLink<never>>>
    const client = createTRPCClient<never>({
      links: [link, terminating],
    }) as unknown as DynamicTrpcClient
    const out = await client.modelConvert.convert.mutate({ v: 1 }, nodePin('agent-a'))
    expect(out).toEqual({ where: 'routed' })
  })

  it('resolves locally when the pin targets the local node (base of nodeId)', async () => {
    const resolver: LocalProviderResolver = {
      getByName: (name) => (name === 'model-convert' ? provider : null),
      localNodeId: 'agent-a/model-studio',
    }
    const link: TRPCLink<never> = localProviderLink(resolver)
    const fail: TRPCLink<never> = () => () => {
      throw new Error('next should not be called — pin targets local node')
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = createTRPCClient<never>({ links: [link, fail] })
    const out = await client.modelConvert.convert.mutate({ v: 7 }, nodePin('agent-a'))
    expect(out).toEqual({ where: 'local', v: 7 })
  })

  it('resolves locally when there is no pin (fast path unchanged)', async () => {
    const resolver: LocalProviderResolver = {
      getByName: (name) => (name === 'model-convert' ? provider : null),
      localNodeId: 'hub',
    }
    const link: TRPCLink<never> = localProviderLink(resolver)
    const fail: TRPCLink<never> = () => () => {
      throw new Error('next should not be called — no pin')
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = createTRPCClient<never>({ links: [link, fail] })
    const out = await client.modelConvert.convert.mutate({ v: 3 })
    expect(out).toEqual({ where: 'local', v: 3 })
  })

  it('resolves locally when the resolver declares no localNodeId (backward compat)', async () => {
    const resolver: LocalProviderResolver = {
      getByName: (name) => (name === 'model-convert' ? provider : null),
    }
    const link: TRPCLink<never> = localProviderLink(resolver)
    const fail: TRPCLink<never> = () => () => {
      throw new Error('next should not be called — no localNodeId means legacy behavior')
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = createTRPCClient<never>({ links: [link, fail] })
    const out = await client.modelConvert.convert.mutate({ v: 5 }, nodePin('agent-a'))
    expect(out).toEqual({ where: 'local', v: 5 })
  })
})

describe('localProviderLink — cap-usage observer hook', () => {
  it('invokes the observer with (callerAddonId, providerAddonId, capName, methodName) on every local op', async () => {
    const provider = { doThing: async (input: { v: number }) => ({ v: input.v + 1 }) }
    const resolver: LocalProviderResolver = {
      getByName: (name: string) => (name === 'cap-foo' ? provider : null),
    }
    const observer = vi.fn<CapUsageObserver>()
    const link: TRPCLink<never> = localProviderLink(resolver, {
      callerAddonId: 'addon-a',
      providerAddonIdForCap: () => 'addon-b',
      observer,
    })

    // Minimal terminating link that should never be called.
    const fail: TRPCLink<never> = () => () => {
      throw new Error('next should not be called')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = createTRPCClient<never>({ links: [link, fail] })
    const out = await client.capFoo.doThing.query({ v: 1 })
    expect(out).toEqual({ v: 2 })
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith({
      callerAddonId: 'addon-a',
      providerAddonId: 'addon-b',
      capName: 'cap-foo',
      methodName: 'doThing',
      atMs: expect.any(Number),
    })
  })

  it('does not throw the caller call if the observer throws', async () => {
    const provider = { x: async () => ({ ok: true }) }
    const resolver: LocalProviderResolver = { getByName: () => provider }
    const observer = vi.fn<CapUsageObserver>(() => {
      throw new Error('observer-broken')
    })
    const link = localProviderLink(resolver, {
      callerAddonId: 'a',
      providerAddonIdForCap: () => 'b',
      observer,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = createTRPCClient<never>({ links: [link] })
    await expect(client.foo.x.query()).resolves.toEqual({ ok: true })
  })
})

// ── brokerTransportLink observer hook ─────────────────────────────────────
//
// For BROKER-routed ops the link can't ask a local resolver who hosts the
// provider — the provider lives in another process. After Moleculer service
// discovery resolves the target action, the resolved Moleculer service name
// IS the provider's addon-id (camstack convention: each addon registers its
// native-cap service under its own addonId). The observer must therefore
// fire AFTER discovery with `providerAddonId = serviceName`, and only fall
// back to the resolver callback in the degenerate case where discovery
// could not distinguish service from cap.

interface BrokerCall {
  readonly action: string
  readonly params: unknown
  readonly opts: unknown
}

interface StubService {
  readonly name: string
  readonly nodeID: string
  readonly actions: Record<string, unknown>
}

function makeStubBroker(
  result: unknown,
  services: ReadonlyArray<StubService>,
): { broker: ServiceBroker; calls: BrokerCall[] } {
  const calls: BrokerCall[] = []
  const broker = {
    call: (action: string, params: unknown, opts: unknown) => {
      calls.push({ action, params, opts })
      return Promise.resolve(result)
    },
    registry: {
      getServiceList: () => services,
    },
  } as unknown as ServiceBroker
  return { broker, calls }
}

function runBrokerOp(
  broker: ServiceBroker,
  path: string,
  input: unknown,
  observerOpts?: Parameters<typeof brokerTransportLink>[2],
): Promise<unknown> {
  const link = brokerTransportLink(broker, undefined, observerOpts)({} as never)
  return new Promise((resolve, reject) => {
    const subscription = link({
      op: { id: 1, type: 'query', path, input, context: {}, signal: null as never },
      next: () => {
        throw new Error('brokerTransportLink should be terminal')
      },
    } as never).subscribe({
      next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
      error: (err: unknown) => reject(err as Error),
      complete: () => {
        /* already resolved via next */
      },
    })
    void subscription
  })
}

describe('brokerTransportLink — cap-usage observer hook', () => {
  it('records providerAddonId from the resolved Moleculer service name (cross-process discovery)', async () => {
    // Cap `stream-params` is hosted by `provider-hikvision` on `agent-1`.
    // The local resolver returns null because the provider is NOT in this
    // process — only the broker registry knows. The observer MUST still
    // fire, with providerAddonId taken from the resolved serviceName.
    const { broker, calls } = makeStubBroker({ ok: true }, [
      {
        name: 'provider-hikvision',
        nodeID: 'agent-1',
        actions: { 'provider-hikvision.stream-params.getStatus': {} },
      },
    ])
    const observer = vi.fn<CapUsageObserver>()
    const resolverFallback = vi.fn<(cap: string) => string | null>(() => null)

    await runBrokerOp(
      broker,
      'streamParams.getStatus',
      { deviceId: 'cam-1' },
      {
        callerAddonId: 'addon-detection-pipeline',
        providerAddonIdForCap: resolverFallback,
        observer,
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.action).toBe('provider-hikvision.stream-params.getStatus')

    // Recorded edge: the resolved serviceName, NOT the resolver fallback.
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith({
      callerAddonId: 'addon-detection-pipeline',
      providerAddonId: 'provider-hikvision',
      capName: 'stream-params',
      methodName: 'getStatus',
      atMs: expect.any(Number),
    })
    // Resolver callback only consulted in the degenerate case (serviceName === capName)
    expect(resolverFallback).not.toHaveBeenCalled()
  })

  it('falls back to providerAddonIdForCap when the resolved serviceName equals the cap name', async () => {
    // Degenerate case: discovery did not distinguish service from cap, so
    // the link cannot determine the provider's addonId from serviceName
    // alone. In that case the resolver callback wins.
    //
    // The link's default behaviour when no service is discovered concretely
    // is to fall back to `serviceName = capName`. We simulate that by
    // returning an empty service list — service discovery returns no
    // candidates, the link defaults serviceName to the cap name.
    //
    // To exercise this path without hitting awaitServiceCandidates'
    // unbounded poll, use a NEVER_BRIDGED_CAPS entry which fast-fails
    // after 5s. But for a unit test we'd rather avoid waiting. Instead,
    // provide a service whose name IS the cap name — that's how an
    // older addon (or the cap router itself) is registered.
    const { broker } = makeStubBroker({ ok: true }, [
      {
        name: 'stream-params',
        nodeID: 'agent-1',
        actions: { 'stream-params.getStatus': {} },
      },
    ])
    const observer = vi.fn<CapUsageObserver>()
    const resolverFallback = vi.fn<(cap: string) => string | null>(() => 'fallback-addon')

    await runBrokerOp(
      broker,
      'streamParams.getStatus',
      { deviceId: 'cam-1' },
      {
        callerAddonId: 'addon-detection-pipeline',
        providerAddonIdForCap: resolverFallback,
        observer,
      },
    )

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith({
      callerAddonId: 'addon-detection-pipeline',
      providerAddonId: 'fallback-addon',
      capName: 'stream-params',
      methodName: 'getStatus',
      atMs: expect.any(Number),
    })
    expect(resolverFallback).toHaveBeenCalledWith('stream-params')
  })

  it('records the caller even when discovery fails AND the resolver returns null', async () => {
    // This used to assert the opposite — "nothing should be recorded" — and
    // that assertion was the bug, not the guard against it.
    //
    // `providerAddonIdForCap` searches only the LOCAL registry, so it returns
    // null for every cross-process provider: every forked runner, including
    // `sqlite-settings`. Dropping the observation therefore made
    // `nodes.getCapUsageGraph` blind to exactly the traffic it exists to show.
    // Queried on the live hub 2026-08-25 while the engine logged 39 717 calls a
    // minute to one collection, it returned an EMPTY ARRAY — which an operator
    // reads as "no addon is calling anything".
    //
    // The caller is always known. It is recorded, and the unknown half stays
    // visibly unknown instead of taking the known half down with it.
    const { broker } = makeStubBroker({ ok: true }, [
      {
        name: 'stream-params',
        nodeID: 'agent-1',
        actions: { 'stream-params.getStatus': {} },
      },
    ])
    const observer = vi.fn<CapUsageObserver>()

    await runBrokerOp(
      broker,
      'streamParams.getStatus',
      { deviceId: 'cam-1' },
      {
        callerAddonId: 'addon-detection-pipeline',
        providerAddonIdForCap: () => null,
        observer,
      },
    )

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer.mock.calls[0]?.[0]).toMatchObject({
      callerAddonId: 'addon-detection-pipeline',
      providerAddonId: UNRESOLVED_PROVIDER_ADDON_ID,
      capName: 'stream-params',
    })
  })

  it('does not affect the caller when the observer itself throws', async () => {
    const { broker, calls } = makeStubBroker({ ok: true }, [
      {
        name: 'provider-hikvision',
        nodeID: 'agent-1',
        actions: { 'provider-hikvision.stream-params.getStatus': {} },
      },
    ])
    const observer = vi.fn<CapUsageObserver>(() => {
      throw new Error('observer-broken')
    })

    const result = await runBrokerOp(
      broker,
      'streamParams.getStatus',
      { deviceId: 'cam-1' },
      {
        callerAddonId: 'addon-detection-pipeline',
        providerAddonIdForCap: () => null,
        observer,
      },
    )

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })
})

/**
 * The usage graph was blind to exactly the traffic it exists to describe.
 *
 * `nodes.getCapUsageGraph` is an admin API that returns caller → provider → cap
 * edges. Queried on the live hub on 2026-08-25, while the sqlite engine was
 * logging 39 717 `query addon-device-settings` calls a minute, it returned an
 * EMPTY ARRAY — which reads as "no addon is calling anything".
 *
 * The cause is one falsy check here: an observation whose PROVIDER cannot be
 * resolved is dropped whole, caller included. And it cannot be resolved for any
 * cross-process provider — `providerAddonIdForCap` only searches the LOCAL
 * registry, so every call to a forked runner (which `sqlite-settings` is) was
 * silently discarded. The code says so: "resolve to null and are silently
 * skipped … a follow-up will fill the gap". The follow-up never came, and in
 * the meantime the gap looked like silence.
 *
 * The caller is ALWAYS known — it is whoever made the call. Recording it under
 * a named placeholder answers "who is hammering this cap", which is the whole
 * question, while an unknown provider stays visibly unknown instead of
 * pretending the call never happened.
 */
describe('an unresolved provider does not erase the caller', () => {
  it('records the observation with the placeholder instead of dropping it', () => {
    const seen: CapUsageObservation[] = []
    const opts: CapUsageObserverOptions = {
      callerAddonId: '@camstack/addon-post-analysis',
      providerAddonIdForCap: () => null,
      observer: (obs) => {
        seen.push(obs)
      },
    }

    recordCapUsage(opts, 'addon-settings', 'getDeviceSettings')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.callerAddonId).toBe('@camstack/addon-post-analysis')
    expect(seen[0]?.capName).toBe('addon-settings')
    expect(seen[0]?.providerAddonId).toBe(UNRESOLVED_PROVIDER_ADDON_ID)
  })

  it('keeps the real provider when the local registry knows it', () => {
    const seen: CapUsageObservation[] = []
    recordCapUsage(
      {
        callerAddonId: '@camstack/addon-pipeline',
        providerAddonIdForCap: () => '@camstack/system',
        observer: (obs) => {
          seen.push(obs)
        },
      },
      'settings-store',
      'query',
    )

    expect(seen[0]?.providerAddonId).toBe('@camstack/system')
  })
})
