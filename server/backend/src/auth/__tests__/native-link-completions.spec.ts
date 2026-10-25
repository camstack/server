import { describe, expect, it } from 'vitest'
import { NativeLinkCompletions } from '../native-link-completions.js'

/** D801 — a native link waits for the app under a one-time, short-lived code. */
const LINK = { userId: 'u-alice', provider: 'auth-oidc/a', subject: 's-1', issuer: 'https://idp/' }

describe('NativeLinkCompletions', () => {
  it('claims once, then never again', () => {
    const store = new NativeLinkCompletions()
    const code = store.park(LINK)
    expect(code).toMatch(/^nlc_[A-Za-z0-9_-]{40,}$/)
    expect(code).not.toContain('u-alice')
    expect(store.claim(code)).toEqual(LINK)
    expect(store.claim(code)).toBeNull()
  })

  it('an expired code claims nothing — and is gone', () => {
    let now = 0
    const store = new NativeLinkCompletions({ now: () => now, ttlMs: 60_000 })
    const code = store.park(LINK)
    now = 60_000
    expect(store.claim(code)).toBeNull()
  })

  it('an unknown code claims nothing', () => {
    expect(new NativeLinkCompletions().claim('nlc_nope')).toBeNull()
  })
})
