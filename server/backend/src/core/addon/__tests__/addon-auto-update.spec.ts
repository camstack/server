import type { InstalledPackage, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Resolved against the `vi.mock` below (hoisted above this import by vitest).
import { AddonPackageService, SYSTEM_PACKAGE } from '../addon-package.service.js'

// --- Mock the lifecycle runner singleton -----------------------------------
// The scheduler calls `getLifecycleRunner()` lazily inside `runAutoUpdate`.
// We replace the singleton module with a fake whose `startJob` is a spy so we
// can assert the engine bulk job is built exactly once with the right targets.
/** The one field set this spec reads off the job the scheduler starts. */
interface StartedJob {
  readonly kind: string
  readonly createdBy: string
  readonly targets: ReadonlyArray<{ readonly name: string; readonly version: string }>
}

// `vi.hoisted`, because `vi.mock` is hoisted above every declaration and its
// factory runs when the service module is imported — a plain `const` here
// would still be in its temporal dead zone at that moment.
const { startJob, eventEmit } = vi.hoisted(() => ({
  startJob: vi.fn(async (_job: StartedJob) => ({ jobId: 'job-1' })),
  eventEmit: vi.fn(),
}))
vi.mock('../../lifecycle/lifecycle-runner.singleton.js', () => ({
  getLifecycleRunner: () => ({
    startJob,
    getJob: () => null,
    listJobs: () => [],
    cancelJob: () => ({ cancelled: false }),
    reconcile: async () => ({ resumed: 0, failed: 0 }),
  }),
}))

const infoLines: Array<{ message: string; meta: Record<string, unknown> | undefined }> = []

/** Minimal scoped logger that records `info` lines for the move assertion. */
function fakeLogger(): IScopedLogger {
  const noop = (): void => {}
  return {
    info: (message: string, extras?: { meta?: Record<string, unknown> }) => {
      infoLines.push({ message, meta: extras?.meta })
    },
    warn: noop,
    error: noop,
    debug: noop,
  } as unknown as IScopedLogger
}

/** Build a service with stubbed dependencies; only the scheduler path is exercised. */
function buildService(): InstanceType<typeof AddonPackageService> {
  const loggingService = { createLogger: () => fakeLogger() }
  const stub = { emit: eventEmit }
  // The constructor only needs `loggingService.createLogger`; the rest are held
  // as references and not touched by `runAutoUpdate`.
  return new AddonPackageService(
    loggingService as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
    stub as never,
  )
}

/** Fake npm-registry response: every name resolves to `latest: <newVersion>`. */
function fakeRegistry(latestByEncodedName: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    const encoded = url.split('/').pop() ?? ''
    const latest = latestByEncodedName[encoded]
    if (!latest) {
      return new Response(null, { status: 404 })
    }
    return new Response(JSON.stringify({ 'dist-tags': { latest } }), { status: 200 })
  }) as typeof fetch
}

