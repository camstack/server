import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddonPackageService } from '../addon-package.service.js'

vi.mock('../../lifecycle/lifecycle-runner.singleton.js', () => ({
  getLifecycleRunner: () => ({ startJob: vi.fn() }),
}))

const emit = vi.fn()

function logger(): IScopedLogger {
  const noop = (): void => {}
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as IScopedLogger
}

function build(serverVersion: string | null): AddonPackageService {
  const stub = { emit }
  return new AddonPackageService(
    { createLogger: () => logger() } as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    undefined,
    () => serverVersion,
  )
}

/** A registry whose every version document declares `camstack.requires.server`. */
function registryRequiring(server: string, latest = '1.3.0'): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        name: '@camstack/addon-x',
        version: latest,
        camstack: { requires: { server } },
      }),
      { status: 200 },
    )) as typeof fetch
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
