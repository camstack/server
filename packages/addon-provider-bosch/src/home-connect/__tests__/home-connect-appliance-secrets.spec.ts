import { collectKeychainStoredKeys, makeSecretMarker } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  APPLIANCE_SECRETS_KEY,
  appliancesWithoutCredential,
  buildHomeConnectFormSchema,
  connectionFromSettings,
  HOME_CONNECT_SECRET_KEYS,
  homeConnectSettingsForPersist,
  legacyApplianceSecretPatch,
  mergeAppliancesForPersist,
} from '../config.js'
import { planLegacyApplianceSecretAdopt } from '../home-connect-secret-adopt.js'

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
    expect(HOME_CONNECT_SECRET_KEYS).toContain(APPLIANCE_SECRETS_KEY)
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
    expect(legacyApplianceSecretPatch(settings)).toBeNull()
    // and a legacy inline row is not stripped while the stored secrets are locked
    expect(
      legacyApplianceSecretPatch({ ...legacySettings, [APPLIANCE_SECRETS_KEY]: marker }),
    ).toBeNull()
  })
})

describe('unreadable stored secrets are unknown, not empty', () => {
  it('never plans a write over an applianceSecrets value it cannot parse', () => {
    const settings = { ...legacySettings, [APPLIANCE_SECRETS_KEY]: '{not json' }
    expect(legacyApplianceSecretPatch(settings)).toBeNull()
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

describe('legacyApplianceSecretPatch', () => {
  it('builds the write that moves the keys: rows without credentials plus the secrets string', () => {
    const patch = legacyApplianceSecretPatch(legacySettings)
    expect(patch).not.toBeNull()
    noSecretsIn(patch?.appliances)
    expect(JSON.parse(patch?.applianceSecrets ?? '{}')).toEqual({ 'HAI-1': { psk: PSK, iv64: IV } })
  })

  it('has nothing to do once the keys are moved', () => {
    const migrated = homeConnectSettingsForPersist(legacySettings)
    expect(legacyApplianceSecretPatch({ token: 'access', ...migrated })).toBeNull()
  })

  it('keeps a key already in the keychain for an appliance that has no inline key', () => {
    const second = { ...legacyRow, haId: 'HAI-2' }
    const patch = legacyApplianceSecretPatch({
      token: 'access',
      appliances: [{ ...legacyRow, psk: undefined, iv64: undefined }, second],
      [APPLIANCE_SECRETS_KEY]: JSON.stringify({ 'HAI-1': { psk: 'kept', iv64: 'kept-iv' } }),
    })
    expect(JSON.parse(patch?.applianceSecrets ?? '{}')).toEqual({
      'HAI-1': { psk: 'kept', iv64: 'kept-iv' },
      'HAI-2': { psk: PSK, iv64: IV },
    })
  })
})

describe('planLegacyApplianceSecretAdopt', () => {
  type SetSettingsCall = { id: string; settings: Record<string, unknown>; secretKeys: string[] }

  function deps(
    setSettings = vi.fn(async (_input: SetSettingsCall): Promise<unknown> => ({ success: true })),
  ) {
    const logger = { info: vi.fn(), warn: vi.fn() }
    return { setSettings, logger, d: { setSettings, logger } }
  }

  it('connects this boot with the migrated settings and writes nothing until persist() runs', async () => {
    const x = deps()
    const plan = planLegacyApplianceSecretAdopt(x.d, 'int-1', legacySettings)
    expect(plan).not.toBeNull()
    expect(x.setSettings).not.toHaveBeenCalled()
    noSecretsIn(plan?.settings['appliances'])
    expect(connectionFromSettings(plan?.settings ?? {})?.appliances?.[0]?.psk).toBe(PSK)

    await plan?.persist()
    expect(x.setSettings).toHaveBeenCalledTimes(1)
    const call = x.setSettings.mock.calls[0]?.[0]
    expect(call?.id).toBe('int-1')
    expect(call?.secretKeys).toEqual([...HOME_CONNECT_SECRET_KEYS])
    noSecretsIn(call?.settings['appliances'])
    expect(JSON.parse(String(call?.settings[APPLIANCE_SECRETS_KEY]))).toEqual({
      'HAI-1': { psk: PSK, iv64: IV },
    })
    // the log line carries counts, never a key
    noSecretsIn(x.logger.info.mock.calls)
  })

  it('has no plan once the settings are migrated — nothing is written, ever again', () => {
    const x = deps()
    const migrated = { token: 'access', ...homeConnectSettingsForPersist(legacySettings) }
    expect(planLegacyApplianceSecretAdopt(x.d, 'int-1', migrated)).toBeNull()
    expect(x.setSettings).not.toHaveBeenCalled()
  })

  it('a failed write is logged and never throws: the move is tried again at the next boot', async () => {
    const x = deps(
      vi.fn(
        async (_input: SetSettingsCall): Promise<unknown> =>
          Promise.reject(new Error('hub unavailable')),
      ),
    )
    const plan = planLegacyApplianceSecretAdopt(x.d, 'int-1', legacySettings)
    await expect(plan?.persist()).resolves.toBeUndefined()
    expect(x.logger.warn).toHaveBeenCalledOnce()
  })
})
