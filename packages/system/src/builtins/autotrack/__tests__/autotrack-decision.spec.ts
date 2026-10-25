/**
 * The decision function, gate by gate. Every test names the gate it pins, so a
 * sabotage of that gate has exactly one place to go red.
 *
 * The clock is injected everywhere (`nowMs` is a parameter), so nothing here
 * waits and nothing is flaky.
 */
import { describe, expect, it } from 'vitest'
import { type AutotrackLoopConfig, DEFAULT_AUTOTRACK_LOOP_CONFIG } from '../autotrack-config.js'
import {
  type AutotrackDecisionInput,
  type AutotrackLoopState,
  decideAutotrack,
  INITIAL_AUTOTRACK_LOOP_STATE,
  type NativeAutotrackState,
} from '../autotrack-decision.js'

const CONFIG: AutotrackLoopConfig = DEFAULT_AUTOTRACK_LOOP_CONFIG
/** Long enough that every timing gate is open unless a test closes it. */
const LONG_AGO = 0
const NOW = 1_000_000

interface InputOverrides {
  readonly nowMs?: number
  readonly armed?: boolean
  readonly errorX?: number
  readonly errorY?: number
  readonly targetAbsent?: boolean
  readonly targetLastSeenAtMs?: number | null
  readonly moveImpulseMs?: number | null
  readonly nativeAutotrack?: NativeAutotrackState
  readonly config?: AutotrackLoopConfig
}

function input(overrides: InputOverrides = {}): AutotrackDecisionInput {
  const absent = overrides.targetAbsent ?? false
  return {
    nowMs: overrides.nowMs ?? NOW,
    armed: overrides.armed ?? true,
    target: absent
      ? null
      : {
          trackId: 't1',
          error: { x: overrides.errorX ?? 0, y: overrides.errorY ?? 0 },
        },
    targetLastSeenAtMs:
      overrides.targetLastSeenAtMs === undefined ? NOW : overrides.targetLastSeenAtMs,
    moveImpulseMs: overrides.moveImpulseMs === undefined ? 200 : overrides.moveImpulseMs,
    nativeAutotrack: overrides.nativeAutotrack ?? 'absent',
    config: overrides.config ?? CONFIG,
  }
}

const IDLE: AutotrackLoopState = INITIAL_AUTOTRACK_LOOP_STATE
const READY: AutotrackLoopState = { ...INITIAL_AUTOTRACK_LOOP_STATE, lastCommandAtMs: LONG_AGO }

describe('decideAutotrack — arming', () => {
  it('holds "disarmed" and issues nothing when not armed, whatever the error', () => {
    const out = decideAutotrack(READY, input({ armed: false, errorX: 0.49 }))
    expect(out.decision).toEqual({ action: 'hold', reason: 'disarmed' })
  })
})

describe('decideAutotrack — the dead zone is the normal case', () => {
  it('holds inside the central 50% box', () => {
    // 0.24 < deadZoneFraction/2 (0.25)
    const out = decideAutotrack(READY, input({ errorX: 0.24, errorY: -0.24 }))
    expect(out.decision).toEqual({ action: 'hold', reason: 'inside-dead-zone' })
    expect(out.state.correctingX).toBe(false)
    expect(out.state.correctingY).toBe(false)
  })

  it('pulses once the subject leaves it', () => {
    const out = decideAutotrack(READY, input({ errorX: 0.26 }))
    expect(out.decision).toEqual({ action: 'pulse', pan: 1, tilt: 0, speed: CONFIG.speed })
    expect(out.state.correctingX).toBe(true)
    expect(out.state.lastCommandAtMs).toBe(NOW)
  })

  it('pans LEFT for a subject on the left', () => {
    const out = decideAutotrack(READY, input({ errorX: -0.3 }))
    expect(out.decision).toMatchObject({ action: 'pulse', pan: -1 })
  })

  it('tilts DOWN for a subject BELOW centre — image y grows downward, tilt is up-positive', () => {
    const out = decideAutotrack(READY, input({ errorY: 0.3 }))
    expect(out.decision).toMatchObject({ action: 'pulse', pan: 0, tilt: -1 })
  })

  it('tilts UP for a subject above centre', () => {
    const out = decideAutotrack(READY, input({ errorY: -0.3 }))
    expect(out.decision).toMatchObject({ action: 'pulse', tilt: 1 })
  })
})

describe('decideAutotrack — the correction stops BEFORE the centre', () => {
  it('keeps correcting between the inner box and the dead zone', () => {
    const correcting: AutotrackLoopState = { ...READY, correctingX: true }
    // 0.20 is inside the dead zone (0.25) but outside the settle box (0.15):
    // a fresh target would hold here; a correction in progress continues.
    const out = decideAutotrack(correcting, input({ errorX: 0.2 }))
    expect(out.decision).toMatchObject({ action: 'pulse', pan: 1 })
    expect(out.state.correctingX).toBe(true)
  })

  it('ends the correction at the inner box, short of the centre', () => {
    const correcting: AutotrackLoopState = { ...READY, correctingX: true }
    const out = decideAutotrack(correcting, input({ errorX: 0.14 }))
    expect(out.decision).toEqual({ action: 'hold', reason: 'settled' })
    expect(out.state.correctingX).toBe(false)
  })

  it('does not re-open a correction until the dead zone is left again', () => {
    const settled = decideAutotrack({ ...READY, correctingX: true }, input({ errorX: 0.14 }))
    const next = decideAutotrack(settled.state, input({ errorX: 0.2 }))
    expect(next.decision).toEqual({ action: 'hold', reason: 'inside-dead-zone' })
  })
})

