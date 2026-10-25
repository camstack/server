/**
 * ensureBroker single-flight (zombie-broker race — confirmed live outage).
 *
 * `ensureBroker`'s check-then-act spans TWO real `await`s — `isLocalIngestOwner()`
 * and `broker.start()` — between the initial `this.brokers.has(brokerId)` guard
 * and the final `this.brokers.set(brokerId, broker)`. Two concurrent callers for
 * the SAME `brokerId` (e.g. two consumers attaching around the same reconcile
 * tick, or two retries resurrecting a broker after a restart — see
 * `ensureBrokerForId`'s doc comment) both pass the `has()` guard while the map
 * is still empty, both build + `start()` their own `StreamBroker`, and the
 * SECOND `this.brokers.set()` silently overwrites the first. The loser is a
 * zombie: unreachable from `this.brokers`, never `.stop()`-ed, but its internal
 * `scheduleReconnect` timer keeps firing forever. A flapping/offline camera
 * drives this repeatedly — zombie accumulation floods the event loop with
 * reconnect timers (the confirmed live hub stall).
 *
 * The REMOTE broker-adapter path already single-flights this exact shape via
 * `remoteAdapterEnsures` (see `ensureBrokerForWebrtcSession`) — the physical
 * `ensureBroker` path lacks the equivalent guard. This spec proves the gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { StreamBroker } from '../stream-broker/stream-broker.js'
import { makeSourceBrokerId } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeManager(): StreamBrokerManager {
  return new StreamBrokerManager(makeLogger())
}

/**
 * Stub out the RTSP layer so publish paths don't try to bind a real port.
 * Mirrors the pattern used by derived-stream-spawn.spec.ts / profile-broker.spec.ts.
 */
function stubRtsp(manager: StreamBrokerManager): void {
  ;(manager as unknown as { rtspProvider: unknown }).rtspProvider = {
    getEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    getInternalEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    setEnabled: vi.fn(),
    isEnabled: vi.fn(() => true),
    setTokenPersister: vi.fn(),
    setEnabledPersister: vi.fn(),
    getAllEntries: vi.fn(() => []),
    regenerateToken: vi.fn(),
    getRtspPort: vi.fn(() => 8554),
    persistTokens: vi.fn(),
  }
  ;(manager as unknown as { rtspServer: unknown }).rtspServer = {
    registerRestreamer: vi.fn(),
    unregisterRestreamer: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getPort: vi.fn(() => 8554),
    loadEnabled: vi.fn(),
  }
}

function brokerCount(manager: StreamBrokerManager): number {
  return (manager as unknown as { brokers: Map<string, StreamBroker> }).brokers.size
}

function brokerMap(manager: StreamBrokerManager): Map<string, StreamBroker> {
  return (manager as unknown as { brokers: Map<string, StreamBroker> }).brokers
}

describe('ensureBroker single-flight (zombie-broker race)', () => {
  let manager: StreamBrokerManager
  const deviceId = 42
  const camStreamId = 'native:main'
  const brokerId = makeSourceBrokerId(deviceId, camStreamId)

  beforeEach(() => {
    manager = makeManager()
    stubRtsp(manager)
  })

  it('two concurrent resurrection attempts for the SAME not-yet-live broker create exactly one StreamBroker', async () => {
    // Publish the source once (uncontended) so the cam stream is known.
    await manager.publishCameraStream({
      deviceId,
      camStreamId,
      kind: 'pull-rtsp',
      url: 'rtsp://example/main',
    })
    expect(brokerCount(manager)).toBe(1)

    // Simulate the live broker instance having gone away (e.g. process
    // respawn) while the cam stream stays registered — exactly the scenario
    // `ensureBrokerForId`'s doc comment describes: "a consumer's retry
    // RESURRECTS the broker after a restart". Two concurrent resurrection
    // attempts for the same brokerId now race inside `ensureBroker`.
    const brokers = brokerMap(manager)
    await brokers.get(brokerId)?.stop()
    brokers.delete(brokerId)
    expect(brokerCount(manager)).toBe(0)

    // Track DISTINCT StreamBroker instances that got `.start()`-ed, not raw
    // call count — a winning broker legitimately gets a second `.start()`
    // call from `checkDemand()`'s idle→resume path once a subscriber
    // attaches (unrelated to the race). What must never happen is a SECOND
    // distinct instance being constructed + started for the same brokerId.
    const origStart = StreamBroker.prototype.start
    const startedInstances = new Set<StreamBroker>()
    const startSpy = vi.spyOn(StreamBroker.prototype, 'start')
    startSpy.mockImplementation(function (this: StreamBroker, ...args: [unknown]) {
      startedInstances.add(this)
      return origStart.apply(this, args as [never])
    })

    const [result1, result2] = await Promise.all([
      manager.subscribeAudioChunks({ brokerId, tag: 'consumer-a' }),
      manager.subscribeAudioChunks({ brokerId, tag: 'consumer-b' }),
    ])

    // Exactly one broker survives in the registry.
    expect(brokerCount(manager)).toBe(1)

    // THE regression signal: only ONE StreamBroker instance may ever be
    // constructed + started per brokerId for a single logical ensure.
    // Pre-fix, both concurrent callers pass the `this.brokers.has(brokerId)`
    // guard before either awaits `isLocalIngestOwner()`, so BOTH build +
    // `.start()` their OWN StreamBroker — this set has 2 members, and the
    // loser is a zombie: started (so its `scheduleReconnect` timer is
    // armed) but unreachable from `this.brokers` and never `.stop()`-ed.
    expect(startedInstances.size).toBe(1)
    // The survivor in the registry must be the (only) instance that was
    // started — never a broker nobody actually started.
    expect(startedInstances.has(brokers.get(brokerId) as StreamBroker)).toBe(true)

    expect(result1.subscriptionId).toBeTruthy()
    expect(result2.subscriptionId).toBeTruthy()

    startSpy.mockRestore()
  })
})

describe('createBrokerForId start() throw (zombie-broker leak — pre-register failure)', () => {
  let manager: StreamBrokerManager
  const deviceId = 43
  const camStreamId = 'native:main'
  const brokerId = makeSourceBrokerId(deviceId, camStreamId)

  beforeEach(() => {
    manager = makeManager()
    stubRtsp(manager)
  })

  it('stops the just-constructed broker and never registers it when broker.start() rejects', async () => {
    const startError = new Error('boom: pipe server bind failure')
    const startSpy = vi.spyOn(StreamBroker.prototype, 'start').mockImplementation(async () => {
      throw startError
    })
    const stopSpy = vi.spyOn(StreamBroker.prototype, 'stop')

    // The caller must still learn the operation failed — the error must
    // propagate unchanged, not be swallowed by the cleanup path.
    await expect(
      manager.publishCameraStream({
        deviceId,
        camStreamId,
        kind: 'pull-rtsp',
        url: 'rtsp://example/main',
      }),
    ).rejects.toThrow(startError)

    // Nothing half-registered: the failed broker must not land in the
    // live registry.
    expect(brokerMap(manager).has(brokerId)).toBe(false)

    // THE regression signal: pre-fix, a throw between `new StreamBroker(...)`
    // and `this.brokers.set(...)` leaves the just-constructed, just-started
    // instance unreachable and never `.stop()`-ed — a zombie whose internal
    // timers (reconnect/watchdog) keep firing forever, same leak class as
    // the single-flight race above.
    expect(stopSpy).toHaveBeenCalledTimes(1)

    startSpy.mockRestore()
    stopSpy.mockRestore()
  })
})
