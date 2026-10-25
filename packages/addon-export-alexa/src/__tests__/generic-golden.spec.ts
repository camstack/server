/**
 * Golden spec (D869): the generic endpoints built from the adapter registry are
 * BYTE-IDENTICAL to what the hand-written row table published before the
 * registry. `helpers/generic-golden.json` was captured from that table; a diff
 * here means Alexa's stored copy of an existing device would change shape.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildGenericDeviceEndpoint } from '../endpoints/generic-device.js'

const GOLDEN: Record<string, unknown> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./helpers/generic-golden.json', import.meta.url)), 'utf8'),
)

const CASES: Record<string, { type: string; capNames: string[] }> = {
  lock: { type: 'lock', capNames: ['lock-control'] },
  contact: { type: 'sensor', capNames: ['contact'] },
  motionPresence: { type: 'sensor', capNames: ['motion', 'presence'] },
  temperature: { type: 'sensor', capNames: ['temperature-sensor'] },
  climateSensors: { type: 'sensor', capNames: ['temperature-sensor', 'humidity-sensor'] },
  switch: { type: 'switch', capNames: ['switch'] },
  siren: { type: 'siren', capNames: ['switch'] },
  light: { type: 'light', capNames: ['switch'] },
  dimmer: { type: 'switch', capNames: ['switch', 'brightness'] },
  none: { type: 'sensor', capNames: ['smoke'] },
}

describe('generic endpoints: registry output equals the pre-registry golden JSON', () => {
  for (const [name, input] of Object.entries(CASES)) {
    it(name, () => {
      const built = buildGenericDeviceEndpoint({
        deviceId: 7,
        stableId: 's7',
        name: `Dev ${name}`,
        ...input,
      })
      // JSON round trip: the golden is what goes over the wire.
      expect(JSON.parse(JSON.stringify(built))).toEqual(GOLDEN[name])
    })
  }
})
