import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ICamstackAddon, AddonDeclaration, AddonContext } from '@camstack/types'
import { AddonLoader } from '../src/kernel/addon-loader'
import { AddonEngineManager } from '../src/kernel/addon-engine-manager'

// --- Mock addon class ---
class MockAddon implements ICamstackAddon {
  readonly id = 'mock-addon'
  readonly manifest: AddonDeclaration = {
    id: 'mock-addon',
    name: 'Mock Addon',
    version: '0.1.0',
    description: 'A mock addon for testing',
    slot: 'detector',
  }

  initializeSpy = vi.fn()
  shutdownSpy = vi.fn()

  postBrokerStart(): void {}
  async initialize(context: AddonContext): Promise<void> {
    this.initializeSpy(context)
  }

  async shutdown(): Promise<void> {
    this.shutdownSpy()
  }
}

const baseContext: Partial<Omit<AddonContext, 'addonConfig'>> = {
  dataDir: '/tmp/data',
}

function buildLoader(): AddonLoader {
  const loader = new AddonLoader()
  ;(loader as unknown as { addons: Map<string, unknown> }).addons.set('mock-addon', {
    declaration: { id: 'mock-addon', entry: './mock.js', slot: 'detector' },
    packageName: 'test-package',
    packageVersion: '0.1.0',
    addonClass: MockAddon,
  })
  return loader
}

/** Helper: get the first underlying MockAddon from the engine manager */
function getFirstAddon(manager: AddonEngineManager): MockAddon {
  const [addon] = manager.getActiveEngines().values()
  if (!(addon instanceof MockAddon)) throw new Error('expected a MockAddon engine')
  return addon
}

/** Helper: get all underlying MockAddons from the engine manager */
function getAllAddons(manager: AddonEngineManager): MockAddon[] {
  return [...manager.getActiveEngines().values()].filter((a) => a instanceof MockAddon)
}

describe('AddonEngineManager', () => {
  let loader: AddonLoader
  let manager: AddonEngineManager

  beforeEach(() => {
    loader = buildLoader()
    manager = new AddonEngineManager(loader, baseContext)
  })

  it('creates a new engine on first call', async () => {
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.5 })
    expect(manager.getActiveEngines().size).toBe(1)
    const addon = getFirstAddon(manager)
    expect(addon).toBeInstanceOf(MockAddon)
    expect(addon.initializeSpy).toHaveBeenCalledOnce()
    expect(addon.initializeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ addonConfig: { threshold: 0.5 } }),
    )
  })

  it('returns the same engine for the same effective config', async () => {
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.5 })
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.5 })
    // Same config → only one addon instance created
    expect(manager.getActiveEngines().size).toBe(1)
    const addon = getFirstAddon(manager)
    expect(addon.initializeSpy).toHaveBeenCalledOnce()
  })

  it('creates a new engine when config differs', async () => {
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.5 })
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.9 })
    expect(manager.getActiveEngines().size).toBe(2)
    const addons = getAllAddons(manager)
    expect(addons[0]).not.toBe(addons[1])
    expect(addons[0]!.initializeSpy).toHaveBeenCalledOnce()
    expect(addons[1]!.initializeSpy).toHaveBeenCalledOnce()
  })

  it('merges global config with camera override', async () => {
    await manager.getOrCreateEngine(
      'mock-addon',
      { threshold: 0.5, model: 'yolov8n' },
      { threshold: 0.8 }, // override
    )
    const addon = getFirstAddon(manager)
    expect(addon.initializeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ addonConfig: { threshold: 0.8, model: 'yolov8n' } }),
    )
  })

  it('getActiveEngines returns all created engines', async () => {
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.5 })
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.9 })
    const engines = manager.getActiveEngines()
    expect(engines.size).toBe(2)
  })

  it('shutdownEngine shuts down and removes a specific engine', async () => {
    const globalConfig = { threshold: 0.5 }
    await manager.getOrCreateEngine('mock-addon', globalConfig)
    const addon = getFirstAddon(manager)
    const configKey = manager.computeConfigKey('mock-addon', globalConfig)

    await manager.shutdownEngine(configKey)

    expect(addon.shutdownSpy).toHaveBeenCalledOnce()
    expect(manager.getActiveEngines().size).toBe(0)
  })

  it('shutdownEngine is a no-op for non-existent key', async () => {
    await expect(manager.shutdownEngine('nonexistent:key')).resolves.toBeUndefined()
  })

  it('shutdownAll shuts down all engines and clears map', async () => {
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.5 })
    await manager.getOrCreateEngine('mock-addon', { threshold: 0.9 })
    const addons = getAllAddons(manager)

    await manager.shutdownAll()

    expect(addons[0]!.shutdownSpy).toHaveBeenCalledOnce()
    expect(addons[1]!.shutdownSpy).toHaveBeenCalledOnce()
    expect(manager.getActiveEngines().size).toBe(0)
  })

  it('throws when addon is not registered', async () => {
    await expect(manager.getOrCreateEngine('unknown-addon', {})).rejects.toThrow(
      'Addon "unknown-addon" is not registered',
    )
  })
})
