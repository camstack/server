/**
 * Devices created while both meters were named "Consumption" keep that stored
 * name. A restore renames one only when it still equals that old default.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type CatalogRenameChild,
  renameLegacyCatalogDevices,
} from '../devices/enpal-catalog-rename.js'
import { ENPAL_CONSUMPTION_NAMES } from '../enpal-catalog.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const houseOld: CatalogRenameChild = {
  deviceId: 11,
  specId: 'house',
  name: 'Consumption',
  userNamed: true,
}
const heatPumpChosen: CatalogRenameChild = {
  deviceId: 12,
  specId: 'heatpump',
  name: 'Pompa di calore',
  userNamed: true,
}

describe('renameLegacyCatalogDevices', () => {
  it('renames a meter that still has the old default, and leaves an operator name', async () => {
    const renamed: Array<{ deviceId: number; name: string; stampUserNamed: boolean }> = []
    const logged: number[] = []
    const logger: IScopedLogger = {
      ...quiet,
      info: (_message, ctx) => {
        const id = ctx?.tags?.deviceId
        if (typeof id === 'number') logged.push(id)
      },
    }
    await renameLegacyCatalogDevices({
      children: [houseOld, heatPumpChosen],
      rename: async (deviceId, name, stampUserNamed) => {
        renamed.push({ deviceId, name, stampUserNamed })
      },
      logger,
    })
    expect(renamed).toEqual([
      { deviceId: 11, name: ENPAL_CONSUMPTION_NAMES.house.en, stampUserNamed: true },
    ])
    expect(logged).toEqual([11])
  })

  it('renames a heat pump that still has the old default to its own catalogue name', async () => {
    const renamed: string[] = []
    await renameLegacyCatalogDevices({
      children: [{ deviceId: 13, specId: 'heatpump', name: 'Consumption', userNamed: false }],
      rename: async (_deviceId, name) => {
        renamed.push(name)
      },
      logger: quiet,
    })
    expect(renamed).toEqual([ENPAL_CONSUMPTION_NAMES.heatpump.en])
  })
})
