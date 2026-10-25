import { describe, expect, it, vi } from 'vitest'
import { PENDING_GATE_REPORT_INTERVAL_MS, PendingGate } from '../pending-gate.js'

/**
 * Item 3 (2026-08-18): the finalize lane itself is already backpressured — each
 * (device, profile) watcher self-serializes and AWAITS stat+move+index, so a
 * disk stall holds at most one finalize in flight per writer and the durable
 * queue is the playlist on disk. What was UNBOUNDED was the fire-and-forget
 * work fanned out per indexed segment (`onIndexed`: the hour-ledger write RPC
 * and the mfra file read): under a stall of the store or the disk those
 * promises accumulate at finalize rate with nothing to stop them. The gate
 * bounds that pending set; over the bound, work is REFUSED (both lanes are
 * reconstructible — the archive walk re-seeds the ledger hour, a playback seek
 * re-fetches the mfra tail) and the refusal is on the record.
 */

interface Deferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (err: Error) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('PendingGate — bounded fire-and-forget lanes', () => {
  it('admits work up to the limit and REFUSES beyond it', async () => {
    const gate = new PendingGate({ label: 'hour-ledger', limit: 2, onSaturated: vi.fn() })
    const a = deferred()
    const b = deferred()
    expect(gate.run(() => a.promise)).toBe(true)
    expect(gate.run(() => b.promise)).toBe(true)
    expect(gate.pending).toBe(2)
    // The lane is full — a stall must throttle, not balloon.
    expect(gate.run(() => Promise.resolve())).toBe(false)
    expect(gate.pending).toBe(2)
    a.resolve()
    b.resolve()
    await flush()
  })

  it('a settled task frees its slot — recovery drains at completion rate', async () => {
    const gate = new PendingGate({ label: 'mfra', limit: 1, onSaturated: vi.fn() })
    const a = deferred()
    expect(gate.run(() => a.promise)).toBe(true)
    expect(gate.run(() => Promise.resolve())).toBe(false)
    a.resolve()
    await flush()
    expect(gate.pending).toBe(0)
    expect(gate.run(() => Promise.resolve())).toBe(true)
    await flush()
  })

  it('reports saturation LOUDLY but throttled — one aggregate line per interval, with the count', () => {
    const onSaturated = vi.fn()
    let nowMs = 100_000
    const gate = new PendingGate({
      label: 'hour-ledger',
      limit: 1,
      onSaturated,
      now: () => nowMs,
    })
    const a = deferred()
    expect(gate.run(() => a.promise)).toBe(true)
    // A long stall drops at finalize rate (~3.4/s): every drop counted, ONE line.
    for (let i = 0; i < 10; i++) expect(gate.run(() => Promise.resolve())).toBe(false)
    expect(onSaturated).toHaveBeenCalledTimes(1)
    expect(onSaturated).toHaveBeenCalledWith({ label: 'hour-ledger', dropped: 1, pending: 1 })

    // Inside the report interval: silence (the count accrues).
    nowMs += PENDING_GATE_REPORT_INTERVAL_MS - 1
    expect(gate.run(() => Promise.resolve())).toBe(false)
    expect(onSaturated).toHaveBeenCalledTimes(1)

    // Past it: the accrued refusals are reported in one line.
    nowMs += 2
    expect(gate.run(() => Promise.resolve())).toBe(false)
    expect(onSaturated).toHaveBeenCalledTimes(2)
    expect(onSaturated).toHaveBeenLastCalledWith({ label: 'hour-ledger', dropped: 11, pending: 1 })
    a.resolve()
  })

  it('a rejecting task frees its slot and surfaces the error — never a wedged lane', async () => {
    const onTaskError = vi.fn()
    const gate = new PendingGate({ label: 'mfra', limit: 1, onSaturated: vi.fn(), onTaskError })
    const a = deferred()
    expect(gate.run(() => a.promise)).toBe(true)
    a.reject(new Error('EIO'))
    await flush()
    expect(gate.pending).toBe(0)
    expect(onTaskError).toHaveBeenCalledTimes(1)
    // The slot is free again.
    expect(gate.run(() => Promise.resolve())).toBe(true)
    await flush()
  })

  it('a task that THROWS synchronously frees its slot too', async () => {
    const onTaskError = vi.fn()
    const gate = new PendingGate({ label: 'mfra', limit: 1, onSaturated: vi.fn(), onTaskError })
    expect(
      gate.run(() => {
        throw new Error('sync boom')
      }),
    ).toBe(true)
    await flush()
    expect(gate.pending).toBe(0)
    expect(onTaskError).toHaveBeenCalledTimes(1)
  })
})
