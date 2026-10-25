import { describe, it, expect } from 'vitest'
import { isAuthorizedHealthRequest } from '../health.routes.js'

const verify = (token: string): unknown => {
  if (token === 'valid-session') return { userId: 'u1', isAdmin: true }
  if (token === 'challenge') return { userId: 'u1', isAdmin: false, kind: 'totp-challenge' }
  throw new Error('invalid token')
}

describe('isAuthorizedHealthRequest', () => {
  it('accepts a valid session Bearer', () => {
    expect(isAuthorizedHealthRequest({ authorization: 'Bearer valid-session' }, verify)).toBe(true)
  })

  it('accepts a valid session cookie', () => {
    expect(isAuthorizedHealthRequest({ cookie: 'camstack_session=valid-session' }, verify)).toBe(
      true,
    )
  })

  it('rejects anonymous, invalid, and kind-tagged challenge tokens', () => {
    expect(isAuthorizedHealthRequest({}, verify)).toBe(false)
    expect(isAuthorizedHealthRequest({ authorization: 'Bearer nope' }, verify)).toBe(false)
    expect(isAuthorizedHealthRequest({ authorization: 'Bearer challenge' }, verify)).toBe(false)
    expect(isAuthorizedHealthRequest({ cookie: 'camstack_session=challenge' }, verify)).toBe(false)
  })

  it('falls through a bad Bearer to a good cookie', () => {
    expect(
      isAuthorizedHealthRequest(
        { authorization: 'Bearer nope', cookie: 'camstack_session=valid-session' },
        verify,
      ),
    ).toBe(true)
  })
})
