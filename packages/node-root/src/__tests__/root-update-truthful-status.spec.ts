/**
 * The update engine tells the truth about what is RUNNING, what is STAGED,
 * and what an action DID — pinned against the 2026-09-19 evening on the hub
 * (D546).
 *
 * Three faults, each of which hid the next:
 *
 *  1. `runningVersion` was a disk read on every call. The number is meant to
 *     say what THIS PROCESS loaded, and a disk read cannot: the copy it reads
 *     is the copy a swap replaces. It is captured once at construction now,
 *     and a disk that differs is reported through `installedVersion`.
 *  2. `checkServerUpdate` answered `{runningVersion, updateAvailable:false}`
 *     for a node whose staged closure had never booted — the restart
 *     requirement lived only on `getServerPackageStatus`. Every check carries
 *     `pendingVersion` + `restartRequired` now, and a staged version is no
 *     longer "an update available".
 *  3. `applyServerUpdate` answered `accepted:false` for a refusal where nothing
 *     was wrong AND for a staging install that died on `ECONNRESET`; the
 *     difference was prose. `outcome` / `reason` / `error` are the discriminant,
 *     and a transient registry failure is retried under a bound before it is
 *     reported.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { rootPackageDir, serverRootDir } from '../root-state.js'
import { currentDir, readPendingRootSwap, writePendingRootSwap } from '../root-single-copy.js'
import {
  isTransientNpmNetworkError,
  RootUpdateService,
  STAGING_ATTEMPTS,
  STAGING_FAILED_REASON,
  type NpmExecFn,
  type RootUpdateEnvNames,
  type RootUpdateLogContext,
  type RootUpdateLogger,
} from '../root-update-service.js'

const NOW = 1_700_000_000_000
const RUNNING = '1.1.50'
const ENV_NAMES: RootUpdateEnvNames = {
  bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
  activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
  seedDir: 'CAMSTACK_SEED_SERVER_DIR',
}
const DATA_ROOT_ENV: NodeJS.ProcessEnv = {
  CAMSTACK_SERVER_BOOT_MODE: 'data-root',
  CAMSTACK_SERVER_ACTIVE_VERSION: RUNNING,
}

/** npm's real wording for the failure the hub hit at 21:04:38Z on 2026-09-19. */
const ECONNRESET_OUTPUT =
  'Command failed: npm install --omit=dev --no-audit --no-fund --loglevel=error @camstack/server@1.2.353\n' +
  'npm error code ECONNRESET\nnpm error network aborted\n' +
  'npm error network This is a problem related to network connectivity.'

interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly context: RootUpdateLogContext | undefined
}

let tmp: string
let dataDir: string
let runningPkgPath: string
let lines: LogLine[]
let sleeps: number[]
let restarts: string[]

function recordingLogger(): RootUpdateLogger {
  const push =
    (level: LogLine['level']) =>
    (message: string, context?: RootUpdateLogContext): void => {
      lines.push({ level, message, context })
    }
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-update-truth-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  runningPkgPath = path.join(tmp, 'running-package.json')
  writeVersion(runningPkgPath, RUNNING)
  lines = []
  sleeps = []
  restarts = []
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeVersion(pkgJsonPath: string, version: string): void {
  fs.mkdirSync(path.dirname(pkgJsonPath), { recursive: true })
  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify({ name: HUB_ROOT_SPEC.packageName, version }),
    'utf-8',
  )
}

/** Put a root package of `version` into the data-root `current/` copy. */
function installCurrent(version: string): void {
  const pkgDir = rootPackageDir(currentDir(serverRootDir(dataDir)), HUB_ROOT_SPEC)
  writeVersion(path.join(pkgDir, 'package.json'), version)
}

function stagePending(version: string): void {
  writePendingRootSwap(serverRootDir(dataDir), {
    schemaVersion: 1,
    version,
    stagingPath: path.join(serverRootDir(dataDir), '.staging-x'),
    requestedAtMs: NOW,
  })
}

