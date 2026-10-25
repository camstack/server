import { describe, expect, it, vi } from 'vitest'
import {
  completionFallbackPath,
  deliverPopupCompletion,
  isSsoCompletePath,
  isOpenerAck,
  parsePopupCompletion,
  type PopupCompletionEnv,
  SSO_POPUP_ACK,
  SSO_POPUP_ACK_TIMEOUT_MS,
  SSO_POPUP_DONE,
  SSO_POPUP_DONE_ACK,
  SSO_POPUP_MESSAGE,
  readableOrigin,
  type SsoChannel,
  trustedPopupCompletion,
  watchSsoPopup,
  withPopupFlag,
} from '../sso-popup'

const ORIGIN = 'https://192.0.2.10:4443'
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const LOGIN = { target: 'login', fragment: 'token=abc.def.ghi&provider=auth-oidc%2Fa' } as const

function fakeWindow(): Window {
  return { postMessage: vi.fn(), closed: false, location: { origin: ORIGIN } } as unknown as Window
}

/** A window at another origin: reading its location throws, as in a browser. */
function crossOriginWindow(): Window {
  return {
    postMessage: vi.fn(),
    closed: false,
    get location(): Location {
      throw new DOMException('Blocked a frame with origin', 'SecurityError')
    },
  } as unknown as Window
}

interface FakeChannel extends SsoChannel {
  readonly posted: unknown[]
  deliver(data: unknown): void
}

function fakeChannel(): FakeChannel {
  const listeners = new Set<(data: unknown) => void>()
  const posted: unknown[] = []
  return {
    posted,
    post: (data) => posted.push(data),
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    deliver(data) {
      for (const l of [...listeners]) l(data)
    },
  }
}

describe('parsePopupCompletion', () => {
  it('reads a login completion, keeping the fragment verbatim minus `return`', () => {
    expect(parsePopupCompletion('#return=login&token=abc.def.ghi&provider=auth-oidc%2Fa')).toEqual(
      LOGIN,
    )
  })

  it('reads a profile completion', () => {
    expect(parsePopupCompletion('#return=profile&linkError=session')).toEqual({
      target: 'profile',
      query: 'linkError=session',
    })
  })

  it('refuses anything else', () => {
    expect(parsePopupCompletion('')).toBeNull()
    expect(parsePopupCompletion('#token=abc')).toBeNull()
    expect(parsePopupCompletion('#return=elsewhere&x=1')).toBeNull()
    expect(parsePopupCompletion('#return=login')).toBeNull()
  })

  it('maps back to the full-page return', () => {
    expect(completionFallbackPath(LOGIN)).toBe('/login#token=abc.def.ghi&provider=auth-oidc%2Fa')
    expect(completionFallbackPath({ target: 'profile', query: 'linked=auth-oidc%2Fa' })).toBe(
      '/system/my-access?linked=auth-oidc%2Fa',
    )
  })
})

describe('withPopupFlag', () => {
  it('adds popup=1 to a relative start url, keeping its query', () => {
    expect(withPopupFlag('/addon/auth-oidc/a/start?link=abc')).toBe(
      '/addon/auth-oidc/a/start?link=abc&popup=1',
    )
    expect(withPopupFlag('/addon/auth-oidc/a/start')).toBe('/addon/auth-oidc/a/start?popup=1')
  })

  it('keeps an absolute url absolute', () => {
    expect(withPopupFlag('https://hub.example/addon/auth-oidc/a/start')).toBe(
      'https://hub.example/addon/auth-oidc/a/start?popup=1',
    )
  })
})

