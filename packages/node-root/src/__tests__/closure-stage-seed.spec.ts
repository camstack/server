/**
 * Staging copies the running closure first.
 *
 * A fresh `.staging-*` directory makes npm run every install script, so
 * node-av re-downloads ffmpeg on every update. Seeding `current/` means an
 * unchanged dependency's postinstall does not run again. A seeded tree that
 * fails validation is installed once more from an empty directory.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedStagingFromCurrent } from '../closure-stage-seed.js'
import { NpmInstallError } from '../npm-install-watch.js'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { rootPackageDir, serverRootDir } from '../root-state.js'
import { currentDir } from '../root-single-copy.js'
import {
  type NpmExecFn,
  type RootUpdateEnvNames,
  type RootUpdateLogger,
  RootUpdateService,
} from '../root-update-service.js'

const ENV_NAMES: RootUpdateEnvNames = {
  bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
  activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
  seedDir: 'CAMSTACK_SEED_SERVER_DIR',
}

const NODE_AV = '1.0.0'
const NODE_AV_NEXT = '2.0.0'

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readVersion(file: string): string | null {
  if (!fs.existsSync(file)) return null
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!isRecord(parsed) || typeof parsed['version'] !== 'string') return null
  return parsed['version']
}

/** What npm does: an unchanged package does not run its install script again. */
function scriptAwareInstall(serverVersion: string, nodeAvWanted: string): NpmExecFn {
  return async (args, opts) => {
    if (args[0] !== 'install' || opts.cwd === undefined) return { stdout: '' }
    const cwd = opts.cwd
    const installed = path.join(cwd, 'node_modules', 'node-av', 'package.json')
    const marker = path.join(cwd, 'node_modules', 'node-av', '.postinstall-ran')
    if (readVersion(installed) !== nodeAvWanted) {
      fs.mkdirSync(path.dirname(marker), { recursive: true })
      fs.writeFileSync(
        installed,
        JSON.stringify({ name: 'node-av', version: nodeAvWanted }),
        'utf8',
      )
      fs.writeFileSync(marker, 'ran', 'utf8')
    }
    const pkgDir = rootPackageDir(cwd, HUB_ROOT_SPEC)
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf8')
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@camstack/server', version: serverVersion }),
      'utf8',
    )
    fs.writeFileSync(
      path.join(cwd, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'camstack-node-root',
            dependencies: { '@camstack/server': serverVersion },
          },
          'node_modules/@camstack/server': { version: serverVersion },
          'node_modules/node-av': { version: nodeAvWanted },
        },
      }),
      'utf8',
    )
    for (const rel of [
      'better-sqlite3/build/Release/better_sqlite3.node',
      '@img/sharp-linux-x64/lib/sharp.node',
      '@seydx/node-av-linux-x64/av.node',
    ]) {
      const full = path.join(cwd, 'node_modules', ...rel.split('/'))
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, 'ELF', 'utf8')
    }
    return { stdout: '' }
  }
}