/** A valid closure lands in the staging cwd, exactly as a real install would. */
function scaffoldClosure(cwd: string, version: string): void {
  const pkgDir = rootPackageDir(cwd, HUB_ROOT_SPEC)
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
  writeVersion(path.join(pkgDir, 'package.json'), version)
  for (const rel of [
    'better-sqlite3/build/Release/better_sqlite3.node',
    '@img/sharp-linux-x64/lib/sharp.node',
    '@seydx/node-av-linux-x64/av.node',
  ]) {
    const full = path.join(cwd, 'node_modules', ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'ELF', 'utf-8')
  }
}

/**
 * An npm that fails the first `failures` installs with `failure`, then lands a
 * closure. `npm view` always answers `latest`.
 */
function flakyNpm(args: {
  readonly latest: string
  readonly failures: number
  readonly failure: string
}): { readonly exec: NpmExecFn; readonly installs: () => number } {
  let installs = 0
  const exec: NpmExecFn = async (argv, opts) => {
    if (argv[0] === 'view') return { stdout: `${args.latest}\n` }
    if (argv[0] === 'install' && opts.cwd !== undefined) {
      installs += 1
      if (installs <= args.failures) throw new Error(args.failure)
      scaffoldClosure(opts.cwd, args.latest)
    }
    return { stdout: '' }
  }
  return { exec, installs: () => installs }
}

function makeService(env: NodeJS.ProcessEnv, execNpm?: NpmExecFn): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: ENV_NAMES,
    logger: recordingLogger(),
    nodeId: 'hub',
    restartServer: (reason) => {
      restarts.push(reason)
    },
    dataDir,
    runningPackageJsonPath: runningPkgPath,
    workspaceProbeDir: tmp,
    execNpm: execNpm ?? (async () => ({ stdout: '' })),
    env,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
}

// ── Fault 1: what is RUNNING is what this process loaded ──────────────────

describe('runningVersion is what THIS process loaded', () => {
  it('does not follow a package.json rewritten on disk after boot', async () => {
    installCurrent(RUNNING)
    const svc = makeService(DATA_ROOT_ENV)

    // The copy on disk moves under the live process — the one thing a lazy
    // disk read reports as "running".
    writeVersion(runningPkgPath, '1.2.352')

    const status = await svc.getServerPackageStatus()
    expect(status.runningVersion).toBe(RUNNING)
    const check = await svc.checkServerUpdate()
    expect(check.runningVersion).toBe(RUNNING)
    expect(svc.getRunningRootPackage().version).toBe(RUNNING)
  })

  it('reports a data-root copy that differs from the running code, and that a restart is required', async () => {
    installCurrent(RUNNING)
    const svc = makeService(DATA_ROOT_ENV)
    expect(await svc.getServerPackageStatus()).toMatchObject({
      installedVersion: RUNNING,
      restartRequired: false,
    })

    installCurrent('1.2.352')

    expect(await svc.getServerPackageStatus()).toMatchObject({
      runningVersion: RUNNING,
      installedVersion: '1.2.352',
      restartRequired: true,
    })
  })

  it('claims no installed version on a baked or workspace boot — the starter did not load current/ there', async () => {
    installCurrent('1.2.352')
    const baked = await makeService({ CAMSTACK_SERVER_BOOT_MODE: 'baked' }).getServerPackageStatus()
    expect(baked.installedVersion).toBeNull()
    expect(baked.restartRequired).toBe(false)
    const workspace = await makeService({
      CAMSTACK_SERVER_BOOT_MODE: 'workspace',
    }).getServerPackageStatus()
    expect(workspace.installedVersion).toBeNull()
  })

  it('logs when the loaded version disagrees with the version the starter booted', () => {
    makeService({
      CAMSTACK_SERVER_BOOT_MODE: 'data-root',
      CAMSTACK_SERVER_ACTIVE_VERSION: '1.1.49',
    })
    const warned = lines.find((l) =>
      l.message.includes('disagrees with the version the starter booted'),
    )
    expect(warned?.level).toBe('warn')
    expect(warned?.context?.meta).toMatchObject({ loadedVersion: RUNNING, bootedVersion: '1.1.49' })
    expect(warned?.context?.tags).toMatchObject({ nodeId: 'hub' })
  })
})