describe('trustedPopupCompletion — the opener only takes its own popup, at its own origin', () => {
  const popup = fakeWindow()
  const data = { type: SSO_POPUP_MESSAGE, completion: LOGIN }

  it('accepts the popup it opened, at its own origin', () => {
    expect(trustedPopupCompletion({ origin: ORIGIN, source: popup, data }, popup, ORIGIN)).toEqual(
      LOGIN,
    )
  })

  it('refuses another origin, even from the same window', () => {
    expect(
      trustedPopupCompletion(
        { origin: 'https://evil.example', source: popup, data },
        popup,
        ORIGIN,
      ),
    ).toBeNull()
    expect(
      trustedPopupCompletion(
        { origin: 'https://camstack.example.top', source: popup, data },
        popup,
        ORIGIN,
      ),
    ).toBeNull()
  })

  it('refuses another window at the right origin', () => {
    expect(
      trustedPopupCompletion({ origin: ORIGIN, source: fakeWindow(), data }, popup, ORIGIN),
    ).toBeNull()
    expect(trustedPopupCompletion({ origin: ORIGIN, source: popup, data }, null, ORIGIN)).toBeNull()
  })

  it('refuses a malformed message', () => {
    for (const bad of [
      null,
      'x',
      { type: 'other', completion: LOGIN },
      { type: SSO_POPUP_MESSAGE },
    ]) {
      expect(
        trustedPopupCompletion({ origin: ORIGIN, source: popup, data: bad }, popup, ORIGIN),
      ).toBeNull()
    }
  })
})

