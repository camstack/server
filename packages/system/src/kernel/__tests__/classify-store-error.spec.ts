/**
 * `classifyStoreError` decides whether a settings read that failed at boot is
 * worth retrying (a hub restarting under a booting runner). The errors it must
 * recognise are the REAL ones the transport raises - constructed here from the
 * real classes and the real socket-channel path, not from made-up messages:
 *
 *  - `UDS request timed out after Nms` (a plain Error, no code),
 *  - Moleculer `RequestTimeoutError` (code is the NUMBER 504),
 *  - Moleculer `ServiceNotFoundError` / `ServiceNotAvailableError`.
 * A peer that ANSWERED with an error, and a plain bug, are permanent.
 */
import { Socket } from 'node:net'
import { Errors } from 'moleculer'
import { classifyStoreError } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeerAnsweredError } from '../transport/peer-answered-error.js'
import { SocketChannel } from '../transport/socket-channel.js'

describe('classifyStoreError on the real transport errors', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the real SocketChannel timeout is transport', async () => {
    const a = new Socket()
    ;(a as unknown as { write: () => boolean }).write = () => true
    const channel = new SocketChannel(a)
    const request = channel.request({ ping: 1 }, { timeoutMs: 100 })
    const outcome = request.catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(200)
    const err = await outcome
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/UDS request timed out after 100ms/)
    expect(classifyStoreError(err)).toBe('transport')
  })

  it('the real closed-channel rejection is transport', async () => {
    const a = new Socket()
    ;(a as unknown as { write: () => boolean }).write = () => true
    const channel = new SocketChannel(a)
    a.emit('close')
    const err = await channel.request({}).catch((e: unknown) => e)
    expect(classifyStoreError(err)).toBe('transport')
  })

  it('Moleculer RequestTimeoutError (numeric code 504) is transport', () => {
    const err = new Errors.RequestTimeoutError({ action: 'settings-store.get', nodeID: 'hub' })
    expect(typeof err.code).toBe('number')
    expect(classifyStoreError(err)).toBe('transport')
  })

  it('Moleculer ServiceNotFound / ServiceNotAvailable are transport', () => {
    expect(
      classifyStoreError(new Errors.ServiceNotFoundError({ action: 'settings-store.get' })),
    ).toBe('transport')
    expect(
      classifyStoreError(new Errors.ServiceNotAvailableError({ action: 'settings-store.get' })),
    ).toBe('transport')
  })

  it('DISARM: a peer that ANSWERED with an error, a bug and a wiring fault are permanent', () => {
    expect(classifyStoreError(new PeerAnsweredError('device not routable'))).toBe('permanent')
    expect(classifyStoreError(new TypeError('x is not a function'))).toBe('permanent')
    expect(classifyStoreError(new Error('settings store not wired'))).toBe('permanent')
    expect(classifyStoreError(new Error('timed out waiting for the operator'))).toBe('permanent')
    // a Moleculer error that is NOT retryable (validation) stays permanent
    expect(classifyStoreError(new Errors.ValidationError('bad input'))).toBe('permanent')
  })
})
