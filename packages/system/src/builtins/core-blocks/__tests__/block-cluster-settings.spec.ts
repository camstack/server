/* eslint-disable @typescript-eslint/no-explicit-any -- AddonContext stub: the same boundary as the sibling addon specs. */
import { type AddonContext, BaseAddon, type ConfigUISchema } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

/**
 * A generated block provides NO capability and declares its form on the cluster hook under
 * `core-blocks` (the shape `renderBlockWrapper` emits, D986). Its values are the addon store of
 * `core-block-<id>`, keys unchanged: a value stored before the move must be read back, and a
 * write must land at the same key, through the framework path and not through a hand override.
 */
const FORM: ConfigUISchema = {
  sections: [
    {
      id: 'main',
      title: 'Block',
      columns: 1,
      fields: [{ type: 'number', key: 'gain', label: 'Gain', default: 1 }],
    },
  ],
}

class BlockLike extends BaseAddon {
  constructor() {
    super({})
  }
  protected override scopedSettingsCapabilities(): readonly string[] {
    return ['core-blocks']
  }
  protected override async clusterSettingsSchema(cap: string) {
    return cap === 'core-blocks' ? FORM : null
  }
  protected async onInitialize() {
    return []
  }
}

function ctxStoring(stored: Record<string, unknown>, written: Record<string, unknown>[]) {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return {
    id: 'core-block-b1',
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir: '/tmp/block',
    nodeDataDir: '/tmp',
    kernel: { localNodeId: 'hub', devices: {} },
    settings: {
      readAddonStore: vi.fn(async () => stored),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        written.push(patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
    },
    api: {},
    capabilities: { get: vi.fn(), getCollection: vi.fn(), getCollectionEntries: vi.fn() },
    deps: {},
    useCapability: vi.fn(),
    acquireCapability: vi.fn(),
    onCapabilityStateChange: vi.fn(),
  } as unknown as AddonContext
}

describe('a core block without a capability keeps its stored values at the same keys', () => {
  it('reads a stored value through the cluster form and writes it back at the same key', async () => {
    const written: Record<string, unknown>[] = []
    const addon = new BlockLike()
    await addon.initialize(ctxStoring({ gain: 4 }, written))

    const view = await addon.getGlobalSettings(undefined, 'core-blocks')
    const field = view?.sections[0]?.fields[0]
    expect(field && 'value' in field ? field.value : undefined).toBe(4)

    const bare = await addon.getGlobalSettings(undefined)
    expect(bare?.sections.map((section) => section.id)).toEqual(['main'])

    await addon.updateGlobalSettingsAsOperator({ gain: 9 })
    expect(written).toEqual([{ gain: 9 }])
  })

  it('without the up-front capability the form would be empty (the declaration is load-bearing)', async () => {
    class Undeclared extends BlockLike {
      protected override scopedSettingsCapabilities(): readonly string[] {
        return []
      }
    }
    const addon = new Undeclared()
    await addon.initialize(ctxStoring({ gain: 4 }, []))
    const view = await addon.getGlobalSettings(undefined)
    expect(view?.sections ?? []).toEqual([])
  })
})
