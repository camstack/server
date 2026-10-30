import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BATCH_FLUSH_MS,
  COMPONENT_RECHECK_MS,
  HEARTBEAT_INTERVAL_MS,
  IMAGE_SIGNAL_PREFIX,
  MAX_VALUE_CHARS,
  PushClient,
  type PushTransport,
} from '../push-client.js'
import { PushHttpError } from '../push-failure.js'
import type { HaCmps, HaDeviceBlock, PushMessage } from '../types.js'

const DEV: HaDeviceBlock = { ids: ['camstack-a'], name: 'A', mf: 'CamStack', mdl: 'camera' }
const CMPS: HaCmps = {
  'binary_sensor-person-detected': {
    platform: 'binary_sensor',
    unique_id: 'a_person_detected',
    name: 'Person detected',
    state_topic: 'camstack/camstack-a/person_detected',
  },
}

interface Recorder {
  readonly sent: PushMessage[]
  readonly transport: PushTransport
  fail: boolean
}

function recorder(): Recorder {
  const sent: PushMessage[] = []
  const rec: Recorder = {
    sent,
    fail: false,
    transport: async (message: PushMessage): Promise<void> => {
      if (rec.fail) throw new Error('unreachable')
      sent.push(message)
    },
  }
  return rec
}

const noopLog = { warn: () => {}, info: () => {}, debug: () => {} }