describe('runAutoUpdate → single engine bulk job', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    startJob.mockClear()
    eventEmit.mockClear()
    infoLines.length = 0
  })

  afterEach(() => {
    fetchSpy?.mockRestore()
    fetchSpy = null
    vi.restoreAllMocks()
  })

  it('routes addon candidates through ONE startJob and EXCLUDES the framework package', async () => {
    const service = buildService()

    const installed: InstalledPackage[] = [
      { name: '@camstack/addon-pipeline', version: '1.0.0', dir: '/x/pipeline' },
      { name: '@camstack/addon-recorder', version: '2.0.0', dir: '/x/recorder' },
      { name: SYSTEM_PACKAGE, version: '0.9.0', dir: '/x/system' },
    ]
    vi.spyOn(service, 'listInstalled').mockReturnValue(installed)
    // Force every package onto the 'latest' channel without touching the
    // config persistence / scheduler timer.
    vi.spyOn(service, 'getEffectiveAutoUpdateChannel').mockReturnValue('latest')

    // Newer versions advertised for all three.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      fakeRegistry({
        '@camstack%2Faddon-pipeline': '1.1.0',
        '@camstack%2Faddon-recorder': '2.1.0',
        '@camstack%2Fsystem': '1.0.0',
      }),
    )

    const updateSpy = vi.spyOn(service, 'updatePackage')

    await service.runAutoUpdate()

    expect(updateSpy).not.toHaveBeenCalled()
    expect(startJob).toHaveBeenCalledTimes(1)

    const arg = startJob.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error('startJob was called without a job')
    expect(arg.kind).toBe('update')
    expect(arg.createdBy).toBe('system')
    // 2026-07-22: framework packages are excluded at CANDIDATE level — they
    // ship via applyServerUpdate only (the engine skip stays as the backstop).
    expect(arg.targets).toHaveLength(2)

    const byName = new Map(arg.targets.map((t) => [t.name, t.version]))
    expect(byName.get('@camstack/addon-pipeline')).toBe('1.1.0')
    expect(byName.get('@camstack/addon-recorder')).toBe('2.1.0')
    expect(byName.has(SYSTEM_PACKAGE)).toBe(false)
    // ONE batched event for the whole `addon` target, not one per package —
    // this assertion said 2 from the per-candidate era and had been red on
    // main ever since `UpdateAvailabilityEmitter` started batching by target.
    expect(eventEmit).toHaveBeenCalledTimes(1)
    expect(eventEmit.mock.calls[0]![0]).toMatchObject({
      category: 'update.available',
      data: {
        target: 'addon',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
      },
    })
  })

  it('moves DOWN when registry latest is lower, and logs from, to and the reason', async () => {
    const service = buildService()
    const installed: InstalledPackage[] = [
      { name: '@camstack/addon-post-analysis', version: '1.2.7', dir: '/x/pa' },
      { name: '@camstack/addon-pipeline', version: '1.2.6', dir: '/x/pipeline' },
    ]
    vi.spyOn(service, 'listInstalled').mockReturnValue(installed)
    vi.spyOn(service, 'getEffectiveAutoUpdateChannel').mockReturnValue('latest')
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      fakeRegistry({
        '@camstack%2Faddon-post-analysis': '1.2.6',
        '@camstack%2Faddon-pipeline': '1.2.6',
      }),
    )
    await service.runAutoUpdate()
    expect(startJob).toHaveBeenCalledTimes(1)
    const arg = startJob.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error('startJob was called without a job')
    expect(arg.targets).toEqual([{ name: '@camstack/addon-post-analysis', version: '1.2.6' }])
    const move = infoLines.find((line) => line.message === 'Moving addon to registry latest')
    expect(move?.meta).toMatchObject({
      name: '@camstack/addon-post-analysis',
      from: '1.2.7',
      to: '1.2.6',
      reason: 'installed version differs from registry latest',
    })
  })

  it('changes nothing when the registry cannot be read', async () => {
    const service = buildService()
    vi.spyOn(service, 'listInstalled').mockReturnValue([
      { name: '@camstack/addon-pipeline', version: '1.2.6', dir: '/x/pipeline' },
    ])
    vi.spyOn(service, 'getEffectiveAutoUpdateChannel').mockReturnValue('latest')
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('ENOTFOUND registry.npmjs.org'))
    await service.runAutoUpdate()
    expect(startJob).not.toHaveBeenCalled()
    expect(infoLines.some((line) => line.message === 'Moving addon to registry latest')).toBe(false)
  })

  it('starts NO job when there are no candidates with a newer version', async () => {
    const service = buildService()

    const installed: InstalledPackage[] = [
      { name: '@camstack/addon-pipeline', version: '1.0.0', dir: '/x/pipeline' },
    ]
    vi.spyOn(service, 'listInstalled').mockReturnValue(installed)
    vi.spyOn(service, 'getEffectiveAutoUpdateChannel').mockReturnValue('latest')

    // Registry advertises the SAME version that's already installed.
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(fakeRegistry({ '@camstack%2Faddon-pipeline': '1.0.0' }))

    await service.runAutoUpdate()

    expect(startJob).not.toHaveBeenCalled()
  })
})

describe('isVersionNewer', () => {
  it('orders plain triples, prereleases below releases, and fails safe on garbage', async () => {
    const { isVersionNewer } = await import('../addon-package.service.js')
    expect(isVersionNewer('1.2.7', '1.2.6')).toBe(true)
    expect(isVersionNewer('1.2.6', '1.2.6')).toBe(false)
    expect(isVersionNewer('1.2.6', '1.2.7')).toBe(false)
    expect(isVersionNewer('2.0.0', '1.9.9')).toBe(true)
    expect(isVersionNewer('1.2.6', '1.2.6-dev')).toBe(true)
    expect(isVersionNewer('1.2.6-dev', '1.2.6')).toBe(false)
    expect(isVersionNewer('not-a-version', '1.0.0')).toBe(false)
    expect(isVersionNewer('1.0.0', 'not-a-version')).toBe(false)
  })
})
