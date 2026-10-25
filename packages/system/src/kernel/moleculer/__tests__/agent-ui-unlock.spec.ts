import { describe, expect, it } from 'vitest'
import { generateMeshCa } from '../mesh-mtls/mesh-ca.js'
import {
  AGENT_UI_UNLOCK_TTL_MS,
  isAllowedAgentDashboardReturnTo,
  isKnownAgentAddress,
  mintAgentUiUnlockTicket,
  parseAgentDashboardOrigins,
  UnlockTicketJtiStore,
  verifyAgentUiUnlockTicket,
} from '../agent-ui-unlock.js'
import { sign } from 'node:crypto'

describe('agent-ui unlock tickets (D821, ES256 by the mesh CA, D857)', () => {
  it('mints a ticket the agent verifies with its pinned CA for the same nodeId', async () => {
    const ca = await generateMeshCa()
    const ticket = mintAgentUiUnlockTicket({
      caKeyPem: ca.keyPem,
      nodeId: 'agent-a',
      nowMs: 1_000_000,
      jti: 'jti-1',
    })
    const payload = verifyAgentUiUnlockTicket(ca.certPem, ticket, {
      expectedNodeId: 'agent-a',
      nowMs: 1_000_000,
    })
    expect(payload).toEqual({
      v: 1,
      nodeId: 'agent-a',
      iat: 1_000_000,
      exp: 1_000_000 + AGENT_UI_UNLOCK_TTL_MS,
      jti: 'jti-1',
    })
  })

  it('refuses another CA, another node, expiry, a tampered payload and a mangled ticket', async () => {
    const ca = await generateMeshCa()
    const other = await generateMeshCa()
    const ticket = mintAgentUiUnlockTicket({
      caKeyPem: ca.keyPem,
      nodeId: 'agent-a',
      nowMs: 1_000_000,
    })
    const ok = { expectedNodeId: 'agent-a', nowMs: 1_000_000 }
    // The ticket verifies under the signing CA, so every refusal below is the check under test.
    expect(verifyAgentUiUnlockTicket(ca.certPem, ticket, ok)).not.toBeNull()
    expect(verifyAgentUiUnlockTicket(other.certPem, ticket, ok)).toBeNull()
    expect(verifyAgentUiUnlockTicket(ca.certPem, ticket, { ...ok, expectedNodeId: 'x' })).toBeNull()
    expect(
      verifyAgentUiUnlockTicket(ca.certPem, ticket, {
        ...ok,
        nowMs: 1_000_000 + AGENT_UI_UNLOCK_TTL_MS + 1,
      }),
    ).toBeNull()
    expect(verifyAgentUiUnlockTicket(ca.certPem, 'not-a-ticket', ok)).toBeNull()
    const [h, p, sig] = ticket.split('.')
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(p ?? '', 'base64url').toString()),
        nodeId: 'evil',
      }),
    ).toString('base64url')
    expect(
      verifyAgentUiUnlockTicket(ca.certPem, `${h}.${forged}.${sig}`, {
        ...ok,
        expectedNodeId: 'evil',
      }),
    ).toBeNull()
  })

  it('a token of another kind signed by the same CA is not an unlock ticket', async () => {
    const ca = await generateMeshCa()
    const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
    const head = part({ alg: 'ES256', typ: 'camstack-pairing-proof' })
    const body = part({ sub: 'agent-a', exp: Math.floor(Date.now() / 1000) + 600 })
    const signature = sign('sha256', Buffer.from(`${head}.${body}`), {
      key: ca.keyPem,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    expect(
      verifyAgentUiUnlockTicket(ca.certPem, `${head}.${body}.${signature}`, {
        expectedNodeId: 'agent-a',
      }),
    ).toBeNull()
  })

  it('refuses a ticket issued before the agent booted, or in the future (L12)', async () => {
    const ca = await generateMeshCa()
    const ticket = mintAgentUiUnlockTicket({ caKeyPem: ca.keyPem, nodeId: 'n', nowMs: 1_000_000 })
    const at = { expectedNodeId: 'n', nowMs: 1_001_000 }
    expect(verifyAgentUiUnlockTicket(ca.certPem, ticket, at)).not.toBeNull()
    expect(
      verifyAgentUiUnlockTicket(ca.certPem, ticket, { ...at, notBeforeMs: 1_000_500 }),
    ).toBeNull()
    expect(verifyAgentUiUnlockTicket(ca.certPem, ticket, { ...at, nowMs: 900_000 })).toBeNull()
  })

  it('jti store is single-use until expiry', () => {
    const store = new UnlockTicketJtiStore()
    expect(store.consume('a', 2_000, 1_000)).toBe(true)
    expect(store.consume('a', 2_000, 1_000)).toBe(false)
    expect(store.consume('a', 2_000, 2_001)).toBe(true)
  })

  it('returnTo allowlist: :4444 and extra origins only', () => {
    expect(isAllowedAgentDashboardReturnTo('http://192.168.1.20:4444/')).toBe(true)
    expect(isAllowedAgentDashboardReturnTo('http://agent.lan:4444')).toBe(true)
    // A ticket never leaves the operator's own network (L10).
    expect(isAllowedAgentDashboardReturnTo('https://agent.example.com:4444')).toBe(false)
    expect(isAllowedAgentDashboardReturnTo('http://8.8.8.8:4444')).toBe(false)
    expect(isAllowedAgentDashboardReturnTo('http://192.168.1.20:4444/evil')).toBe(false)
    expect(isAllowedAgentDashboardReturnTo('http://evil.example/')).toBe(false)
    expect(
      isAllowedAgentDashboardReturnTo('https://agent.npm.local/', ['https://agent.npm.local']),
    ).toBe(true)
    expect(parseAgentDashboardOrigins('https://a.example, http://b.example:4444')).toEqual([
      'https://a.example',
      'http://b.example:4444',
    ])
  })

  it('returnTo must be an address the hub knows for THIS node, unless listed (#10)', () => {
    const known = ['agent-a', '192.168.1.20']
    expect(isKnownAgentAddress('http://192.168.1.20:4444/', known)).toBe(true)
    expect(isKnownAgentAddress('http://192.168.1.77:4444/', known)).toBe(false)
    expect(
      isKnownAgentAddress('http://192.168.1.77:4444/', known, ['http://192.168.1.77:4444']),
    ).toBe(true)
    expect(isKnownAgentAddress('http://192.168.1.77:4444/', null)).toBe(false)
  })
})
