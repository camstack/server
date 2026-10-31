import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  HUB_ROOT_SPEC,
  readPendingRootSwap,
  readRestartIntentMarker,
  rootPackageDir,
  serverRootDir,
  writeDesktopAppState,
  type NpmExecFn,
} from '@camstack/node-root'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventFilter, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import {
  AGENT_RUNTIME_ADDON_ID,
  AgentRestartAnnouncer,
  AgentUpdateService,
  agentRuntimeManifestEntry,
  isRunningInContainer,
  resolveAgentPackageJsonPath,
  scheduleAgentRestart,
} from '../agent-update-service.js'
import { buildServerManagementProvider } from '../../api/core/server-management.provider.js'

const NOW = 1_700_000_000_000

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

let tmp: string
let dataDir: string
let runningPkgPath: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-update-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  runningPkgPath = path.join(tmp, 'running-package.json')
  fs.writeFileSync(
    runningPkgPath,
    JSON.stringify({ name: '@camstack/server', version: '1.1.40' }),
    'utf-8',
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Scaffold the required native prebuilds under a staging closure. */
function scaffoldNatives(closureDir: string): void {
  for (const rel of [
    'better-sqlite3/build/Release/better_sqlite3.node',
    '@img/sharp-linux-x64/lib/sharp.node',
    '@seydx/node-av-linux-x64/av.node',
  ]) {
    const full = path.join(closureDir, 'node_modules', ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'ELF', 'utf-8')
  }
}

interface MakeServiceArgs {
  readonly execNpm?: NpmExecFn
  readonly env?: NodeJS.ProcessEnv
  readonly restartAgent?: (requestedBy: string) => void
}

function makeService(args: MakeServiceArgs = {}): AgentUpdateService {
  return new AgentUpdateService({
    logger: makeLogger(),
    restartAgent: args.restartAgent ?? (() => undefined),
    dataDir,
    execNpm: args.execNpm ?? (async () => ({ stdout: '' })),
    env: args.env ?? { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
    now: () => NOW,
    runningPackageJsonPath: runningPkgPath,
  })
}

describe('AgentUpdateService — agent bindings', () => {
  it('reports the @camstack/server package with the shared server env markers', async () => {
    const svc = makeService({
      env: {
        CAMSTACK_SERVER_BOOT_MODE: 'data-root',
        CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.40',
        CAMSTACK_SEED_SERVER_DIR: tmp,
      },
    })
    // Seed dir version comes from <seedDir>/package.json — write one.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: '@camstack/server', version: '1.1.30' }),
      'utf-8',
    )
    const status = await svc.getServerPackageStatus()
    expect(status.packageName).toBe('@camstack/server')
    expect(status.runningVersion).toBe('1.1.40')
    expect(status.activeVersion).toBe('1.1.40')
    expect(status.seedVersion).toBe('1.1.30')
    expect(status.bootMode).toBe('data-root')
    expect(svc.getRunningRootPackage()).toEqual({ name: '@camstack/server', version: '1.1.40' })
  })

  it('checks npm for @camstack/server@latest', async () => {
    const execNpm = vi.fn<NpmExecFn>(async () => ({ stdout: '1.1.41\n' }))
    const svc = makeService({ execNpm })
    const result = await svc.checkServerUpdate()
    expect(execNpm).toHaveBeenCalledWith(
      ['view', '@camstack/server@latest', 'version'],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    )
    expect(result.latestVersion).toBe('1.1.41')
    expect(result.updateAvailable).toBe(true)
  })

  it('stages an update into .staging-*, arms the pending-root-swap marker, and restarts', async () => {
    const restartAgent = vi.fn()
    // npm installs into the STAGING cwd — scaffold a valid agent closure
    // (entry + version + native prebuilds) there so staging validation passes.
    const stagingAwareExecNpm: NpmExecFn = async (args, opts) => {
      if (args[0] === 'install' && opts.cwd !== undefined) {
        const pkgDir = rootPackageDir(opts.cwd, HUB_ROOT_SPEC)
        fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
        fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
        fs.writeFileSync(
          path.join(pkgDir, 'package.json'),
          JSON.stringify({ name: '@camstack/server', version: '1.1.41' }),
          'utf-8',
        )
        scaffoldNatives(opts.cwd)
      }
      return { stdout: '' }
    }
    const svc = makeService({ execNpm: stagingAwareExecNpm, restartAgent })
    const result = await svc.applyServerUpdate({ version: '1.1.41' })
    expect(result.accepted, result.message).toBe(true)
    expect(result.restarting).toBe(true)
    expect(restartAgent).toHaveBeenCalledOnce()
    // Single-copy model: a pending-root-swap marker points at the staged
    // closure (NOT a versions/<X> dir); the starter swaps it in on next boot.
    const marker = readPendingRootSwap(serverRootDir(dataDir))
    expect(marker?.version).toBe('1.1.41')
    expect(marker && fs.existsSync(marker.stagingPath)).toBe(true)
    expect(marker?.stagingPath.includes(`${path.sep}versions${path.sep}`)).toBe(false)
  })

  it('refuses updates from a workspace checkout', async () => {
    const svc = makeService({ env: { CAMSTACK_SERVER_BOOT_MODE: 'workspace' } })
    const result = await svc.applyServerUpdate({ version: '1.1.41' })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/workspace/i)
  })

  it('confirmBootHealthy is a GC no-op returning promoted:null (no probation)', () => {
    const svc = makeService({
      env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root', CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.41' },
    })
    expect(svc.confirmBootHealthy()).toEqual({ promoted: null })
  })

  it('rollback is unsupported in the single-copy model (no N-1)', async () => {
    const restartAgent = vi.fn()
    const svc = makeService({ restartAgent })
    const result = await svc.rollbackServerUpdate()
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/not supported|re-appl/i)
    expect(restartAgent).not.toHaveBeenCalled()
  })
})

