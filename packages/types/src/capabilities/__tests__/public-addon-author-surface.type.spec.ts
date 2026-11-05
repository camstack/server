/**
 * An external addon author imports these from the package entry
 * (`src/index.ts`, published as `@camstack/types`). They are not reachable
 * through a deep path the package does not export.
 *
 * `fakeAddonContext` comes from `src/testing.ts` (`@camstack/types/testing`),
 * never the root entry.
 *
 * Disarm: drop `statusInstanceOf` from `capabilities/index.ts` — the import
 * below fails. Restore `IDeviceExportProvider` to a plain `InferProvider` —
 * the exporter without the three contribution methods fails to assign.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { fakeAddonContext } from '../../testing.js'
import { type IDeviceExportProvider, type InstanceChange, statusInstanceOf } from '../../index.js'

describe('public addon-author surface', () => {
  it('exports InstanceChange, statusInstanceOf and a typed addon context from the testing subpath', async () => {
    const change: InstanceChange = 'created'
    expectTypeOf<InstanceChange>().toEqualTypeOf<'created' | 'updated' | 'enabled' | 'deleted'>()
    expect(change).toBe('created')
    expect(statusInstanceOf({ instanceId: 'bridge-1' })).toBe('bridge-1')
    expect(statusInstanceOf({ deviceId: 4 })).toBeUndefined()
    const ctx = await fakeAddonContext({ id: 'external-addon' })
    expect(ctx.id).toBe('external-addon')
    expect(ctx.kernel.localNodeId).toBe('hub')
  })

  it('lets a device-export provider omit the three device-settings methods', () => {
    const exporter: IDeviceExportProvider = {
      getStatus: async () => ({ linkState: 'unlinked', exposedDeviceCount: 0 }),
      listInstances: async () => [],
      listSupportedDeviceKinds: async () => [],
      listExposedDevices: async () => [],
      exposeDevice: async () => {
        return
      },
      unexposeDevice: async () => {
        return
      },
    }
    expect(exporter.getDeviceSettingsContribution).toBeUndefined()
    expect(exporter.getDeviceLiveContribution).toBeUndefined()
    expect(exporter.applyDeviceSettingsPatch).toBeUndefined()
  })
})
