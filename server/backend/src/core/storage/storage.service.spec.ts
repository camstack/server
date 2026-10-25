import { describe, it, expect, vi } from 'vitest'
import { StorageService } from './storage.service'
import type { ICoreStorageProvider as IStorageProvider, IStorageLocation } from '@camstack/system'

const createMockProvider = (): IStorageProvider => {
  const mockLocation: IStorageLocation = { structured: undefined, files: undefined }
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getLocation: vi.fn().mockReturnValue(mockLocation),
    export: vi.fn(),
    import: vi.fn(),
  }
}

describe('StorageService', () => {
  const createService = (): StorageService => {
    return new StorageService()
  }

  it('delegates getLocation to active provider', () => {
    const service = createService()
    const provider = createMockProvider()
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    service.setProvider(provider)

    const result = service.getLocation('data')

    expect(provider.getLocation).toHaveBeenCalledWith('data')
    expect(result).toBeDefined()
  })

  it('maps legacy location names to new names', () => {
    const service = createService()
    const provider = createMockProvider()
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    service.setProvider(provider)

    // Legacy 'config' and 'events' both map to 'data'.
    // StorageManager.getLocation accepts `StorageLocationName | string`,
    // so string literals flow through without casts.
    service.getLocation('config')
    expect(provider.getLocation).toHaveBeenCalledWith('data')

    service.getLocation('events')
    expect(provider.getLocation).toHaveBeenNthCalledWith(2, 'data')
  })

  it('throws if no provider set', () => {
    const service = createService()

    expect(() => service.getLocation('data')).toThrow('No storage provider configured')
    expect(() => service.getProvider()).toThrow('No storage provider configured')
  })

  it('setProvider changes the active provider', () => {
    const service = createService()
    const provider1 = createMockProvider()
    const provider2 = createMockProvider()

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    service.setProvider(provider1)
    expect(service.getProvider()).toBe(provider1)

    // eslint-disable-next-line @typescript-eslint/no-deprecated
    service.setProvider(provider2)
    expect(service.getProvider()).toBe(provider2)

    service.getLocation('data')
    expect(provider2.getLocation).toHaveBeenCalledWith('data')
    expect(provider1.getLocation).not.toHaveBeenCalled()
  })
})
