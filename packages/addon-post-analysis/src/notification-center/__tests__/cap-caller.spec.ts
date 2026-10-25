import { describe, expect, it } from 'vitest'
import { requireCapCaller } from '../cap-caller.js'

/**
 * The incident these pin: `notification-rules.listSnoozes` declares
 * `caller: 'required'`, the export addon reads it once per reconcile pass, and
 * an addon has no authenticated user. The cap's own docblock promises the
 * router "fails the call with UNAUTHORIZED" in that case; on the addon→addon
 * path it does not, so the provider dereferenced `undefined` and the operator
 * got `Cannot read properties of undefined (reading 'userId')` ~140 times an
 * hour, naming neither the method nor the reason.
 */
describe('requireCapCaller', () => {
  it('refuses a caller-less call with a message that names the method and the reason', () => {
    expect(() => requireCapCaller('listSnoozes', undefined)).toThrow(
      /notification-rules\.listSnoozes declares caller: 'required'/,
    )
    expect(() => requireCapCaller('listSnoozes', undefined)).toThrow(
      /addon-to-addon cap call has no authenticated user/,
    )
  })

  it('never throws the message the operator actually saw', () => {
    let message = ''
    try {
      requireCapCaller('listSnoozes', undefined)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).not.toMatch(/Cannot read properties of undefined/)
  })

  it('names the method it was asked about, not a fixed one', () => {
    expect(() => requireCapCaller('cancelSnooze', undefined)).toThrow(
      /notification-rules\.cancelSnooze/,
    )
  })

  it('passes a real caller straight through', () => {
    const caller = { userId: 'u1', isAdmin: false }
    expect(requireCapCaller('listSnoozes', caller)).toBe(caller)
  })

  it('treats an empty userId as no identity — a blank is not a user', () => {
    expect(() => requireCapCaller('listSnoozes', { userId: '', isAdmin: true })).toThrow(
      /carried no caller identity/,
    )
  })
})
