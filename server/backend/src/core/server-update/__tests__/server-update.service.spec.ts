/**
 * ServerUpdateService (hub adapter) — SINGLE-COPY model (2026-07-18 collapse).
 *
 * The hub class is a thin binding over the shared `RootUpdateService`
 * (`@camstack/node-root`, bundled into `dist/server-root/index.js`); the engine
 * itself is exhaustively covered by `packages/node-root/.../root-update-service.spec.ts`.
 * This suite verifies that the SAME single-copy behaviour holds THROUGH the hub
 * adapter's constructor (`@camstack/server` spec, `CAMSTACK_SERVER_*` env
 * markers, hub data-dir + running package.json).
 *
 * Single-copy semantics under test:
 *   - `applyServerUpdate` stages a closure into a `.staging-*` dir, writes the
 *     `.pending-root-swap.json` marker and restarts — NO `versions/<X>`, NO
 *     probation `state.json.pendingBoot`, NO N-1.
 *   - `rollbackServerUpdate` is always refused (no retained previous copy).
 *   - `confirmBootHealthy` is a no-op GC (nothing to promote).
 *   - `getServerPackageStatus` reports `previousVersion: null`,
 *     `rolledBack: null`, `stateFileCorrupt: false`, and derives
 *     `pending-restart` from the swap marker.
 *
 * Spec: docs/superpowers/specs/2026-07-18-single-framework-copy-collapse-design.md
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  readPendingRootSwap,
  serverPackageDir,
  serverRootDir,
  stagingDirPath,
  writePendingRootSwap,
} from '../../../server-root/index.js'
import { ServerUpdateService, type NpmExecFn } from '../server-update.service.js'

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-update-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  runningPkgPath = path.join(tmp, 'running-package.json')
  fs.writeFileSync(
    runningPkgPath,
    JSON.stringify({ name: '@camstack/server', version: '1.1.50' }),
    'utf-8',
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface MakeServiceArgs {
  readonly execNpm?: NpmExecFn
  readonly env?: NodeJS.ProcessEnv
  readonly restartServer?: (requestedBy: string) => void
}

function makeService(args: MakeServiceArgs = {}): ServerUpdateService {
  return new ServerUpdateService({
    logger: makeLogger(),
    restartServer: args.restartServer ?? (() => undefined),
    dataDir,
    execNpm: args.execNpm ?? (async () => ({ stdout: '' })),
    env: args.env ?? { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
    now: () => NOW,
    runningPackageJsonPath: runningPkgPath,
  })
}

/** The `.node` prebuilds every staged closure must carry (native assertion). */
const NATIVE_PREBUILDS: readonly string[] = [
  'better-sqlite3/build/Release/better_sqlite3.node',
  '@img/sharp-linux-x64/lib/sharp.node',
  '@seydx/node-av-linux-x64/av.node',
]

/**
 * execNpm mock. Answers `npm view` with `version`, and on `npm install`
 * scaffolds a VALID staged closure into the staging cwd — the loadable entry,
 * a matching package.json, and the required native prebuilds — so
 * `stageClosure`'s validation + native assertion pass, mirroring a real
 * `npm install` of the closure into `.staging-*`.
 */
function installExec(version: string): NpmExecFn {
  return async (npmArgs, opts) => {
    if (npmArgs[0] === 'view') return { stdout: `${version}\n` }
    expect(npmArgs[0]).toBe('install')
    const cwd = opts.cwd ?? ''
    expect(cwd).not.toBe('')
    const pkgDir = serverPackageDir(cwd)
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// staged entry', 'utf-8')
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@camstack/server', version }),
      'utf-8',
    )
    for (const rel of NATIVE_PREBUILDS) {
      const full = path.join(cwd, 'node_modules', ...rel.split('/'))
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, 'ELF', 'utf-8')
    }
    return { stdout: '' }
  }
}

describe('checkServerUpdate', () => {
  it('reports an available update from the registry', async () => {
    const execNpm: NpmExecFn = async (npmArgs) => {
      expect(npmArgs).toContain('view')
      expect(npmArgs).toContain('@camstack/server@latest')
      return { stdout: '1.1.51\n' }
    }
    const service = makeService({ execNpm })
    const result = await service.checkServerUpdate()
    expect(result).toMatchObject({
      latestVersion: '1.1.51',
      runningVersion: '1.1.50',
      updateAvailable: true,
      error: null,
    })
  })

  it('reports no update when latest equals running', async () => {
    const service = makeService({ execNpm: async () => ({ stdout: '1.1.50\n' }) })
    const result = await service.checkServerUpdate()
    expect(result.updateAvailable).toBe(false)
  })

  it('surfaces registry failures without throwing', async () => {
    const service = makeService({
      execNpm: async () => {
        throw new Error('ENOTFOUND registry')
      },
    })
    const result = await service.checkServerUpdate()
    expect(result.error).toMatch(/ENOTFOUND/)
    expect(result.updateAvailable).toBe(false)
  })
})

