/**
 * brokerTransportLink — service-discovery waiting tests.
 *
 * Regression coverage for the RTSP-provider boot race that surfaced
 * live on 2026-04-22: a forked worker ran `onRestoreDevices` and
 * called `ctx.api.streamBroker.publishCameraStream.mutate(...)` BEFORE
 * the hub's INFO packet reached the worker. The transport resolved
 * zero candidates and `broker.call(...)` failed with "Service not
 * found", silently dropped by the provider's try/catch. No camera
 * ever got its streams published → orchestrator reported "no
 * assigned slot" → camera never dispatched.
 *
 * Fix: `brokerTransportLink` waits for service discovery before
 * dispatching a LOAD-BALANCED (non-node-pinned) call so transient
 * cold-boot / respawn races resolve once the service appears.
 *
 * Updated contract (added 2026-05-29 with `DEFAULT_DISCOVERY_TIMEOUT_MS`):
 * the wait is bounded by a hard deadline (default 30s). Beyond that
 * the link returns empty candidates so `broker.call` rejects with
 * "service not found" at the caller site instead of silently polling
 * forever. Callers that legitimately need to wait longer use
 * `ctx.acquireCapability` BEFORE issuing the RPC — the documented
 * liveness mechanism (CLAUDE.md). A per-link override exists for
 * tests via `BrokerTransportLinkOptions.discoveryTimeoutMs`.
 *
 * What these tests lock in:
 *   1. Call issued BEFORE the service is registered resolves as soon
 *      as the service appears (within the deadline).
 *   2. Call to a pinned nodeId surfaces "service not found" fast —
 *      the caller has chosen the target node explicitly and a miss
 *      is a bug, not a race.
 *   3. Caller AbortSignal cancels the discovery wait and rejects the
 *      tRPC observer with an AbortError-shaped rejection.
 *   4. A service registered and then deregistered, then registered
 *      again resolves the next call — no stale cache.
 *   5. Load-balanced discovery rejects after `discoveryTimeoutMs`
 *      elapses without a service appearing — no infinite polling.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { brokerTransportLink } from '../../moleculer/trpc-links.js'

function runOp(
  broker: ServiceBroker,
  path: string,
  input: unknown,
  signal?: AbortSignal,
  discoveryTimeoutMs?: number,
): Promise<unknown> {
  const link = brokerTransportLink(
    broker,
    undefined,
    undefined,
    discoveryTimeoutMs !== undefined ? { discoveryTimeoutMs } : undefined,
  )({} as never)
  return new Promise((resolve, reject) => {
    const sub = link({
      op: { id: 1, type: 'query', path, input, context: {}, signal: signal ?? null } as never,
      next: () => {
        throw new Error('brokerTransportLink should be terminal')
      },
    } as never).subscribe({
      next: (env: unknown) => resolve((env as { result: { data: unknown } }).result.data),
      error: (err: unknown) => reject(err as Error),
      complete: () => {
        /* resolved via next */
      },
    })
    // Forward signal aborts to subscription teardown so abort cancels the
    // observer even after we've returned the promise.
    if (signal) {
      const onAbort = () => sub.unsubscribe()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

describe('brokerTransportLink — service discovery waiting (RTSP boot-race regression)', () => {
  let brokers: ServiceBroker[] = []

  afterEach(async () => {
    for (const b of brokers) {
      try {
        await b.stop()
      } catch {
        /* */
      }
    }
    brokers = []
  })

  async function makeBroker(nodeID: string): Promise<ServiceBroker> {
    const b = new ServiceBroker({ nodeID, transporter: 'Fake', logger: false })
    await b.start()
    brokers.push(b)
    return b
  }

  it('awaits service discovery when the service is not yet registered (load-balanced call)', async () => {
    const broker = await makeBroker('worker')

    // Fire the call BEFORE the service exists. In the pre-fix world
    // this rejected immediately with "Service not found".
    const callPromise = runOp(broker, 'streamBroker.publishCameraStream', {
      deviceId: 4,
      camStreamId: 'stream-1',
      url: 'rtsp://cam',
    })

    // Verify the call is NOT rejecting yet — it's pending discovery.
    const racePromise = Promise.race([
      callPromise.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 250)),
    ])
    expect(await racePromise).toBe('pending')

    // Register the service AFTER the call has been issued. The link's
    // discovery poll should pick it up and dispatch.
    broker.createService({
      name: 'stream-broker',
      actions: {
        'stream-broker.publishCameraStream': {
          handler: () => ({ published: true }),
        },
      },
    })

    const result = await callPromise
    expect(result).toEqual({ published: true })
  })

  it('fast-fails a pinned call when the specified node does not host the service', async () => {
    const broker = await makeBroker('worker')
    broker.createService({
      name: 'stream-broker',
      actions: { 'stream-broker.publishCameraStream': { handler: () => ({ ok: true }) } },
    })

    // Pinning an unknown node is an operator-side bug — the caller
    // asked for a specific location that doesn't host this cap.
    // awaitPinnedServiceCandidates retries for up to 2s (100ms cadence)
    // to absorb the service-registry propagation window, then surfaces
    // the miss via broker.call so the error is bounded, not infinite.
    const start = Date.now()
    await expect(
      runOp(broker, 'streamBroker.publishCameraStream', {
        nodeId: 'agent-does-not-exist',
        deviceId: 4,
      }),
    ).rejects.toThrow()
    expect(Date.now() - start).toBeLessThan(3000) // bounded 2s retry + broker.call overhead
  })

  it('cancels discovery wait when the caller aborts its AbortSignal', async () => {
    const broker = await makeBroker('worker')
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 150)

    const start = Date.now()
    await expect(
      runOp(broker, 'streamBroker.publishCameraStream', { deviceId: 4 }, ctrl.signal),
    ).rejects.toThrow()
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(1000)
  })

  it('rejects after the load-balanced discovery deadline elapses with no provider', async () => {
    // A cap that never (re-)registers used to leave the link polling
    // forever — every consumer of the wedged cap hung silently. The
    // default deadline is 30s; we override to 200ms here to keep the
    // test snappy.
    const broker = await makeBroker('worker')
    const start = Date.now()
    await expect(runOp(broker, 'noSuchCap.someMethod', { x: 1 }, undefined, 200)).rejects.toThrow()
    const elapsed = Date.now() - start
    // Allow generous slack for `broker.call`'s own "service not found"
    // resolution after the discovery returns empty.
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(2000)
  })

  it('recovers after a service is registered, deregistered, and registered again', async () => {
    const broker = await makeBroker('worker')

    broker.createService({
      name: 'stream-broker',
      actions: {
        'stream-broker.publishCameraStream': { handler: () => ({ n: 1 }) },
      },
    })
    expect(await runOp(broker, 'streamBroker.publishCameraStream', { deviceId: 4 })).toEqual({
      n: 1,
    })

    // Destroy the service → next call starts waiting again.
    await broker.destroyService('stream-broker')

    const callPromise = runOp(broker, 'streamBroker.publishCameraStream', { deviceId: 4 })
    const racePromise = Promise.race([
      callPromise.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 200)),
    ])
    expect(await racePromise).toBe('pending')

    // Re-register — call completes.
    broker.createService({
      name: 'stream-broker',
      actions: {
        'stream-broker.publishCameraStream': { handler: () => ({ n: 2 }) },
      },
    })
    expect(await callPromise).toEqual({ n: 2 })
  })
})
