import { describe, expect, it } from 'vitest'
import { applyMirrorRefresh, INITIAL_PTZ_MIRROR } from '../ptz-mirror.js'

describe('applyMirrorRefresh', () => {
  it('starts unknown — never "off" (D315/D393)', () => {
    expect(INITIAL_PTZ_MIRROR.nativeAutotrack).toBe('unknown')
    expect(INITIAL_PTZ_MIRROR.moveImpulseMs).toBeNull()
  })

  it('takes both answers from a successful read', () => {
    const m = applyMirrorRefresh(
      INITIAL_PTZ_MIRROR,
      { kind: 'read', moveImpulseMs: 200, nativeAutotrack: 'disabled' },
      1_000,
    )
    expect(m.moveImpulseMs).toBe(200)
    expect(m.nativeAutotrack).toBe('disabled')
    expect(m.lastRefreshAtMs).toBe(1_000)
  })

  it('leaves every gate standing when a refresh FAILS — a bad read is not an answer (D49)', () => {
    const known = applyMirrorRefresh(
      INITIAL_PTZ_MIRROR,
      { kind: 'read', moveImpulseMs: 200, nativeAutotrack: 'disabled' },
      1_000,
    )
    const after = applyMirrorRefresh(known, { kind: 'failed', error: 'ECONNRESET' }, 2_000)
    expect(after.moveImpulseMs).toBe(200)
    expect(after.nativeAutotrack).toBe('disabled')
    expect(after.lastRefreshAtMs).toBe(1_000)
    expect(after.lastError).toBe('ECONNRESET')
    expect(after.consecutiveFailures).toBe(1)
  })

  it('a failure before any success leaves the mirror unknown, which refuses to move', () => {
    const after = applyMirrorRefresh(INITIAL_PTZ_MIRROR, { kind: 'failed', error: 'boom' }, 10)
    expect(after.nativeAutotrack).toBe('unknown')
    expect(after.moveImpulseMs).toBeNull()
  })

  it('does not erase a known impulse when a read answers without one', () => {
    const known = applyMirrorRefresh(
      INITIAL_PTZ_MIRROR,
      { kind: 'read', moveImpulseMs: 350, nativeAutotrack: 'absent' },
      1_000,
    )
    const after = applyMirrorRefresh(
      known,
      { kind: 'read', moveImpulseMs: null, nativeAutotrack: 'absent' },
      2_000,
    )
    expect(after.moveImpulseMs).toBe(350)
  })

  it('clears the failure streak on the next success', () => {
    const failed = applyMirrorRefresh(INITIAL_PTZ_MIRROR, { kind: 'failed', error: 'x' }, 1)
    const ok = applyMirrorRefresh(
      failed,
      { kind: 'read', moveImpulseMs: 500, nativeAutotrack: 'enabled' },
      2,
    )
    expect(ok.consecutiveFailures).toBe(0)
    expect(ok.lastError).toBeNull()
  })
})
