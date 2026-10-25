import { describe, expect, it } from 'vitest'
import { entityIndexFromDescription } from '../home-connect-device-description.js'
import { listedApplianceFromStored } from '../home-connect-stored-appliance.js'

describe('listedApplianceFromStored', () => {
  it('passes through persisted deviceDescription with entities', () => {
    const row = {
      haId: 'HAI-DW-1',
      name: 'Kitchen',
      type: 'Dishwasher',
      host: 'BOSCH-Dishwasher-HAI-DW-1',
      psk: 'psk',
      mode: 'TLS' as const,
      deviceDescription: {
        info: { deviceID: 'HAI-DW-1', deviceType: 'Dishwasher', model: 'Kitchen' },
        program: [],
        entities: {
          '552': { uid: 552, name: 'BSH.Common.Status.OperationState' },
        },
      },
    }
    const listed = listedApplianceFromStored(row)
    const index = entityIndexFromDescription(JSON.parse(listed.connection.deviceDescription))
    expect(index.get(552)?.name).toBe('BSH.Common.Status.OperationState')
  })
})