describe('provider + manifest surface', () => {
  it('exposes exactly the server-management cap methods', () => {
    const provider = buildServerManagementProvider(makeService(), dataDir)
    expect(Object.keys(provider ?? {}).sort()).toEqual([
      'applyServerUpdate',
      'checkServerUpdate',
      'getLaunchOverrides',
      'getServerPackageStatus',
      'installDesktopUpdate',
      'restartServer',
      'rollbackServerUpdate',
      'setLaunchOverrides',
    ])
  })

  it('agentRuntimeManifestEntry declares server-management and node-certificates under agent-runtime', () => {
    expect(agentRuntimeManifestEntry()).toEqual({
      addonId: AGENT_RUNTIME_ADDON_ID,
      capabilities: ['server-management', 'node-certificates'],
    })
  })
})

describe('isRunningInContainer (restart-policy warning — security review #3)', () => {
  it('true when /.dockerenv exists, false otherwise', () => {
    expect(isRunningInContainer((p) => p === '/.dockerenv')).toBe(true)
    expect(isRunningInContainer(() => false)).toBe(false)
  })
})

describe('scheduleAgentRestart — restart-intent marker (phase 3 supervisor)', () => {
  // Fake timers so the 2s-grace self-SIGTERM never actually fires in the test
  // process; the marker write is synchronous BEFORE that timer is armed.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('drops a restart-intent marker in the server-root dir before exiting', () => {
    scheduleAgentRestart(makeLogger(), 'server-update: @camstack/server@1.2.3', dataDir)
    const marker = readRestartIntentMarker(serverRootDir(dataDir))
    expect(marker?.reason).toBe('server-update: @camstack/server@1.2.3')
    expect(typeof marker?.requestedAtMs).toBe('number')
  })

  it('ends a wedged restart with SIGKILL on itself, never process.exit', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    try {
      scheduleAgentRestart(makeLogger(), 'server-update: x', dataDir)
      vi.advanceTimersByTime(60_000)
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM')
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL')
      expect(exit).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      exit.mockRestore()
    }
  })

  it('writes no marker when no dataDir is provided', () => {
    scheduleAgentRestart(makeLogger(), 'server-update: x')
    expect(readRestartIntentMarker(serverRootDir(dataDir))).toBeNull()
  })
})

describe('resolveAgentPackageJsonPath', () => {
  it('finds the @camstack/server package.json one level up from dist/', () => {
    const pkgRoot = path.join(tmp, 'closure', 'node_modules', '@camstack', 'server')
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true })
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: '@camstack/server', version: '1.1.40' }),
      'utf-8',
    )
    expect(resolveAgentPackageJsonPath(path.join(pkgRoot, 'dist'))).toBe(
      path.join(pkgRoot, 'package.json'),
    )
  })
})

/** Records what the agent emits; nothing else is exercised. */
class RecordingBus implements IEventBus {
  readonly emitted: SystemEvent[] = []
  emit(event: SystemEvent): void {
    this.emitted.push(event)
  }
  subscribe(_filter: EventFilter, _handler: (event: SystemEvent) => void): () => void {
    return () => undefined
  }
  getRecent(): readonly SystemEvent[] {
    return []
  }
}