describe('applyServerUpdate (single-copy stage + swap-on-restart)', () => {
  it('stages into .staging-*, writes the pending-root-swap marker, then restarts', async () => {
    const restartServer = vi.fn()
    const service = makeService({ execNpm: installExec('1.1.51'), restartServer })

    const result = await service.applyServerUpdate({ version: '1.1.51' })
    expect(result).toMatchObject({ accepted: true, targetVersion: '1.1.51', restarting: true })

    // The pending-root-swap marker (NOT state.json.pendingBoot) is armed, and it
    // points at a live `.staging-*` closure — never a versions/<X> dir.
    const marker = readPendingRootSwap(serverRootDir(dataDir))
    expect(marker?.version).toBe('1.1.51')
    expect(marker && fs.existsSync(marker.stagingPath)).toBe(true)
    expect(marker?.stagingPath.includes(`${path.sep}versions${path.sep}`)).toBe(false)
    const entry = path.join(serverPackageDir(marker?.stagingPath ?? ''), 'dist', 'launcher.js')
    expect(fs.existsSync(entry)).toBe(true)

    expect(restartServer).toHaveBeenCalledOnce()
  })

  it('resolves latest when no explicit version is given', async () => {
    const restartServer = vi.fn()
    const service = makeService({ execNpm: installExec('1.1.52'), restartServer })
    const result = await service.applyServerUpdate({})
    expect(result).toMatchObject({ accepted: true, targetVersion: '1.1.52' })
    expect(readPendingRootSwap(serverRootDir(dataDir))?.version).toBe('1.1.52')
  })

  it('refuses in workspace boot mode', async () => {
    const service = makeService({ env: { CAMSTACK_SERVER_BOOT_MODE: 'workspace' } })
    const result = await service.applyServerUpdate({ version: '1.1.51' })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/workspace/i)
  })

  it('refuses when the target version is already running', async () => {
    const service = makeService({ execNpm: installExec('1.1.50') })
    const result = await service.applyServerUpdate({ version: '1.1.50' })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/already running/i)
  })

  it('refuses when a version is already staged and awaiting restart', async () => {
    writePendingRootSwap(serverRootDir(dataDir), {
      schemaVersion: 1,
      version: '1.1.51',
      stagingPath: path.join(serverRootDir(dataDir), '.staging-1.1.51-1-1'),
      requestedAtMs: NOW,
    })
    const restartServer = vi.fn()
    const service = makeService({ execNpm: installExec('1.1.52'), restartServer })
    const result = await service.applyServerUpdate({ version: '1.1.52' })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/already staged/i)
    // The armed marker is untouched — last write must NOT win silently.
    expect(readPendingRootSwap(serverRootDir(dataDir))?.version).toBe('1.1.51')
    expect(restartServer).not.toHaveBeenCalled()
  })

  it('fails staging (no marker, no restart) when the staged closure is invalid', async () => {
    const restartServer = vi.fn()
    const service = makeService({
      // install "succeeds" but produces no closure — validation fails.
      execNpm: async (npmArgs) => (npmArgs[0] === 'view' ? { stdout: '1.1.51\n' } : { stdout: '' }),
      restartServer,
    })
    const result = await service.applyServerUpdate({ version: '1.1.51' })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/staging failed/i)
    expect(restartServer).not.toHaveBeenCalled()
    expect(readPendingRootSwap(serverRootDir(dataDir))).toBeNull()
  })

  it('fails staging (no marker) when the staged closure lacks native prebuilds', async () => {
    const restartServer = vi.fn()
    // Scaffold a loadable closure WITHOUT the native prebuilds.
    const execNpm: NpmExecFn = async (npmArgs, opts) => {
      if (npmArgs[0] === 'view') return { stdout: '1.1.51\n' }
      const pkgDir = serverPackageDir(opts.cwd ?? '')
      fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@camstack/server', version: '1.1.51' }),
        'utf-8',
      )
      return { stdout: '' }
    }
    const service = makeService({ execNpm, restartServer })
    const result = await service.applyServerUpdate({ version: '1.1.51' })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/native prebuilds/i)
    expect(restartServer).not.toHaveBeenCalled()
    expect(readPendingRootSwap(serverRootDir(dataDir))).toBeNull()
  })

  it('refuses while another operation is in flight (concurrent stage)', async () => {
    // A holder, not a `let`: assigned inside the executor, it would be narrowed
    // to its initializer (`null`) at the call site below.
    const install: { release: (() => void) | null } = { release: null }
    const gate = new Promise<void>((resolve) => {
      install.release = resolve
    })
    const execNpm: NpmExecFn = async (npmArgs, opts) => {
      if (npmArgs[0] === 'view') return { stdout: '1.1.52\n' }
      await gate
      return await installExec('1.1.52')(npmArgs, opts)
    }
    const service = makeService({ execNpm })
    const applyPromise = service.applyServerUpdate({ version: '1.1.52' })
    // Let the first apply reach the staging await before racing a second.
    await new Promise((resolve) => setImmediate(resolve))
    const second = await service.applyServerUpdate({ version: '1.1.53' })
    expect(second.accepted).toBe(false)
    expect(second.message).toMatch(/in flight/i)
    install.release?.()
    await applyPromise
  })
})

