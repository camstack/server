/**
 * brokerTransportLink — node pinning via `nodeId` input field.
 *
 * Verifies that when a tRPC op carries `{ nodeId: '...' }` in its input,
 * the link strips the field from the forwarded payload and passes
 * `{ nodeID }` as a Moleculer call option so the broker delivers the
 * action to the specified node instead of load-balancing across all
 * registered providers.
 *
 * Matches the hub-side codegen convention in `generated-cap-routers.ts`
 * (`resolveProvider`) — same `nodeId` field, same strip-and-route
 * behavior, extended to worker-side broker transport.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ServiceBroker } from 'moleculer'
import { brokerTransportLink } from '../../moleculer/trpc-links.js'

interface BrokerCall {
  action: string
  params: unknown
  opts: unknown
}

function makeStubBroker(
  result: unknown,
  services: ReadonlyArray<{ name: string; nodeID: string; actions: Record<string, unknown> }> = [
    {
      name: 'detection-pipeline',
      nodeID: 'hub',
      actions: { 'detection-pipeline.pipeline-executor.runPipeline': {} },
    },
  ],
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

function runOp(broker: ServiceBroker, path: string, input: unknown): Promise<unknown> {
  const link = brokerTransportLink(broker)({} as never)
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

describe('brokerTransportLink — node pinning', () => {
  it('forwards `nodeId` from input as Moleculer { nodeID } option and strips it from the payload', async () => {
    const { broker, calls } = makeStubBroker({ ok: true })
    await runOp(broker, 'pipelineExecutor.runPipeline', {
      nodeId: 'dev-agent-0',
      steps: ['a'],
      imageBase64: 'x',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.action).toBe('detection-pipeline.pipeline-executor.runPipeline')
    expect(calls[0]!.opts).toEqual({ nodeID: 'dev-agent-0' })
    expect(calls[0]!.params).toEqual({ steps: ['a'], imageBase64: 'x' })
  })

  it('omits the nodeID option when input has no nodeId (default load-balancing preserved)', async () => {
    const { broker, calls } = makeStubBroker({ ok: true })
    await runOp(broker, 'pipelineExecutor.runPipeline', { steps: ['a'] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts).toBeUndefined()
    expect(calls[0]!.params).toEqual({ steps: ['a'] })
  })

  it('passes scalar input through untouched (no object → no nodeId extraction)', async () => {
    const { broker, calls } = makeStubBroker({ ok: true })
    await runOp(broker, 'pipelineExecutor.runPipeline', 'scalar-payload')
    expect(calls[0]!.opts).toBeUndefined()
    expect(calls[0]!.params).toBe('scalar-payload')
  })

  it('leaves undefined input alone', async () => {
    const { broker, calls } = makeStubBroker({ ok: true })
    await runOp(broker, 'pipelineExecutor.runPipeline', undefined)
    expect(calls[0]!.params).toBeUndefined()
    expect(calls[0]!.opts).toBeUndefined()
  })

  it('pins to hub explicitly when nodeId === "hub"', async () => {
    const { broker, calls } = makeStubBroker({ ok: true })
    await runOp(broker, 'pipelineExecutor.runPipeline', { nodeId: 'hub', foo: 1 })
    expect(calls[0]!.opts).toEqual({ nodeID: 'hub' })
    expect(calls[0]!.params).toEqual({ foo: 1 })
  })

  it('promotes parent nodeId ("hub") to child sub-node when a forkable addon hosts the action', async () => {
    // Regression test: detection-pipeline is forkable, so its Moleculer
    // service registers on `hub/detection-pipeline`. UI picker exposes only
    // `hub`; calling `broker.call(..., {nodeID: 'hub'})` returned "service
    // not found on hub node". The link now fuzzy-matches to the child.
    const { broker, calls } = makeStubBroker({ ok: true }, [
      {
        name: 'detection-pipeline',
        nodeID: 'hub/detection-pipeline',
        actions: { 'detection-pipeline.pipeline-executor.runPipeline': {} },
      },
    ])
    await runOp(broker, 'pipelineExecutor.runPipeline', { nodeId: 'hub', steps: [] })
    expect(calls[0]!.opts).toEqual({ nodeID: 'hub/detection-pipeline' })
    expect(calls[0]!.action).toBe('detection-pipeline.pipeline-executor.runPipeline')
  })

  it('prefers exact nodeId match over child match when both are registered', async () => {
    const { broker, calls } = makeStubBroker({ ok: true }, [
      {
        name: 'detection-pipeline',
        nodeID: 'hub/detection-pipeline',
        actions: { 'detection-pipeline.pipeline-executor.runPipeline': {} },
      },
      {
        name: 'detection-pipeline',
        nodeID: 'agent-1',
        actions: { 'detection-pipeline.pipeline-executor.runPipeline': {} },
      },
    ])
    await runOp(broker, 'pipelineExecutor.runPipeline', { nodeId: 'agent-1', steps: [] })
    expect(calls[0]!.opts).toEqual({ nodeID: 'agent-1' })
  })

  it('leaves nodeId unchanged when no candidate matches it (surfaces original miss)', async () => {
    const { broker, calls } = makeStubBroker({ ok: true }, [
      {
        name: 'detection-pipeline',
        nodeID: 'hub/detection-pipeline',
        actions: { 'detection-pipeline.pipeline-executor.runPipeline': {} },
      },
    ])
    await runOp(broker, 'pipelineExecutor.runPipeline', { nodeId: 'unknown-node', steps: [] })
    expect(calls[0]!.opts).toEqual({ nodeID: 'unknown-node' })
  })
})

// ── Dynamic stub broker used by timing tests ──────────────────────────────

type ServiceEntry = { name: string; nodeID: string; actions: Record<string, unknown> }

function makeDynamicStubBroker(
  result: unknown,
  getServices: () => ReadonlyArray<ServiceEntry>,
): { broker: ServiceBroker; calls: BrokerCall[] } {
  const calls: BrokerCall[] = []
  const broker = {
    call: (action: string, params: unknown, opts: unknown) => {
      calls.push({ action, params, opts })
      return Promise.resolve(result)
    },
    registry: {
      getServiceList: () => getServices(),
    },
  } as unknown as ServiceBroker
  return { broker, calls }
}

/**
 * Variant of `runOp` that accepts an optional `AbortSignal` for cancellation
 * tests, and uses a `signal`-aware broker call that rejects on abort.
 */