// ── Fault 2: a check says what is STAGED ──────────────────────────────────

describe('checkServerUpdate carries the restart requirement', () => {
  it('names the staged version and says a restart is required', async () => {
    installCurrent(RUNNING)
    stagePending('1.1.60')
    const svc = makeService(DATA_ROOT_ENV, async () => ({ stdout: '1.1.60\n' }))

    const check = await svc.checkServerUpdate()

    expect(check).toMatchObject({
      runningVersion: RUNNING,
      latestVersion: '1.1.60',
      pendingVersion: '1.1.60',
      restartRequired: true,
      // The staged version is a restart away, not an update to fetch.
      updateAvailable: false,
      error: null,
    })
  })

  it('still reports an update when the registry moved past the staged version', async () => {
    installCurrent(RUNNING)
    stagePending('1.1.60')
    const svc = makeService(DATA_ROOT_ENV, async () => ({ stdout: '1.1.61\n' }))
    expect(await svc.checkServerUpdate()).toMatchObject({
      pendingVersion: '1.1.60',
      restartRequired: true,
      updateAvailable: true,
    })
  })

  it('keeps the restart facts on a failed registry check — offline is not "nothing pending"', async () => {
    installCurrent(RUNNING)
    stagePending('1.1.60')
    const svc = makeService(DATA_ROOT_ENV, async () => {
      throw new Error('npm error code EAI_AGAIN')
    })
    expect(await svc.checkServerUpdate()).toMatchObject({
      error: 'npm error code EAI_AGAIN',
      pendingVersion: '1.1.60',
      restartRequired: true,
    })
  })

  it('answers no pending version and no restart on a settled node', async () => {
    installCurrent(RUNNING)
    const svc = makeService(DATA_ROOT_ENV, async () => ({ stdout: `${RUNNING}\n` }))
    expect(await svc.checkServerUpdate()).toMatchObject({
      pendingVersion: null,
      restartRequired: false,
      updateAvailable: false,
    })
  })
})

// ── Fault 3: an action says what it DID ───────────────────────────────────

describe('applyServerUpdate outcome', () => {
  it('staged: the closure landed and the node restarts — the caller is told the old version still runs until then', async () => {
    installCurrent(RUNNING)
    const npm = flakyNpm({ latest: '1.1.51', failures: 0, failure: '' })
    const svc = makeService(DATA_ROOT_ENV, npm.exec)

    const result = await svc.applyServerUpdate({ version: '1.1.51' })

    expect(result).toMatchObject({
      accepted: true,
      restarting: true,
      outcome: 'staged',
      reason: null,
      error: null,
    })
    expect(result.message).toContain(`still runs ${RUNNING}`)
    expect(readPendingRootSwap(serverRootDir(dataDir))?.version).toBe('1.1.51')
    expect(restarts).toHaveLength(1)
  })

  it('already-current: the target is the running version', async () => {
    const svc = makeService(DATA_ROOT_ENV)
    expect(await svc.applyServerUpdate({ version: RUNNING })).toMatchObject({
      accepted: false,
      outcome: 'already-current',
      reason: 'already-running',
      error: null,
    })
  })

  it('refused: a version is already staged, and the reason is the stable name', async () => {
    stagePending('1.1.60')
    const svc = makeService(DATA_ROOT_ENV)
    expect(await svc.applyServerUpdate({ version: '1.1.61' })).toMatchObject({
      accepted: false,
      outcome: 'refused',
      reason: 'already-staged',
      error: null,
    })
  })

  it('failed: a staging install that died carries the npm output as `error`, and nothing is armed', async () => {
    const npm = flakyNpm({
      latest: '1.2.353',
      failures: 1,
      failure: 'npm error code E404\nnpm error 404 Not Found',
    })
    const svc = makeService(DATA_ROOT_ENV, npm.exec)

    const result = await svc.applyServerUpdate({ version: '1.2.353' })

    expect(result).toMatchObject({
      accepted: false,
      restarting: false,
      outcome: 'failed',
      reason: STAGING_FAILED_REASON,
    })
    expect(result.error).toContain('npm error code E404')
    expect(readPendingRootSwap(serverRootDir(dataDir))).toBeNull()
    expect(restarts).toHaveLength(0)
  })

  it('restart-scheduled / refused on the plain restart path', () => {
    expect(makeService(DATA_ROOT_ENV).restartNode()).toMatchObject({
      accepted: true,
      outcome: 'restart-scheduled',
    })
    stagePending('1.1.60')
    expect(makeService(DATA_ROOT_ENV).restartNode()).toMatchObject({
      accepted: false,
      outcome: 'refused',
      reason: 'already-staged',
    })
  })
})

