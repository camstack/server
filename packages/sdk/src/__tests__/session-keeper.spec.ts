import { describe, expect, it, vi } from 'vitest'
import { SessionKeeper, type SessionTokens } from '../session-keeper.js'

/**
 * Transparent refresh: a refreshing client swaps its access token before it
 * expires, persists the rotated pair, and signs out only when the hub says
 * the session is over — never on a network blip.
 */

function harness(refresh: (rt: string) => Promise<SessionTokens>) {
  let now = 1_000_000
  const timers: Array<{ at: number; fn: () => void }> = []
  const onTokens = vi.fn()
  const onExpired = vi.fn()
  const keeper = new SessionKeeper({
    refresh,
    onTokens,
    onExpired,
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn }
      timers.push(timer)
      return () => {
        const i = timers.indexOf(timer)
        if (i !== -1) timers.splice(i, 1)
      }
    },
  })
  const runTimers = async (ms: number) => {
    now += ms
    for (const t of [...timers]) {
      if (t.at <= now) {
        timers.splice(timers.indexOf(t), 1)
        t.fn()
      }
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  return { keeper, onTokens, onExpired, runTimers, at: () => now, pending: () => timers.length }
}

const HOUR = 3_600_000

describe('SessionKeeper', () => {
  it('refreshes before the access token expires and hands the rotated pair to the app', async () => {
    const refresh = vi.fn(async (rt: string) => ({
      token: 'access-2',
      refreshToken: `${rt}-rotated`,
      expiresAt: 1_000_000 + 4 * HOUR,
    }))
    const h = harness(refresh)
    h.keeper.adopt({ token: 'access-1', refreshToken: 'csr_1', expiresAt: h.at() + 2 * HOUR })
    await h.runTimers(HOUR) // nothing yet
    expect(refresh).not.toHaveBeenCalled()
    await h.runTimers(HOUR - 60_000) // inside the refresh margin
    expect(refresh).toHaveBeenCalledWith('csr_1')
    expect(h.onTokens).toHaveBeenCalledWith({
      token: 'access-2',
      refreshToken: 'csr_1-rotated',
      expiresAt: 1_000_000 + 4 * HOUR,
    })
    expect(h.pending()).toBe(1) // the next refresh is already scheduled
  })

  it('a session WITHOUT a refresh token (legacy) is left alone', async () => {
    const refresh = vi.fn()
    const h = harness(refresh)
    h.keeper.adopt({ token: 'legacy', expiresAt: h.at() + 2 * HOUR })
    expect(h.pending()).toBe(0)
  })

  it('a refusal from the hub (session over) signs out once', async () => {
    const refusal = Object.assign(new Error('Session expired'), { data: { code: 'UNAUTHORIZED' } })
    const h = harness(async () => {
      throw refusal
    })
    h.keeper.adopt({ token: 'a', refreshToken: 'csr_1', expiresAt: h.at() + 120_000 })
    await h.runTimers(120_000)
    expect(h.onExpired).toHaveBeenCalledTimes(1)
    expect(h.onTokens).not.toHaveBeenCalled()
  })

  it('a network failure is retried, never treated as a sign-out', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
      if (calls === 1) throw new Error('fetch failed')
      return { token: 'b', refreshToken: 'csr_2', expiresAt: 1_000_000 + 10 * HOUR }
    })
    h.keeper.adopt({ token: 'a', refreshToken: 'csr_1', expiresAt: h.at() + 120_000 })
    await h.runTimers(120_000)
    expect(h.onExpired).not.toHaveBeenCalled()
    await h.runTimers(30_000)
    expect(h.onTokens).toHaveBeenCalledTimes(1)
  })

  it('ensureFresh refreshes at once when the token is already expired (app resumed after hours)', async () => {
    const refresh = vi.fn(async () => ({ token: 'b', refreshToken: 'csr_2', expiresAt: 9e15 }))
    const h = harness(refresh)
    h.keeper.adopt({ token: 'a', refreshToken: 'csr_1', expiresAt: h.at() - 1 })
    await h.keeper.ensureFresh()
    expect(refresh).toHaveBeenCalledTimes(1)
    await h.keeper.ensureFresh()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('concurrent callers share ONE refresh (no double rotation)', async () => {
    let resolve: (t: SessionTokens) => void = () => undefined
    const refresh = vi.fn(() => new Promise<SessionTokens>((r) => (resolve = r)))
    const h = harness(refresh)
    h.keeper.adopt({ token: 'a', refreshToken: 'csr_1', expiresAt: h.at() - 1 })
    const a = h.keeper.ensureFresh()
    const b = h.keeper.ensureFresh()
    resolve({ token: 'b', refreshToken: 'csr_2', expiresAt: 9e15 })
    await Promise.all([a, b])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('stop cancels the schedule', () => {
    const h = harness(vi.fn())
    h.keeper.adopt({ token: 'a', refreshToken: 'csr_1', expiresAt: h.at() + HOUR })
    h.keeper.stop()
    expect(h.pending()).toBe(0)
  })
})
