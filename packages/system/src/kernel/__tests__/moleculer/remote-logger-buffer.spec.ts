/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- test pokes broker internals via a structural spy */
/**
 * Part A regression test for D8 log forwarding.
 *
 * `createRemoteLogger` must NOT silently drop log lines emitted before
 * the hub `$hub` service is discovered. Lines emitted while
 * disconnected are buffered (bounded FIFO, cap 500) and flushed — in
 * emission order — to `$hub.log` when `setHubConnected` flips the
 * broker to connected.
 *
 * The buffer is shared PER BROKER: a single forked process can host
 * multiple addon contexts, and one `setHubConnected(broker)` flush must
 * drain every remote logger created against that broker.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  __createRemoteLoggerForTests,
  setHubConnected,
  __resetHubConnectedForTests,
} from '../../moleculer/addon-context-factory.js'

interface HubLogCall {
  readonly action: string
  readonly payload: { readonly level: string; readonly message: string; readonly meta?: unknown }
}

/**
 * Minimal structural `ServiceBroker` stand-in — only the surface
 * `createRemoteLogger` touches (`nodeID` + `call`). Records every
 * `$hub.log` invocation so the test can assert order + count.
 */
function makeSpyBroker(nodeID: string): { broker: any; calls: HubLogCall[] } {
  const calls: HubLogCall[] = []
  const broker = {
    nodeID,
    call(action: string, payload: any): Promise<unknown> {
      calls.push({ action, payload })
      return Promise.resolve()
    },
  }
  return { broker, calls }
}

describe('createRemoteLogger pre-connect buffer', () => {
  beforeEach(() => {
    __resetHubConnectedForTests()
  })

  it('buffers log lines emitted before hub discovery and flushes them in order on connect', () => {
    const { broker, calls } = makeSpyBroker('hub/worker-1')
    const logger = __createRemoteLoggerForTests(broker, 'addon-x')

    logger.info('line-1')
    logger.warn('line-2')
    logger.error('line-3')

    // Nothing reached the hub yet — hub not discovered.
    expect(calls).toHaveLength(0)

    setHubConnected(broker)

    // All three buffered lines flushed to `$hub.log` in emission order.
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c.action)).toEqual(['$hub.log', '$hub.log', '$hub.log'])
    expect(calls.map((c) => c.payload.message)).toEqual(['line-1', 'line-2', 'line-3'])
    expect(calls.map((c) => c.payload.level)).toEqual(['info', 'warn', 'error'])
  })

  it('forwards directly once connected', () => {
    const { broker, calls } = makeSpyBroker('hub/worker-2')
    const logger = __createRemoteLoggerForTests(broker, 'addon-y')

    setHubConnected(broker)
    logger.info('post-connect')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload.message).toBe('post-connect')
  })

  it('drains every logger created against the same broker on a single connect', () => {
    const { broker, calls } = makeSpyBroker('hub/worker-3')
    const loggerA = __createRemoteLoggerForTests(broker, 'addon-a')
    const loggerB = __createRemoteLoggerForTests(broker, 'addon-b')

    loggerA.info('from-a')
    loggerB.info('from-b')
    expect(calls).toHaveLength(0)

    setHubConnected(broker)

    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.payload.message)).toEqual(['from-a', 'from-b'])
  })

  it('no-arg setHubConnected flushes existing brokers and makes new brokers start connected', () => {
    // Part 1: broker A created BEFORE the no-arg call — buffered lines flush.
    const { broker: brokerA, calls: callsA } = makeSpyBroker('hub/worker-noarg-A')
    const loggerA = __createRemoteLoggerForTests(brokerA, 'addon-noarg-a')

    loggerA.info('buffered-1')
    loggerA.warn('buffered-2')
    expect(callsA).toHaveLength(0)

    // Call setHubConnected with NO argument — process-wide baseline flip.
    setHubConnected()

    // Broker A's buffer must have flushed.
    expect(callsA).toHaveLength(2)
    expect(callsA.map((c) => c.payload.message)).toEqual(['buffered-1', 'buffered-2'])

    // Part 2: broker B created AFTER the no-arg call — starts already connected.
    const { broker: brokerB, calls: callsB } = makeSpyBroker('hub/worker-noarg-B')
    const loggerB = __createRemoteLoggerForTests(brokerB, 'addon-noarg-b')

    loggerB.info('direct-1')

    // Must forward directly (no buffering) because hubConnectedDefault is true.
    expect(callsB).toHaveLength(1)
    expect(callsB[0]!.payload.message).toBe('direct-1')
  })

  it('drops the oldest entry on overflow and surfaces the dropped count in the next flushed line meta', () => {
    const { broker, calls } = makeSpyBroker('hub/worker-4')
    const logger = __createRemoteLoggerForTests(broker, 'addon-z')

    // Emit one more than the 500 cap — the very first line must be dropped.
    for (let i = 0; i < 501; i++) {
      logger.info(`msg-${i}`)
    }
    expect(calls).toHaveLength(0)

    setHubConnected(broker)

    expect(calls).toHaveLength(500)
    // Oldest dropped: buffer now starts at msg-1.
    expect(calls[0]!.payload.message).toBe('msg-1')
    expect(calls[499]!.payload.message).toBe('msg-500')
    // Dropped-count surfaced on the first flushed line's meta.
    const firstMeta = calls[0]!.payload.meta as { droppedLogLines?: number } | undefined
    expect(firstMeta?.droppedLogLines).toBe(1)
  })
})
