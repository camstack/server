import { describe, expect, it } from 'vitest'
import { adminCredentialHint, adminRejectedHint, BROWSER_LOGIN_HINT } from '../login-hints.js'

describe('login hints', () => {
  it('both name the browser-approval login and the token-file fallback', () => {
    for (const hint of [
      adminRejectedHint('camstack login'),
      adminCredentialHint('camstack login'),
    ]) {
      expect(hint).toContain(BROWSER_LOGIN_HINT)
      expect(hint).toContain('--browser')
      expect(hint).toContain('--token-file')
    }
  })
})