// ── The bounded retry ─────────────────────────────────────────────────────

describe('a transient registry failure is retried under a bound', () => {
  it('classifies npm network errors and nothing else', () => {
    expect(isTransientNpmNetworkError(ECONNRESET_OUTPUT)).toBe(true)
    expect(isTransientNpmNetworkError('npm error code ETIMEDOUT')).toBe(true)
    expect(isTransientNpmNetworkError('npm error code EAI_AGAIN')).toBe(true)
    expect(isTransientNpmNetworkError('npm error code E404\nnpm error 404 Not Found')).toBe(false)
    expect(isTransientNpmNetworkError('staged closure missing native prebuilds: sharp')).toBe(false)
  })

  it('lands on the second attempt after one ECONNRESET, and says so', async () => {
    installCurrent(RUNNING)
    const npm = flakyNpm({ latest: '1.2.353', failures: 1, failure: ECONNRESET_OUTPUT })
    const svc = makeService(DATA_ROOT_ENV, npm.exec)

    const result = await svc.applyServerUpdate({ version: '1.2.353' })

    expect(result.outcome).toBe('staged')
    expect(npm.installs()).toBe(2)
    expect(sleeps).toEqual([5_000])
    const retried = lines.find((l) => l.message.includes('transient network error, retrying'))
    expect(retried?.level).toBe('warn')
    expect(retried?.context?.meta).toMatchObject({ attempt: 1, attempts: STAGING_ATTEMPTS })
    expect(retried?.context?.tags).toMatchObject({ nodeId: 'hub' })
  })

  it('gives up after the bound and reports the failure with the attempt count', async () => {
    const npm = flakyNpm({ latest: '1.2.353', failures: 99, failure: ECONNRESET_OUTPUT })
    const svc = makeService(DATA_ROOT_ENV, npm.exec)

    const result = await svc.applyServerUpdate({ version: '1.2.353' })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('ECONNRESET')
    expect(npm.installs()).toBe(STAGING_ATTEMPTS)
    expect(sleeps).toEqual([5_000, 15_000])
    const final = lines.find(
      (l) => l.level === 'error' && l.message === 'root package update staging failed',
    )
    expect(final?.context?.meta).toMatchObject({
      attempt: STAGING_ATTEMPTS,
      attempts: STAGING_ATTEMPTS,
      transient: true,
    })
  })

  it('does not retry a failure that would answer the same every time', async () => {
    const npm = flakyNpm({ latest: '1.2.353', failures: 99, failure: 'npm error code E404' })
    const svc = makeService(DATA_ROOT_ENV, npm.exec)

    await svc.applyServerUpdate({ version: '1.2.353' })

    expect(npm.installs()).toBe(1)
    expect(sleeps).toEqual([])
  })
})
