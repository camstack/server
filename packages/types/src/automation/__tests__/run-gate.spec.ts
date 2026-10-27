import { describe, expect, it } from 'vitest'
import { RunGate } from '../run-gate.js'

describe('run mode gates', () => {
  it('single drops a trigger while a run is in progress, and names the mode', () => {
    const gate = new RunGate({ mode: 'single' })
    expect(gate.admit().decision).toBe('run')
    const second = gate.admit()
    expect(second.decision).toBe('drop')
    expect(second.reason).toContain('single')
    gate.release()
    expect(gate.admit().decision).toBe('run')
  })

  it('restart admits the new trigger and says it aborts the run in progress', () => {
    const gate = new RunGate({ mode: 'restart' })
    expect(gate.admit().decision).toBe('run')
    const second = gate.admit()
    expect(second.decision).toBe('restart')
    expect(second.reason).toContain('aborting 1')
  })

  it('queued holds up to max triggers, drops the rest, and hands a freed slot to the queue', () => {
    const gate = new RunGate({ mode: 'queued', max: 2 })
    expect(gate.admit().decision).toBe('run')
    expect(gate.admit().decision).toBe('queued')
    expect(gate.admit().decision).toBe('queued')
    const dropped = gate.admit()
    expect(dropped.decision).toBe('drop')
    expect(dropped.reason).toContain('queue is full (2)')
    expect(gate.queuedTriggers).toBe(2)
    expect(gate.release()).toBe(true)
    expect(gate.queuedTriggers).toBe(1)
    expect(gate.activeRuns).toBe(1)
    expect(gate.release()).toBe(true)
    expect(gate.release()).toBe(false)
    expect(gate.activeRuns).toBe(0)
  })

  it('parallel runs up to max at once and drops beyond it', () => {
    const gate = new RunGate({ mode: 'parallel', max: 2 })
    expect(gate.admit().decision).toBe('run')
    expect(gate.admit().decision).toBe('run')
    const third = gate.admit()
    expect(third.decision).toBe('drop')
    expect(third.reason).toContain('parallel')
    gate.release()
    expect(gate.admit().decision).toBe('run')
  })

  it('cooldown is single plus a wait measured from the last run START', () => {
    const gate = new RunGate({ mode: 'cooldown', minutes: 30 })
    expect(gate.admit().decision).toBe('run')
    expect(gate.admit().decision).toBe('drop')
    const t0 = 1_000_000
    expect(gate.cooldown({ manual: false, now: t0, lastRunStartedAt: null }).ok).toBe(true)
    const inside = gate.cooldown({ manual: false, now: t0 + 10 * 60_000, lastRunStartedAt: t0 })
    expect(inside.ok).toBe(false)
    expect(inside.reason).toContain('20.0 min left')
    expect(gate.cooldown({ manual: false, now: t0 + 30 * 60_000, lastRunStartedAt: t0 }).ok).toBe(
      true,
    )
  })

  it('a manual trigger bypasses the cooldown wait but not the single limit', () => {
    const gate = new RunGate({ mode: 'cooldown', minutes: 30 })
    const manual = gate.cooldown({ manual: true, now: 1_060_000, lastRunStartedAt: 1_000_000 })
    expect(manual.ok).toBe(true)
    expect(manual.bypassed).toBe(true)
    expect(gate.admit().decision).toBe('run')
    expect(gate.admit().decision).toBe('drop')
  })

  it('has no cooldown outside cooldown mode', () => {
    const gate = new RunGate({ mode: 'queued', max: 3 })
    expect(gate.cooldown({ manual: false, now: 2, lastRunStartedAt: 1 }).ok).toBe(true)
  })
})
