import { describe, it, expect } from 'vitest'
import { shouldRedirectToLogin } from '../auth/session-cookie.js'

describe('shouldRedirectToLogin', () => {
  it('true for an HTML GET with no credentials', () => {
    expect(shouldRedirectToLogin('GET', 'text/html,application/xhtml+xml')).toBe(true)
  })
  it('false for a non-GET', () => {
    expect(shouldRedirectToLogin('POST', 'text/html')).toBe(false)
  })
  it('false for an API GET (JSON accept)', () => {
    expect(shouldRedirectToLogin('GET', 'application/json')).toBe(false)
  })
  it('false when Accept is absent', () => {
    expect(shouldRedirectToLogin('GET', undefined)).toBe(false)
  })
})