describe('stageClosure seeds from current/', () => {
  let tmp: string
  let dataDir: string
  const lines: { message: string; source: unknown }[] = []

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function arrange(): void {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-seed-'))
    dataDir = path.join(tmp, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      path.join(tmp, 'running-package.json'),
      JSON.stringify({ name: '@camstack/server', version: '1.1.50' }),
      'utf8',
    )
    const current = currentDir(serverRootDir(dataDir))
    fs.mkdirSync(path.join(current, 'node_modules', 'node-av'), { recursive: true })
    fs.writeFileSync(
      path.join(current, 'package.json'),
      JSON.stringify({
        name: 'camstack-node-root',
        private: true,
        dependencies: { '@camstack/server': '1.1.50' },
      }),
      'utf8',
    )
    fs.writeFileSync(path.join(current, 'package-lock.json'), '{}\n', 'utf8')
    fs.writeFileSync(
      path.join(current, 'node_modules', 'node-av', 'package.json'),
      JSON.stringify({ name: 'node-av', version: NODE_AV }),
      'utf8',
    )
    lines.length = 0
  }

  function service(execNpm: NpmExecFn): RootUpdateService {
    const logger: RootUpdateLogger = {
      debug: () => undefined,
      info: (message, context) => {
        lines.push({ message, source: context?.meta?.['source'] })
      },
      warn: () => undefined,
      error: () => undefined,
    }
    return new RootUpdateService({
      spec: HUB_ROOT_SPEC,
      envNames: ENV_NAMES,
      logger,
      restartServer: () => undefined,
      dataDir,
      runningPackageJsonPath: path.join(tmp, 'running-package.json'),
      workspaceProbeDir: tmp,
      execNpm,
      env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root' },
      now: () => 1_700_000_000_000,
    })
  }

  function markerInStaging(): string | null {
    const root = serverRootDir(dataDir)
    const staged = fs.readdirSync(root).find((name) => name.startsWith('.staging-'))
    if (staged === undefined) return null
    const marker = path.join(root, staged, 'node_modules', 'node-av', '.postinstall-ran')
    return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null
  }

  it('does not rerun the install script of an unchanged dependency', async () => {
    arrange()
    const svc = service(scriptAwareInstall('1.1.60', NODE_AV))
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
    expect(markerInStaging()).toBeNull()
    expect(
      lines.some(
        (line) => line.message === 'root package closure produced' && line.source === 'seeded',
      ),
    ).toBe(true)
  })

  it('reruns the install script when that dependency changed', async () => {
    arrange()
    const svc = service(scriptAwareInstall('1.1.60', NODE_AV_NEXT))
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
    expect(markerInStaging()).toBe('ran')
  })

  it('falls back to a clean install when the seeded closure fails validation', async () => {
    arrange()
    let installs = 0
    const execNpm: NpmExecFn = async (args, opts) => {
      const cwd = opts.cwd
      if (cwd === undefined) return { stdout: '' }
      if (args[0] === 'ls') return { stdout: '' }
      if (args[0] !== 'install') return { stdout: '' }
      installs += 1
      const seeded = fs.existsSync(path.join(cwd, 'node_modules', 'node-av', 'package.json'))
      if (seeded) return { stdout: '' }
      return scriptAwareInstall('1.1.60', NODE_AV)(args, opts)
    }
    const svc = service(execNpm)
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
    expect(installs).toBe(2)
    expect(
      lines.some(
        (line) => line.message === 'root package closure produced' && line.source === 'clean',
      ),
    ).toBe(true)
  })

  it('falls back to a clean install when a seeded tree keeps a stale transitive', async () => {
    arrange()
    const installs: string[] = []
    const lsArgs: string[][] = []
    const execNpm: NpmExecFn = async (args, opts) => {
      const cwd = opts.cwd
      if (cwd === undefined) return { stdout: '' }
      if (args[0] === 'ls') {
        lsArgs.push([...args])
        return { stdout: '' }
      }
      if (args[0] !== 'install') return { stdout: '' }
      const seeded = fs.existsSync(path.join(cwd, 'node_modules', 'node-av', 'package.json'))
      installs.push(seeded ? 'seeded' : 'clean')
      const installed = await scriptAwareInstall('1.1.60', NODE_AV)(args, opts)
      if (!seeded) return installed
      const lockPath = path.join(cwd, 'package-lock.json')
      const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      if (!isRecord(parsed) || !isRecord(parsed['packages'])) {
        throw new Error('lockfile missing packages')
      }
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          ...parsed,
          packages: { ...parsed['packages'], 'node_modules/left-pad': { version: '2.0.0' } },
        }),
        'utf8',
      )
      fs.mkdirSync(path.join(cwd, 'node_modules', 'left-pad'), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, 'node_modules', 'left-pad', 'package.json'),
        JSON.stringify({ name: 'left-pad', version: '1.0.0' }),
        'utf8',
      )
      return installed
    }
    const svc = service(execNpm)
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
    expect(installs).toEqual(['seeded', 'clean'])
    expect(lsArgs[0]).toEqual(['ls', '--omit=dev', '--all'])
    expect(
      lines.some(
        (line) => line.message === 'root package closure produced' && line.source === 'clean',
      ),
    ).toBe(true)
  })

  it('falls back to a clean install when npm ls hits the ceiling', async () => {
    arrange()
    let lsCalls = 0
    const installs: string[] = []
    const execNpm: NpmExecFn = async (args, opts) => {
      const cwd = opts.cwd
      if (cwd === undefined) return { stdout: '' }
      if (args[0] === 'ls') {
        lsCalls += 1
        if (lsCalls === 1) {
          throw new NpmInstallError('timeout-ceiling', cwd, null, 'npm ls hit the hard ceiling')
        }
        return { stdout: '' }
      }
      if (args[0] !== 'install') return { stdout: '' }
      const seeded = fs.existsSync(path.join(cwd, 'node_modules', 'node-av', 'package.json'))
      installs.push(seeded ? 'seeded' : 'clean')
      if (seeded) return { stdout: '' }
      return scriptAwareInstall('1.1.60', NODE_AV)(args, opts)
    }
    const svc = service(execNpm)
    const res = await svc.applyServerUpdate({ version: '1.1.60' })
    expect(res.accepted, res.message).toBe(true)
    expect(res.reason).not.toBe('timeout-ceiling')
    expect(installs).toEqual(['seeded', 'clean'])
  })

  it('copies a node_modules .bin entry as a symlink', async () => {
    arrange()
    const current = currentDir(serverRootDir(dataDir))
    const binDir = path.join(current, 'node_modules', '.bin')
    const target = path.join(current, 'node_modules', 'node-av', 'package.json')
    fs.mkdirSync(binDir, { recursive: true })
    fs.symlinkSync(path.relative(binDir, target), path.join(binDir, 'node-av'))
    const staging = path.join(dataDir, 'staging-copy')
    fs.mkdirSync(staging)
    await seedStagingFromCurrent(current, staging)
    const copied = path.join(staging, 'node_modules', '.bin', 'node-av')
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(true)
  })
})
