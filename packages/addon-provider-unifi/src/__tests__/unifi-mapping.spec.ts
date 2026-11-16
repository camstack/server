/**
 * The features an infra device fans out into offer only what the client can do: the
 * Integration API can neither read nor set the status LED, so no LED switch is offered
 * (planning#581).
 */
import { describe, expect, it } from 'vitest'
import type { UnifiInfraSnapshot } from '../unifi-client-contract.js'
import { buildInfraFeatures } from '../unifi-mapping.js'

const SWITCH: UnifiInfraSnapshot = {
  id: 'sw1',
  name: 'marker-switch',
  model: 'USW-Lite-8-PoE',
  kind: 'switch',
  cpuPercent: 5,
  cpuTempC: 40,
  clients: 3,
  state: 'online',
  uptimeSec: 100,
  ports: [{ idx: 1, poeOn: true, poeCapable: true }],
  ledOn: false,
  online: true,
}

describe('buildInfraFeatures', () => {
  it('offers no LED switch — the Integration API cannot read or set the LED', () => {
    const features = buildInfraFeatures(SWITCH)
    expect(features.some((f) => f.kind === 'switch' && f.switchFeature === 'led')).toBe(false)
  })

  it('keeps the restart button and the per-port power-cycle', () => {
    const features = buildInfraFeatures(SWITCH)
    expect(features).toContainEqual({ kind: 'button', buttonAction: 'restart' })
    expect(features).toContainEqual({ kind: 'button', buttonAction: 'power-cycle', portIdx: 1 })
  })
})
