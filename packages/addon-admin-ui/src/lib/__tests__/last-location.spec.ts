// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveLoginRestorePath, saveLastLocation } from '../last-location'

/**
 * Where a sign-in lands. The page ProtectedRoute interrupted (`state.from`)
 * used to be restored verbatim — so a session that ended ON the change-password
 * page sent the operator straight back to it after signing in with his new
 * password, and he changed it again, and was signed out again: a loop.
 */
describe('resolveLoginRestorePath', () => {
  beforeEach(() => window.localStorage.clear())

  it('restores an ordinary interrupted page', () => {
    expect(resolveLoginRestorePath('/cameras/12?tab=events')).toBe('/cameras/12?tab=events')
  })

  it('never restores the change-password page — the last visit, else devices', () => {
    expect(resolveLoginRestorePath('/change-password')).toBe('/devices')
    saveLastLocation('/storage')
    expect(resolveLoginRestorePath('/change-password')).toBe('/storage')
  })

  it('never restores the login page itself nor a scheme-relative url', () => {
    expect(resolveLoginRestorePath('/login')).toBe('/devices')
    expect(resolveLoginRestorePath('//evil.example.com')).toBe('/devices')
  })

  it('no interrupted page: the last visit, else devices', () => {
    expect(resolveLoginRestorePath(undefined)).toBe('/devices')
    saveLastLocation('/storage')
    expect(resolveLoginRestorePath(undefined)).toBe('/storage')
  })
})
