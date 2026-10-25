import { describe, expect, it } from 'vitest'

import {
  canDeleteDevice,
  canRevokeDevice,
  countdown,
  describeMeshRenewal,
  expiryTone,
  httpsRenewPolicy,
  type HttpsNodeRow,
} from '../certificate-model'

const served = (isHub: boolean, mode: 'generated' | 'uploaded' | 'disabled', online = true) =>
  ({
    nodeId: isHub ? 'hub' : 'agent-1',
    isHub,
    online,
    https: {
      kind: 'served',
      status: {
        mode,
        leafFingerprintSha256: 'AA',
        caFingerprintSha256: null,
        validTo: null,
        sans: [],
        reissueError: null,
        restartRequired: false,
      },
    },
  }) satisfies HttpsNodeRow

describe('httpsRenewPolicy', () => {
  it('refuses an operator-uploaded certificate on the hub, and says why', () => {
    const policy = httpsRenewPolicy(served(true, 'uploaded'))
    expect(policy.allowed).toBe(false)
    expect(policy.reason).toContain('uploaded')
  })
  it('allows a generated hub certificate and an agent', () => {
    expect(httpsRenewPolicy(served(true, 'generated')).allowed).toBe(true)
    expect(httpsRenewPolicy(served(false, 'generated')).allowed).toBe(true)
  })
  it('refuses an offline node', () => {
    expect(httpsRenewPolicy(served(false, 'generated', false)).allowed).toBe(false)
  })
})

describe('device row rules', () => {
  it('deletes only revoked rows and revokes only live ones', () => {
    expect(canDeleteDevice({ status: 'revoked' })).toBe(true)
    expect(canDeleteDevice({ status: 'active' })).toBe(false)
    expect(canDeleteDevice({ status: 'expired' })).toBe(false)
    expect(canRevokeDevice({ status: 'revoked' })).toBe(false)
    expect(canRevokeDevice({ status: 'expired' })).toBe(true)
  })
})

describe('describeMeshRenewal', () => {
  it('names the stage and whether the previous leaf was kept', () => {
    const out = describeMeshRenewal({
      ok: false,
      nodeId: 'agent-1',
      stage: 'reconnect',
      reason: 'timed out',
      keptPreviousLeaf: true,
    })
    expect(out.tone).toBe('danger')
    expect(out.message).toContain('waiting for the node to reconnect')
    expect(out.message).toContain('timed out')
    expect(out.message).toContain('previous certificate')
  })
})

describe('time helpers', () => {
  it('counts down and clamps at zero', () => {
    expect(countdown(10 * 60_000, 0)).toEqual({ expired: false, label: '10:00' })
    expect(countdown(1000, 5000)).toEqual({ expired: true, label: '0:00' })
  })
  it('flags leaves close to expiry', () => {
    const now = 0
    expect(expiryTone(10 * 86_400_000, now)).toBe('soon')
    expect(expiryTone(-1, now)).toBe('expired')
    expect(expiryTone(90 * 86_400_000, now)).toBe('ok')
    expect(expiryTone(null, now)).toBe('unknown')
  })
})
