import type {
  IAddonResolver,
  IAddonCaller,
  IEngineManager,
  InferenceOutput,
  FrameInput,
  CropInput,
} from '@camstack/types'

/**
 * Adapter that wraps an IEngineManager + addonConfigs as an IAddonResolver.
 *
 * Used for backwards compatibility — the in-process AddonEngineManager
 * still uses the old getOrCreateEngine(addonId, globalConfig, override) API.
 * This adapter bridges it to the new resolve(addonId, config) interface.
 */
export class EngineManagerResolver implements IAddonResolver {
  constructor(
    private readonly engineManager: IEngineManager,
    private readonly addonConfigs: Map<string, Record<string, unknown>>,
  ) {}

  async resolve(addonId: string, config: Record<string, unknown>): Promise<IAddonCaller> {
    const globalConfig = this.addonConfigs.get(addonId) ?? {}
    const engine = await this.engineManager.getOrCreateEngine(addonId, globalConfig, config)

    return {
      process: async (input: FrameInput | CropInput): Promise<InferenceOutput> => {
        return engine.process(input as FrameInput)
      },
    }
  }

  async shutdownAll(): Promise<void> {
    await this.engineManager.shutdownAll()
  }
}
