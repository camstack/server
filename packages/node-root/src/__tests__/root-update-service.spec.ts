import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { rootPackageDir, serverRootDir } from '../root-state.js'
import { readPendingRootSwap, writePendingRootSwap } from '../root-single-copy.js'
import {
  RootUpdateService,
  type NpmExecFn,
  type RootRestartUpdate,
  type RootUpdateEnvNames,
  type RootUpdateLogger,
} from '../root-update-service.js'

const NOW = 1_700_000_000_000

const ENV_NAMES: RootUpdateEnvNames = {
  bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
  activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
  seedDir: 'CAMSTACK_SEED_SERVER_DIR',
}

function makeLogger(): RootUpdateLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
}

let tmp: string
let dataDir: string
let runningPkgPath: string
/**
 * Every restart the engine asked for, with the UPDATE CONTEXT it passed. The
 * context is the only place the version the node is LEAVING exists — after the
 * reboot the process is the new one and cannot know it (see the `fromVersion`
 * case below).
 */
type RecordedRestart = { readonly reason: string; readonly update?: RootRestartUpdate }

let restarts: RecordedRestart[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-update-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  runningPkgPath = path.join(tmp, 'running-package.json')
  fs.writeFileSync(
    runningPkgPath,
    JSON.stringify({ name: '@camstack/server', version: '1.1.50' }),
    'utf-8',
  )
  restarts = []
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * execNpm stub: scaffolds a VALID staged closure (entry + version + native
 * prebuilds) into the staging cwd so `stageClosure`'s validation + native
 * assertion pass, mirroring a real `npm install` of the closure.
 */
function makeInstallStub(version: string): NpmExecFn {
  return async (args, opts) => {
    if (args[0] === 'install' && opts.cwd !== undefined) {
      const pkgDir = rootPackageDir(opts.cwd, HUB_ROOT_SPEC)
      fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@camstack/server', version }),
        'utf-8',
      )
      for (const rel of [
        'better-sqlite3/build/Release/better_sqlite3.node',
        '@img/sharp-linux-x64/lib/sharp.node',
        '@seydx/node-av-linux-x64/av.node',
      ]) {
        const full = path.join(opts.cwd, 'node_modules', ...rel.split('/'))
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, 'ELF', 'utf-8')
      }
    }
    return { stdout: '' }
  }
}

function makeService(
  env: NodeJS.ProcessEnv,
  execNpm: NpmExecFn = async () => ({ stdout: '' }),
  ensureNativePrebuilds?: (closureDir: string) => Promise<void>,
  logger: RootUpdateLogger = makeLogger(),
): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: ENV_NAMES,
    logger,
    restartServer: (reason, update) =>
      restarts.push(update === undefined ? { reason } : { reason, update }),
    dataDir,
    runningPackageJsonPath: runningPkgPath,
    workspaceProbeDir: tmp,
    execNpm,
    ...(ensureNativePrebuilds !== undefined ? { ensureNativePrebuilds } : {}),
    env,
    now: () => NOW,
  })
}

/** Install stub that scaffolds a loadable closure WITHOUT any native `.node`. */
function makeInstallStubNoNatives(version: string): NpmExecFn {
  return async (args, opts) => {
    if (args[0] === 'install' && opts.cwd !== undefined) {
      const pkgDir = rootPackageDir(opts.cwd, HUB_ROOT_SPEC)
      fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@camstack/server', version }),
        'utf-8',
      )
    }
    return { stdout: '' }
  }
}

