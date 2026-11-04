/**
 * The HomeKit export's two settings migrations on real SQLite in the canonical `addon-settings`
 * layout: `interfaceName` is copied to its hub node row (the bare row stays, a marked neighbour
 * survives), and an inline `fixedPin` moves into the keychain and reads back.
 */
import { describe, expect, it } from 'vitest'
import {
  type SettingsRows,
  settingsFixture,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/addon-settings-fixture.js'
import { readRawKeys } from '../hub-node-fields.js'
import {
  ADDON_MIGRATIONS,
  DROP_EXPOSURE_KEYS_ID,
  EXPOSURE_TO_RECORD_ID,
  EXPORT_HAP_ID,
  FIXED_PIN_TO_KEYCHAIN_ID,
  type HapCataloguePorts,
  IDENTITY_TO_INSTANCE_ID,
  INTERFACE_NAME_PER_NODE_ID,
} from '../index.js'

const NEIGHBOUR = 'keep-me'

/** The keychain the addon's operator write fills: the row holds a marker, the vault the value. */
function keychainPorts(rows: SettingsRows, vault: Map<string, string>): HapCataloguePorts {
  return {
    readStored: rows.readStored,
    readLegacyIdentity: async () => null,
    readBridgeName: async () => '',
    putDefaultRecord: async () => 'exists',
    readDefaultRecord: async () => null,
    clearLegacyIdentity: async () => undefined,
    patchDefaultName: async () => undefined,
    clearFixedPin: async () => {
      rows.remove('fixedPin')
    },
    putExposure: async () => 'exists',
    readExposure: async () => null,
    storeFixedPin: async (pin) => {
      const existing = (await rows.readStored(['fixedPin']))['fixedPin']
      if (typeof existing === 'object' && existing !== null) return
      vault.set('ref-1', pin)
      rows.write('fixedPin', { $secret: 'ref-1' })
    },
  }
}

const hap = (seed: Record<string, unknown>, vault = new Map<string, string>()) => ({
  vault,
  fixture: settingsFixture<HapCataloguePorts>({
    addonId: EXPORT_HAP_ID,
    // Migrations 6-8 delete these very rows and have their own spec (global-knobs.sqlite.spec.ts).
    catalogue: ADDON_MIGRATIONS.filter((m) => m.meta.seq <= 5),
    seed,
    neighbour: NEIGHBOUR,
    ports: (rows) => keychainPorts(rows, vault),
  }),
})

describe('export-hap settings migrations', () => {
  it('copies interfaceName to the hub node row, keeps the bare row and a marked neighbour', async () => {
    const { fixture } = hap({ interfaceName: 'en0', bridgeName: 'Home' })
    expect(await fixture.boot()).toEqual({
      failed: [],
      applied: [
        INTERFACE_NAME_PER_NODE_ID,
        FIXED_PIN_TO_KEYCHAIN_ID,
        IDENTITY_TO_INSTANCE_ID,
        EXPOSURE_TO_RECORD_ID,
        DROP_EXPOSURE_KEYS_ID,
      ],
    })
    const rows = fixture.rows()
    expect(rows['export-hap.interfaceName@hub']).toEqual({
      addonId: 'export-hap',
      key: 'interfaceName@hub',
      value: 'en0',
      nodeId: 'hub',
    })
    expect(rows['export-hap.interfaceName']?.['value']).toBe('en0')
    expect(rows['export-hap.bridgeName']?.['value']).toBe('Home')
    expect(rows['export-hap.bridgeName@hub']).toBeUndefined()
    expect(rows['other-addon.interfaceName']?.['value']).toBe(NEIGHBOUR)
  })

  it('does not overwrite an interfaceName already on the node row', async () => {
    const { fixture } = hap({
      interfaceName: 'en0',
      'interfaceName@hub': 'eth1',
    })
    // The run is a clean no-op for that key: it neither overwrites the row nor fails on it.
    expect((await fixture.boot()).failed).toEqual([])
    expect(fixture.rows()['export-hap.interfaceName@hub']?.['value']).toBe('eth1')
  })

  it('moves an inline fixedPin into the keychain and it reads back', async () => {
    const { fixture, vault } = hap({ fixedPin: '123-45-678' })
    await fixture.boot()
    const stored = (
      await readRawKeys(
        async (key) => ({
          kind: 'present',
          value: fixture.rows()[`export-hap.${key}`]?.['value'],
        }),
        EXPORT_HAP_ID,
        ['fixedPin'],
      )
    )['fixedPin']
    expect(stored).toEqual({ $secret: 'ref-1' })
    expect(vault.get('ref-1')).toBe('123-45-678')
    expect(JSON.stringify(fixture.rows())).not.toContain('123-45-678')
  })

  it('leaves a marker-backed or empty fixedPin alone and a second run is a no-op', async () => {
    const marked = hap({ fixedPin: { $secret: 'ref-9' } })
    await marked.fixture.boot()
    expect(marked.vault.size).toBe(0)
    expect(marked.fixture.rows()['export-hap.fixedPin']?.['value']).toEqual({
      $secret: 'ref-9',
    })

    const { fixture, vault } = hap({
      interfaceName: 'en0',
      fixedPin: '123-45-678',
    })
    await fixture.boot()
    const first = JSON.stringify(fixture.rows())
    // The engine would skip an applied id; running the bodies again must change nothing either.
    await fixture.boot()
    expect(JSON.stringify(fixture.rows())).toBe(first)
    expect(vault.size).toBe(1)
  })
})
