import type { ICamstackAddon, AddonContext, IEngineManager, IEngineInstance } from '@camstack/types'
import { AddonLoader } from './addon-loader.js'
import { createHash } from 'node:crypto'

type EngineProcessFn = IEngineInstance['process']
type EngineClassifyAudioFn = NonNullable<IEngineInstance['classifyAudio']>

/**
 * Narrow a dynamic addon method to a callable with the given signature.
 *
 * Type-level bridge: ICamstackAddon does not yet declare process/classifyAudio;
 * dynamic dispatch is guarded by a `typeof === 'function'` check. Remove once
 * the addon interface is extended with an engine trait.
 */
function resolveAddonMethod<F extends (...args: never[]) => unknown>(
  target: ICamstackAddon,
  name: string,
): F | null {
  const fn: unknown = Reflect.get(target, name)
  if (typeof fn !== 'function') return null
  return fn.bind(target) as F
}

/** Wrap an ICamstackAddon as IEngineInstance — typed process/classifyAudio access */
function toEngineInstance(addon: ICamstackAddon, addonId: string): IEngineInstance {
  const processFn = resolveAddonMethod<EngineProcessFn>(addon, 'process')
  const classifyAudioFn = resolveAddonMethod<EngineClassifyAudioFn>(addon, 'classifyAudio')
  return {
    process: async (input) => {
      if (!processFn) throw new Error(`Addon "${addonId}" has no process() method`)
      return processFn(input)
    },
    classifyAudio: classifyAudioFn ? async (audioInput) => classifyAudioFn(audioInput) : undefined,
  }
}

export class AddonEngineManager implements IEngineManager {
  private engines = new Map<string, ICamstackAddon>()

  constructor(
    private readonly loader: AddonLoader,
    private readonly baseContext: Partial<Omit<AddonContext, 'addonConfig'>>,
  ) {}

  /**
   * Get or create an addon engine for the given effective config.
   * Cameras with the same addonId + effective config share the same engine.
   */
  async getOrCreateEngine(
    addonId: string,
    globalConfig: Record<string, unknown>,
    cameraOverride?: Record<string, unknown>,
  ): Promise<IEngineInstance> {
    // Merge global + override
    const effectiveConfig = { ...globalConfig, ...cameraOverride }
    const configKey = `${addonId}:${this.hashConfig(effectiveConfig)}`

    const existing = this.engines.get(configKey)
    if (existing) return toEngineInstance(existing, addonId)

    // Create new instance
    const addon = this.loader.createInstance(addonId)
    const partial = { ...this.baseContext, addonConfig: effectiveConfig }
    await addon.initialize(partial as AddonContext)
    this.engines.set(configKey, addon)
    return toEngineInstance(addon, addonId)
  }

  /** Get all active engines */
  getActiveEngines(): Map<string, ICamstackAddon> {
    return new Map(this.engines)
  }

  /** Shutdown a specific engine by its config key */
  async shutdownEngine(configKey: string): Promise<void> {
    const engine = this.engines.get(configKey)
    if (engine) {
      await engine.shutdown()
      this.engines.delete(configKey)
    }
  }

  /** Shutdown all engines */
  async shutdownAll(): Promise<void> {
    for (const [, engine] of this.engines) {
      await engine.shutdown()
    }
    this.engines.clear()
  }

  /** Compute a deterministic config key (visible for tests) */
  computeConfigKey(addonId: string, effectiveConfig: Record<string, unknown>): string {
    return `${addonId}:${this.hashConfig(effectiveConfig)}`
  }

  private hashConfig(config: Record<string, unknown>): string {
    return createHash('md5').update(JSON.stringify(config)).digest('hex').slice(0, 8)
  }
}
