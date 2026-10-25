/**
 * Session-decode read refusals after teardown are NOT inference faults (D656).
 * Live Mac bursts (frameId 1–8) logged them as `runInference failed`.
 */
import { describe, expect, it } from 'vitest'
import {
  SessionDecodeReadRefusedError,
  TO_BUFFER_REFUSED_EXITED,
  TO_BUFFER_REFUSED_KILLED,
} from '../session-decode-coordinator.js'
import { isSessionDecodeReadGone } from '../session-decode-read-gone.js'

describe('isSessionDecodeReadGone', () => {
  it('names SessionDecodeReadRefusedError', () => {
    expect(
      isSessionDecodeReadGone(new SessionDecodeReadRefusedError(TO_BUFFER_REFUSED_EXITED, 7)),
    ).toBe(true)
    expect(
      isSessionDecodeReadGone(new SessionDecodeReadRefusedError(TO_BUFFER_REFUSED_KILLED, 2)),
    ).toBe(true)
  })

  it('matches the in-flight exit rejection and a local frameRef miss', () => {
    expect(
      isSessionDecodeReadGone(
        new Error('session-decode-coordinator: worker exited before toBuffer reply'),
      ),
    ).toBe(true)
    expect(isSessionDecodeReadGone(new Error('local frameRef miss: stale-ref'))).toBe(true)
  })

  it('leaves real pool faults alone', () => {
    expect(isSessionDecodeReadGone(new Error('Python pool returned unexpected kind'))).toBe(false)
  })
})
