import { describe, it, expect, afterEach, vi } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createAddonService } from '../../moleculer/addon-service-factory.js'
import type { ICamstackAddon, AddonDeclaration } from '@camstack/types'

function makeTestAddon(overrides?: Partial<ICamstackAddon>): ICamstackAddon {
  return {
    manifest: { id: 'test-addon', name: 'Test Addon' },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getConfigSchema: vi.fn().mockReturnValue({ sections: [] }),
    getConfig: vi.fn().mockReturnValue({}),
    ...overrides,
  } as unknown as ICamstackAddon
}

function makeTestProviders(): Map<string, unknown> {
  return new Map([['detector', { detect: vi.fn().mockResolvedValue({ detections: [] }) }]])
}

const testDeclaration: AddonDeclaration = {
  id: 'test-addon',
  entry: './dist/index.js',
  capabilities: [{ name: 'detector' }],
}

describe('createAddonService', () => {
  let broker: ServiceBroker

  afterEach(async () => {
    if (broker) await broker.stop()
  })

  it('creates a Moleculer service schema from an addon', () => {
    const addon = makeTestAddon()
    const providers = makeTestProviders()
    const schema = createAddonService(addon, testDeclaration, { providers })
    expect(schema.name).toBe('test-addon')
    expect(schema.actions?.['detector.detect']).toBeDefined()
  })

  it('routes action calls to registered provider', async () => {
    const detectFn = vi.fn().mockResolvedValue({ detections: ['cat'] })
    const addon = makeTestAddon()
    const providers = new Map<string, unknown>([['detector', { detect: detectFn }]])

    broker = new ServiceBroker({ nodeID: 'test', transporter: 'Fake', logger: false })
    const schema = createAddonService(addon, testDeclaration, { providers })
    broker.createService(schema)
    await broker.start()

    const result = await broker.call('test-addon.detector.detect', { frame: 'abc' })
    expect(detectFn).toHaveBeenCalledWith({ frame: 'abc' })
    expect(result).toEqual({ detections: ['cat'] })
  })

  it('exposes addon metadata in service metadata', () => {
    const addon = makeTestAddon()
    const providers = makeTestProviders()
    const schema = createAddonService(addon, testDeclaration, { providers })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Moleculer types metadata as `any`
    expect(schema.metadata?.addonId).toBe('test-addon')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Moleculer types metadata as `any`
    expect(schema.metadata?.capabilities).toEqual(testDeclaration.capabilities)
  })
})
