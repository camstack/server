/**
 * Reconnect schedule — the player's auto-retry policy as a pure function.
 *
 * The operator's report ("the stream errors and stays dark; retry must be
 * automatic in every case") exposed two silent behaviours in the inline
 * version: exhaustion returned without a trace (the retry loop just stopped —
 * a camera stays dark while looking busy), and no attempt was observable
 * anywhere. The schedule is now a pure decision — attempt in, action out —
 * so both the backoff shape and the exhaustion edge are pinned by tests, and
 * the component layer only executes the action (timer + callbacks).
 */
import { describe, it, expect } from 'vitest'
import { nextReconnectAction, RECONNECT_POLICY } from '../reconnect-schedule'

describe('nextReconnectAction', () => {
  it('first attempt: base delay (jitter pinned at 1.0)', () => {
    const action = nextReconnectAction(0, () => 0.5) // 0.8 + 0.5*0.4 = 1.0
    expect(action).toEqual({ kind: 'retry', delayMs: RECONNECT_POLICY.baseDelayMs })
  })

  it('backoff doubles per attempt and caps at the max delay', () => {
    const unit = (): number => 0.5
    const a1 = nextReconnectAction(1, unit)
    const a2 = nextReconnectAction(2, unit)
    expect(a1).toEqual({ kind: 'retry', delayMs: RECONNECT_POLICY.baseDelayMs * 2 })
    expect(a2).toEqual({ kind: 'retry', delayMs: RECONNECT_POLICY.baseDelayMs * 4 })
    const deep = nextReconnectAction(20, unit)
    expect(deep).toEqual({ kind: 'retry', delayMs: RECONNECT_POLICY.maxDelayMs })
  })

  it('jitter stays within ±20%', () => {
    const low = nextReconnectAction(0, () => 0)
    const high = nextReconnectAction(0, () => 1)
    expect(low.kind).toBe('retry')
    expect(high.kind).toBe('retry')
    if (low.kind === 'retry' && high.kind === 'retry') {
      expect(low.delayMs).toBe(Math.round(RECONNECT_POLICY.baseDelayMs * 0.8))
      expect(high.delayMs).toBe(Math.round(RECONNECT_POLICY.baseDelayMs * 1.2))
    }
  })

  it('exhaustion is an EXPLICIT action, not a silent return', () => {
    expect(nextReconnectAction(RECONNECT_POLICY.maxAttempts, () => 0.5)).toEqual({
      kind: 'exhausted',
      attempts: RECONNECT_POLICY.maxAttempts,
    })
    expect(nextReconnectAction(RECONNECT_POLICY.maxAttempts + 5, () => 0.5)).toEqual({
      kind: 'exhausted',
      attempts: RECONNECT_POLICY.maxAttempts + 5,
    })
  })
})