describe('watchSsoPopup — the opener side', () => {
  function target() {
    const listeners = new Set<(e: MessageEvent) => void>()
    return {
      location: { origin: ORIGIN } as Location,
      addEventListener: vi.fn((_t: string, l: (e: MessageEvent) => void) => listeners.add(l)),
      removeEventListener: vi.fn((_t: string, l: (e: MessageEvent) => void) => listeners.delete(l)),
      dispatch(e: Partial<MessageEvent>) {
        for (const l of [...listeners]) l(e as MessageEvent)
      },
      listeners,
    }
  }

  it('acks the popup at its own origin and returns once', () => {
    const popup = fakeWindow()
    const t = target()
    const onReturn = vi.fn()
    watchSsoPopup(popup, { onReturn }, t as never)
    const msg = { type: SSO_POPUP_MESSAGE, completion: LOGIN }
    t.dispatch({ origin: 'https://evil.example', source: popup, data: msg })
    expect(onReturn).not.toHaveBeenCalled()
    t.dispatch({ origin: ORIGIN, source: popup, data: msg })
    t.dispatch({ origin: ORIGIN, source: popup, data: msg })
    expect(onReturn).toHaveBeenCalledTimes(1)
    expect(onReturn).toHaveBeenCalledWith(LOGIN)
    expect(popup.postMessage).toHaveBeenCalledWith({ type: SSO_POPUP_ACK }, ORIGIN)
    expect(t.listeners.size).toBe(0)
  })

  it('takes a "done" signal on the same-origin channel when the opener reference is gone, and acks it there', () => {
    const popup = fakeWindow()
    const ch = fakeChannel()
    const onDone = vi.fn()
    watchSsoPopup(popup, { onReturn: vi.fn(), onDone }, target() as never, { channel: ch })
    ch.deliver({ type: 'something-else' })
    ch.deliver({ type: SSO_POPUP_DONE, target: 'login', token: 'leak' })
    expect(onDone).not.toHaveBeenCalled() // a signal never carries a token
    ch.deliver({ type: SSO_POPUP_DONE, target: 'profile', query: 'linked=auth-oidc%2Fa' })
    expect(onDone).toHaveBeenCalledWith({ target: 'profile', query: 'linked=auth-oidc%2Fa' })
    expect(ch.posted).toContainEqual({ type: SSO_POPUP_DONE_ACK })
    ch.deliver({ type: SSO_POPUP_DONE, target: 'login' })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('reports the popup closing — the only signal a cross-origin finish leaves the opener', () => {
    const popup = { postMessage: vi.fn(), closed: false } as unknown as Window & { closed: boolean }
    const ticks: Array<() => void> = []
    const onClosed = vi.fn()
    const stop = watchSsoPopup(popup, { onReturn: vi.fn(), onClosed }, target() as never, {
      channel: null,
      setInterval: (fn) => {
        ticks.push(fn)
        return 1
      },
      clearInterval: vi.fn(),
    })
    ticks[0]?.()
    expect(onClosed).not.toHaveBeenCalled()
    popup.closed = true
    ticks[0]?.()
    ticks[0]?.()
    expect(onClosed).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('deliverPopupCompletion — the popup side', () => {
  function env(opener: Window | null, channel: FakeChannel | null = null) {
    const listeners = new Set<(e: MessageEvent) => void>()
    const timers: Array<() => void> = []
    const e: PopupCompletionEnv & {
      dispatch(m: Partial<MessageEvent>): void
      fireTimers(): void
    } = {
      opener,
      origin: ORIGIN,
      channel,
      addEventListener: (_t, l) => listeners.add(l),
      removeEventListener: (_t, l) => listeners.delete(l),
      close: vi.fn(),
      continueAt: vi.fn(),
      persistSession: vi.fn(async () => undefined),
      showResult: vi.fn(),
      setTimeout: vi.fn((fn: () => void, ms: number) => {
        expect(ms).toBe(SSO_POPUP_ACK_TIMEOUT_MS)
        timers.push(fn)
      }),
      dispatch(m) {
        for (const l of [...listeners]) l(m as MessageEvent)
      },
      fireTimers() {
        for (const t of timers.splice(0)) t()
      },
    }
    return e
  }
  const LINKED = { target: 'profile', query: 'linked=auth-oidc%2Fa' } as const
  const LINK_FAILED = { target: 'profile', query: 'linkError=session' } as const

  it('posts to a same-origin opener at its OWN origin only, then closes on the ack', async () => {
    const opener = fakeWindow()
    const e = env(opener)
    const done = deliverPopupCompletion(LOGIN, e)
    await flush()
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: SSO_POPUP_MESSAGE, completion: LOGIN },
      ORIGIN,
    )
    e.dispatch({ origin: 'https://evil.example', source: opener, data: { type: SSO_POPUP_ACK } })
    await flush()
    expect(e.close).not.toHaveBeenCalled()
    e.dispatch({ origin: ORIGIN, source: opener, data: { type: SSO_POPUP_ACK } })
    await done
    expect(e.close).toHaveBeenCalledTimes(1)
    e.fireTimers()
    expect(e.continueAt).not.toHaveBeenCalled()
  })

  it('a link that finished on ANOTHER origin than its opener closes the popup (the opener sees it close)', async () => {
    const opener = crossOriginWindow()
    const e = env(opener, fakeChannel())
    const done = deliverPopupCompletion(LINKED, e)
    await flush()
    // Nothing is posted to a window at another origin.
    expect(opener.postMessage).not.toHaveBeenCalled()
    e.fireTimers()
    await done
    expect(e.close).toHaveBeenCalledTimes(1)
    expect(e.continueAt).not.toHaveBeenCalled()
  })

  it('a FAILED link on another origin shows why, and leaves closing to the user', async () => {
    const e = env(crossOriginWindow(), fakeChannel())
    const done = deliverPopupCompletion(LINK_FAILED, e)
    await flush()
    e.fireTimers()
    await done
    expect(e.close).not.toHaveBeenCalled()
    expect(e.continueAt).not.toHaveBeenCalled()
    expect(e.showResult).toHaveBeenCalledWith({ kind: 'link-error', message: expect.any(String) })
  })

  it('opener reference gone (COOP), same origin: the link outcome goes on the channel; the ack closes', async () => {
    const ch = fakeChannel()
    const e = env(null, ch)
    const done = deliverPopupCompletion(LINKED, e)
    await flush()
    expect(ch.posted).toEqual([
      { type: SSO_POPUP_DONE, target: 'profile', query: 'linked=auth-oidc%2Fa' },
    ])
    ch.deliver({ type: SSO_POPUP_DONE_ACK })
    await done
    expect(e.close).toHaveBeenCalledTimes(1)
    e.fireTimers()
    expect(e.continueAt).not.toHaveBeenCalled()
  })

  it('opener reference gone, login: the popup keeps the session at its own origin and signals "done" WITHOUT the token', async () => {
    const ch = fakeChannel()
    const e = env(null, ch)
    const done = deliverPopupCompletion(LOGIN, e)
    await flush()
    expect(e.persistSession).toHaveBeenCalledWith('abc.def.ghi')
    expect(ch.posted).toEqual([{ type: SSO_POPUP_DONE, target: 'login' }])
    expect(JSON.stringify(ch.posted)).not.toContain('abc.def.ghi')
    ch.deliver({ type: SSO_POPUP_DONE_ACK })
    await done
    expect(e.close).toHaveBeenCalledTimes(1)
  })

  it('a login challenge (2FA) is never put on the channel: nobody to take it = the full-page return', async () => {
    const ch = fakeChannel()
    const e = env(null, ch)
    await deliverPopupCompletion({ target: 'login', fragment: 'challenge=c.h.t&factors=totp' }, e)
    expect(ch.posted).toEqual([])
    expect(e.continueAt).toHaveBeenCalledWith('/login#challenge=c.h.t&factors=totp')
  })

  it('continues as a full-page return when nobody takes the outcome', async () => {
    const e = env(null, fakeChannel())
    const done = deliverPopupCompletion(LOGIN, e)
    await flush()
    e.fireTimers()
    await done
    expect(e.continueAt).toHaveBeenCalledWith('/login#token=abc.def.ghi&provider=auth-oidc%2Fa')
    const closedOpener = { ...fakeWindow(), closed: true } as unknown as Window
    const e2 = env(closedOpener, null)
    await deliverPopupCompletion(LINKED, e2)
    expect(closedOpener.postMessage).not.toHaveBeenCalled()
    expect(e2.continueAt).toHaveBeenCalledWith('/system/my-access?linked=auth-oidc%2Fa')
  })

  it('a same-origin opener that never acks: a successful link still closes the popup', async () => {
    const e = env(fakeWindow(), fakeChannel())
    const done = deliverPopupCompletion(LINKED, e)
    await flush()
    e.fireTimers() // postMessage ack window
    await flush()
    e.fireTimers() // channel ack window
    await done
    expect(e.close).toHaveBeenCalledTimes(1)
    expect(e.continueAt).not.toHaveBeenCalled()
  })

  it('isOpenerAck checks window, origin and type', () => {
    const opener = fakeWindow()
    const ack = { type: SSO_POPUP_ACK }
    expect(isOpenerAck({ origin: ORIGIN, source: opener, data: ack }, opener, ORIGIN)).toBe(true)
    expect(isOpenerAck({ origin: ORIGIN, source: fakeWindow(), data: ack }, opener, ORIGIN)).toBe(
      false,
    )
    expect(
      isOpenerAck({ origin: ORIGIN, source: opener, data: { type: 'x' } }, opener, ORIGIN),
    ).toBe(false)
  })

  it('readableOrigin: a cross-origin window reads as null', () => {
    expect(readableOrigin(fakeWindow())).toBe(ORIGIN)
    expect(readableOrigin(crossOriginWindow())).toBeNull()
  })
})

describe('isSsoCompletePath', () => {
  it('matches the completion route at the root or under the mount', () => {
    expect(isSsoCompletePath('/sso-complete', '')).toBe(true)
    expect(isSsoCompletePath('/sso-complete/', '')).toBe(true)
    expect(isSsoCompletePath('/api/camstack/p/g/sso-complete', '/api/camstack/p/g')).toBe(true)
    expect(isSsoCompletePath('/login', '')).toBe(false)
    expect(isSsoCompletePath('/sso-complete-x', '')).toBe(false)
  })
})
