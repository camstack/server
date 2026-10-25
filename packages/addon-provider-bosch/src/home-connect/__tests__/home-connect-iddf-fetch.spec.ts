import { describe, expect, it } from 'vitest'
import { entityIndexFromDescription } from '../home-connect-device-description.js'
import { buildStoreZip } from '../home-connect-iddf.js'
import {
  enrichHomeConnectConnection,
  entityCountInStoredDescription,
} from '../home-connect-iddf-fetch.js'
import type { LoginFetch } from '../home-connect-login.js'

describe('enrichHomeConnectConnection', () => {
  it('does not throw when IDDF fetch returns 404, and does not decode with another model', async () => {
    const fetchImpl: LoginFetch = async () => ({
      status: 404,
      headers: { get: () => null },
      text: async () => '',
    })
    const base = {
      token: 'tok',
      appliances: [
        {
          haId: 'HAI-TLS',
          name: 'DW',
          type: 'Dishwasher',
          host: 'BOSCH-Dishwasher-HAI-TLS',
          psk: 'psk',
          mode: 'TLS' as const,
        },
      ],
    }
    let warnMessage = ''
    let warnMeta: Record<string, unknown> = {}
    const { connection, changed, missing } = await enrichHomeConnectConnection(base, fetchImpl, {
      onWarn: (message, meta) => {
        warnMessage = message
        warnMeta = meta
      },
    })
    expect(changed).toBe(false)
    expect(missing).toEqual(['HAI-TLS'])
    expect(warnMessage).toContain('degraded')
    expect(warnMeta).toMatchObject({
      haId: 'HAI-TLS',
      reason: 'http-error',
      status: 404,
    })
    expect(entityCountInStoredDescription(connection.appliances?.[0]?.deviceDescription)).toBe(0)
  })

  it('fills TLS appliance deviceDescription from IDDF zip', async () => {
    const zip = buildStoreZip({
      'appliance_DeviceDescription.xml':
        '<device><description><type>Dishwasher</type><model>M</model></description><status uid="228" refCID="01" refDID="00"/></device>',
      'appliance_FeatureMapping.xml':
        '<featureMappingFile><featureDescription><feature refUID="228">BSH.Common.Status.OperationState</feature></featureDescription><errorDescription/><enumDescriptionList/></featureMappingFile>',
    })
    const fetchImpl: LoginFetch = async (url) => ({
      status: url.includes('HAI-TLS') ? 200 : 404,
      headers: { get: () => null },
      text: async () => '',
      arrayBuffer: async () => Uint8Array.from(zip).buffer,
    })
    const base = {
      token: 'tok',
      appliances: [
        {
          haId: 'HAI-TLS',
          name: 'DW',
          type: 'Dishwasher',
          host: 'BOSCH-Dishwasher-HAI-TLS',
          psk: 'psk',
          mode: 'TLS' as const,
        },
      ],
    }
    const { connection, changed } = await enrichHomeConnectConnection(base, fetchImpl)
    expect(changed).toBe(true)
    const row = connection.appliances?.[0]
    expect(entityIndexFromDescription(row?.deviceDescription).get(552)?.name).toBe(
      'BSH.Common.Status.OperationState',
    )
  })
})
