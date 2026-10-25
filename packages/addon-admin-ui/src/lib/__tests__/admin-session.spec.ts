import { afterEach, describe, expect, it, vi } from 'vitest'

const refreshSession = vi.fn()
const setToken = vi.fn()
vi.mock('../backend', () => ({
  getSystem: () => ({ refreshSession, setToken }),
}))

const {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  clearStoredSession,
  onSessionRotated,
  readStoredSession,
  reconnectWithFreshSession,
  recoverSession,
  sessionFromFragment,
  sessionKeeper,
  storeSession,
} = await import('../admin-session')

describe('admin session storage', () => {
  afterEach(() => {
    clearStoredSession()
    vi.clearAllMocks()
  })

  it('keeps the access token under the key every reader already uses, the refresh token beside it', () => {
    storeSession({ token: 'a.b.c', refreshToken: 'csr_1', expiresAt: 123 })
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('a.b.c')
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('csr_1')
    expect(readStoredSession()).toEqual({ token: 'a.b.c', refreshToken: 'csr_1', expiresAt: 123 })
  })

  it('a session without a refresh token clears a stale one', () => {
    storeSession({ token: 'a', refreshToken: 'csr_old' })
    storeSession({ token: 'b' })
    expect(readStoredSession()).toEqual({ token: 'b' })
  })

  it('reads a session from an SSO return fragment', () => {
    expect(
      sessionFromFragment(
        new URLSearchParams('token=t&refreshToken=csr_x&expiresAt=99&provider=p'),
      ),
    ).toEqual({ token: 't', refreshToken: 'csr_x', expiresAt: 99 })
    expect(sessionFromFragment(new URLSearchParams('provider=p'))).toBeNull()
  })

  it('a tab whose refresh token another tab already rotated adopts the stored pair instead of spending it', async () => {
    storeSession({ token: 'fresh', refreshToken: 'csr_new', expiresAt: Date.now() + 3_600_000 })
    sessionKeeper().adopt({ token: 'stale', refreshToken: 'csr_old', expiresAt: Date.now() - 1 })
    await sessionKeeper().ensureFresh()
    expect(refreshSession).not.toHaveBeenCalled()
    expect(setToken).toHaveBeenCalledWith('fresh')
    sessionKeeper().stop()
  })

  it('refreshes through the hub when nobody else did, and stores the rotated pair', async () => {
    refreshSession.mockResolvedValueOnce({
      token: 'next',
      refreshToken: 'csr_2',
      expiresAt: Date.now() + 7_200_000,
    })
    storeSession({ token: 'old', refreshToken: 'csr_1', expiresAt: Date.now() - 1 })
    sessionKeeper().adopt({ token: 'old', refreshToken: 'csr_1', expiresAt: Date.now() - 1 })
    await sessionKeeper().ensureFresh()
    expect(refreshSession).toHaveBeenCalledWith('csr_1')
    expect(readStoredSession()?.refreshToken).toBe('csr_2')
    sessionKeeper().stop()
  })

  it('a watchdog reconnect with an expired access token refreshes BEFORE the handshake', async () => {
    const order: string[] = []
    refreshSession.mockImplementationOnce(async () => {
      order.push('refresh')
      return { token: 'next', refreshToken: 'csr_2', expiresAt: Date.now() + 7_200_000 }
    })
    storeSession({ token: 'old', refreshToken: 'csr_1', expiresAt: Date.now() - 1 })
    sessionKeeper().adopt({ token: 'old', refreshToken: 'csr_1', expiresAt: Date.now() - 1 })
    await reconnectWithFreshSession(() => order.push('reconnect'))
    expect(order).toEqual(['refresh', 'reconnect'])
    expect(setToken).toHaveBeenCalledWith('next')
    sessionKeeper().stop()
  })

  it('a rotation applies the new token to the System, then tells the app so it can re-handshake', async () => {
    const seen: string[] = []
    setToken.mockImplementation((t: string) => seen.push(`setToken:${t}`))
    const off = onSessionRotated(() => seen.push('rotated'))
    refreshSession.mockResolvedValueOnce({
      token: 'rot',
      refreshToken: 'csr_3',
      expiresAt: Date.now() + 7_200_000,
    })
    sessionKeeper().adopt({ token: 'old', refreshToken: 'csr_1', expiresAt: Date.now() - 1 })
    await sessionKeeper().refreshNow()
    expect(seen).toEqual(['setToken:rot', 'rotated'])
    off()
    setToken.mockReset()
    sessionKeeper().stop()
  })

  it('recoverSession is true after a successful refresh and false when the hub refuses it', async () => {
    refreshSession.mockResolvedValueOnce({
      token: 'ok',
      refreshToken: 'csr_4',
      expiresAt: Date.now() + 7_200_000,
    })
    sessionKeeper().adopt({
      token: 'old',
      refreshToken: 'csr_1',
      expiresAt: Date.now() + 3_600_000,
    })
    expect(await recoverSession()).toBe(true)
    refreshSession.mockRejectedValueOnce(
      Object.assign(new Error('no'), { data: { code: 'UNAUTHORIZED' } }),
    )
    expect(await recoverSession()).toBe(false)
    sessionKeeper().stop()
  })
})
