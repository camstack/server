/**
 * D986 point 3: a device's effective settings are device row, then fleet-default row, then schema
 * default, with the source per field - ONE resolver, the same answer from hub-main's view and the
 * forked runner's, over one real SQLite file. `readDeviceStore` keeps returning the raw overrides.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createAddonSettingsStore } from '../addon-settings-store.js'
import {
  clientOverDoor,
  realHarness,
  type ContractHarness,
  type DeviceView,
} from './device-settings-contract.js'
import { createRunnerDeviceSettings } from '../moleculer/runner-device-settings.js'

const ADDON = 'detector'
const SCHEMA_DEFAULTS = { threshold: 0.4, interval: 5, label: 'none', zones: [] as number[] }

const open: ContractHarness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

async function seeded(): Promise<ContractHarness> {
  const h = await realHarness(ADDON)
  open.push(h)
  const fleet = createAddonSettingsStore(h.door, ADDON)
  // fleet defaults, plus a node row and a field outside the device form that must never resolve
  await fleet.merge({ interval: 10, label: 'fleet', 'threshold@agent-1': 0.9, unrelated: 1 })
  // device 7 overrides threshold and label (label equal to the schema default stays an override)
  await h.hubView.writeDeviceStore(7, { threshold: 0.7, label: 'none' })
  return h
}

const VIEWS: readonly ['hub' | 'runner', (h: ContractHarness) => DeviceView][] = [
  ['hub', (h) => h.hubView],
  ['runner', (h) => h.runnerView],
]

describe('device settings resolver (hub-main and runner views)', () => {
  for (const [name, view] of VIEWS) {
    it(`${name}: device, then fleet default, then schema default, with the source per field`, async () => {
      const h = await seeded()
      const resolved = await view(h).readResolvedDeviceStore(7, SCHEMA_DEFAULTS)
      expect(resolved).toEqual({
        threshold: { value: 0.7, source: 'device' },
        interval: { value: 10, source: 'fleet-default' },
        label: { value: 'none', source: 'device' },
        zones: { value: [], source: 'schema-default' },
      })
    })

    it(`${name}: a device with no row inherits the fleet default, and the raw store stays raw`, async () => {
      const h = await seeded()
      const resolved = await view(h).readResolvedDeviceStore(8, SCHEMA_DEFAULTS)
      expect(resolved['interval']).toEqual({ value: 10, source: 'fleet-default' })
      expect(resolved['threshold']).toEqual({ value: 0.4, source: 'schema-default' })
      await expect(view(h).readDeviceStore(8)).resolves.toEqual({})
      await expect(view(h).readDeviceStore(7)).resolves.toEqual({ threshold: 0.7, label: 'none' })
    })

    it(`${name}: Reset (deleting the device row) turns the field back into its inherited source`, async () => {
      const h = await seeded()
      await view(h).writeDeviceStore(7, { label: undefined })
      const resolved = await view(h).readResolvedDeviceStore(7, SCHEMA_DEFAULTS)
      expect(resolved['label']).toEqual({ value: 'fleet', source: 'fleet-default' })
      expect(resolved['threshold']).toEqual({ value: 0.7, source: 'device' })
    })
  }

  it('a store that does not answer throws: never the schema default of a value nobody chose', async () => {
    const h = await seeded()
    const failing = {
      ...h.door,
      query: async (): Promise<never> => {
        throw new Error('store did not answer')
      },
    }
    await expect(
      createRunnerDeviceSettings(clientOverDoor(failing), ADDON).readResolvedDeviceStore(
        7,
        SCHEMA_DEFAULTS,
      ),
    ).rejects.toThrow(/could not be read/)
  })
})
