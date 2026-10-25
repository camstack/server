import { describe, expect, it } from 'vitest'
import { sourceWaitState, waitForSourceMedia } from './egress-source-readiness.js'

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 1_000
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

describe('waitForSourceMedia', () => {
  it('a source already carrying media is not waited on at all', async () => {
    const c = clock()
    let polls = 0
    const out = await waitForSourceMedia({
      hasMedia: () => {
        polls += 1
        return true
      },
      timeoutMs: 20_000,
      pollMs: 500,
      ...c,
    })
    expect(out).toEqual({ ready: true, waitedMs: 0, outcome: 'live' })
    expect(polls).toBe(1)
  })

  it('waits for a publisher that materialises late, and says how long', async () => {
    // The measured shape: 5 486 ms of nothing, then packets.
    const c = clock()
    let asked = 0
    const out = await waitForSourceMedia({
      hasMedia: () => {
        asked += 1
        return asked > 11
      },
      timeoutMs: 20_000,
      pollMs: 500,
      ...c,
    })
    expect(out.ready).toBe(true)
    expect(out.outcome).toBe('materialized')
    expect(out.waitedMs).toBe(5_500)
  })

  it('gives up at the deadline and reports NOT ready — it never refuses', async () => {
    const c = clock()
    const out = await waitForSourceMedia({
      hasMedia: () => false,
      timeoutMs: 2_000,
      pollMs: 500,
      ...c,
    })
    expect(out).toEqual({ ready: false, waitedMs: 2_000, outcome: 'timeout' })
  })

  it('an UNKNOWN source ends the wait at once — absent is not empty', async () => {
    const c = clock()
    const out = await waitForSourceMedia({
      hasMedia: () => null,
      timeoutMs: 20_000,
      pollMs: 500,
      ...c,
    })
    expect(out).toEqual({ ready: false, waitedMs: 0, outcome: 'unknown' })
  })

  it('stops waiting when the source becomes unknowable mid-wait', async () => {
    const c = clock()
    let asked = 0
    const out = await waitForSourceMedia({
      hasMedia: () => {
        asked += 1
        return asked > 2 ? null : false
      },
      timeoutMs: 20_000,
      pollMs: 500,
      ...c,
    })
    expect(out.outcome).toBe('unknown')
    expect(out.waitedMs).toBe(1_000)
  })
})

describe('sourceWaitState', () => {
  it('a source already carrying media is READY', () => {
    expect(sourceWaitState({ hasMedia: true, materializing: false })).toBe(true)
  })

  it('a source being BUILT is worth waiting for', () => {
    // The case the wait was really for: a second consumer arrives while the
    // first is already waking the camera.
    expect(sourceWaitState({ hasMedia: false, materializing: true })).toBe(false)
  })

  it('a COLD idle source is null — the spawn is what wakes it', () => {
    // Measured 2026-09-13: waiting here spent 15 s and changed nothing, because
    // the dial the wait was withholding is the demand that starts the
    // materialize. `null` means "waiting cannot help", not "no media".
    expect(sourceWaitState({ hasMedia: false, materializing: false })).toBeNull()
  })
})
