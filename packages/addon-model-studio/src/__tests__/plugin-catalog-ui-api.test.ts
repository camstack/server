/**
 * Task 7B hardening RED — UI catalog parser must not treat unknown drift as ok.
 */
import { describe, expect, it } from 'vitest'
import { listPluginCatalogCatalog } from '../ui/api.js'

function trpcReturning(payload: unknown) {
  return {
    addons: { custom: { mutate: async () => payload } },
  } as never
}

describe('listPluginCatalogCatalog drift status', () => {
  it('maps unknown or adversarial statuses fail-closed to unavailable, never ok', async () => {
    const result = await listPluginCatalogCatalog(
      trpcReturning({
        entries: [],
        drift: [
          { manifestId: 'known-ok', status: 'ok' },
          { manifestId: 'known-missing', status: 'missing' },
          { manifestId: 'known-size', status: 'size-changed' },
          { manifestId: 'known-unavail', status: 'unavailable' },
          { manifestId: 'upper-ok', status: 'OK' },
          { manifestId: 'okay', status: 'okay' },
          { manifestId: 'empty', status: '' },
          { manifestId: 'numeric', status: 0 },
          { manifestId: 'bool', status: true },
          { manifestId: 'error', status: 'error' },
          { manifestId: 'novel', status: 'totally-new' },
          { manifestId: 'missing-status' },
        ],
      }),
    )
    const byId = Object.fromEntries(result.drift.map((row) => [row.manifestId, row.status]))
    expect(byId['known-ok']).toBe('ok')
    expect(byId['known-missing']).toBe('missing')
    expect(byId['known-size']).toBe('size-changed')
    expect(byId['known-unavail']).toBe('unavailable')
    for (const id of [
      'upper-ok',
      'okay',
      'empty',
      'numeric',
      'bool',
      'error',
      'novel',
      'missing-status',
    ]) {
      expect(byId[id], id).toBe('unavailable')
      expect(byId[id], id).not.toBe('ok')
    }
  })
})