/** Deposit the three required native `.node` files into a staged closure. */
function depositNatives(closureDir: string): void {
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

describe('applyServerUpdate (single-copy stage + swap-on-restart)', () => {
  it('stages into .staging-*, writes the pending-root-swap marker, and restarts', async () => {
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, makeInstallStub('1.1.60'))
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
    expect(res.restarting).toBe(true)
    expect(restarts).toHaveLength(1)

    const marker = readPendingRootSwap(serverRootDir(dataDir))
    expect(marker?.version).toBe('1.1.60')
    // The staged closure lives at the marker's stagingPath (NOT versions/<X>).
    expect(marker && fs.existsSync(marker.stagingPath)).toBe(true)
    expect(marker?.stagingPath.includes(`${path.sep}versions${path.sep}`)).toBe(false)
  })

  it('hands the restart seam the version the node is LEAVING, not only the target', async () => {
    // The `.restart-pending` marker is written by the seam, read after the
    // reboot and turned into the operator's "Server aggiornato" notification.
    // On 2026-08-19 that notification said only "@camstack/server sul nodo hub
    // è stato aggiornato": the marker carried `toVersion=1.2.138` and no
    // `fromVersion`, because the reason STRING was the only channel and it can
    // only spell one version. The new process cannot recover the old one — it
    // IS the new one — so the fact has to leave here or not at all.
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, makeInstallStub('1.1.60'))
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
    expect(restarts).toHaveLength(1)
    expect(restarts[0]?.update).toEqual({
      packageName: '@camstack/server',
      fromVersion: '1.1.50',
      toVersion: '1.1.60',
    })
  })

  it('a plain node restart carries no update context', () => {
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })
    expect(svc.restartNode().accepted).toBe(true)
    expect(restarts[0]?.update).toBeUndefined()
  })

  it('refuses when a version is already staged and awaiting restart', async () => {
    writePendingRootSwap(serverRootDir(dataDir), {
      schemaVersion: 1,
      version: '1.1.55',
      stagingPath: path.join(serverRootDir(dataDir), '.staging-x'),
      requestedAtMs: NOW,
    })
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, makeInstallStub('1.1.60'))
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted).toBe(false)
    expect(res.message).toMatch(/already staged/i)
  })

  it('refuses in workspace mode', async () => {
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'workspace' }, makeInstallStub('1.1.60'))
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted).toBe(false)
    expect(res.message).toMatch(/workspace/i)
  })

  it('refuses when the target equals the running version', async () => {
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, makeInstallStub('1.1.50'))
    const res = await svc.applyServerUpdate({ version: '1.1.50' })
    expect(res.accepted).toBe(false)
    expect(res.message).toMatch(/already running/i)
  })

  it('fails staging (no marker armed) when the staged closure lacks native prebuilds', async () => {
    // Install stub that scaffolds a loadable closure WITHOUT natives.
    const execNpm: NpmExecFn = async (args, opts) => {
      if (args[0] === 'install' && opts.cwd !== undefined) {
        const pkgDir = rootPackageDir(opts.cwd, HUB_ROOT_SPEC)
        fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
        fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
        fs.writeFileSync(
          path.join(pkgDir, 'package.json'),
          JSON.stringify({ name: '@camstack/server', version: '1.1.60' }),
          'utf-8',
        )
      }
      return { stdout: '' }
    }
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, execNpm)
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted).toBe(false)
    expect(res.message).toMatch(/native prebuilds/i)
    expect(readPendingRootSwap(serverRootDir(dataDir))).toBeNull()
    expect(restarts).toHaveLength(0)
  })

  it('runs the injected ensure step BEFORE the validator — healing a source-only closure', async () => {
    // The npm install leaves NO natives (the toolchain-less desktop symptom);
    // the injected ensure step deposits them, so staging must SUCCEED.
    const ensureCalls: string[] = []
    const ensureNativePrebuilds = async (closureDir: string): Promise<void> => {
      ensureCalls.push(closureDir)
      depositNatives(closureDir)
    }
    const svc = makeService(
      { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
      makeInstallStubNoNatives('1.1.60'),
      ensureNativePrebuilds,
    )
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
    expect(res.restarting).toBe(true)
    const marker = readPendingRootSwap(serverRootDir(dataDir))
    expect(marker?.version).toBe('1.1.60')
    // The ensure step received the SAME staging dir the marker points at.
    expect(ensureCalls).toEqual([marker?.stagingPath])
  })

  it('still aborts when the ensure step cannot supply the missing prebuild', async () => {
    // Ensure step runs but deposits nothing — the validator must still refuse.
    const svc = makeService(
      { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
      makeInstallStubNoNatives('1.1.60'),
      async () => undefined,
    )
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted).toBe(false)
    expect(res.message).toMatch(/native prebuilds/i)
    expect(readPendingRootSwap(serverRootDir(dataDir))).toBeNull()
  })

  it('does not let an ensure-step throw abort a closure that already has natives', async () => {
    // ensure step throws, but the install already deposited natives → success.
    const svc = makeService(
      { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
      makeInstallStub('1.1.60'),
      async () => {
        throw new Error('prebuild fetch blew up')
      },
    )
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
  })
})

describe('rollbackServerUpdate — unsupported in the single-copy model', () => {
  it('is always refused with a manual-recovery hint', async () => {
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })
    const res = await svc.rollbackServerUpdate()
    expect(res.accepted).toBe(false)
    expect(res.message).toMatch(/not supported|re-appl/i)
  })
})

describe('restartNode', () => {
  it('refuses while a version is staged awaiting restart', () => {
    writePendingRootSwap(serverRootDir(dataDir), {
      schemaVersion: 1,
      version: '1.1.55',
      stagingPath: path.join(serverRootDir(dataDir), '.staging-x'),
      requestedAtMs: NOW,
    })
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })
    const res = svc.restartNode()
    expect(res.accepted).toBe(false)
    expect(res.message).toMatch(/staged/i)
  })

  it('accepts a plain restart when idle', () => {
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })
    const res = svc.restartNode()
    expect(res.accepted).toBe(true)
    expect(restarts).toHaveLength(1)
  })
})

