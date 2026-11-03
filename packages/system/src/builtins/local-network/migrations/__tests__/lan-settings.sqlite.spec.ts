/**
 * The LAN access settings become hub node settings, on real SQLite in the canonical
 * `addon-settings` layout: each bare row is copied to `<key>@hub` carrying `nodeId`, the bare row
 * and a field the migration does not know survive, a node row is never overwritten and a second
 * run changes nothing.
 */
import { describe, expect, it } from 'vitest'
import { settingsFixture } from '../../../sqlite-storage/__tests__/support/addon-settings-fixture.js'
import type { HubNodeFieldsPorts } from '../hub-node-fields.js'
import {
  ADDON_MIGRATIONS,
  LAN_SETTINGS_PER_NODE_ID,
  LAN_SETTING_KEYS,
  LOCAL_NETWORK_ID,
} from '../index.js'

const lan = (seed: Record<string, unknown>) =>
  settingsFixture<HubNodeFieldsPorts>({
    addonId: LOCAL_NETWORK_ID,
    catalogue: ADDON_MIGRATIONS,
    seed,
    neighbour: 'keep-me',
    ports: (rows) => ({ readStored: rows.readStored }),
  })

describe('local-network lan-settings-per-node', () => {
  it('copies every stored LAN setting to the hub row and keeps the rest', async () => {
    const f = lan({
      httpEnabled: false,
      httpPort: 8080,
      tlsEnabled: true,
      mdnsAdvertise: false,
      passiveDiscovery: false,
      localHostname: 'camstack.lan',
      allowedAddresses: ['10.0.0.1'],
    })
    expect(await f.boot()).toEqual({ failed: [], applied: [LAN_SETTINGS_PER_NODE_ID] })
    const rows = f.rows()
    for (const key of LAN_SETTING_KEYS) {
      expect(rows[`local-network.${key}@hub`]).toEqual({
        addonId: 'local-network',
        key: `${key}@hub`,
        value: rows[`local-network.${key}`]?.['value'],
        nodeId: 'hub',
      })
    }
    expect(rows['local-network.httpEnabled@hub']?.['value']).toBe(false)
    expect(rows['local-network.httpPort@hub']?.['value']).toBe(8080)
    expect(rows['local-network.allowedAddresses']?.['value']).toEqual(['10.0.0.1'])
    expect(rows['local-network.allowedAddresses@hub']).toBeUndefined()
    expect(rows['other-addon.httpPort']?.['value']).toBe('keep-me')
  })

  it('never overwrites a node row and a second run is a no-op', async () => {
    const f = lan({ httpPort: 8080, 'httpPort@hub': 9090, localHostname: 'a.lan' })
    // Copied where absent, left alone where present, and the run does not fail on the present row.
    expect((await f.boot()).failed).toEqual([])
    expect(f.rows()['local-network.httpPort@hub']?.['value']).toBe(9090)
    expect(f.rows()['local-network.localHostname@hub']?.['value']).toBe('a.lan')
    const once = JSON.stringify(f.rows())
    await f.boot()
    expect(JSON.stringify(f.rows())).toBe(once)
  })
})
