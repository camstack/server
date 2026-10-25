import { describe, expect, it, vi } from 'vitest'
import { buildHomeConnectConnectionTestProvider } from '../home-connect-connection-test.js'
import type { LoginFetch, LoginHttpResponse } from '../home-connect-login.js'

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

function jsonResponse(status: number, body: string): LoginHttpResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => body,
  }
}

function accessToken(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `e30.${payload}.sig`
}

const accountFetch: LoginFetch = async (url) => {
  if (url.includes('/paired-appliances')) {
    return jsonResponse(
      200,
      JSON.stringify({
        appliances: [{ haId: 'HAI-A', brand: 'BOSCH', haType: 'Dishwasher', vib: 'Sala' }],
      }),
    )
  }
  if (url.includes('/encryption-information')) {
    return jsonResponse(200, JSON.stringify({ aes: { key: 'k', iv: 'i' } }))
  }
  return jsonResponse(404, '{}')
}

describe('Home Connect connection-test', () => {
  it('validates the account token and reports the appliances', async () => {
    const provider = buildHomeConnectConnectionTestProvider({
      logger: logger() as never,
      fetchImpl: accountFetch,
    })
    const outcome = await provider.testSettings({
      settings: { token: accessToken('acct-1'), refresh: 'refresh-1' },
    })
    expect(outcome.outcome).toBe('validated')
    if (outcome.outcome === 'validated') expect(outcome.detail).toContain('Sala')
  })

  it('rejects incomplete settings', async () => {
    const provider = buildHomeConnectConnectionTestProvider({ logger: logger() as never })
    const outcome = await provider.testSettings({ settings: {} })
    expect(outcome.outcome).toBe('rejected')
  })

  it('rejects a token Home Connect will not accept', async () => {
    const provider = buildHomeConnectConnectionTestProvider({
      logger: logger() as never,
      fetchImpl: async () => jsonResponse(401, '{}'),
    })
    const outcome = await provider.testSettings({
      settings: { token: 'stale', refresh: 'also-stale' },
    })
    expect(outcome.outcome).toBe('rejected')
  })
})
