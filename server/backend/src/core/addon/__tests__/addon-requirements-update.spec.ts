import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigService } from '../../config/config.service'
import { EventBusService } from '../../events/event-bus.service'
import { LoggingService } from '../../logging/logging.service'
import { NotificationServiceWrapper } from '../../notification/notification-wrapper.service'
import { ToastServiceWrapper } from '../../notification/toast-wrapper.service'
import { AddonPackageService } from '../addon-package.service.js'
import { AddonRegistryService } from '../addon-registry.service.js'

vi.mock('../../lifecycle/lifecycle-runner.singleton.js', () => ({
  getLifecycleRunner: () => ({ startJob: vi.fn() }),
}))

const emit = vi.fn()

/** A class instance with only the members the spec sets: no constructor, no cast. */
function stubOf<T extends object>(ctor: { readonly prototype: T }, members: object): T {
  const instance: T = Object.create(ctor.prototype)
  for (const [key, value] of Object.entries(members)) {
    Object.defineProperty(instance, key, { value, writable: true, configurable: true })
  }
  return instance
}

function logger(): IScopedLogger {
  const noop = (): void => {}
  const sink: IScopedLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => sink,
    withTags: () => sink,
  }
  return sink
}

function build(serverVersion: string | null): AddonPackageService {
  return new AddonPackageService(
    stubOf(LoggingService, { createLogger: () => logger() }),
    stubOf(EventBusService, { emit }),
    stubOf(ConfigService, { emit }),
    stubOf(AddonRegistryService, { emit }),
    stubOf(NotificationServiceWrapper, { emit }),
    stubOf(ToastServiceWrapper, { emit }),
    undefined,
    () => serverVersion,
  )
}

/** A registry whose every version document declares `camstack.requires.server`. */
function registryRequiring(server: string, latest = '1.3.0'): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        name: '@camstack/addon-x',
        version: latest,
        camstack: { requires: { server } },
      }),
      { status: 200 },
    )
}

describe('addon requirements (D989)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    emit.mockClear()
  })

  it('updatePackage refuses an addon whose target needs a newer server, naming both versions', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(registryRequiring('>=1.3.0'))
    const service = build('1.2.0')

    const result = await service.updatePackage('@camstack/addon-x', '1.3.0')

    expect(result.success).toBe(false)
    expect(result.unmet).toEqual([{ kind: 'server-too-old', required: '1.3.0', running: '1.2.0' }])
    expect(result.error).toContain('1.3.0')
    expect(result.error).toContain('1.2.0')
  })

  it('an unreadable running server never passes a declared minimum', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(registryRequiring('>=1.3.0'))
    const result = await build(null).updatePackage('@camstack/addon-x', '1.3.0')
    expect(result.success).toBe(false)
    expect(result.unmet?.[0]?.kind).toBe('server-too-old')
  })

  it('updatePackage refuses when the registry document for the target cannot be read', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('unavailable', { status: 503 }),
    )
    const result = await build('1.2.0').updatePackage('@camstack/addon-x', '1.3.0')
    expect(result.success).toBe(false)
    expect(result.error).toContain('could not be read')
    expect(result.error).toContain('503')

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('socket hang up')
    })
    const thrown = await build('1.2.0').updatePackage('@camstack/addon-x', '1.3.0')
    expect(thrown.success).toBe(false)
    expect(thrown.error).toContain('socket hang up')
  })

  it('the update sweep lists a held update as blocked and does not announce it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(registryRequiring('>=1.3.0'))
    const service = build('1.2.0')

    const updates = await service.checkUpdatesForInstalled([
      { name: '@camstack/addon-x', version: '1.2.0' },
    ])

    expect(updates).toHaveLength(1)
    expect(updates[0]?.blockedBy).toEqual([
      { kind: 'server-too-old', required: '1.3.0', running: '1.2.0' },
    ])
    expect(emit).not.toHaveBeenCalled()
  })

  it('the update sweep offers an update normally when the server meets the minimum', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(registryRequiring('>=1.3.0'))
    const updates = await build('1.3.0').checkUpdatesForInstalled([
      { name: '@camstack/addon-x', version: '1.2.0' },
    ])
    expect(updates).toHaveLength(1)
    expect(updates[0]?.blockedBy).toBeUndefined()
    expect(updates[0]?.latestVersion).toBe('1.3.0')
  })
})