describe('the agent announces its own restart before exiting (D723)', () => {
  function serviceWith(bus: RecordingBus, restartAgent: () => void): AgentUpdateService {
    return new AgentUpdateService({
      logger: makeLogger(),
      restartAgent,
      dataDir,
      execNpm: async () => ({ stdout: '' }),
      env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root', CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.40' },
      now: () => NOW,
      runningPackageJsonPath: runningPkgPath,
      eventBus: bus,
      nodeId: 'agent-a',
    })
  }

  it('a plain restart emits system.restarting with the node, BEFORE the exit', () => {
    const bus = new RecordingBus()
    const order: string[] = []
    const svc = serviceWith(bus, () => order.push(`exit after ${bus.emitted.length} events`))
    const result = svc.restartNode()
    expect(result.accepted).toBe(true)
    expect(order).toEqual(['exit after 1 events'])
    expect(bus.emitted[0]).toMatchObject({
      category: 'system.restarting',
      data: {
        kind: 'manual',
        nodeId: 'agent-a',
        requestedBy: 'server-update: manual restart',
      },
    })
  })

  it('an update-driven restart carries the target version', async () => {
    const bus = new RecordingBus()
    const stagingAwareExecNpm: NpmExecFn = async (args, opts) => {
      if (args[0] === 'install' && opts.cwd !== undefined) {
        const pkgDir = rootPackageDir(opts.cwd, HUB_ROOT_SPEC)
        fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
        fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
        fs.writeFileSync(
          path.join(pkgDir, 'package.json'),
          JSON.stringify({ name: '@camstack/server', version: '1.1.41' }),
          'utf-8',
        )
        scaffoldNatives(opts.cwd)
      }
      return { stdout: '' }
    }
    const svc = new AgentUpdateService({
      logger: makeLogger(),
      restartAgent: () => undefined,
      dataDir,
      execNpm: stagingAwareExecNpm,
      env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
      now: () => NOW,
      runningPackageJsonPath: runningPkgPath,
      eventBus: bus,
      nodeId: 'agent-a',
    })
    const result = await svc.applyServerUpdate({ version: '1.1.41' })
    expect(result.accepted, result.message).toBe(true)
    const announced = bus.emitted.filter((e) => e.category === 'system.restarting')
    expect(announced).toHaveLength(1)
    expect(announced[0]?.data).toMatchObject({
      kind: 'framework-update',
      toVersion: '1.1.41',
      packageName: '@camstack/server',
      nodeId: 'agent-a',
    })
  })

  it('a desktop shell install announces the shell updating, with both app versions', () => {
    const bus = new RecordingBus()
    writeDesktopAppState(serverRootDir(dataDir), {
      appVersion: '1.2.10',
      available: true,
      downloaded: true,
      version: '1.2.11',
      checking: false,
      error: null,
      updatedAtMs: NOW,
    })
    const svc = new AgentUpdateService({
      logger: makeLogger(),
      restartAgent: () => undefined,
      dataDir,
      execNpm: async () => ({ stdout: '' }),
      env: { CAMSTACK_AGENT_APP_VERSION: '1.2.10' },
      readWrapperProbes: () => ({
        platform: 'darwin',
        dockerEnvFileExists: false,
        proc1Cgroup: null,
      }),
      now: () => NOW,
      runningPackageJsonPath: runningPkgPath,
      eventBus: bus,
      nodeId: 'agent-a',
    })
    expect(svc.installDesktopUpdate().accepted).toBe(true)
    expect(bus.emitted).toHaveLength(1)
    expect(bus.emitted[0]).toMatchObject({
      category: 'system.restarting',
      data: {
        kind: 'framework-update',
        what: 'desktop-shell',
        packageName: 'CamStack desktop app',
        fromVersion: '1.2.10',
        toVersion: '1.2.11',
        nodeId: 'agent-a',
      },
    })
  })

  it('a boot on a different container image announces node-updating once; the first boot is silent', () => {
    const bus = new RecordingBus()
    const svc = serviceWith(bus, () => undefined)
    svc.announceImageChangeIfAny('1.2.10', {})
    expect(bus.emitted).toHaveLength(0)
    svc.announceImageChangeIfAny('1.2.11', {})
    expect(bus.emitted).toHaveLength(1)
    expect(bus.emitted[0]).toMatchObject({
      category: 'system.restarting',
      data: {
        what: 'container-image',
        fromVersion: '1.2.10',
        toVersion: '1.2.11',
        nodeId: 'agent-a',
      },
    })
    svc.announceImageChangeIfAny('1.2.11', {})
    expect(bus.emitted).toHaveLength(1)
  })

  it('a bus bound later is the one announced on, under the bound node id', () => {
    const late = new RecordingBus()
    const announcer = new AgentRestartAnnouncer(makeLogger(), null, 'agent')
    announcer.announce({ kind: 'manual', requestedAt: 1 })
    expect(late.emitted).toHaveLength(0)
    announcer.bind(late, 'mac-mini')
    announcer.announce({ kind: 'manual', requestedAt: 2 })
    expect(late.emitted[0]?.data).toMatchObject({ nodeId: 'mac-mini', requestedAt: 2 })
  })
})
