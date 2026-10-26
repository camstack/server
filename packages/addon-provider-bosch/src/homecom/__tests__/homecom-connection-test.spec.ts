import { describe, expect, it, vi } from 'vitest'
import * as apiClientModule from '../homecom-api-client.js'
import { createInMemoryHomeComApiClient } from '../homecom-api-client.js'
import { buildHomeComConnectionTestProvider } from '../homecom-connection-test.js'

const emptySnapshot = {
  gateway: { gatewayId: 'gateway-k40', name: 'K40', model: 'K40' },
  circuits: [],
  dhw: null,
} as const

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

describe('HomeCom connection-test', () => {
  it('validates complete token settings when makeClient is injected', async () => {
    const provider = buildHomeComConnectionTestProvider({
      logger: logger() as never,
      makeClient: () =>
        createInMemoryHomeComApiClient({
          snapshot: emptySnapshot,
          tokensValid: true,
        }),
    })
    const outcome = await provider.testSettings({
      settings: {
        username: 'user@example.com',
        token: 'valid-access-token',
        refresh: 'valid-refresh-token',
        brand: 'bosch',
        region: 'eu',
      },
    })
    expect(outcome.outcome).toBe('validated')
  })

  it('rejects when injected client raises HomeComAuthError', async () => {
    const provider = buildHomeComConnectionTestProvider({
      logger: logger() as never,
      makeClient: () =>
        createInMemoryHomeComApiClient({
          snapshot: emptySnapshot,
          tokensValid: false,
        }),
    })
    const outcome = await provider.testSettings({
      settings: {
        username: 'user@example.com',
        token: 'short',
        refresh: 'valid-refresh-token',
        brand: 'bosch',
        region: 'eu',
      },
    })
    expect(outcome.outcome).toBe('rejected')
  })

  it('lists gateways when the saved gateway id is blank', async () => {
    const provider = buildHomeComConnectionTestProvider({
      logger: logger() as never,
      makeClient: () =>
        createInMemoryHomeComApiClient({
          snapshot: emptySnapshot,
          tokensValid: true,
        }),
    })
    const outcome = await provider.testSettings({
      settings: {
        username: 'user@example.com',
        token: 'valid-access-token',
        refresh: 'valid-refresh-token',
        brand: 'bosch',
        region: 'eu',
        gatewayId: '',
      },
    })
    expect(outcome.outcome).toBe('validated')
    if (outcome.outcome !== 'validated') {
      expect(outcome.error).not.toMatch(/settings incomplete/i)
    }
  })

  it('names an empty gateway list and a list that failed with a status', async () => {
    const empty = buildHomeComConnectionTestProvider({
      logger: logger() as never,
      makeClient: () => ({
        refreshTokens: async () => ({ token: 't', refresh: 'r' }),
        listGateways: async () => [],
        fetchSystem: async () => emptySnapshot,
        probeGateway: async () => ({ resource: '/gateway/DateTime', value: '2024-01-01T00:00:00' }),
        setCircuitSetpoint: async () => undefined,
        setCircuitMode: async () => undefined,
        setDhwTarget: async () => undefined,
        setDhwMode: async () => undefined,
        setFanMode: async () => undefined,
        setSwingVertical: async () => undefined,
        setSwingHorizontal: async () => undefined,
      }),
    })
    const none = await empty.testSettings({
      settings: {
        token: 'valid-access-token',
        refresh: 'valid-refresh-token',
        brand: 'bosch',
        region: 'eu',
      },
    })
    expect(none.outcome).toBe('rejected')
    if (none.outcome === 'rejected') {
      expect(none.error).toBe('This Bosch account has no HomeCom gateway.')
    }

    const failed = buildHomeComConnectionTestProvider({
      logger: logger() as never,
      makeClient: () => ({
        refreshTokens: async () => ({ token: 't', refresh: 'r' }),
        listGateways: async () => {
          throw new Error('The gateway list failed (HTTP 404).')
        },
        fetchSystem: async () => emptySnapshot,
        probeGateway: async () => ({ resource: '/gateway/DateTime', value: '2024-01-01T00:00:00' }),
        setCircuitSetpoint: async () => undefined,
        setCircuitMode: async () => undefined,
        setDhwTarget: async () => undefined,
        setDhwMode: async () => undefined,
        setFanMode: async () => undefined,
        setSwingVertical: async () => undefined,
        setSwingHorizontal: async () => undefined,
      }),
    })
    const listed = await failed.testSettings({
      settings: {
        token: 'valid-access-token',
        refresh: 'valid-refresh-token',
        brand: 'bosch',
        region: 'eu',
      },
    })
    expect(listed.outcome).toBe('rejected')
    if (listed.outcome === 'rejected') {
      expect(listed.error).toBe('The gateway list failed (HTTP 404).')
    }
  })

  it('uses createHomeComApiClient when makeClient is omitted', async () => {
    const createSpy = vi.spyOn(apiClientModule, 'createHomeComApiClient').mockReturnValue(
      createInMemoryHomeComApiClient({
        snapshot: emptySnapshot,
        tokensValid: true,
      }),
    )
    const provider = buildHomeComConnectionTestProvider({
      logger: logger() as never,
    })
    await provider.testSettings({
      settings: {
        username: 'user@example.com',
        token: 'valid-access-token',
        refresh: 'valid-refresh-token',
        brand: 'bosch',
        region: 'eu',
      },
    })
    // One client lists the account's gateways, the next reads the one it found.
    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(createSpy.mock.calls[0]?.[1]).toBe('')
    expect(createSpy.mock.calls[1]?.[1]).toBe('gateway-k40')
    createSpy.mockRestore()
  })
})
