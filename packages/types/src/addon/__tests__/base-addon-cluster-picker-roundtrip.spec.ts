import { describe, expect, it } from 'vitest'
import type { ConfigUISchema, ConfigUISchemaWithValues } from '../../interfaces/config-ui.js'
import { collectHydratedFieldEntries } from '../../interfaces/config-ui.js'
import { BaseAddon } from '../base-addon.js'
import { newWorld, worldContext, type KeychainWorld } from './keychain-world.js'

/**
 * The Roles and nodes pickers read and write through the scoped pair (D986 §7). Against a real
 * settings store (no mocked hooks) a node written through `updateScopedSettings` lands on its bare
 * key and reads back through `getScopedSettings('cluster', cap)`.
 */

const RECORDER_CAP = 'recording'
const ANALYTICS_CAP = 'pipeline-analytics'

const NODE_KEYS: Readonly<Record<string, string>> = {
  [RECORDER_CAP]: 'recordingNodeId',
  [ANALYTICS_CAP]: 'postProcessingNodeId',
}

function clusterForm(key: string): ConfigUISchema {
  return {
    sections: [
      {
        id: 'cluster',
        title: 'Cluster',
        fields: [{ type: 'text', key, label: key, default: '' }],
      },
    ],
  }
}

class PickerAddon extends BaseAddon<Record<string, string>> {
  constructor() {
    super({ recordingNodeId: '', postProcessingNodeId: '' })
  }
  protected override scopedSettingsCapabilities(): readonly string[] {
    return [RECORDER_CAP, ANALYTICS_CAP]
  }
  protected override async clusterSettingsSchema(cap: string) {
    const key = NODE_KEYS[cap]
    return key === undefined ? null : clusterForm(key)
  }
  protected async onInitialize() {
    return []
  }
}

async function boot(world: KeychainWorld): Promise<PickerAddon> {
  const addon = new PickerAddon()
  const ctx = worldContext(world, 'pickers')
  await addon.initialize({ ...ctx, kernel: { ...ctx.kernel, localNodeId: 'hub' } })
  return addon
}

function valueOf(form: ConfigUISchemaWithValues | null, key: string): unknown {
  return collectHydratedFieldEntries(form).get(key)?.value
}

describe('cluster pickers: the scoped API stores the bare key', () => {
  it.each([
    [RECORDER_CAP, 'recordingNodeId'],
    [ANALYTICS_CAP, 'postProcessingNodeId'],
  ])('%s: a write through updateScopedSettings reads back through getScopedSettings', async (cap, key) => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.updateScopedSettings('cluster', cap, { [key]: 'hub' })
    expect(world.store[key]).toBe('hub')
    expect(valueOf(await addon.getScopedSettings('cluster', cap), key)).toBe('hub')
  })

  it('a cap serves only its own picker key', async () => {
    const world = newWorld()
    const addon = await boot(world)
    await addon.updateScopedSettings('cluster', RECORDER_CAP, { recordingNodeId: 'garage-nuc' })
    expect(
      valueOf(await addon.getScopedSettings('cluster', ANALYTICS_CAP), 'postProcessingNodeId'),
    ).toBe('')
    expect(
      valueOf(await addon.getScopedSettings('cluster', ANALYTICS_CAP), 'recordingNodeId'),
    ).toBeUndefined()
  })
})
