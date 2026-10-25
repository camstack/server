/**
 * Tape operations run one at a time (fix round, L2): a rejected operation
 * never wedges the queue, and a HUNG one is abandoned at its deadline — the
 * caller is rejected, a line tagged with the camera says which operation, and
 * the next operation runs.
 *
 * Disarms:
 *  - set `this.tail = next` (no catch) — "an operation that throws does not
 *    stop the next" fails (the next op is skipped with the same rejection);
 *  - drop the deadline race in `withDeadline` — "a hung operation is
 *    abandoned at its deadline" fails (the next op never runs; the test
 *    times out).
 */
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import { TapeOperationQueue, TapeOperationTimeoutError } from '../tape-operation-queue.js'

describe('TapeOperationQueue', () => {
  it('an operation that throws does not stop the next', async () => {
    const queue = new TapeOperationQueue({ logger: makeLogRecorder().logger })
    const failed = queue.run(
      async () => {
        throw new Error('EIO')
      },
      { name: 'promote', deviceId: 101 },
    )
    const next = queue.run(async () => 'ran', { name: 'release', deviceId: 101 })
    await expect(failed).rejects.toThrow('EIO')
    await expect(next).resolves.toBe('ran')
  })

  it('a hung operation is abandoned at its deadline, logged with its camera, and the next runs', async () => {
    const { logger, entries } = makeLogRecorder()
    const queue = new TapeOperationQueue({ logger, deadlineMs: 20 })
    const hung = queue.run(() => new Promise<never>(() => {}), { name: 'promote', deviceId: 102 })
    const next = queue.run(async () => 'ran', { name: 'release', deviceId: 102 })
    await expect(hung).rejects.toBeInstanceOf(TapeOperationTimeoutError)
    await expect(next).resolves.toBe('ran')
    expect(entries).toContainEqual({
      level: 'warn',
      message: 'tracking tape operation abandoned at its deadline',
      extras: { tags: { deviceId: 102 }, meta: { operation: 'promote', deadlineMs: 20 } },
    })
  }, 2_000)
})
