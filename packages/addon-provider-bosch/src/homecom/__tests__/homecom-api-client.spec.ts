import { describe, expect, it } from 'vitest'
import { createInMemoryHomeComApiClient, HomeComAuthError } from '../homecom-api-client.js'

describe('createInMemoryHomeComApiClient', () => {
  it('refreshTokens returns new tokens when valid', async () => {
    const client = createInMemoryHomeComApiClient({
      snapshot: {
        gateway: { gatewayId: 'g1', name: 'K40', model: 'K40' },
        circuits: [],
        dhw: null,
      },
    })
    const tokens = await client.refreshTokens()
    expect(tokens.token).toBe('new-access')
  })

  it('setCircuitSetpoint records mutation and updates snapshot', async () => {
    const client = createInMemoryHomeComApiClient({
      snapshot: {
        gateway: { gatewayId: 'g1', name: 'K40', model: 'K40' },
        circuits: [
          {
            id: '0',
            name: 'HC1',
            operationMode: 'Heat',
            setpoint: 20,
            currentRoomTemp: 19,
            minTemp: 5,
            maxTemp: 30,
          },
        ],
        dhw: null,
      },
    })
    await client.setCircuitSetpoint('0', 23)
    expect(client.mutations.some((m) => m.path.includes('setpoint'))).toBe(true)
    const snap = await client.fetchSystem()
    expect(snap.circuits[0]?.setpoint).toBe(23)
  })

  it('refreshTokens throws HomeComAuthError when tokens invalid', async () => {
    const client = createInMemoryHomeComApiClient({
      snapshot: {
        gateway: { gatewayId: 'g1', name: 'K40', model: 'K40' },
        circuits: [],
        dhw: null,
      },
      tokensValid: false,
    })
    await expect(client.refreshTokens()).rejects.toBeInstanceOf(HomeComAuthError)
  })
})
