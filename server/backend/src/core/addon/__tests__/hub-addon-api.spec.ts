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

import type { DeviceCommandObservation } from '@camstack/types'
import { commandOrigin } from '@camstack/types/addon'
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

describe('createHubAddonApi device commands (D1022)', () => {
  interface SwitchApi {
    readonly switch: {
      readonly setState: { mutate(input: unknown, opts?: unknown): Promise<unknown> }
      readonly getState: { query(input: unknown): Promise<unknown> }
    }
  }

  function switchSetup(fail = false): {
    readonly observed: DeviceCommandObservation[]
    readonly api: (addonId: string) => SwitchApi
  } {
    const observed: DeviceCommandObservation[] = []
    const provider = {
      setState: async (): Promise<{ ok: true }> => {
        if (fail) throw new Error('device unreachable')
        return { ok: true }
      },
      getState: async (): Promise<{ on: boolean }> => ({ on: true }),
    }
    const resolver = { getByName: (cap: string): unknown => (cap === 'switch' ? provider : null) }
    return {
      observed,
      api: (addonId) =>
        createHubAddonApi({
          resolver,
          callerAddonId: addonId,
          links: [],
          commandSink: (obs) => void observed.push(obs),
        }) as unknown as SwitchApi,
    }
  }

  it('reports the command with the addon the client belongs to', async () => {
    const { observed, api } = switchSetup()
    await api('core-blocks').switch.setState.mutate({ deviceId: 7, on: true })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      deviceId: 7,
      capName: 'switch',
      method: 'setState',
      actor: { kind: 'addon', addonId: 'core-blocks' },
    })
  })

  it('records the origin claim of an action run as detail', async () => {
    const { observed, api } = switchSetup()
    await api('core-blocks').switch.setState.mutate(
      { deviceId: 7, on: true },
      commandOrigin({ kind: 'action', actionId: 'a1', runId: 'r1' }),
    )
    expect(observed[0]?.actor).toEqual({
      kind: 'action',
      addonId: 'core-blocks',
      actionId: 'a1',
      runId: 'r1',
    })
  })

  it('does not report a query', async () => {
    const { observed, api } = switchSetup()
    await api('core-blocks').switch.getState.query({ deviceId: 7 })
    expect(observed).toEqual([])
  })

  it('settles the outcome as rejected when the command throws', async () => {
    const { observed, api } = switchSetup(true)
    await expect(api('core-blocks').switch.setState.mutate({ deviceId: 7, on: true })).rejects.toThrow(
      'device unreachable',
    )
    await expect(observed[0]?.outcome).rejects.toThrow('device unreachable')
  })
})
