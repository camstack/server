import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IEventBus, IScopedLogger, StreamSource } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager'

/**
 * Level-triggered stream-health sweep regression suite.
 *
 * The rfc4571 wedge latched brokers in a phantom `status: 'streaming'` state
 * with zero traffic. The edge-triggered health sweep (emit only on a
 * healthy↔stale TRANSITION) could not recover it: once the broker was flagged
 * stale, `wasHealthy === isHealthy` short-circuited every subsequent pass and
 * nothing ever re-dialed. The backstop that makes this whole class of stall
 * self-healing is a LEVEL trigger: on every pass, if a broker is unhealthy AND
 * still reports `status === 'streaming'`, force a redial — before the
 * transition early-out.
 */

function createMockLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return logger
}

function noopBus(): IEventBus {
  const bus: IEventBus = {
    emit: () => {},
    subscribe: () => () => {},
    getRecent: () => [],
  }
  return bus
}

function pushRtpSource(): StreamSource {
  return { type: 'push-rtp', url: '', videoCodec: 'h264' }
}

describe('StreamBrokerManager level-triggered health sweep redial', () => {
  let manager: StreamBrokerManager
  let logger: IScopedLogger

  beforeEach(() => {
    logger = createMockLogger()
    manager = new StreamBrokerManager(logger)
    manager.setEventBus(noopBus())
  })

  afterEach(async () => {
    await manager.destroyAll().catch(() => {})
  })

  it('redials a phantom-streaming broker that has received no packets', async () => {
    const broker = new StreamBroker('592/main', logger)
    const redial = vi.spyOn(broker, 'redial').mockImplementation(() => {})
    // push-rtp latches status:'streaming' the instant start() runs, with
    // lastPacketAt = 0 → unhealthy but phantom-streaming.
    await broker.start(pushRtpSource())
    expect(broker.getStats().status).toBe('streaming')
    expect(broker.getLastPacketAt()).toBe(0)

    manager.runStreamHealthSweepForTest('592/main', broker)

    expect(redial).toHaveBeenCalledTimes(1)
  })

  it('does NOT redial a connecting/idle broker with no packets', async () => {
    const broker = new StreamBroker('593/main', logger)
    const redial = vi.spyOn(broker, 'redial').mockImplementation(() => {})
    // A broker that never dialed sits at status 'idle' — unhealthy but NOT
    // phantom-streaming, so the sweep must leave it alone.
    expect(broker.getStats().status).toBe('idle')

    manager.runStreamHealthSweepForTest('593/main', broker)

    expect(redial).not.toHaveBeenCalled()
  })
})
