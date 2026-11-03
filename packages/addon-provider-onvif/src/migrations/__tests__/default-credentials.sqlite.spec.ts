/**
 * The retired addon-wide ONVIF credentials, on real SQLite in the canonical `addon-settings`
 * layout: the password is cleared from the keychain BEFORE its row goes (so no secret is orphaned),
 * both rows are then deleted, a neighbour and an unrelated key survive, and a second run is a no-op.
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import {
  ADDON_MIGRATIONS,
  DROP_DEFAULT_CREDENTIAL_KEYS_ID,
  DROP_DEFAULT_CREDENTIALS_ID,
  type OnvifMigrationPorts,
  PROVIDER_ONVIF_ID,
} from '../index.js'

const MARKER = { $secret: 'secret://provider-onvif/global/defaultPassword' }

function onvif(seed: Record<string, unknown>, vault: Set<string>) {
  return settingsFixture<OnvifMigrationPorts>({
    addonId: PROVIDER_ONVIF_ID,
    catalogue: ADDON_MIGRATIONS,
    seed,
    neighbour: 'keep-me',
    ports: (rows) => ({
      readStored: rows.readStored,
      clearDefaultPassword: async () => {
        // `clearSecrets`: the keychain value goes; the marker's row is deleted by the next plan.
        vault.delete(MARKER.$secret)
      },
    }),
  })
}

describe('provider-onvif drop-default-credentials', () => {
  it('clears the keychain secret, deletes both rows and keeps everything else', async () => {
    const vault = new Set([MARKER.$secret])
    const f = onvif(
      { defaultUsername: 'admin', defaultPassword: MARKER, cameras: [{ id: 'a' }] },
      vault,
    )
    expect(await f.boot()).toEqual({
      failed: [],
      applied: [DROP_DEFAULT_CREDENTIALS_ID, DROP_DEFAULT_CREDENTIAL_KEYS_ID],
    })
    const rows = f.rows()
    expect(vault.size).toBe(0)
    expect(rows['provider-onvif.defaultUsername']).toBeUndefined()
    expect(rows['provider-onvif.defaultPassword']).toBeUndefined()
    expect(rows['provider-onvif.cameras']?.['value']).toEqual([{ id: 'a' }])
    expect(rows['other-addon.defaultUsername']?.['value']).toBe('keep-me')
    expect(rows['other-addon.defaultPassword']?.['value']).toBe('keep-me')
  })

  it('is a no-op once the rows are gone', async () => {
    const vault = new Set<string>()
    const f = onvif({ cameras: [] }, vault)
    await f.boot()
    const once = JSON.stringify(f.rows())
    await f.boot()
    expect(JSON.stringify(f.rows())).toBe(once)
  })
})
