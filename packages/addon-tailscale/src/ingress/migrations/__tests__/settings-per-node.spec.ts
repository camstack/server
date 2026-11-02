/**
 * Every ingress field becomes a node setting: each bare row is copied to `<key>@hub`, the bare
 * row stays, and a row already on the node is never overwritten. Real SQLite, the canonical
 * `addon-settings` layout.
 */
import { describe, expect, it } from 'vitest'
import { perNodeFixture } from '../../../__tests__/per-node-fixture.js'
import { ADDON_MIGRATIONS } from '../index.js'
import { INGRESS_ADDON_ID, INGRESS_SETTING_KEYS } from '../settings-per-node.js'

const ID = 'tailscale-ingress/2026-11-03-settings-per-node'
const NEIGHBOUR = 'keep-me'
const BARE: Record<string, unknown> = {
  mode: 'funnel',
  sourcePort: 8443,
  targetPath: '/marked-path',
  upstreamScheme: 'http',
}
const rowId = (key: string): string => `${INGRESS_ADDON_ID}.${key}`
const start = (bare: Record<string, unknown> = BARE) =>
  perNodeFixture(INGRESS_ADDON_ID, ADDON_MIGRATIONS, bare, NEIGHBOUR)

describe(ID, () => {
  it('copies every field to its hub node row, carrying nodeId, and keeps the bare rows', async () => {
    const f = start()
    expect(await f.boot()).toEqual({ failed: [], applied: [ID] })
    const rows = f.rows()
    for (const key of INGRESS_SETTING_KEYS) {
      expect(rows[rowId(`${key}@hub`)]).toEqual({
        addonId: INGRESS_ADDON_ID,
        key: `${key}@hub`,
        value: BARE[key],
        nodeId: 'hub',
      })
      expect(rows[rowId(key)]).toEqual({
        addonId: INGRESS_ADDON_ID,
        key,
        value: BARE[key],
      })
    }
  })

  it('does not touch another addon, and a marked field the migration does not know survives', async () => {
    const f = start({ ...BARE, unknownMarked: { mark: 'survive' } })
    await f.boot()
    const rows = f.rows()
    expect(rows[rowId('unknownMarked')]?.['value']).toEqual({
      mark: 'survive',
    })
    expect(rows[rowId('unknownMarked@hub')]).toBeUndefined()
    const neighbours = Object.keys(rows).filter((id) => id.startsWith('other-addon.'))
    expect(neighbours).toHaveLength(Object.keys(BARE).length + 1)
    for (const id of neighbours) expect(rows[id]?.['value']).toBe(NEIGHBOUR)
  })

  it('a second run is a no-op', async () => {
    const f = start()
    await f.boot()
    const after = f.rows()
    expect(await f.boot()).toEqual({ failed: [], applied: [ID] })
    expect(f.rows()).toEqual(after)
  })

  it('never overwrites a value already on the node row', async () => {
    const f = start()
    f.insertRow(rowId('mode@hub'), {
      addonId: INGRESS_ADDON_ID,
      key: 'mode@hub',
      value: 'serve',
      nodeId: 'hub',
    })
    await f.boot()
    expect(f.rows()[rowId('mode@hub')]?.['value']).toBe('serve')
    expect(f.rows()[rowId('sourcePort@hub')]?.['value']).toBe(8443)
  })

  it('refuses when the node row appeared between the read and the apply', async () => {
    const f = start()
    const result = await f.boot(() =>
      f.insertRow(rowId('mode@hub'), {
        addonId: INGRESS_ADDON_ID,
        key: 'mode@hub',
        value: 'serve',
        nodeId: 'hub',
      }),
    )
    expect(result.failed).toEqual([ID])
    expect(f.rows()[rowId('sourcePort@hub')]).toBeUndefined()
  })
})
