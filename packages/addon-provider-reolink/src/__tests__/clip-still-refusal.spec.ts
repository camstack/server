/**
 * "Not yet" and "never" are two answers, and only the branch that refused
 * knows which one it gave.
 *
 * There is deliberately NO table here mapping a code to a disposition. A table
 * is a second authority, and it is the one a new code forgets to join — this
 * repo has shipped that mistake before. Instead the two constructors are typed
 * so narrowly that the wrong pairing does not compile: `deferStill` accepts
 * only the two codes that mean "the still is still coming", `refuseStill` only
 * the ones that mean "it is not".
 */
import { describe, expect, it } from 'vitest'
import {
  deferStill,
  queueRefusal,
  refuseStill,
  ThumbQueueRefusedError,
} from '../clips/clip-still-refusal.js'

describe('the two constructors', () => {
  it('marks a queued still DEFERRED, with the hint the queue measured', () => {
    const refusal = deferStill('queue-full', 'queue-full: 9 mints waiting for host h', 9_000)
    expect(refusal.disposition).toBe('deferred')
    expect(refusal.code).toBe('queue-full')
    expect(refusal.retryAfterMs).toBe(9_000)
    expect(refusal.reason).toContain('9 mints waiting')
  })

  it('marks everything else FINAL, and carries no retry hint at all', () => {
    const refusal = refuseStill('sleeping', 'sleeping: a still would wake this camera')
    expect(refusal.disposition).toBe('final')
    expect(refusal.retryAfterMs).toBeUndefined()
  })

  it('keeps the camera’s own words verbatim — the code never replaces them', () => {
    const words = 'rejected: responseCode=400 (Baichuan)'
    expect(refuseStill('camera-refused', words).reason).toBe(words)
  })
})

describe('queueRefusal — the ONE place a queue error becomes a wire answer', () => {
  it('turns a full lane into a deferred answer that says when to come back', () => {
    const refusal = queueRefusal(
      new ThumbQueueRefusedError('queue-full', 'queue-full: 16 waiting for host h', 16_000),
    )
    expect(refusal?.disposition).toBe('deferred')
    expect(refusal?.code).toBe('queue-full')
    expect(refusal?.retryAfterMs).toBe(16_000)
  })

  it('turns an open host backoff into a deferred answer too — the host is resting, not refusing us', () => {
    const refusal = queueRefusal(
      new ThumbQueueRefusedError('camera-backoff', 'camera-backoff: host h is backing off', 4_000),
    )
    expect(refusal?.disposition).toBe('deferred')
    expect(refusal?.code).toBe('camera-backoff')
  })

  it('does not claim an ordinary failure — the caller names that one itself', () => {
    // A decode failure, a socket close, a timeout: none of them is the queue
    // saying "come back", and a `null` here is what makes the caller say
    // `camera-refused` explicitly instead of inheriting a default.
    expect(queueRefusal(new Error('Baichuan socket closed'))).toBeNull()
    expect(queueRefusal('not even an error')).toBeNull()
  })
})