describe('rollbackServerUpdate — unsupported in the single-copy model', () => {
  it('is always refused with a manual-recovery hint', async () => {
    const service = makeService()
    const result = await service.rollbackServerUpdate()
    expect(result.accepted).toBe(false)
    expect(result.restarting).toBe(false)
    expect(result.message).toMatch(/not supported|re-appl/i)
  })
})

describe('restartNode', () => {
  it('accepts a plain restart when idle', () => {
    const restartServer = vi.fn()
    const service = makeService({ restartServer })
    const result = service.restartNode()
    expect(result.accepted).toBe(true)
    expect(result.restarting).toBe(true)
    expect(restartServer).toHaveBeenCalledOnce()
  })

  it('refuses while a version is staged awaiting restart', () => {
    writePendingRootSwap(serverRootDir(dataDir), {
      schemaVersion: 1,
      version: '1.1.51',
      stagingPath: path.join(serverRootDir(dataDir), '.staging-1.1.51-1-1'),
      requestedAtMs: NOW,
    })
    const restartServer = vi.fn()
    const service = makeService({ restartServer })
    const result = service.restartNode()
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/staged/i)
    expect(restartServer).not.toHaveBeenCalled()
  })
})

describe('confirmBootHealthy — no-op GC (no probation promotion)', () => {
  it('returns promoted:null with nothing staged', () => {
    const service = makeService()
    expect(service.confirmBootHealthy()).toEqual({ promoted: null })
  })

  it('sweeps a stale orphaned .staging-* dir but spares a fresh one', () => {
    const rootDir = serverRootDir(dataDir)
    fs.mkdirSync(rootDir, { recursive: true })
    // Fresh staging dir — a concurrent applyServerUpdate mid-npm-install.
    const freshStaging = stagingDirPath(rootDir, '1.1.52', 123, 999)
    fs.mkdirSync(freshStaging, { recursive: true })
    // Stale staging dir — orphaned by a crash >24h before the injected clock.
    const staleStaging = path.join(rootDir, '.staging-1.1.40-1-1')
    fs.mkdirSync(staleStaging, { recursive: true })
    const old = new Date(NOW - 48 * 60 * 60 * 1000)
    fs.utimesSync(staleStaging, old, old)

    const service = makeService()
    expect(service.confirmBootHealthy()).toEqual({ promoted: null })
    expect(fs.existsSync(freshStaging)).toBe(true)
    expect(fs.existsSync(staleStaging)).toBe(false)
  })
})

describe('getServerPackageStatus', () => {
  it('reports idle single-copy status with no previous/rollback', async () => {
    const seedDir = path.join(tmp, 'seed')
    fs.mkdirSync(seedDir, { recursive: true })
    fs.writeFileSync(
      path.join(seedDir, 'package.json'),
      JSON.stringify({ name: '@camstack/server', version: '1.1.42' }),
      'utf-8',
    )
    const service = makeService({
      execNpm: async () => ({ stdout: '1.1.52\n' }),
      env: {
        CAMSTACK_SERVER_BOOT_MODE: 'data-root',
        CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.50',
        CAMSTACK_SEED_SERVER_DIR: seedDir,
      },
    })
    await service.checkServerUpdate()
    const status = await service.getServerPackageStatus()
    expect(status).toMatchObject({
      packageName: '@camstack/server',
      runningVersion: '1.1.50',
      activeVersion: '1.1.50',
      seedVersion: '1.1.42',
      latestVersion: '1.1.52',
      updateAvailable: true,
      bootMode: 'data-root',
      updateState: 'idle',
      pendingVersion: null,
      // Single-copy: no N-1, no rollback record, no state file to corrupt.
      previousVersion: null,
      rolledBack: null,
      stateFileCorrupt: false,
    })
  })

  it('reports pending-restart when a swap is staged', async () => {
    writePendingRootSwap(serverRootDir(dataDir), {
      schemaVersion: 1,
      version: '1.1.51',
      stagingPath: path.join(serverRootDir(dataDir), '.staging-1.1.51-1-1'),
      requestedAtMs: NOW,
    })
    const service = makeService()
    const status = await service.getServerPackageStatus()
    expect(status.updateState).toBe('pending-restart')
    expect(status.pendingVersion).toBe('1.1.51')
    expect(status.previousVersion).toBeNull()
    expect(status.rolledBack).toBeNull()
  })
})