describe('PushClient', () => {
  let rec: Recorder
  let client: PushClient

  beforeEach(() => {
    vi.useFakeTimers()
    rec = recorder()
    client = new PushClient({ transport: rec.transport, logger: noopLog, brokerId: 'ha_1' })
  })

  afterEach(async () => {
    await client.dispose()
    vi.useRealTimers()
  })

  it('batches state updates instead of sending one POST each', async () => {
    client.publishState('camstack/camstack-a/person_detected', 'true')
    client.publishState('camstack/camstack-a/motion_detected', 'true')
    expect(rec.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    expect(rec.sent).toHaveLength(1)
    const [message] = rec.sent
    expect(message?.type).toBe('batch')
    if (message?.type !== 'batch') throw new Error('expected a batch')
    expect(message.items).toHaveLength(2)
  })

  it('does not resend an unchanged value', async () => {
    client.publishState('camstack/camstack-a/person_detected', 'true')
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    client.publishState('camstack/camstack-a/person_detected', 'true')
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    expect(rec.sent).toHaveLength(1)
  })

  it('sends the value again once it changes', async () => {
    client.publishState('camstack/camstack-a/person_detected', 'true')
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    client.publishState('camstack/camstack-a/person_detected', 'false')
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    expect(rec.sent).toHaveLength(2)
  })

  it('collapses an oversized payload to the image signal', async () => {
    const huge = 'x'.repeat(MAX_VALUE_CHARS + 1)
    client.publishState('camstack/camstack-a/last_image', huge)
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    const [message] = rec.sent
    if (message?.type !== 'batch') throw new Error('expected a batch')
    const item = message.items[0]
    if (item?.type !== 'state_update') throw new Error('expected a state update')
    expect(item.value.startsWith(IMAGE_SIGNAL_PREFIX)).toBe(true)
    expect(item.value.length).toBeLessThan(64)
  })

  it('flushes pending state before an entity_change, and sends it alone', async () => {
    client.publishState('camstack/camstack-a/person_detected', 'true')
    await client.publishEntityChange('camstack-a', CMPS, DEV)
    expect(rec.sent.map((m) => m.type)).toEqual(['batch', 'entity_change'])
  })

  it('carries the COMPLETE cmps set on entity_change, never a delta', async () => {
    await client.publishEntityChange('camstack-a', CMPS, DEV)
    const [message] = rec.sent
    if (message?.type !== 'entity_change') throw new Error('expected an entity change')
    expect(Object.keys(message.cmps)).toEqual(Object.keys(CMPS))
    expect(message.dev).toEqual(DEV)
  })

  it('heartbeats on its own interval, unbatched', async () => {
    client.start()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2 + 10)
    const beats = rec.sent.filter((m) => m.type === 'heartbeat')
    expect(beats.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps heartbeating while HA is unreachable and reports availability', async () => {
    client.start()
    rec.fail = true
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)
    expect(client.healthy).toBe(false)
    rec.fail = false
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)
    expect(client.healthy).toBe(true)
  })

  it('forgets its dedup cache when the link returns, so nothing stays suppressed', async () => {
    client.publishState('camstack/camstack-a/person_detected', 'true')
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    expect(rec.sent).toHaveLength(1)

    rec.fail = true
    client.start()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)
    rec.fail = false
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)

    const before = rec.sent.length
    client.publishState('camstack/camstack-a/person_detected', 'true')
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    expect(rec.sent.length).toBe(before + 1)
  })

  it('signals that the link returned — once per outage, not once per success', async () => {
    const restored: string[] = []
    const link = new PushClient({
      transport: rec.transport,
      logger: noopLog,
      brokerId: 'ha_1',
      onLinkRestored: (brokerId) => restored.push(brokerId),
    })
    try {
      link.start()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2 + 10)
      expect(restored).toEqual([])

      rec.fail = true
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)
      rec.fail = false
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3 + 10)

      expect(restored).toEqual(['ha_1'])
    } finally {
      await link.dispose()
    }
  })

  /**
   * Ordering is the whole point: the addon re-announces from inside this
   * callback, so a cache still holding the old values would suppress
   * exactly the messages the re-announce exists to send.
   */
  it('clears the dedup cache BEFORE it signals, so the re-announce is not deduped away', async () => {
    const topic = 'camstack/camstack-a/person_detected'
    let resent = 0
    const link = new PushClient({
      transport: rec.transport,
      logger: noopLog,
      brokerId: 'ha_1',
      onLinkRestored: () => {
        link.publishState(topic, 'true')
        resent += 1
      },
    })
    try {
      link.publishState(topic, 'true')
      await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
      const before = rec.sent.length

      link.start()
      rec.fail = true
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10)
      rec.fail = false
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + BATCH_FLUSH_MS + 10)

      expect(resent).toBe(1)
      const batches = rec.sent
        .slice(before)
        .filter((message) => message.type === 'batch')
        .flatMap((message) => (message.type === 'batch' ? message.items : []))
      expect(batches.some((item) => item.type === 'state_update' && item.topic === topic)).toBe(
        true,
      )
    } finally {
      await link.dispose()
    }
  })

  it('counts a dropped publish rather than losing it silently', async () => {
    rec.fail = true
    client.publishState('camstack/camstack-a/person_detected', 'true')
    await vi.advanceTimersByTimeAsync(BATCH_FLUSH_MS)
    expect(client.droppedCount).toBeGreaterThan(0)
  })

  describe('full resync', () => {
    it('an entity_change carries no `full` field unless asked', async () => {
      await client.publishEntityChange('camstack-a', CMPS, DEV)
      expect(rec.sent[0]).toEqual({
        type: 'entity_change',
        device_id: 'camstack-a',
        cmps: CMPS,
        dev: DEV,
      })
    })

    it('marks an entity_change as part of a full resync with `full: true`', async () => {
      await client.publishEntityChange('camstack-a', CMPS, DEV, true)
      expect(rec.sent[0]).toEqual({
        type: 'entity_change',
        device_id: 'camstack-a',
        cmps: CMPS,
        dev: DEV,
        full: true,
      })
    })

    it('reports whether the announce was delivered', async () => {
      expect(await client.publishEntityChange('camstack-a', CMPS, DEV)).toBe(true)
      rec.fail = true
      expect(await client.publishEntityChange('camstack-a', CMPS, DEV)).toBe(false)
    })
  })

  describe('failure reasons', () => {
    it('puts the reason in the message text, keeping meta', async () => {
      const warn = vi.fn()
      const client = new PushClient({
        transport: async () => {
          throw new PushHttpError(404, 'Not Found')
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn },
        brokerId: 'b1',
      })
      client.publishState('t', 'v')
      await client.flush()
      const call = warn.mock.calls[0]
      expect(call).toBeDefined()
      const [text, opts] = call ?? []
      expect(text).toContain('HTTP 404')
      expect(text).toContain('messages dropped')
      expect(opts?.meta.error).toContain('404')
      expect(client.failure?.kind).toBe('component-missing')
    })

    it('a 404 stops hitting the network until the recheck window or a reset', async () => {
      vi.useFakeTimers()
      let calls = 0
      const client = new PushClient({
        transport: async () => {
          calls += 1
          throw new PushHttpError(404, '')
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        brokerId: 'b1',
      })
      await client.publishEntityChange('d', CMPS, DEV)
      expect(calls).toBe(1)
      await client.publishEntityChange('d', CMPS, DEV)
      await client.publishEntityChange('d', CMPS, DEV)
      expect(calls).toBe(1)
      expect(client.suspended).toBe(true)
      client.resetBackoff()
      await client.publishEntityChange('d', CMPS, DEV)
      expect(calls).toBe(2)
      vi.advanceTimersByTime(COMPONENT_RECHECK_MS + 1)
      await client.publishEntityChange('d', CMPS, DEV)
      expect(calls).toBe(3)
      vi.useRealTimers()
    })

    it('a 413 batch is split in halves until it lands; nothing is dropped', async () => {
      const sizes: number[] = []
      const client = new PushClient({
        transport: async (m: PushMessage) => {
          if (m.type !== 'batch') return
          sizes.push(m.items.length)
          if (m.items.length > 2) throw new PushHttpError(413, '')
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        brokerId: 'b1',
      })
      for (let i = 0; i < 8; i += 1) client.publishState(`t${i}`, 'v')
      await client.flush()
      expect(sizes).toEqual([8, 4, 2, 2, 4, 2, 2])
      expect(client.healthy).toBe(true)
      expect(client.droppedCount).toBe(0)
    })

    it('a single item that is still too large is dropped, bounded', async () => {
      const client = new PushClient({
        transport: async () => {
          throw new PushHttpError(413, '')
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        brokerId: 'b1',
      })
      for (let i = 0; i < 4; i += 1) client.publishState(`t${i}`, 'v')
      await client.flush()
      expect(client.healthy).toBe(false)
      expect(client.droppedCount).toBe(4)
    })
  })
})
