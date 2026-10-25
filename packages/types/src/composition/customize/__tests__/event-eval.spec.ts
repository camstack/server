import { describe, expect, it } from 'vitest'
import {
  INITIAL_PULSE,
  INITIAL_SPAN,
  stepPulse,
  stepSpan,
  type LevelSample,
} from '../event-eval.js'

const low = (changedAt: number): LevelSample => ({ kind: 'level', active: false, changedAt })
const high = (changedAt: number): LevelSample => ({ kind: 'level', active: true, changedAt })
const unread: LevelSample = { kind: 'unread' }

describe('pulse', () => {
  it('counts a rising edge and ignores a level that is already high', () => {
    const seeded = stepPulse(INITIAL_PULSE, high(1_000), 2_000)
    expect(seeded.count).toBe(0)
    expect(seeded.lastPressedAt).toBeNull()
    expect(seeded.priorActive).toBe(true)

    const armed = stepPulse(INITIAL_PULSE, low(1_000), 2_000)
    const pressed = stepPulse(armed, high(2_000), 2_000)
    expect(pressed.count).toBe(1)
    expect(pressed.lastPressedAt).toBe(2_000)
  })

  it('merges presses inside the debounce and counts the next one', () => {
    const armed = stepPulse(INITIAL_PULSE, low(0), 2_000)
    const first = stepPulse(armed, high(1_000), 2_000)
    const held = stepPulse(first, high(1_500), 2_000)
    const fell = stepPulse(held, low(2_000), 2_000)
    const early = stepPulse(fell, high(2_500), 2_000)
    const later = stepPulse(stepPulse(early, low(3_000), 2_000), high(3_000), 2_000)
    expect(first.count).toBe(1)
    expect(early.count).toBe(1)
    expect(early.lastPressedAt).toBe(1_000)
    expect(later.count).toBe(2)
    expect(later.lastPressedAt).toBe(3_000)
  })

  it('does not move edge memory on an unread sample', () => {
    const armed = stepPulse(INITIAL_PULSE, low(1_000), 2_000)
    const missed = stepPulse(armed, unread, 2_000)
    expect(missed).toBe(armed)
    const pressed = stepPulse(missed, high(4_000), 2_000)
    expect(pressed.count).toBe(1)

    const again = stepPulse(stepPulse(pressed, unread, 2_000), high(5_000), 2_000)
    expect(again.count).toBe(1)
    expect(again.lastPressedAt).toBe(4_000)
  })
})

describe('span', () => {
  const timing = { timeoutMs: 30_000, cooldownMs: 0 }

  it('starts on a rising edge and ends on a falling edge', () => {
    const idle = stepSpan(INITIAL_SPAN, high(1_000), { ...timing, nowMs: 1_000 })
    expect(idle.open).toBe(false)
    const armed = stepSpan(INITIAL_SPAN, low(1_000), { ...timing, nowMs: 1_000 })
    const open = stepSpan(armed, high(2_000), { ...timing, nowMs: 2_000 })
    expect(open.open).toBe(true)
    expect(open.startedAt).toBe(2_000)
    const closed = stepSpan(open, low(5_000), { ...timing, nowMs: 5_000 })
    expect(closed.open).toBe(false)
    expect(closed.endedAt).toBe(5_000)
  })

  it('ends at the timeout when the fall never arrives', () => {
    const armed = stepSpan(INITIAL_SPAN, low(0), { ...timing, nowMs: 0 })
    const open = stepSpan(armed, high(1_000), { ...timing, nowMs: 1_000 })
    const held = stepSpan(open, high(1_000), { ...timing, nowMs: 20_000 })
    expect(held.open).toBe(true)
    const ended = stepSpan(held, high(1_000), { ...timing, nowMs: 31_000 })
    expect(ended.open).toBe(false)
    expect(ended.endedAt).toBe(31_000)
  })

  it('ignores a rise inside the cooldown and accepts one on the boundary', () => {
    const cool = { timeoutMs: 30_000, cooldownMs: 10_000 }
    const armed = stepSpan(INITIAL_SPAN, low(0), { ...cool, nowMs: 0 })
    const open = stepSpan(armed, high(1_000), { ...cool, nowMs: 1_000 })
    const closed = stepSpan(open, low(2_000), { ...cool, nowMs: 2_000 })
    const blocked = stepSpan(closed, high(5_000), { ...cool, nowMs: 5_000 })
    expect(blocked.open).toBe(false)
    expect(blocked.startedAt).toBe(1_000)
    const next = stepSpan(
      stepSpan(blocked, low(11_000), { ...cool, nowMs: 11_000 }),
      high(12_000),
      {
        ...cool,
        nowMs: 12_000,
      },
    )
    expect(next.open).toBe(true)
    expect(next.startedAt).toBe(12_000)
  })

  it('does not end or start from an unread sample', () => {
    const armed = stepSpan(INITIAL_SPAN, low(0), { ...timing, nowMs: 0 })
    const open = stepSpan(armed, high(1_000), { ...timing, nowMs: 1_000 })
    const missed = stepSpan(open, unread, { ...timing, nowMs: 2_000 })
    expect(missed.open).toBe(true)
    expect(missed.priorActive).toBe(true)
    const closed = stepSpan(missed, low(4_000), { ...timing, nowMs: 4_000 })
    expect(closed.open).toBe(false)
    expect(closed.endedAt).toBe(4_000)

    const still = stepSpan(INITIAL_SPAN, unread, { ...timing, nowMs: 1_000 })
    expect(still.open).toBe(false)
    expect(still.priorActive).toBeUndefined()
  })
})
