/**
 * D696 (amended 2026-10-02): a camera provider SAYS that it no longer writes
 * its cameras' `motion` slice, on the read the orchestrator's provider gate
 * asks — `deviceProvider.getStatus` — the way the runner says it on
 * `getLocalLoad().motionSliceWriter`.
 *
 * It is said by `BaseDeviceProvider`, which every provider BUNDLES (providers
 * build `self-contained`: `@camstack/types` is inlined into each dist). So only
 * a provider built from this code carries it, and an old provider — one that
 * still writes the slice — answers without it whatever server it runs under.
 */
import { describe, expect, it } from 'vitest'
import { deviceProviderCapability } from '../../capabilities/device-provider.cap.js'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { BaseDeviceProvider } from '../base-device-provider.js'
import type { CreateDeviceSpec } from '../device-management.js'

class SliceTestProvider extends BaseDeviceProvider {
  protected readonly addonId = 'provider-slice-test'
  protected readonly providerName = 'slice-test'
  protected readonly deviceClasses = {}
  protected async onGetCreationSchema(): Promise<ConfigUISchema | null> {
    return null
  }
  protected async onCreateDevice(): Promise<CreateDeviceSpec> {
    throw new Error('not used')
  }
}

function provider(): SliceTestProvider {
  const p = new SliceTestProvider({})
  Reflect.set(p, '_ctx', { kernel: { devices: { getAll: async () => [] } } })
  return p
}

describe('a device provider says it does not write its cameras` motion slice (D696)', () => {
  it('getStatus answers motionSliceWriter: orchestrator', async () => {
    const status = await provider().getStatus()
    expect(status.motionSliceWriter).toBe('orchestrator')
  })

  it('the cap`s output schema keeps the field, and an old provider`s answer has none', () => {
    const output = deviceProviderCapability.methods.getStatus.output
    expect(
      output.parse({ connected: true, deviceCount: 3, motionSliceWriter: 'orchestrator' }),
    ).toMatchObject({ motionSliceWriter: 'orchestrator' })
    expect(output.parse({ connected: true, deviceCount: 3 })).not.toHaveProperty(
      'motionSliceWriter',
    )
  })
})
