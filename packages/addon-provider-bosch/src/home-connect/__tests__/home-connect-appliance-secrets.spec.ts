import { collectKeychainStoredKeys, makeSecretMarker } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  APPLIANCE_SECRETS_KEY,
  appliancesWithoutCredential,
  buildHomeConnectFormSchema,
  connectionFromSettings,
  homeConnectSettingsForPersist,
  mergeAppliancesForPersist,
} from '../config.js'

const PSK = 'psk-AAAA-secret-value'
const IV = 'iv64-BBBB-secret-value'

const legacyRow = {
  haId: 'HAI-1',
  name: 'Kitchen',
  type: 'Dishwasher',
  host: 'BOSCH-Dishwasher-HAI-1',
  mode: 'TLS',
  psk: PSK,
  iv64: IV,
}

const legacySettings = { token: 'access', appliances: JSON.stringify([legacyRow]) }

function noSecretsIn(value: unknown): void {
  const text = JSON.stringify(value)
  expect(text).not.toContain(PSK)
  expect(text).not.toContain(IV)
}

describe('appliance credentials are keychain secrets, not row data', () => {
  it('declares applianceSecrets as a password field the hub moves into the keychain', () => {
    const fields = buildHomeConnectFormSchema().sections[0]?.fields ?? []
    const field = fields.find((f) => f.key === APPLIANCE_SECRETS_KEY)
    expect(field?.type).toBe('password')
    expect(collectKeychainStoredKeys(buildHomeConnectFormSchema()).has(APPLIANCE_SECRETS_KEY)).toBe(
      true,
    )
  })

  it('persisting settings moves psk and iv64 off the row into applianceSecrets', () => {
    const out = homeConnectSettingsForPersist(legacySettings)
    const rows = out['appliances']
    expect(Array.isArray(rows)).toBe(true)
    noSecretsIn(rows)
    expect(JSON.parse(String(out[APPLIANCE_SECRETS_KEY]))).toEqual({
      'HAI-1': { psk: PSK, iv64: IV },
    })
  })

  it('merges rows and the keychain secret back into a connection', () => {
    const rowOnly = { ...legacyRow, psk: undefined, iv64: undefined }
    const connection = connectionFromSettings({
      token: 'access',
      appliances: [rowOnly],
      [APPLIANCE_SECRETS_KEY]: JSON.stringify({ 'HAI-1': { psk: PSK, iv64: IV } }),
    })
    expect(connection?.appliances?.[0]).toMatchObject({ haId: 'HAI-1', psk: PSK, iv64: IV })
  })

  it('still reads a pre-migration row with the key inline (so a boot before the move still connects)', () => {
    const connection = connectionFromSettings(legacySettings)
    expect(connection?.appliances?.[0]).toMatchObject({ psk: PSK, iv64: IV })
  })

  it('an appliance with no credential anywhere is left out and reported, not given an empty key', () => {
    const settings = {
      token: 'access',
      appliances: [{ ...legacyRow, psk: undefined, iv64: undefined }],
    }
    expect(connectionFromSettings(settings)?.appliances).toEqual([])
    expect(appliancesWithoutCredential(settings)).toEqual(['HAI-1'])
  })

  it('keys the keychain cannot serve right now are "locked", never "absent": no key is minted or dropped', () => {
    const marker = makeSecretMarker('secret://owner/integration/x/applianceSecrets')
    const settings = {
      token: 'access',
      appliances: [{ ...legacyRow, psk: undefined, iv64: undefined }],
      [APPLIANCE_SECRETS_KEY]: marker,
    }
    expect(appliancesWithoutCredential(settings)).toEqual(['HAI-1'])
    // and a legacy inline row is not stripped while the stored secrets are locked
    const locked = homeConnectSettingsForPersist({
      ...legacySettings,
      [APPLIANCE_SECRETS_KEY]: marker,
    })
    expect(locked[APPLIANCE_SECRETS_KEY]).toEqual(marker)
    expect(JSON.stringify(locked['appliances'])).toContain(PSK)
  })
})

describe('unreadable stored secrets are unknown, not empty', () => {
  it('never plans a write over an applianceSecrets value it cannot parse', () => {
    const settings = { ...legacySettings, [APPLIANCE_SECRETS_KEY]: '{not json' }
    expect(homeConnectSettingsForPersist(settings)[APPLIANCE_SECRETS_KEY]).toBe('{not json')
    // the inline key is left on the row, not lost
    expect(JSON.stringify(homeConnectSettingsForPersist(settings)['appliances'])).toContain(PSK)
  })
})

describe('mergeAppliancesForPersist', () => {
  it('keeps a paired appliance that has no credential and refreshes the ones the connection knows', () => {
    const keyless = { haId: 'HAI-2', name: 'Oven', type: 'Dishwasher', host: 'h2', mode: 'TLS' }
    const known = { ...legacyRow, mode: 'TLS' as const, deviceDescription: { version: 2 } }
    const rows = mergeAppliancesForPersist(
      [{ ...legacyRow, psk: undefined, iv64: undefined }, keyless],
      [{ ...known, psk: PSK, iv64: IV }],
    )
    expect(rows.map((r) => r['haId'])).toEqual(['HAI-1', 'HAI-2'])
    expect(rows[0]?.['deviceDescription']).toEqual({ version: 2 })
  })
})
