/**
 * The property the recorder specs depend on, stated once.
 *
 * Two CI runs in a row (35497173489, 35501079112) failed a recorder spec
 * because a counted drain — `for (let i = 0; i < 20; i++) await
 * vi.advanceTimersByTimeAsync(0)` — ran out before the controller's real
 * filesystem work had landed, and four more specs in this directory were
 * commented out on 2026-09-14 for the same reason. The developer Mac cannot be
 * made slow enough to reproduce the runner's particular miss, and it does not
 * have to be: the difference between the two idioms is a property, and a
 * property can be stated on any machine.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settleTurns, settleUntil } from './settle.js'

/**
 * Work whose latency fake timers CANNOT collapse: real `stat` calls go to
 * libuv's threadpool, which is exactly where a loaded runner's extra
 * milliseconds come from. Two hundred of them need far more than a handful of
 * event-loop turns on any machine, fast or slow.
 */
function threadpoolWork(): { landed: () => boolean } {
  let done = false
  void (async (): Promise<void> => {
    for (let i = 0; i < 200; i++) await fs.stat(os.tmpdir())
    done = true
  })()
  return { landed: () => done }
}

describe('settling under fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a COUNTED drain can run out before real work has landed — that is the defect', async () => {
    const work = threadpoolWork()
    await settleTurns(5)
    expect(work.landed()).toBe(false)
  })

  it('settleUntil waits for the landing, however many turns it takes', async () => {
    const work = threadpoolWork()
    await settleUntil(work.landed, 'the threadpool work')
    expect(work.landed()).toBe(true)
  })

  it('and it is BOUNDED — work that never lands fails saying what it waited for', async () => {
    await expect(settleUntil(() => false, 'a thing that never happens')).rejects.toThrow(
      /a thing that never happens never landed/,
    )
  })
})
