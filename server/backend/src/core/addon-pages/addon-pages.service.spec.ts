import { describe, it, expect, vi } from 'vitest'

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}))

import * as fs from 'node:fs'
import { AddonPagesService } from './addon-pages.service'
import type { CapabilityService } from '../capability/capability.service'
import type { LoggingService } from '../logging/logging.service'
import type { ConfigService } from '../config/config.service'
import type { IAddonPageProvider, AddonPageDeclaration, IScopedLogger } from '@camstack/types'

function createMockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

function createMockLoggingService(): LoggingService {
  return {
    createLogger: vi.fn().mockReturnValue(createMockLogger()),
  } as unknown as LoggingService
}

function createMockConfigService(): ConfigService {
  return {
    get: vi.fn().mockReturnValue('./data'),
  } as unknown as ConfigService
}

function createMockPageProvider(
  id: string,
  pages: readonly AddonPageDeclaration[],
): IAddonPageProvider {
  return {
    id,
    listPages: () => pages,
  }
}

/**
 * AddonPagesService now resolves bundles via the `addon-pages-source`
 * collection cap (split from the public `addon-pages` singleton cap
 * earlier this session).
 */
function createMockCapabilityService(providers: IAddonPageProvider[] = []): CapabilityService {
  return {
    getSingleton: vi.fn(() => null),
    getCollection: vi.fn((capability: string) => {
      if (capability === 'addon-pages-source') return providers
      return []
    }),
    resolveForDevice: vi.fn(() => null),
    resolveCollectionForDevice: vi.fn(() => []),
    setRegistry: vi.fn(),
    getRegistry: vi.fn(() => null),
  } as unknown as CapabilityService
}

function buildService(providers: IAddonPageProvider[] = []): AddonPagesService {
  return new AddonPagesService(
    createMockLoggingService(),
    createMockConfigService(),
    createMockCapabilityService(providers),
  )
}

describe('AddonPagesService.resolveBundle', () => {
  it('should return null for unregistered addon', () => {
    const service = buildService([])
    const result = service.resolveBundle('nonexistent', 'dist/pages/main.js')
    expect(result).toBeNull()
  })

  it('should return null when file does not exist', () => {
    const provider = createMockPageProvider('benchmark', [])
    const service = buildService([provider])

    const existsMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>
    existsMock.mockReturnValue(false)

    const result = service.resolveBundle('benchmark', 'dist/pages/benchmark.js')
    expect(result).toBeNull()
  })

  it('should return resolved path when file exists', () => {
    const provider = createMockPageProvider('benchmark', [])
    const service = buildService([provider])

    const existsMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>
    existsMock.mockReturnValue(true)

    const result = service.resolveBundle('benchmark', 'dist/pages/benchmark.js')
    expect(result).not.toBeNull()
    expect(result).toContain('addon-benchmark')
    expect(result).toContain('dist/pages/benchmark.js')
  })

  it('should deny path traversal attempts', () => {
    const provider = createMockPageProvider('benchmark', [])
    const service = buildService([provider])
    const result = service.resolveBundle('benchmark', '../../etc/passwd')
    expect(result).toBeNull()
  })

  it('should deny absolute path traversal', () => {
    const provider = createMockPageProvider('benchmark', [])
    const service = buildService([provider])
    const result = service.resolveBundle('benchmark', '../../../etc/passwd')
    expect(result).toBeNull()
  })
})
