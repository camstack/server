import type {
  AddonContext,
  ConfigFieldWithValue,
  ConfigUISchema,
  ConfigUISchemaWithValues,
  EventFilter,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
  SystemEvent,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import DetectionPipelineAddon from '../index.js'
import type { RuntimeEnv } from '../runtimes.js'

/**
 * D986 M4: the detection pipeline's settings are declared by the capability that owns them. The
 * five Inference-executor knobs are per node (`pipeline-executor`, `<key>@<nodeId>`), the
 * model-substitution readout is cluster-wide (`detection-pipeline`). Stored values must read back
 * unchanged through the scoped declarations.
 */
class Probe extends DetectionPipelineAddon {
  caps(): readonly string[] {
    return this.scopedSettingsCapabilities()
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    return []
  }

  protected override async probeHardwareEnv(): Promise<RuntimeEnv> {
    return { platform: 'darwin', arch: 'arm64', hardware: null }
  }
}

function keysOf(schema: ConfigUISchema | null): string[] {
  if (schema === null) throw new Error('no schema declared')
  return schema.sections
    .flatMap((section) => section.fields)
    .flatMap((field) =>
      'key' in field && field.type !== 'info' && field.type !== 'separator' ? [field.key] : [],
    )
    .sort()
}

function fieldValue(
  schema: ConfigUISchema | ConfigUISchemaWithValues | null,
  key: string,
): unknown {
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields as readonly ConfigFieldWithValue[]) {
      if ('key' in field && field.key === key && 'value' in field) return field.value
    }
  }
  return undefined
}

function fakeContext(localNodeId: string, store: Record<string, unknown>): AddonContext {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
    withTags: () => logger,
  }
  const eventBus: IEventBus = {
    emit(_event: SystemEvent) {},
    subscribe(_filter: EventFilter | string, _handler: (event: SystemEvent) => void) {
      return noop
    },
    getRecent: () => [],
  }
  // Test double of the addon context: only the members the settings path reads exist.
  return {
    id: 'detection-pipeline',
    logger,
    eventBus,
    addonConfig: {},
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp/fake',
    kernel: { localNodeId },
    deps: { ensurePython: async () => '/usr/bin/python3' },
    api: {},
    settings: {
      readAddonStore: async () => ({ ...store }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      },
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => {},
    },
  } as unknown as AddonContext
}

describe('the detection pipeline scoped settings', () => {
  let addon: Probe | null = null
  afterEach(async () => {
    await addon?.shutdown()
    addon = null
  })

  it('names both capabilities and splits the keys by scope', async () => {
    addon = new Probe()
    expect(addon.caps()).toEqual(
      expect.arrayContaining(['detection-pipeline', 'pipeline-executor']),
    )
    expect(keysOf(await addon.getScopedSettingsSchema('node', 'pipeline-executor'))).toEqual(
      ['batchMode', 'concurrency', 'maxBatchSize', 'numWorkers', 'windowMs'].sort(),
    )
    expect(keysOf(await addon.getScopedSettingsSchema('cluster', 'detection-pipeline'))).toEqual([
      'activeModelSubstitutions',
    ])
    expect(await addon.getScopedSettingsSchema('cluster', 'pipeline-executor')).toBeNull()
    expect(await addon.getScopedSettingsSchema('node', 'detection-pipeline')).toBeNull()
    expect(await addon.getScopedSettingsSchema('device-defaults', 'detection-pipeline')).toBeNull()
    expect(await addon.getScopedSettingsSchema('device-defaults', 'pipeline-executor')).toBeNull()
  })

  it('serves the stored per-node value through the scoped declarations', async () => {
    const store: Record<string, unknown> = { 'numWorkers@macmini': 7, 'windowMs@hub': 5 }
    addon = new Probe()
    await addon.initialize(fakeContext('hub', store))
    const mac = await addon.getGlobalSettings(undefined, undefined, 'macmini')
    expect(fieldValue(mac, 'numWorkers')).toBe(7)
    const hub = await addon.getGlobalSettings(undefined, undefined, 'hub')
    expect(fieldValue(hub, 'windowMs')).toBe(5)
    expect(fieldValue(hub, 'numWorkers')).not.toBe(7)
  })

  it('injects the CoreML tuning into the node form at request time', async () => {
    addon = new Probe()
    await addon.initialize(fakeContext('hub', {}))
    const schema = await addon.getScopedSettingsSchema('node', 'pipeline-executor')
    const concurrency = schema?.sections
      .flatMap((section) => section.fields)
      .find((field) => 'key' in field && field.key === 'concurrency')
    expect(concurrency).toMatchObject({ max: 4 })
  })
})
