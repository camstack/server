import { describe, it, expect } from 'vitest'
import { isTransientNetworkError } from '../commands/deploy.js'

describe('isTransientNetworkError', () => {
  it('treats hub-bounce network errors as transient (retryable)', () => {
    for (const m of [
      'fetch failed',
      'request to https://host failed, reason: connect ECONNREFUSED 127.0.0.1:4443',
      'socket hang up',
      'read ECONNRESET',
      'The operation timed out',
      'getaddrinfo ENOTFOUND host',
    ]) {
      expect(isTransientNetworkError(new Error(m)), m).toBe(true)
    }
  })

  it('unwraps a transient cause', () => {
    const err = new Error('upload failed', { cause: new Error('fetch failed') })
    expect(isTransientNetworkError(err)).toBe(true)
  })

  it('does NOT retry real server rejections or non-errors', () => {
    expect(isTransientNetworkError(new Error('Server returned 400 Bad Request'))).toBe(false)
    expect(isTransientNetworkError(new Error('addon validation failed: missing capability'))).toBe(
      false,
    )
    expect(isTransientNetworkError('fetch failed')).toBe(false) // not an Error instance
    expect(isTransientNetworkError(undefined)).toBe(false)
  })
})
