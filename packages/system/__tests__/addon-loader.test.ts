import { describe, it, expect } from 'vitest'
import type { ICamstackAddon, AddonDeclaration, AddonContext } from '@camstack/types'
import { AddonLoader } from '../src/kernel/addon-loader'

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
  postBrokerStart(): void {}
  async initialize(_context: AddonContext): Promise<void> {}
  async shutdown(): Promise<void> {}
}

describe('AddonLoader', () => {
  it('starts with no addons registered', () => {
    const loader = new AddonLoader()
    expect(loader.listAddons()).toHaveLength(0)
  })

  it('hasAddon returns false for unknown addon', () => {
    const loader = new AddonLoader()
    expect(loader.hasAddon('nonexistent')).toBe(false)
  })

  it('getAddon returns undefined for unknown addon', () => {
    const loader = new AddonLoader()
    expect(loader.getAddon('nonexistent')).toBeUndefined()
  })

  it('createInstance throws for unknown addon', () => {
    const loader = new AddonLoader()
    expect(() => loader.createInstance('nonexistent')).toThrow(
      'Addon "nonexistent" is not registered',
    )
  })

  describe('with manually registered addon via loadFromPath', () => {
    async function buildLoader(): Promise<AddonLoader> {
      const loader = new AddonLoader()
      // Instead of a real file path, we inject via a helper that bypasses dynamic import
      // by monkeypatching. But that's complex — instead we test via a temp module.
      // We use vitest module mock by registering via the internal map through loadFromPath
      // with a virtual module path that we mock.
      //
      // For simplicity, directly test the internal register helper by using
      // a workaround: expose a registerAddon method or cast.
      // Since AddonLoader is a plain class, we can cast to `any` for testing purposes.
      ;(loader as unknown as { addons: Map<string, unknown> }).addons.set('mock-addon', {
        declaration: { id: 'mock-addon', entry: './mock.js', slot: 'detector' },
        packageName: 'test-package',
        addonClass: MockAddon,
      })
      return loader
    }

    it('getAddon returns the registered addon', async () => {
      const loader = await buildLoader()
      const addon = loader.getAddon('mock-addon')
      expect(addon).toBeDefined()
      expect(addon?.declaration.id).toBe('mock-addon')
      expect(addon?.packageName).toBe('test-package')
    })

    it('listAddons returns all registered addons', async () => {
      const loader = await buildLoader()
      const list = loader.listAddons()
      expect(list).toHaveLength(1)
      expect(list[0]?.declaration.id).toBe('mock-addon')
    })

    it('hasAddon returns true for registered addon', async () => {
      const loader = await buildLoader()
      expect(loader.hasAddon('mock-addon')).toBe(true)
    })

    it('createInstance returns a new instance of the addon', async () => {
      const loader = await buildLoader()
      const instance = loader.createInstance('mock-addon')
      expect(instance).toBeInstanceOf(MockAddon)
      expect(instance.id).toBe('mock-addon')
    })

    it('createInstance creates independent instances', async () => {
      const loader = await buildLoader()
      const a = loader.createInstance('mock-addon')
      const b = loader.createInstance('mock-addon')
      expect(a).not.toBe(b)
    })
  })

  it('loadFromDirectory handles non-existent directory gracefully', async () => {
    const loader = new AddonLoader()
    await expect(loader.loadFromDirectory('/nonexistent/path')).resolves.toBeUndefined()
    expect(loader.listAddons()).toHaveLength(0)
  })
})
