import { describe, expect, it } from 'vitest'
import { isRecoverableBaichuanError } from '../error-classifier'

describe('isRecoverableBaichuanError', () => {
  it('flags Baichuan socket closed errors as recoverable', () => {
    expect(isRecoverableBaichuanError(new Error('Baichuan socket closed (graceful)'))).toBe(true)
    expect(isRecoverableBaichuanError(new Error('Baichuan UDP stream closed'))).toBe(true)
    expect(isRecoverableBaichuanError(new Error('Baichuan TCP socket is not connected'))).toBe(true)
  })

  it('flags generic TCP storm errors as recoverable', () => {
    expect(isRecoverableBaichuanError(new Error('socket hang up'))).toBe(true)
    expect(isRecoverableBaichuanError(new Error('read ECONNRESET'))).toBe(true)
    expect(isRecoverableBaichuanError(new Error('write EPIPE'))).toBe(true)
  })

  it('flags D2C disconnects as recoverable', () => {
    expect(isRecoverableBaichuanError(new Error('UDP relay D2C_DISC packet'))).toBe(true)
  })

  it('treats unknown errors as non-recoverable', () => {
    expect(isRecoverableBaichuanError(new Error('Authentication failed'))).toBe(false)
    expect(isRecoverableBaichuanError(new Error('Invalid handshake'))).toBe(false)
  })

  it('handles non-Error inputs without throwing', () => {
    expect(isRecoverableBaichuanError(undefined)).toBe(false)
    expect(isRecoverableBaichuanError(null)).toBe(false)
    expect(isRecoverableBaichuanError('socket hang up')).toBe(true)
    expect(isRecoverableBaichuanError({ toString: () => 'ECONNRESET' })).toBe(true)
  })
})
