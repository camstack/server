/**
 * Dev server-deploy channel — staging from uploaded tarballs (single-copy model).
 *
 * Covers the `dev-uploads/` branch of `RootUpdateService.stageClosure`:
 *   - dev-uploads detection → synthetic package.json with `file:` dependency
 *     on the root tgz + `overrides` for every other uploaded package,
 *   - the registry path stays byte-identical when no dev-uploads dir exists,
 *   - a dev-channel version whose uploads are absent is REFUSED,
 *   - promote-time cleanup keeps only the 3 most recent dev-uploads entries.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEV_UPLOADS_KEEP_COUNT,
  devUploadVersionDir,
  devUploadsDir,
  isDevChannelVersion,
  writeDevUploadManifest,
} from '../dev-uploads.js'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { rootPackageDir, serverRootDir } from '../root-state.js'
import { readPendingRootSwap } from '../root-single-copy.js'
import {
  RootUpdateService,
  type NpmExecFn,
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

interface CapturedInstall {
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly stagingPackageJson: unknown
}

let tmp: string
let dataDir: string
let runningPkgPath: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-update-dev-'))
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

/**
 * execNpm stub: captures the args + synthetic package.json, then scaffolds a
 * VALID closure (entry + version + native prebuilds) into the staging cwd.
 */
function makeInstallCapture(version: string): {
  readonly execNpm: NpmExecFn
  readonly calls: CapturedInstall[]
} {
  const calls: CapturedInstall[] = []
  const execNpm: NpmExecFn = async (args, opts) => {
    if (args[0] === 'install' && opts.cwd !== undefined) {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(opts.cwd, 'package.json'), 'utf-8'))
      calls.push({ args, cwd: opts.cwd, stagingPackageJson: raw })
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
  return { execNpm, calls }
}

function makeService(env: NodeJS.ProcessEnv, execNpm: NpmExecFn): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: ENV_NAMES,
    logger: makeLogger(),
    restartServer: () => undefined,
    dataDir,
    runningPackageJsonPath: runningPkgPath,
    workspaceProbeDir: tmp,
    execNpm,
    env,
    now: () => NOW,
  })
}

function seedDevUploads(version: string, packages: Readonly<Record<string, string>>): string {
  const dir = devUploadVersionDir(serverRootDir(dataDir), version)
  fs.mkdirSync(dir, { recursive: true })
  for (const filename of Object.values(packages)) {
    fs.writeFileSync(path.join(dir, filename), 'tgz-bytes', 'utf-8')
  }
  writeDevUploadManifest(dir, { version, packages })
  return dir
}

describe('isDevChannelVersion', () => {
  it('accepts only -dev.<epoch> suffixed versions', () => {
    expect(isDevChannelVersion('1.1.55-dev.1783970000')).toBe(true)
    expect(isDevChannelVersion('1.1.55')).toBe(false)
    expect(isDevChannelVersion('1.1.55-rc.1')).toBe(false)
    expect(isDevChannelVersion('1.1.55-dev.')).toBe(false)
    expect(isDevChannelVersion('1.1.55-dev.abc')).toBe(false)
  })
})

describe('stageClosure — dev-uploads branch', () => {
  const DEV_VERSION = '1.1.54-dev.1783970000'

  it('stages from tarballs: file: dependency on the root tgz + overrides for the rest', async () => {
    const uploadsDir = seedDevUploads(DEV_VERSION, {
      '@camstack/server': 'camstack-server.tgz',
      '@camstack/types': 'camstack-types.tgz',
      '@camstack/system': 'camstack-system.tgz',
    })
    const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted, result.message).toBe(true)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.args.some((a) => a.startsWith('@camstack/server@'))).toBe(false)
    const pkgJson = call.stagingPackageJson as {
      dependencies?: Record<string, string>
      overrides?: Record<string, string>
    }
    expect(pkgJson.dependencies).toEqual({
      '@camstack/server': `file:${path.join(uploadsDir, 'camstack-server.tgz')}`,
    })
    expect(pkgJson.overrides).toEqual({
      '@camstack/types': `file:${path.join(uploadsDir, 'camstack-types.tgz')}`,
      '@camstack/system': `file:${path.join(uploadsDir, 'camstack-system.tgz')}`,
    })

    // The staged closure is armed for swap-on-restart (NOT under versions/).
    const marker = readPendingRootSwap(serverRootDir(dataDir))
    expect(marker?.version).toBe(DEV_VERSION)
    expect(marker && fs.existsSync(marker.stagingPath)).toBe(true)
  })

  it('registry path is untouched when no dev-uploads dir exists', async () => {
    const { execNpm, calls } = makeInstallCapture('1.1.51')
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: '1.1.51' })
    expect(result.accepted).toBe(true)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.args).toContain('@camstack/server@1.1.51')
    const pkgJson = call.stagingPackageJson as Record<string, unknown>
    expect(pkgJson['dependencies']).toBeUndefined()
    expect(pkgJson['overrides']).toBeUndefined()
  })

  it('REFUSES a dev-channel version whose uploads are absent on this node', async () => {
    const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted).toBe(false)
    expect(result.restarting).toBe(false)
    expect(result.message).toMatch(/dev-channel|no uploaded tarballs/i)
    expect(calls).toHaveLength(0)
  })

  it('fails staging with a clear error when the manifest is missing', async () => {
    const dir = devUploadVersionDir(serverRootDir(dataDir), DEV_VERSION)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'camstack-server.tgz'), 'tgz', 'utf-8')
    const { execNpm } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/manifest/i)
  })

  it('fails staging when the manifest lacks the root package', async () => {
    seedDevUploads(DEV_VERSION, { '@camstack/types': 'camstack-types.tgz' })
    const { execNpm } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/@camstack\/server/)
  })
})

describe('confirmBootHealthy — dev-uploads cleanup', () => {
  it(`keeps only the ${DEV_UPLOADS_KEEP_COUNT} most recent dev-uploads entries`, () => {
    const versions = [100, 101, 102, 103, 104].map((e) => `1.1.54-dev.${e}`)
    for (const v of versions) seedDevUploads(v, { '@camstack/server': 'camstack-server.tgz' })
    const { execNpm } = makeInstallCapture(versions[4]!)
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    svc.confirmBootHealthy()

    const remaining = fs
      .readdirSync(devUploadsDir(serverRootDir(dataDir)))
      .filter((name) => !name.startsWith('.'))
      .sort()
    expect(remaining).toEqual([versions[2], versions[3], versions[4]].sort())
  })

  it('is a no-op when the dev-uploads dir does not exist', () => {
    const { execNpm } = makeInstallCapture('1.1.51')
    const svc = makeService({ CAMSTACK_SERVER_BOOT_MODE: 'data-root' }, execNpm)
    expect(() => svc.confirmBootHealthy()).not.toThrow()
  })
})