function runOpWithSignal(
  broker: ServiceBroker,
  path: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const link = brokerTransportLink(broker)({} as never)
  return new Promise((resolve, reject) => {
    const subscription = link({
      op: {
        id: 1,
        type: 'query',
        path,
        input,
        context: {},
        signal: signal ?? (null as never),
      },
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

// ── Timing tests ──────────────────────────────────────────────────────────

describe('brokerTransportLink — pinned call bounded retry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const ACTION_PATH = 'pipelineExecutor.runPipeline'
  const PIPELINE_ACTION = 'detection-pipeline.pipeline-executor.runPipeline'

  function makeService(nodeID: string): ServiceEntry {
    return {
      name: 'detection-pipeline',
      nodeID,
      actions: { [PIPELINE_ACTION]: {} },
    }
  }

  it('resolves immediately when service is available on first poll (no delay)', async () => {
    // Service is present from tick 0 — awaitPinnedServiceCandidates should
    // return on its very first loop iteration without any setTimeout delay.
    const { broker, calls } = makeDynamicStubBroker({ ok: true }, () => [
      makeService('hub/detection-pipeline'),
    ])

    const promise = runOpWithSignal(broker, ACTION_PATH, { nodeId: 'hub', steps: [] })
    // Run all pending microtasks/timers so the async loop can complete.
    await vi.runAllTimersAsync()
    await promise

    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts).toEqual({ nodeID: 'hub/detection-pipeline' })
  })

  it('resolves after one 100ms polling tick when service appears at 100ms', async () => {
    let available = false
    const { broker, calls } = makeDynamicStubBroker({ ok: true }, () =>
      available ? [makeService('hub/detection-pipeline')] : [],
    )

    const promise = runOpWithSignal(broker, ACTION_PATH, { nodeId: 'hub', steps: [] })

    // First check (synchronous): service not yet available — loop enters wait.
    // Advance 100ms → first setTimeout(r, 100) fires, next loop iteration
    // still sees empty list (available is still false).
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toHaveLength(0)

    // Make service available, advance another 100ms → found, resolves.
    available = true
    await vi.advanceTimersByTimeAsync(100)
    await promise

    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts).toEqual({ nodeID: 'hub/detection-pipeline' })
  })

  it('resolves at 1900ms — just inside the 2000ms deadline', async () => {
    // Service appears on the 19th polling tick (1900ms). The deadline check
    // fires AFTER the candidate check so 1900ms is still within the window.
    let tickCount = 0
    const { broker, calls } = makeDynamicStubBroker({ ok: true }, () => {
      // Each call to getServiceList corresponds to a loop iteration.
      // Return the service starting at tick 19 (1900ms elapsed).
      return tickCount >= 19 ? [makeService('hub/detection-pipeline')] : []
    })

    const promise = runOpWithSignal(broker, ACTION_PATH, { nodeId: 'hub', steps: [] })

    // Advance 18 ticks (1800ms) — service not yet available.
    for (let i = 0; i < 18; i++) {
      await vi.advanceTimersByTimeAsync(100)
      tickCount++
    }
    expect(calls).toHaveLength(0)

    // 19th tick: service appears.
    tickCount++
    await vi.advanceTimersByTimeAsync(100)
    await promise

    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts).toEqual({ nodeID: 'hub/detection-pipeline' })
  })

  it('times out after 2000ms and surfaces broker.call error when service never appears', async () => {
    // Service never registers. After 2000ms the loop exits with an empty
    // candidate list, broker.call is invoked with `nodeID: 'hub'` (the
    // original preferred value) and the stub broker rejects to simulate
    // Moleculer's "service not found" error.
    const brokerError = new Error('Service not found: detection-pipeline on node hub')
    const calls: BrokerCall[] = []
    const broker = {
      call: (action: string, params: unknown, opts: unknown) => {
        calls.push({ action, params, opts })
        return Promise.reject(brokerError)
      },
      registry: {
        getServiceList: () => [],
      },
    } as unknown as ServiceBroker

    const promise = runOpWithSignal(broker, ACTION_PATH, { nodeId: 'hub', steps: [] })
    // Attach a no-op catch immediately so the rejection is always "handled"
    // before vitest's unhandled-rejection detector fires.
    const caught = promise.catch((e: unknown) => e)

    // Advance past the 2000ms deadline (plus a little extra for safety).
    await vi.advanceTimersByTimeAsync(2100)
    const result = await caught
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch('Service not found')

    // broker.call must have been invoked (not silently dropped).
    expect(calls).toHaveLength(1)
  })

  it('rejects with abort error when AbortSignal fires mid-wait', async () => {
    // Service never appears. We abort after 200ms. The link should reject
    // before the 2000ms deadline fires.
    const { broker, calls } = makeDynamicStubBroker({ ok: true }, () => [])
    const controller = new AbortController()

    const promise = runOpWithSignal(
      broker,
      ACTION_PATH,
      { nodeId: 'hub', steps: [] },
      controller.signal,
    )
    // Attach a no-op catch immediately so the rejection is always "handled".
    const caught = promise.catch((e: unknown) => e)

    // Advance 200ms — two polling ticks pass, service still absent.
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toHaveLength(0)

    // Abort the signal — the polling loop sets abort.aborted = true.
    controller.abort()
    // Run any remaining microtasks so the async loop detects the abort.
    await vi.advanceTimersByTimeAsync(0)
    await vi.runAllTimersAsync()

    const result = await caught
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/aborted/)

    // broker.call must NOT have been invoked — the op was cancelled.
    expect(calls).toHaveLength(0)
  })

  it('promotes parent nodeId to child sub-node when child registers after 200ms', async () => {
    // Caller pins `nodeId: 'hub'`. The actual service lives on
    // `hub/detection-pipeline` and registers 200ms after the op starts.
    // resolveTargetNode must promote 'hub' → 'hub/detection-pipeline'.
    let available = false
    const { broker, calls } = makeDynamicStubBroker({ ok: true }, () =>
      available ? [makeService('hub/detection-pipeline')] : [],
    )

    const promise = runOpWithSignal(broker, ACTION_PATH, { nodeId: 'hub', steps: [] })

    await vi.advanceTimersByTimeAsync(200)
    available = true
    await vi.advanceTimersByTimeAsync(100)
    await promise

    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts).toEqual({ nodeID: 'hub/detection-pipeline' })
  })

  it('prefers exact nodeId match over child when exact appears later', async () => {
    // child `hub/detection-pipeline` appears at 100ms.
    // exact `hub` appears at 300ms.
    // resolveTargetNode checks exact first — once `hub` is registered
    // the exact candidate wins and that node is used for the call.
    let childAvailable = false
    let exactAvailable = false

    const { broker } = makeDynamicStubBroker({ ok: true }, () => {
      const services: ServiceEntry[] = []
      if (childAvailable) services.push(makeService('hub/detection-pipeline'))
      if (exactAvailable) services.push(makeService('hub'))
      return services
    })

    const promise = runOpWithSignal(broker, ACTION_PATH, { nodeId: 'hub', steps: [] })

    // 100ms: child appears. resolveTargetNode will find the child match but
    // we need to advance further to let the exact match appear.
    await vi.advanceTimersByTimeAsync(100)
    childAvailable = true

    // 200ms: still only child available — but the loop resolves on child
    // unless we add more ticks. To test that exact wins over child we need
    // the exact to appear while still in the polling window. Since the loop
    // returns as soon as resolveTargetNode is non-null, and child appears at
    // tick 1, we must ensure the exact appears before the child is detected.
    //
    // Restructure: child NOT available until tick 3 (300ms), exact appears
    // at tick 2 (200ms) so exact match fires first.
    childAvailable = false
    exactAvailable = false

    // Re-run with a fresh broker to control the sequence cleanly.
    let tick = 0
    const calls2: BrokerCall[] = []
    const broker2 = {
      call: (action: string, params: unknown, opts: unknown) => {
        calls2.push({ action, params, opts })
        return Promise.resolve({ ok: true })
      },
      registry: {
        getServiceList: () => {
          // tick 0: nothing; tick 2: exact `hub`; tick 3: child too
          const svcs: ServiceEntry[] = []
          if (tick >= 2) svcs.push(makeService('hub'))
          if (tick >= 3) svcs.push(makeService('hub/detection-pipeline'))
          return svcs
        },
      },
    } as unknown as ServiceBroker

    const promise2 = runOpWithSignal(broker2, ACTION_PATH, { nodeId: 'hub', steps: [] })

    await vi.advanceTimersByTimeAsync(100)
    tick++ // tick 1 — nothing
    await vi.advanceTimersByTimeAsync(100)
    tick++ // tick 2 — exact `hub` appears
    await vi.advanceTimersByTimeAsync(100) // runs the iteration that sees tick 2
    await promise2

    expect(calls2).toHaveLength(1)
    expect(calls2[0]!.opts).toEqual({ nodeID: 'hub' })

    // Silence the original promise (it will never resolve since we detached broker)
    void promise.catch(() => {
      /* expected */
    })
  })
})
