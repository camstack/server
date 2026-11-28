/**
 * `heat-pump-control` circuit controls (planning#741 B4) through the REAL router: each of the
 * three new methods is routed by `deviceId`, hands its whole input to the provider, and is
 * refused on a malformed input before the provider is reached. The limits themselves
 * (allowed / min / max) are the provider's, pinned in the bosch addon specs.
 */
import { METHOD_ACCESS_MAP } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

const HEAT_PUMP = 5630

type Call = { readonly method: string; readonly input: Record<string, unknown> }

function recordingProvider(seen: Call[]) {
  const record = (method: string) => async (input: Record<string, unknown>) => {
    seen.push({ method, input })
  }
  return {
    setCircuitControlType: record('setCircuitControlType'),
    setCircuitTargetTemp: record('setCircuitTargetTemp'),
    setDhwLevelTemp: record('setDhwLevelTemp'),
  }
}

const CASES = [
  ['setCircuitControlType', { circuitId: 'hc1', controlType: 'ISRC' }],
  ['setCircuitTargetTemp', { circuitId: 'hc1', temp: 21.5 }],
  ['setDhwLevelTemp', { circuitId: 'dhw1', level: 'eco', temp: 55 }],
] as const

describe('heat-pump-control circuit controls: live router', () => {
  it.each(CASES)('%s is a device-scoped method in the access map', (method) => {
    expect(METHOD_ACCESS_MAP[`heatPumpControl.${method}`]).toMatchObject({
      capName: 'heat-pump-control',
      capScope: 'device',
    })
  })

  it.each(
    CASES,
  )('%s routes by deviceId and hands the whole input to the provider', async (method, input) => {
    const seen: Call[] = []
    const router = buildCapRouterForTest('heat-pump-control', () => recordingProvider(seen))
    const result = await invokeProcedure(router, method, makeCtx('admin'), {
      deviceId: HEAT_PUMP,
      ...input,
    })
    expect(result).toMatchObject({ ok: true })
    expect(seen).toEqual([{ method, input: { deviceId: HEAT_PUMP, ...input } }])
  })

  it.each([
    ['setCircuitControlType', { circuitId: 'hc1' }],
    ['setCircuitTargetTemp', { circuitId: 'hc1', temp: 'warm' }],
    ['setDhwLevelTemp', { circuitId: 'dhw1', temp: 55 }],
  ] as const)('%s refuses a malformed input before the provider', async (method, input) => {
    const seen: Call[] = []
    const router = buildCapRouterForTest('heat-pump-control', () => recordingProvider(seen))
    const result = await invokeProcedure(router, method, makeCtx('admin'), {
      deviceId: HEAT_PUMP,
      ...input,
    })
    expect(result).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect(seen).toEqual([])
  })
})
