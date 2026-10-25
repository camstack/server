import { describe, it, expect } from 'vitest'
import { CrashSupervisor } from '../../moleculer/crash-supervisor.js'

describe('CrashSupervisor', () => {
  it('respawns with exponential backoff under the crash threshold', () => {
    const s = new CrashSupervisor({ windowMs: 60_000, maxCrashes: 5, maxBackoffMs: 30_000 })
    const d1 = s.recordCrash('runner-a', 1000)
    expect(d1.action).toBe('respawn')
    const d2 = s.recordCrash('runner-a', 1500)
    expect(d2.action).toBe('respawn')
    if (d1.action !== 'respawn' || d2.action !== 'respawn') throw new Error('expected respawn')
    expect(d2.backoffMs).toBeGreaterThan(d1.backoffMs) // backoff grows
  })

  it('trips to failed after maxCrashes within the window', () => {
    const s = new CrashSupervisor({ windowMs: 60_000, maxCrashes: 3, maxBackoffMs: 30_000 })
    s.recordCrash('runner-b', 1000)
    s.recordCrash('runner-b', 2000)
    const tripped = s.recordCrash('runner-b', 3000)
    expect(tripped.action).toBe('failed') // 3rd crash in-window trips the breaker
  })

  it('a crash outside the window does not count toward the threshold', () => {
    const s = new CrashSupervisor({ windowMs: 10_000, maxCrashes: 2, maxBackoffMs: 30_000 })
    s.recordCrash('runner-c', 1000)
    const after = s.recordCrash('runner-c', 1000 + 20_000) // outside the 10s window
    expect(after.action).toBe('respawn') // old crash aged out — still respawn
  })

  it('exponential backoff never exceeds maxBackoffMs', () => {
    const s = new CrashSupervisor({ windowMs: 60_000, maxCrashes: 10, maxBackoffMs: 1_000 })
    // 8 in-window crashes — below the maxCrashes=10 trip threshold, so
    // every decision stays a `respawn` and the backoff grows past the cap.
    for (let i = 1; i <= 8; i++) {
      const decision = s.recordCrash('runner-e', 1000 + i * 100)
      if (decision.action !== 'respawn') throw new Error('expected respawn below the threshold')
      expect(decision.backoffMs).toBeLessThanOrEqual(1_000) // clamped to maxBackoffMs
    }
  })

  it('reset clears crash history so a fresh streak starts over', () => {
    const s = new CrashSupervisor({ windowMs: 60_000, maxCrashes: 2, maxBackoffMs: 30_000 })
    s.recordCrash('runner-d', 1000)
    s.reset('runner-d')
    const after = s.recordCrash('runner-d', 2000)
    expect(after.action).toBe('respawn') // history cleared — not the 2nd crash
  })

  it('reset after a tripped breaker lets an operator restart recover the runner', () => {
    const s = new CrashSupervisor({ windowMs: 60_000, maxCrashes: 3, maxBackoffMs: 30_000 })
    // Crash maxCrashes times within the window — the breaker trips to `failed`.
    s.recordCrash('runner-f', 1000)
    s.recordCrash('runner-f', 2000)
    const tripped = s.recordCrash('runner-f', 3000)
    expect(tripped.action).toBe('failed') // terminal D6 state

    // An operator restart (`$process.restart`) calls `reset` — this must
    // clear the tripped history so the runner is supervised from scratch.
    s.reset('runner-f')

    // The next crash after recovery is treated as the first of a fresh
    // streak: `respawn`, not an immediate re-trip to `failed`.
    const recovered = s.recordCrash('runner-f', 4000)
    expect(recovered.action).toBe('respawn')
    if (recovered.action !== 'respawn') throw new Error('expected respawn after reset')
    expect(recovered.crashesInWindow).toBe(1) // streak restarted at 1
  })
})
