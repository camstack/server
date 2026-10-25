/**
 * Drift guard: `brokerCallForCap` and `brokerTransportLink` MUST resolve a cap
 * call to the SAME Moleculer dispatch (action name + target node + stripped
 * params). The two used to be parallel hand-synced implementations of the same
 * service-discovery + `capActionName` convention; they now share a single
 * `resolveBrokerCapCall` core, and this test fails the moment they diverge.
 *
 * Drives both public entry points against one real Fake-transporter broker:
 *   - the link path: an op through `brokerTransportLink`
 *   - the fallback path: a direct `brokerCallForCap` call (the F0 onUnownedCall core)
 * `broker.call` is spied so we compare exactly what each path dispatches.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { brokerTransportLink, brokerCallForCap } from '../../moleculer/trpc-links.js'

interface RecordedCall {
  readonly action: string
  readonly params: unknown
  readonly nodeID: string | undefined
}

describe('broker dispatch drift guard — brokerCallForCap ≡ brokerTransportLink', () => {
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

  async function makeBrokerWithService(nodeID: string): Promise<ServiceBroker> {
    const b = new ServiceBroker({ nodeID, transporter: 'Fake', logger: false })
    await b.start()
    brokers.push(b)
    b.createService({
      name: 'stream-broker',
      actions: { 'stream-broker.publishCameraStream': { handler: () => ({ ok: true }) } },
    })
    return b
  }

  // Spy on broker.call so we capture exactly what each path dispatches, while
  // service DISCOVERY still reads the intact registry.
  function spyCall(broker: ServiceBroker): RecordedCall[] {
    const recorded: RecordedCall[] = []
    vi.spyOn(broker, 'call').mockImplementation(
      (action: string, params?: unknown, opts?: { nodeID?: string }) => {
        recorded.push({ action, params, nodeID: opts?.nodeID })
        return Promise.resolve({ ok: true })
      },
    )
    return recorded
  }

  // Run one op through brokerTransportLink (terminal link) to completion.
  function runLink(broker: ServiceBroker, path: string, input: unknown): Promise<unknown> {
    const link = brokerTransportLink(broker)({} as never)
    return new Promise((resolve, reject) => {
      link({
        op: { id: 1, type: 'query', path, input, context: {}, signal: null } as never,
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
    })
  }

  it('node-pinned call: both paths dispatch the identical action, nodeID and stripped params', async () => {
    const broker = await makeBrokerWithService('worker')
    const recorded = spyCall(broker)

    const input = { deviceId: 4, camStreamId: 's1', nodeId: 'worker' }
    await brokerCallForCap(broker, 'stream-broker', 'publishCameraStream', input)
    await runLink(broker, 'streamBroker.publishCameraStream', input)

    expect(recorded).toHaveLength(2)
    const [viaFallback, viaLink] = recorded
    expect(viaFallback!.action).toBe(viaLink!.action)
    expect(viaFallback!.nodeID).toBe(viaLink!.nodeID)
    expect(viaFallback!.nodeID).toBe('worker')
    // both strip the routing-only `nodeId` field from the forwarded params
    expect(viaFallback!.params).toEqual(viaLink!.params)
    expect(viaFallback!.params).toEqual({ deviceId: 4, camStreamId: 's1' })
  })

  it('load-balanced call (no nodeId): both paths dispatch the identical action and leave params intact', async () => {
    const broker = await makeBrokerWithService('worker')
    const recorded = spyCall(broker)

    const input = { deviceId: 7 }
    await brokerCallForCap(broker, 'stream-broker', 'publishCameraStream', input)
    await runLink(broker, 'streamBroker.publishCameraStream', input)

    expect(recorded).toHaveLength(2)
    const [viaFallback, viaLink] = recorded
    expect(viaFallback!.action).toBe(viaLink!.action)
    expect(viaFallback!.nodeID).toBeUndefined()
    expect(viaLink!.nodeID).toBeUndefined()
    expect(viaFallback!.params).toEqual(viaLink!.params)
    expect(viaFallback!.params).toEqual({ deviceId: 7 })
  })
})
