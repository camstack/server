/**
 * D915: a `deviceConfig` widget declared `placement: 'hero'` reaches the
 * device page as ONE section marked `location: 'hero'` — the marker the
 * admin UI keys on to show it directly under the device's hero card. The section is
 * emitted per BINDING entry (D12/D13), so every device bound to `consumables`
 * gets it and nothing here knows a device type.
 */
import type {
  AddonContext,
  DeviceBindingEntry,
  ICapabilityRegistry,
  IScopedLogger,
} from '@camstack/types'
import { consumablesCapability, isDeviceConfigCap } from '@camstack/types'
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

function makeDeps(): AggregationDeps {
  return { ctx: { logger: makeLogger() } as unknown as AddonContext } as AggregationDeps
}

const NO_REGISTRY = {
  getDefinition: () => undefined,
  getProviderForDevice: () => null,
} as unknown as ICapabilityRegistry

const entry = (providerAddonId: string): DeviceBindingEntry => ({
  capName: 'consumables',
  kind: 'native',
  providerAddonId,
  providerNodeId: 'hub',
  nativeAddonId: providerAddonId,
})

describe('deriveDeviceConfigContribution — a hero widget (consumables)', () => {
  it('marks the consumables section hero, not top-tab', async () => {
    const def = consumablesCapability
    if (!isDeviceConfigCap(def)) throw new Error('consumables lost its deviceConfig declaration')
    const out = await deriveDeviceConfigContribution(
      makeDeps(),
      NO_REGISTRY,
      def,
      entry('provider-dreame'),
      502,
      'settings',
    )
    expect(out?.sections).toHaveLength(1)
    const section = out?.sections[0]
    expect(section?.location).toBe('hero')
    expect(section?.fields[0]).toMatchObject({
      type: 'widget',
      widgetId: 'host/consumables-panel',
    })
  })

  it('answers the same for any provider — the binding decides, not the device type', async () => {
    const def = consumablesCapability
    if (!isDeviceConfigCap(def)) throw new Error('consumables lost its deviceConfig declaration')
    const vacuum = await deriveDeviceConfigContribution(
      makeDeps(),
      NO_REGISTRY,
      def,
      entry('provider-dreame'),
      502,
      'settings',
    )
    const dishwasher = await deriveDeviceConfigContribution(
      makeDeps(),
      NO_REGISTRY,
      def,
      entry('bosch'),
      501,
      'settings',
    )
    // Same section for both; only the writer tag names each provider.
    expect(dishwasher?.sections[0]?.location).toBe(vacuum?.sections[0]?.location)
    expect(dishwasher?.sections[0]?.id).toBe(vacuum?.sections[0]?.id)
    expect(dishwasher?.sections[0]?.fields[0]).toMatchObject({
      widgetId: 'host/consumables-panel',
    })
  })
})
