/**
 * An in-process hub addon's `ctx.api` carries ITS identity.
 *
 * All hub addons used to share one client whose `localProviderLink` had no
 * caller, so a caller-stamped capability (`device-history`, keychain, records)
 * reached its local provider unstamped and refused with "the caller addon could
 * not be identified" — 200 lines in 8 minutes from `metrics-native` alone.
 * Build the client without the `callerAddonId` and the first test fails with
 * `undefined`; share one client and the second one fails.
 */

import { describe, expect, it } from 'vitest'
import { createHubAddonApi } from '../hub-addon-api.js'

interface DeclareSeriesApi {
  readonly deviceHistory: {
    readonly declareSeries: { mutate(input: { name: string }): Promise<unknown> }
  }
}

function setup(): {
  readonly seen: unknown[]
  readonly apiFor: (addonId: string) => DeclareSeriesApi
} {
  const seen: unknown[] = []
  const provider = {
    declareSeries: async (input: unknown): Promise<{ ok: true }> => {
      seen.push(input)
      return { ok: true }
    },
  }
  const resolver = {
    getByName: (cap: string): unknown => (cap === 'device-history' ? provider : null),
  }
  return {
    seen,
    apiFor: (addonId) =>
      createHubAddonApi({
        resolver,
        callerAddonId: addonId,
        links: [],
      }) as unknown as DeclareSeriesApi,
  }
}

describe('createHubAddonApi', () => {
  it('stamps the owning addon on a caller-stamped capability call', async () => {
    const { seen, apiFor } = setup()
    await apiFor('metrics-native').deviceHistory.declareSeries.mutate({ name: 'x' })
    expect(seen).toEqual([{ name: 'x', callerAddonId: 'metrics-native' }])
  })

  it('stamps each addon with its own id', async () => {
    const { seen, apiFor } = setup()
    await apiFor('metrics-native').deviceHistory.declareSeries.mutate({ name: 'a' })
    await apiFor('other-addon').deviceHistory.declareSeries.mutate({ name: 'b' })
    expect(seen).toEqual([
      { name: 'a', callerAddonId: 'metrics-native' },
      { name: 'b', callerAddonId: 'other-addon' },
    ])
  })
})
