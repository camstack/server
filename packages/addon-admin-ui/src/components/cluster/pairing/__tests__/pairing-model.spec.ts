import { describe, expect, it } from 'vitest'

import {
  canConfirm,
  formatCountdown,
  formatEndpoint,
  isTerminalPairing,
  pairingPhase,
  sanitizeCodeInput,
  shortFingerprint,
  type PairingView,
} from '../pairing-model'

function view(over: Partial<PairingView>): PairingView {
  return {
    pairingId: 'p1',
    nodeId: 'agent-1',
    endpoint: { host: '192.0.2.10', port: 4444 },
    code: '123456',
    state: 'awaiting-confirmation',
    hubConfirmed: false,
    agentConfirmed: false,
    expiresAt: 0,
    failure: null,
    ...over,
  }
}

describe('pairing model', () => {
  it('keeps only up to six digits of what is typed', () => {
    expect(sanitizeCodeInput('12a3 45-678')).toBe('123456')
    expect(sanitizeCodeInput('')).toBe('')
  })

  it('formats the countdown and never goes negative', () => {
    expect(formatCountdown(300_000, 0)).toBe('5:00')
    expect(formatCountdown(61_000, 0)).toBe('1:01')
    expect(formatCountdown(1_000, 5_000)).toBe('0:00')
  })

  it('brackets an IPv6 endpoint', () => {
    expect(formatEndpoint('192.0.2.1', 4444)).toBe('192.0.2.1:4444')
    expect(formatEndpoint('fd00::1', 4444)).toBe('[fd00::1]:4444')
  })

  it('shortens only long fingerprints', () => {
    expect(shortFingerprint('AB:CD')).toBe('AB:CD')
    expect(shortFingerprint('A'.repeat(64))).toHaveLength(21)
  })

  it('derives the phase from the answered view only', () => {
    expect(pairingPhase({ view: null, beginError: null })).toBe('sending')
    expect(pairingPhase({ view: null, beginError: 'boom' })).toBe('send-failed')
    expect(pairingPhase({ view: view({}), beginError: null })).toBe('awaiting-both')
    expect(pairingPhase({ view: view({ hubConfirmed: true }), beginError: null })).toBe(
      'awaiting-agent',
    )
    expect(pairingPhase({ view: view({ agentConfirmed: true }), beginError: null })).toBe(
      'awaiting-hub',
    )
    expect(pairingPhase({ view: view({ state: 'completing' }), beginError: null })).toBe(
      'completing',
    )
    expect(pairingPhase({ view: view({ state: 'expired' }), beginError: null })).toBe('expired')
  })

  it('lets the operator confirm only while a code can still be accepted', () => {
    expect(canConfirm('awaiting-both')).toBe(true)
    expect(canConfirm('awaiting-hub')).toBe(true)
    expect(canConfirm('awaiting-agent')).toBe(false)
    expect(canConfirm('completing')).toBe(false)
    expect(canConfirm('paired')).toBe(false)
  })

  it('knows the final states', () => {
    for (const s of ['paired', 'rejected', 'failed', 'expired'] as const) {
      expect(isTerminalPairing(s)).toBe(true)
    }
    expect(isTerminalPairing('awaiting-confirmation')).toBe(false)
    expect(isTerminalPairing('completing')).toBe(false)
  })
})