describe('decideAutotrack — timing gates', () => {
  it('holds for the pulse dead time: impulse + settle', () => {
    const justCommanded: AutotrackLoopState = { ...IDLE, lastCommandAtMs: NOW - 500 }
    // 500 < 200 (impulse) + 400 (settle)
    const out = decideAutotrack(justCommanded, input({ errorX: 0.4 }))
    expect(out.decision).toEqual({ action: 'hold', reason: 'pulse-dead-time' })
  })

  it('holds on the loop-owned commands/second ceiling after the pulse has landed', () => {
    const recent: AutotrackLoopState = { ...IDLE, lastCommandAtMs: NOW - 1_500 }
    // 1500 ms is past impulse+settle (600) but inside 1000 / (1/3) = 3000.
    const out = decideAutotrack(recent, input({ errorX: 0.4 }))
    expect(out.decision).toEqual({ action: 'hold', reason: 'rate-limited' })
  })

  it('pulses once the ceiling has elapsed', () => {
    const old: AutotrackLoopState = { ...IDLE, lastCommandAtMs: NOW - 3_001 }
    const out = decideAutotrack(old, input({ errorX: 0.4 }))
    expect(out.decision).toMatchObject({ action: 'pulse' })
  })

  it('does not derive its ceiling from the frame rate: 10 frames at 10 Hz issue ONE command', () => {
    let state: AutotrackLoopState = IDLE
    let pulses = 0
    for (let i = 0; i < 10; i += 1) {
      const out = decideAutotrack(state, input({ nowMs: NOW + i * 100, errorX: 0.4 }))
      state = out.state
      if (out.decision.action === 'pulse') pulses += 1
    }
    expect(pulses).toBe(1)
  })
})

describe('decideAutotrack — refusals that keep the head safe', () => {
  it('refuses when the driver cannot say how long a pulse lasts (D393)', () => {
    const out = decideAutotrack(READY, input({ errorX: 0.4, moveImpulseMs: null }))
    expect(out.decision).toEqual({ action: 'hold', reason: 'impulse-duration-unknown' })
  })

  it('refuses while the camera drives its own head', () => {
    const out = decideAutotrack(READY, input({ errorX: 0.4, nativeAutotrack: 'enabled' }))
    expect(out.decision).toEqual({ action: 'hold', reason: 'native-autotrack-enabled' })
  })

  it('refuses when the native state has never been read — unknown is not "off"', () => {
    const out = decideAutotrack(READY, input({ errorX: 0.4, nativeAutotrack: 'unknown' }))
    expect(out.decision).toEqual({ action: 'hold', reason: 'native-autotrack-unknown' })
  })

  it('refuses on an unreadable frame geometry rather than reading it as centred', () => {
    const out = decideAutotrack(READY, {
      ...input({ errorX: 0.4 }),
      target: { trackId: 't1', error: null },
    })
    expect(out.decision).toEqual({ action: 'hold', reason: 'frame-geometry-unknown' })
  })
})

describe('decideAutotrack — absence and home', () => {
  it('holds, and never releases, while the target is inside its disappear delay', () => {
    const out = decideAutotrack(READY, {
      ...input({ targetAbsent: true }),
      targetLastSeenAtMs: NOW - (CONFIG.disappearDelayMs - 1),
    })
    expect(out.decision).toEqual({ action: 'hold', reason: 'target-absent' })
    expect(out.state.homeIssued).toBe(false)
  })

  it('goes home once the delay has elapsed', () => {
    const out = decideAutotrack(READY, {
      ...input({ targetAbsent: true }),
      targetLastSeenAtMs: NOW - CONFIG.disappearDelayMs,
    })
    expect(out.decision).toEqual({ action: 'home', reason: 'target-gone' })
    expect(out.state.homeIssued).toBe(true)
  })

  it('goes home exactly once per absence', () => {
    const first = decideAutotrack(READY, {
      ...input({ targetAbsent: true }),
      targetLastSeenAtMs: NOW - CONFIG.disappearDelayMs,
    })
    const second = decideAutotrack(first.state, {
      ...input({ nowMs: NOW + 10_000, targetAbsent: true }),
      targetLastSeenAtMs: NOW - CONFIG.disappearDelayMs,
    })
    expect(second.decision).toEqual({ action: 'hold', reason: 'home-already-issued' })
  })

  it('re-arms home when a target comes back and leaves again', () => {
    const homed = decideAutotrack(READY, {
      ...input({ targetAbsent: true }),
      targetLastSeenAtMs: NOW - CONFIG.disappearDelayMs,
    })
    const back = decideAutotrack(homed.state, input({ nowMs: NOW + 1_000 }))
    expect(back.state.homeIssued).toBe(false)
    const goneAgain = decideAutotrack(back.state, {
      ...input({ nowMs: NOW + 100_000, targetAbsent: true }),
      targetLastSeenAtMs: NOW + 1_000,
    })
    expect(goneAgain.decision).toEqual({ action: 'home', reason: 'target-gone' })
  })

  it('holds "no-target" when nothing has ever been held', () => {
    const out = decideAutotrack(IDLE, {
      ...input({ targetAbsent: true }),
      targetLastSeenAtMs: null,
    })
    expect(out.decision).toEqual({ action: 'hold', reason: 'no-target' })
  })
})

describe('decideAutotrack — purity', () => {
  it('never mutates the state it was given', () => {
    const before: AutotrackLoopState = { ...READY }
    const snapshot = JSON.stringify(before)
    decideAutotrack(before, input({ errorX: 0.4 }))
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})
