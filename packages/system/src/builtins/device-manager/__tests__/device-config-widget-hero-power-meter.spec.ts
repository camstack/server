/**
 * D1004: `power-meter` is a hero widget exactly like `consumables` — every
 * device bound to it, of any type, gets ONE `location: 'hero'` section naming
 * `host/power-meter-line`; nothing here knows a device type.
 */
import type {
  AddonContext,
  DeviceBindingEntry,
  ICapabilityRegistry,
  IScopedLogger,
} from '@camstack/types'
import { isDeviceConfigCap, powerMeterCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { deriveDeviceConfigContribution } from '../device-aggregation.js'
import type { AggregationDeps } from '../device-aggregation.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

const deps = { ctx: { logger: makeLogger() } as unknown as AddonContext } as AggregationDeps
const registry = {
  getDefinition: () => undefined,
  getProviderForDevice: () => null,
} as unknown as ICapabilityRegistry
const entry = (providerAddonId: string): DeviceBindingEntry => ({
  capName: 'power-meter',
  kind: 'native',
  providerAddonId,
  providerNodeId: 'hub',
  nativeAddonId: providerAddonId,
})

describe('deriveDeviceConfigContribution — a hero widget (power-meter)', () => {
  it('marks the power-meter section hero and names the host widget', async () => {
    const def = powerMeterCapability
    if (!isDeviceConfigCap(def)) throw new Error('power-meter lost its deviceConfig declaration')
    const out = await deriveDeviceConfigContribution(
      deps,
      registry,
      def,
      entry('bosch'),
      7,
      'settings',
    )
    expect(out?.sections).toHaveLength(1)
    expect(out?.sections[0]?.location).toBe('hero')
    expect(out?.sections[0]?.fields[0]).toMatchObject({
      type: 'widget',
      widgetId: 'host/power-meter-line',
    })
  })

  it('answers the same for any provider — the binding decides', async () => {
    const def = powerMeterCapability
    if (!isDeviceConfigCap(def)) throw new Error('power-meter lost its deviceConfig declaration')
    const a = await deriveDeviceConfigContribution(deps, registry, def, entry('a'), 1, 'settings')
    const b = await deriveDeviceConfigContribution(deps, registry, def, entry('b'), 2, 'settings')
    expect(a?.sections[0]?.id).toBe(b?.sections[0]?.id)
    expect(a?.sections[0]?.location).toBe(b?.sections[0]?.location)
  })

  it('contributes nothing to the live aggregate', async () => {
    const def = powerMeterCapability
    if (!isDeviceConfigCap(def)) throw new Error('power-meter lost its deviceConfig declaration')
    expect(
      await deriveDeviceConfigContribution(deps, registry, def, entry('a'), 1, 'live'),
    ).toBeNull()
  })
})
