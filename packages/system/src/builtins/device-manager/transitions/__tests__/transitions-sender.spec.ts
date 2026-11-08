import { describe, expect, it, vi } from 'vitest'
import type { DeviceTransition } from '@camstack/types'
import { DEVICE_TRANSITIONS_RECORD_BATCH_MAX } from '@camstack/types'
import { TransitionSender } from '../transitions-sender.js'

function row(i: number, deviceId = 1): DeviceTransition {
  return {
    id: `${deviceId}:${i}`,
    deviceId,
    capName: 'switch',
    field: 'on',
    at: i,
    from: false,
    to: true,
    outcome: 'device',
    actor: { kind: 'device' },
  }
}

function make(opts: { max?: number; fail?: boolean } = {}) {
  const sent: DeviceTransition[][] = []
  const state = { fail: opts.fail === true }
  const errors: Array<{ msg: string; tags: unknown }> = []
  const sender = new TransitionSender({
    send: async (batch) => {
      if (state.fail) throw new Error('hub busy')
      sent.push([...batch])
    },
    logger: {
      error: (msg: string, meta?: { tags?: unknown }) =>
        void errors.push({ msg, tags: meta?.tags }),
    },
    maxQueued: opts.max ?? 10_000,
  })
  return { sender, sent, state, errors }
}

describe('transition sender (D1022)', () => {
  it('flushes in batches no larger than the wire bound', async () => {
    const w = make()
    for (let i = 0; i < DEVICE_TRANSITIONS_RECORD_BATCH_MAX + 5; i += 1) w.sender.enqueue(row(i))
    await w.sender.flush()
    expect(w.sent.map((b) => b.length)).toEqual([DEVICE_TRANSITIONS_RECORD_BATCH_MAX, 5])
  })

  it('keeps a failed batch and sends it on the next flush', async () => {
    const w = make({ fail: true })
    w.sender.enqueue(row(1))
    await w.sender.flush()
    expect(w.sent).toEqual([])
    expect(w.sender.queued()).toBe(1)
    w.state.fail = false
    await w.sender.flush()
    expect(w.sent).toHaveLength(1)
    expect(w.sender.queued()).toBe(0)
  })

  it('says a failed flush once per streak', async () => {
    const w = make({ fail: true })
    w.sender.enqueue(row(1))
    await w.sender.flush()
    await w.sender.flush()
    expect(w.errors).toHaveLength(1)
    w.state.fail = false
    await w.sender.flush()
    w.state.fail = true
    w.sender.enqueue(row(2))
    await w.sender.flush()
    expect(w.errors).toHaveLength(2)
  })

  it('past the bound drops the OLDEST and says so on every overflow', async () => {
    const w = make({ max: 3 })
    for (let i = 1; i <= 5; i += 1) w.sender.enqueue(row(i, 40 + i))
    expect(w.sender.queued()).toBe(3)
    expect(w.errors.filter((e) => e.tags === undefined)).toHaveLength(2)
    await w.sender.flush()
    expect(w.sent[0]?.map((t) => t.at)).toEqual([3, 4, 5])
  })

  it('abandon says what it throws away, and nothing when the queue is empty', () => {
    const w = make()
    w.sender.abandon()
    expect(w.errors).toEqual([])
    w.sender.enqueue(row(1, 41))
    w.sender.enqueue(row(2, 42))
    w.sender.abandon()
    expect(w.sender.queued()).toBe(0)
    expect(w.errors[0]?.msg).toContain('2 transition(s)')
    expect(w.errors.filter((e) => e.tags !== undefined)).toHaveLength(2)
  })

  it('logs each dropped device with its tag', () => {
    const w = make({ max: 1 })
    w.sender.enqueue(row(1, 41))
    w.sender.enqueue(row(2, 42))
    expect(w.errors.some((e) => JSON.stringify(e.tags) === JSON.stringify({ deviceId: 41 }))).toBe(
      true,
    )
  })

  it('does not overlap two flushes', async () => {
    const send = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    const sender = new TransitionSender({
      send,
      logger: { error: () => undefined },
      maxQueued: 100,
    })
    sender.enqueue(row(1))
    await Promise.all([sender.flush(), sender.flush()])
    expect(send).toHaveBeenCalledTimes(1)
  })
})
