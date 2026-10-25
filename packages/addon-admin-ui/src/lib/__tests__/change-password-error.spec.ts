import { describe, expect, it } from 'vitest'
import { classifyChangePasswordError } from '../change-password-error'

/**
 * The change-password page names WHY a change failed. A request whose socket
 * the hub closed under it reaches the client as a tRPC error with no `data`
 * and the message "Unknown error" — which is exactly what the operator saw
 * after the forced first-run change ended his own session.
 */

class FakeTrpcError extends Error {
  readonly data: unknown
  constructor(message: string, data: unknown) {
    super(message)
    this.data = data
  }
}

describe('classifyChangePasswordError', () => {
  it('a wrong current password is named by its stable code', () => {
    const err = new FakeTrpcError('La password non è corretta', {
      code: 'INTERNAL_SERVER_ERROR',
      i18n: { code: 'auth.password-incorrect' },
    })
    expect(classifyChangePasswordError(err)).toEqual({ kind: 'wrong-current' })
  })

  it('an UNAUTHORIZED answer means the session ended', () => {
    const err = new FakeTrpcError('UNAUTHORIZED', { code: 'UNAUTHORIZED' })
    expect(classifyChangePasswordError(err)).toEqual({ kind: 'session-ended' })
  })

  it('an error without a server payload is a lost connection, never "Unknown error"', () => {
    expect(classifyChangePasswordError(new FakeTrpcError('Unknown error', undefined))).toEqual({
      kind: 'connection-lost',
    })
    expect(classifyChangePasswordError(new Error('Unknown error'))).toEqual({
      kind: 'connection-lost',
    })
  })

  it('any other server refusal keeps the (already localized) server message', () => {
    const err = new FakeTrpcError('Password too short', { code: 'BAD_REQUEST' })
    expect(classifyChangePasswordError(err)).toEqual({
      kind: 'rejected',
      message: 'Password too short',
    })
  })

  it('a thrown non-error is a lost connection', () => {
    expect(classifyChangePasswordError('boom')).toEqual({ kind: 'connection-lost' })
  })
})
