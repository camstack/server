import { describe, expect, it } from 'vitest'
import {
  KICK_WINDOW_MS,
  MAX_RELOGINS_IN_WINDOW,
  RELOGIN_BASE_DELAY_MS,
  RELOGIN_MAX_DELAY_MS,
  ReloginGate,
} from '../petkit-relogin-gate.js'

describe('ReloginGate', () => {
  it('allows the first re-login immediately', () => {
    const gate = new ReloginGate()
    expect(gate.request(1_000)).toEqual({ kind: 'relogin' })
  })

  it('refuses a second re-login inside the base delay and names when it may retry', () => {
    const gate = new ReloginGate()
    gate.request(0)
    const second = gate.request(1_000)
    expect(second.kind).toBe('wait')
    if (second.kind === 'wait') expect(second.retryAt).toBe(RELOGIN_BASE_DELAY_MS)
  })

  it('doubles the delay per attempt, capped', () => {
    const gate = new ReloginGate({
      maxInWindow: 50,
      windowMs: Number.MAX_SAFE_INTEGER,
    })
    let now = 0
    gate.request(now)
    let expected = RELOGIN_BASE_DELAY_MS
    for (let i = 0; i < 10; i += 1) {
      const refused = gate.request(now + 1)
      expect(refused.kind).toBe('wait')
      if (refused.kind === 'wait') expect(refused.retryAt - now).toBe(expected)
      now += expected
      expect(gate.request(now)).toEqual({ kind: 'relogin' })
      expected = Math.min(expected * 2, RELOGIN_MAX_DELAY_MS)
    }
  })

  it('blocks after repeated kicks inside the window', () => {
    const gate = new ReloginGate()
    let now = 0
    for (let i = 0; i < MAX_RELOGINS_IN_WINDOW; i += 1) {
      expect(gate.request(now).kind).toBe('relogin')
      now += RELOGIN_MAX_DELAY_MS
    }
    const blocked = gate.request(now)
    expect(blocked.kind).toBe('blocked')
    // stays blocked, no matter how long a poll keeps failing
    expect(gate.request(now + 10 * KICK_WINDOW_MS).kind).toBe('blocked')
  })

  it('reset (operator re-saved the account) re-arms the gate', () => {
    const gate = new ReloginGate()
    let now = 0
    for (let i = 0; i < MAX_RELOGINS_IN_WINDOW; i += 1) {
      gate.request(now)
      now += RELOGIN_MAX_DELAY_MS
    }
    expect(gate.request(now).kind).toBe('blocked')
    gate.reset()
    expect(gate.request(now)).toEqual({ kind: 'relogin' })
  })

  it('a re-login that stays healthy for a full window is forgotten', () => {
    const gate = new ReloginGate()
    gate.request(0)
    expect(gate.request(KICK_WINDOW_MS + 1)).toEqual({ kind: 'relogin' })
  })
})
