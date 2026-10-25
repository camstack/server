/**
 * cap-providers-bulk-update.spec.ts
 *
 * Verifies the wire-up in buildAddonsProvider for:
 *   1. isSystem field added to listUpdates output
 *   2. list({ nodeId }) returns that node's installed versions
 *
 * NOTE (F3 Task 6): the in-memory bulk-coordinator delegation tests were
 * removed along with the coordinator + the 4 bulk tRPC procs — "Update all"
 * now routes through the lifecycle job engine (`addons.startJob`). The
 * remaining tests here cover the surviving listUpdates behavior. (The
 * `updateFrameworkPackage` cap + its deferRestart propagation were removed in
 * the single-copy framework collapse — framework updates ship via
 * applyServerUpdate.)
 *
 * Spec: docs/superpowers/specs/2026-05-21-addons-bulk-update-progress-design.md
 * Plan: docs/superpowers/plans/2026-06-23-f3-bulk-and-reconcile.md  (Task 6)
 * Plan: docs/superpowers/plans/2026-10-11-admin-ui-backlog.md  (Task 7)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IAddonsProvider } from '@camstack/types'
import { SYSTEM_PACKAGE } from '../core/addon/addon-package.service.js'

// ── Imports ───────────────────────────────────────────────────────────────────
import { buildAddonsProvider } from '../api/core/cap-providers.js'
import { initLifecycleRunner } from '../core/lifecycle/lifecycle-runner.singleton.js'
import { makeCtx } from './cap-routers/harness.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    scope: vi.fn(),
    child: vi.fn(),
  }
  // scope returns a scoped logger with the same shape
  logger.scope.mockReturnValue(logger)
  logger.child.mockReturnValue(logger)
  return logger
}

interface ProviderEnv {
  readonly provider: IAddonsProvider
  readonly psMock: Record<string, ReturnType<typeof vi.fn>>
  readonly arMock: {
    listAllAddons: ReturnType<typeof vi.fn>
    refreshRunnerStates: ReturnType<typeof vi.fn>
    getAddonHealthSnapshot: ReturnType<typeof vi.fn>
  }
  readonly brokerCall: ReturnType<typeof vi.fn>
}

function createProviderEnv(): ProviderEnv {
  // The runner is now a boot singleton fetched by buildAddonsProvider via
  // getLifecycleRunner(); init it once (idempotent) so the provider can build.
  initLifecycleRunner({
    dataDir: '/tmp/cap-providers-bulk-update-spec',
    fetchTarball: async () => Buffer.from(''),
    extract: async () => {},
    applyAddonUpdate: async () => {},
    emit: () => {},
  })
  const psMock: Record<string, ReturnType<typeof vi.fn>> = {
    getRollbackablePackages: vi.fn().mockReturnValue(new Set()),
    getAddonHealthSnapshot: vi.fn().mockReturnValue([]),
    listAllAddons: vi.fn().mockReturnValue([]),
    refreshRunnerStates: vi.fn().mockResolvedValue(undefined),
    listInstalled: vi.fn().mockReturnValue([]),
    installAndLoad: vi.fn().mockResolvedValue({ success: true }),
    installFromWorkspaceAndLoad: vi.fn().mockResolvedValue({ success: true }),
    isWorkspaceAvailable: vi.fn().mockResolvedValue(false),
    listWorkspacePackages: vi.fn().mockResolvedValue([]),
    uninstallAndReload: vi.fn().mockResolvedValue({ success: true }),
    reloadPackages: vi.fn().mockResolvedValue({ success: true }),
    searchNpm: vi.fn().mockResolvedValue([]),
    checkUpdates: vi.fn().mockResolvedValue([]),
    checkUpdatesForInstalled: vi.fn().mockResolvedValue([]),
    updatePackage: vi.fn().mockResolvedValue({ success: true }),
    rollbackPackage: vi.fn().mockResolvedValue({ success: true }),
    restartServer: vi.fn().mockResolvedValue({ success: true }),
    listFrameworkPackages: vi.fn().mockResolvedValue([]),
    getPackageVersions: vi.fn().mockResolvedValue([]),
    getAutoUpdateSettings: vi.fn().mockResolvedValue({ channel: 'stable', intervalSeconds: 3600 }),
    setAutoUpdateSettings: vi.fn().mockResolvedValue({ success: true }),
    getAddonAutoUpdate: vi.fn().mockResolvedValue({ channel: 'inherit' }),
    setAddonAutoUpdate: vi.fn().mockResolvedValue({ success: true }),
    packPackage: vi.fn().mockResolvedValue({ buffer: Buffer.alloc(0), version: '1.0.0' }),
  }

  const arMock = {
    listAddons: vi.fn().mockReturnValue([]),
    listAllAddons: vi.fn().mockReturnValue([]),
    refreshRunnerStates: vi.fn().mockResolvedValue(undefined),
    getAddonHealthSnapshot: vi.fn().mockReturnValue([]),
    getCapabilityRegistry: vi.fn().mockReturnValue({
      listCapabilities: vi.fn().mockReturnValue([]),
    }),
    getCustomActionRegistry: vi.fn().mockReturnValue({
      resolve: vi.fn().mockReturnValue(null),
    }),
    restartAddon: vi.fn().mockResolvedValue({ success: true }),
    retryAddonLoad: vi.fn().mockResolvedValue({ success: true }),
  }

  const lsMock = {
    createLogger: vi.fn().mockReturnValue(makeLogger()),
    query: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  }

  const brokerCall = vi.fn().mockResolvedValue({})
  const moleculerMock = {
    broker: {
      call: brokerCall,
    },
  }

  const configServiceMock = {}

  const ctx = makeCtx('admin')

  const provider = buildAddonsProvider(
    arMock as never,
    psMock as never,
    lsMock as never,
    moleculerMock as never,
    configServiceMock as never,
    ctx,
  )

  return { provider, psMock, arMock, brokerCall }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildAddonsProvider — listUpdates isSystem field', () => {
  let env: ProviderEnv

  beforeEach(() => {
    vi.clearAllMocks()
    env = createProviderEnv()
  })

  it('adds isSystem: true for SYSTEM_PACKAGE', async () => {
    const systemPkg = SYSTEM_PACKAGE
    env.psMock['checkUpdates']!.mockResolvedValue([
      {
        name: systemPkg,
        currentVersion: '0.1.38',
        latestVersion: '0.1.40',
        category: 'core',
        requiresRestart: true,
      },
    ])

    const result = await env.provider.listUpdates({ nodeId: 'hub' })

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe(systemPkg)
    expect(result[0]!.isSystem).toBe(true)
  })

  it('adds isSystem: false for non-framework packages', async () => {
    env.psMock['checkUpdates']!.mockResolvedValue([
      {
        name: '@camstack/addon-stream-broker',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        category: 'addon',
        requiresRestart: false,
      },
    ])

    const result = await env.provider.listUpdates({ nodeId: 'hub' })

    expect(result).toHaveLength(1)
    expect(result[0]!.isSystem).toBe(false)
  })

  it('handles mixed system and non-system packages correctly', async () => {
    env.psMock['checkUpdates']!.mockResolvedValue([
      {
        name: SYSTEM_PACKAGE,
        currentVersion: '0.1.38',
        latestVersion: '0.1.40',
        category: 'core',
        requiresRestart: true,
      },
      {
        name: '@camstack/addon-foo',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        category: 'addon',
        requiresRestart: false,
      },
    ])

    const result = await env.provider.listUpdates({ nodeId: 'hub' })

    expect(result).toHaveLength(2)
    const systemRow = result.find((r) => r.name === SYSTEM_PACKAGE)
    const fooRow = result.find((r) => r.name === '@camstack/addon-foo')
    expect(systemRow?.isSystem).toBe(true)
    expect(fooRow?.isSystem).toBe(false)
  })

  it('SYSTEM_PACKAGE gets isSystem: true', async () => {
    env.psMock['checkUpdates']!.mockResolvedValue([
      {
        name: SYSTEM_PACKAGE,
        currentVersion: '0.1.0',
        latestVersion: '0.1.1',
        category: 'core',
        requiresRestart: true,
      },
    ])

    const result = await env.provider.listUpdates({ nodeId: 'hub' })

    expect(result).toHaveLength(1)
    for (const row of result) {
      expect(row.isSystem).toBe(true)
    }
  })
})

describe('buildAddonsProvider — searchAvailable', () => {
  it('hands the capability filter to the npm search and marks installed packages', async () => {
    vi.clearAllMocks()
    const env = createProviderEnv()
    env.psMock['searchNpm']!.mockResolvedValue([
      { name: '@camstack/addon-tailscale', capabilities: ['network-access'], installed: false },
    ])
    env.psMock['listInstalled']!.mockReturnValue([{ name: '@camstack/addon-tailscale' }])

    const result = await env.provider.searchAvailable({ capability: 'network-access' })

    expect(env.psMock['searchNpm']).toHaveBeenCalledWith(undefined, 'network-access')
    expect(result[0]?.installed).toBe(true)
  })
})

describe('buildAddonsProvider — list accepts optional nodeId', () => {
  let env: ProviderEnv

  const HUB_VERSION = '1.0.0'
  const AGENT_VERSION = '2.3.4'
  const PKG = '@camstack/addon-stream-broker'

  function hubAddonRow(version: string) {
    return {
      manifest: {
        id: 'stream-broker',
        name: 'Stream broker',
        packageName: PKG,
        packageVersion: version,
        version,
      },
      source: 'installed' as const,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    env = createProviderEnv()
    env.arMock.listAllAddons.mockReturnValue([hubAddonRow(HUB_VERSION)])
  })

  it('omit / hub returns hub installed versions', async () => {
    const omitted = await env.provider.list(undefined)
    const hub = await env.provider.list({ nodeId: 'hub' })

    expect(omitted).toHaveLength(1)
    expect(omitted[0]!.manifest.packageVersion).toBe(HUB_VERSION)
    expect(hub[0]!.manifest.packageVersion).toBe(HUB_VERSION)
    expect(env.brokerCall).not.toHaveBeenCalled()
  })

  it('list for agent returns agent versions, not hub, when fixtures differ', async () => {
    env.brokerCall.mockResolvedValue({
      addons: [
        {
          id: 'stream-broker',
          status: 'running',
          packageName: PKG,
          version: AGENT_VERSION,
        },
      ],
    })

    const result = await env.provider.list({ nodeId: 'agent-a' })

    expect(result).toHaveLength(1)
    expect(result[0]!.manifest.packageVersion).toBe(AGENT_VERSION)
    expect(result[0]!.manifest.packageVersion).not.toBe(HUB_VERSION)
    expect(env.brokerCall).toHaveBeenCalledWith(
      '$agent.status',
      {},
      expect.objectContaining({ nodeID: 'agent-a' }),
    )
  })

  it('list for agent omits packages the agent does not have', async () => {
    env.brokerCall.mockResolvedValue({ addons: [] })

    const result = await env.provider.list({ nodeId: 'agent-a' })

    expect(result).toHaveLength(0)
  })
})
