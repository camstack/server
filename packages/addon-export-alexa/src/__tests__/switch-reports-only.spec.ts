/**
 * D1058: a switch that ANSWERED `getOptions().supportsSetState: false` (a PoE
 * port seen only through an API key) is not exported as a PowerController —
 * every TurnOn / TurnOff would fail. No answer keeps it (D315).
 */
import type { AddonApi } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { discoveryExtrasFor } from '../endpoints/adapters/index.js'
import { SWITCH_OPTIONS_KEY } from '../endpoints/adapters/switch.js'
import { planGenericEndpoint } from '../endpoints/generic-device.js'

const PORT = { deviceId: 33, stableId: 'port-3', name: 'Port 3', type: 'switch', role: null }

function apiAnswering(getOptions: () => Promise<unknown>): AddonApi {
  // The fake covers only the router the switch adapter reads at discovery.
  return Object.assign(Object.create(null), {
    switch: { getOptions: { query: getOptions } },
  })
}

async function planFor(getOptions: () => Promise<unknown>) {
  const slices = await discoveryExtrasFor(apiAnswering(getOptions), PORT.deviceId, ['switch'])
  return { slices, plan: planGenericEndpoint({ ...PORT, capNames: ['switch'], slices }) }
}

describe('Alexa — a switch that only reports (D1058)', () => {
  it('reads getOptions at discovery and skips a switch that cannot be set', async () => {
    const { slices, plan } = await planFor(async () => ({
      supportsSetState: false,
      supportsPowerCycle: true,
    }))
    expect(slices[SWITCH_OPTIONS_KEY]).toEqual({
      supportsSetState: false,
      supportsPowerCycle: true,
    })
    expect(plan.kind).toBe('skip')
  })

  it('a settable switch is a PowerController', async () => {
    const { plan } = await planFor(async () => ({
      supportsSetState: true,
      supportsPowerCycle: false,
    }))
    expect(plan.kind).toBe('endpoint')
  })

  it('a provider without getOptions, or a failed read, keeps the switch', async () => {
    const { plan } = await planFor(() =>
      Promise.reject(new Error('does not implement "getOptions"')),
    )
    expect(plan.kind).toBe('endpoint')
  })
})
