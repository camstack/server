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
