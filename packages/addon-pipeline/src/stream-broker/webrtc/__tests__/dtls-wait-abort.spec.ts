import { describe, it, expect } from 'vitest'
import { dtlsWaitAbortReason } from '../session'

describe('dtlsWaitAbortReason (planning#730)', () => {
  it('stops the pre-DTLS wait when the peer is closed or failed', () => {
    expect(dtlsWaitAbortReason('closed', 'checking')).toBe('peer-closed')
    expect(dtlsWaitAbortReason('connecting', 'closed')).toBe('peer-closed')
    expect(dtlsWaitAbortReason('failed', 'checking')).toBe('peer-failed')
  })
  it('keeps waiting while the peer is still negotiating', () => {
    expect(dtlsWaitAbortReason('connecting', 'checking')).toBeNull()
    expect(dtlsWaitAbortReason(undefined, undefined)).toBeNull()
  })
})
