/**
 * Every client field becomes a node setting: each bare row is copied to `<key>@hub`, the bare row
 * stays, a row already on the node is never overwritten, and the keychain marker of `authKey`
 * arrives untouched. Real SQLite, the canonical `addon-settings` layout.
 */
import { isSecretMarker, isSecretRefOwnedBy, makeSecretMarker } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { perNodeFixture } from '../../../__tests__/per-node-fixture.js'
import { SETTINGS_PER_NODE_MIGRATION } from '../index.js'
import { CLIENT_ADDON_ID, CLIENT_SETTING_KEYS } from '../settings-per-node.js'

const REF = 'secret://tailscale-client/global/authKey'
const MARKER = makeSecretMarker(REF)
const NEIGHBOUR = 'keep-me'
const BARE: Record<string, unknown> = {
  clientMode: 'onboard',
  hostname: 'camstack-hub',
  acceptRoutes: true,
  acceptDns: false,
  advertisedRoutes: '192.0.2.0/24',
  advertisedTags: 'tag:server',
  exitNodeId: 'exit-1',
  shieldsUp: true,
  ssh: true,
  authKey: MARKER,
}
const rowId = (key: string): string => `${CLIENT_ADDON_ID}.${key}`

const start = (bare: Record<string, unknown> = BARE) =>
  perNodeFixture(CLIENT_ADDON_ID, [SETTINGS_PER_NODE_MIGRATION], bare, NEIGHBOUR)

describe('tailscale-client/2026-11-03-settings-per-node', () => {
  it('copies every field to its hub node row, carrying nodeId, and keeps the bare rows', async () => {
    const f = start()
    expect(await f.boot()).toEqual({
      failed: [],
      applied: ['tailscale-client/2026-11-03-settings-per-node'],
    })
    const rows = f.rows()
    for (const key of CLIENT_SETTING_KEYS) {
      expect(rows[rowId(`${key}@hub`)]).toEqual({
        addonId: CLIENT_ADDON_ID,
        key: `${key}@hub`,
        value: BARE[key],
        nodeId: 'hub',
      })
      expect(rows[rowId(key)]).toEqual({
        addonId: CLIENT_ADDON_ID,
        key,
        value: BARE[key],
      })
    }
  })

  it('carries the authKey keychain ref across the @hub suffix: the marker is copied verbatim', async () => {
    const f = start()
    await f.boot()
    const copied = f.rows()[rowId('authKey@hub')]?.['value']
    expect(isSecretMarker(copied)).toBe(true)
    expect(copied).toEqual(MARKER)
    expect(isSecretRefOwnedBy(REF, 'tailscale-client')).toBe(true)
    // The copy holds the ref, never the plaintext.
    expect(JSON.stringify(f.rows()[rowId('authKey@hub')])).not.toContain('tskey')
  })

  it('does not touch another addon, and a marked field the migration does not know survives', async () => {
    const f = start({ ...BARE, unknownMarked: { mark: 'survive' } })
    await f.boot()
    const rows = f.rows()
    expect(rows[rowId('unknownMarked')]).toEqual({
      addonId: CLIENT_ADDON_ID,
      key: 'unknownMarked',
      value: { mark: 'survive' },
    })
    expect(rows[rowId('unknownMarked@hub')]).toBeUndefined()
    for (const key of Object.keys(rows).filter((id) => id.startsWith('other-addon.'))) {
      expect(Reflect.get(rows[key] ?? {}, 'value')).toBe(NEIGHBOUR)
    }
    expect(Object.keys(rows).filter((id) => id.startsWith('other-addon.'))).toHaveLength(
      Object.keys(BARE).length + 1,
    )
  })

  it('a second run is a no-op', async () => {
    const f = start()
    await f.boot()
    const after = f.rows()
    expect(await f.boot()).toEqual({
      failed: [],
      applied: ['tailscale-client/2026-11-03-settings-per-node'],
    })
    expect(f.rows()).toEqual(after)
  })

  it('never overwrites a value already on the node row', async () => {
    const f = start()
    f.insertRow(rowId('hostname@hub'), {
      addonId: CLIENT_ADDON_ID,
      key: 'hostname@hub',
      value: 'chosen-on-node',
      nodeId: 'hub',
    })
    await f.boot()
    expect(f.rows()[rowId('hostname@hub')]?.['value']).toBe('chosen-on-node')
    expect(f.rows()[rowId('ssh@hub')]?.['value']).toBe(true)
  })

  it('refuses when the node row appeared between the read and the apply', async () => {
    const f = start()
    const result = await f.boot(() =>
      f.insertRow(rowId('ssh@hub'), {
        addonId: CLIENT_ADDON_ID,
        key: 'ssh@hub',
        value: false,
        nodeId: 'hub',
      }),
    )
    expect(result.failed).toEqual(['tailscale-client/2026-11-03-settings-per-node'])
    const rows = f.rows()
    expect(rows[rowId('ssh@hub')]?.['value']).toBe(false)
    expect(rows[rowId('hostname@hub')]).toBeUndefined()
  })
})