describe('getServerPackageStatus', () => {
  it('reports pending-restart while a swap is staged, no previous/rollback', async () => {
    writePendingRootSwap(serverRootDir(dataDir), {
      schemaVersion: 1,
      version: '1.1.60',
      stagingPath: path.join(serverRootDir(dataDir), '.staging-x'),
      requestedAtMs: NOW,
    })
    const svc = makeService({
      CAMSTACK_SERVER_BOOT_MODE: 'data-root',
      CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.50',
    })
    const status = await svc.getServerPackageStatus()
    expect(status.updateState).toBe('pending-restart')
    expect(status.pendingVersion).toBe('1.1.60')
    expect(status.previousVersion).toBeNull()
    expect(status.rolledBack).toBeNull()
    expect(status.stateFileCorrupt).toBe(false)
  })

  it('reports idle with the running version when nothing is staged', async () => {
    const svc = makeService({
      CAMSTACK_SERVER_BOOT_MODE: 'data-root',
      CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.50',
    })
    const status = await svc.getServerPackageStatus()
    expect(status.updateState).toBe('idle')
    expect(status.runningVersion).toBe('1.1.50')
    expect(status.activeVersion).toBe('1.1.50')
  })
})

describe('image contract (seed vs the release the contract delivers)', () => {
  /** Bake a seed dir the way the image does — a package.json at seedDir. */
  function writeSeed(version: string): string {
    const seedDir = path.join(tmp, 'seed')
    fs.mkdirSync(seedDir, { recursive: true })
    fs.writeFileSync(
      path.join(seedDir, 'package.json'),
      JSON.stringify({ name: '@camstack/server', version }),
      'utf-8',
    )
    return seedDir
  }

  it('status flags a stale image with NO registry check — running proves it (2026-08-02 hub)', async () => {
    // The real numbers, scaled to the harness: the data-root runs 1.1.50 while
    // the baked image seed is a series behind. Every other field says healthy.
    const seedDir = writeSeed('1.0.10')
    const svc = makeService({
      CAMSTACK_SERVER_BOOT_MODE: 'data-root',
      CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.50',
      CAMSTACK_SEED_SERVER_DIR: seedDir,
    })
    const status = await svc.getServerPackageStatus()
    expect(status.imageContract?.state).toBe('behind-series')
    expect(status.imageContract?.seedVersion).toBe('1.0.10')
    expect(status.imageContract?.contractVersion).toBe('1.1.50')
    expect(status.imageContract?.contractSource).toBe('running')
  })

  it('status uses the registry latest as the contract once a check has run', async () => {
    const seedDir = writeSeed('1.1.50')
    const svc = makeService(
      {
        CAMSTACK_SERVER_BOOT_MODE: 'data-root',
        CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.50',
        CAMSTACK_SEED_SERVER_DIR: seedDir,
      },
      async () => ({ stdout: '1.1.55\n' }),
    )
    await svc.checkServerUpdate()
    const status = await svc.getServerPackageStatus()
    expect(status.imageContract?.state).toBe('behind-patch')
    expect(status.imageContract?.contractVersion).toBe('1.1.55')
    expect(status.imageContract?.contractSource).toBe('registry')
  })

  it('checkServerUpdate WARN-logs a diverged image — silence reads as "never happened"', async () => {
    const warns: string[] = []
    const seedDir = writeSeed('1.0.10')
    const logger: RootUpdateLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => warns.push(message),
      error: () => undefined,
    }
    const svc = makeService(
      {
        CAMSTACK_SERVER_BOOT_MODE: 'data-root',
        CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.50',
        CAMSTACK_SEED_SERVER_DIR: seedDir,
      },
      async () => ({ stdout: '1.1.55\n' }),
      undefined,
      logger,
    )
    await svc.checkServerUpdate()
    expect(warns.some((m) => m.includes('image'))).toBe(true)
  })

  it('checkServerUpdate stays quiet when the image matches the contract', async () => {
    const warns: string[] = []
    const seedDir = writeSeed('1.1.55')
    const logger: RootUpdateLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => warns.push(message),
      error: () => undefined,
    }
    const svc = makeService(
      {
        CAMSTACK_SERVER_BOOT_MODE: 'data-root',
        CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.50',
        CAMSTACK_SEED_SERVER_DIR: seedDir,
      },
      async () => ({ stdout: '1.1.55\n' }),
      undefined,
      logger,
    )
    await svc.checkServerUpdate()
    expect(warns).toEqual([])
  })

  it('status reports unknown (not in-sync) in a dev workspace with no seed', async () => {
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'workspace' })
    const status = await svc.getServerPackageStatus()
    expect(status.imageContract?.state).toBe('unknown')
  })
})

describe('confirmBootHealthy', () => {
  it('is a no-op that returns promoted:null (no probation promotion)', () => {
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' })
    expect(svc.confirmBootHealthy()).toEqual({ promoted: null })
  })
})
