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
import * as zlib from 'node:zlib'
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
  bootMode: 'DOMINEVO_SERVER_BOOT_MODE',
  activeVersion: 'DOMINEVO_SERVER_ACTIVE_VERSION',
  seedDir: 'DOMINEVO_SEED_SERVER_DIR',
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
    JSON.stringify({ name: '@dominevo/server', version: '1.1.50' }),
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
        JSON.stringify({ name: '@dominevo/server', version }),
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

/** A gzipped ustar tarball holding `files` under `package/`. */
function tarballWith(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, body] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(`package/${name}`, 0, 'utf8')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    blocks.push(header, Buffer.from(body, 'utf8'), Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
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

function seedDevUploads(
  version: string,
  packages: Readonly<Record<string, string>>,
  buildTimeMs?: number,
): string {
  const dir = devUploadVersionDir(serverRootDir(dataDir), version)
  fs.mkdirSync(dir, { recursive: true })
  for (const filename of Object.values(packages)) {
    fs.writeFileSync(path.join(dir, filename), 'tgz-bytes', 'utf-8')
  }
  writeDevUploadManifest(dir, {
    version,
    packages,
    ...(buildTimeMs === undefined ? {} : { buildTimeMs }),
  })
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
      '@dominevo/server': 'camstack-server.tgz',
      '@dominevo/types': 'camstack-types.tgz',
    })
    const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted, result.message).toBe(true)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.args.some((a) => a.startsWith('@dominevo/server@'))).toBe(false)
    const pkgJson = call.stagingPackageJson as {
      dependencies?: Record<string, string>
      overrides?: Record<string, string>
    }
    expect(pkgJson.dependencies).toEqual({
      '@dominevo/server': `file:${path.join(uploadsDir, 'camstack-server.tgz')}`,
    })
    expect(pkgJson.overrides).toEqual({
      '@dominevo/types': `file:${path.join(uploadsDir, 'camstack-types.tgz')}`,
    })

    // The staged closure is armed for swap-on-restart (NOT under versions/).
    const marker = readPendingRootSwap(serverRootDir(dataDir))
    expect(marker?.version).toBe(DEV_VERSION)
    expect(marker && fs.existsSync(marker.stagingPath)).toBe(true)
  })

  it('bounds the install with --before = build time + 5 min when the manifest carries one', async () => {
    const buildTimeMs = Date.parse('2026-11-24T10:00:00.000Z')
    seedDevUploads(DEV_VERSION, { '@dominevo/server': 'camstack-server.tgz' }, buildTimeMs)
    const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted, result.message).toBe(true)
    expect(calls[0]!.args).toContain('--before=2026-11-24T10:05:00.000Z')
  })

  it('installs unbounded (no --before) when the manifest has no build time', async () => {
    seedDevUploads(DEV_VERSION, { '@dominevo/server': 'camstack-server.tgz' })
    const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted, result.message).toBe(true)
    expect(calls[0]!.args.some((a) => a.startsWith('--before'))).toBe(false)
  })

  describe('closure pins inside the uploaded server tarball (#681)', () => {
    const PINS = { '@trpc/server': '11.18.0', sharp: '0.35.2' }
    const BUILD_TIME = Date.parse('2026-11-24T10:00:00.000Z')

    it('merges the pins into overrides (file: entries win) and passes no --before', async () => {
      const dir = seedDevUploads(
        DEV_VERSION,
        { '@dominevo/server': 'camstack-server.tgz', '@dominevo/types': 'camstack-types.tgz' },
        BUILD_TIME,
      )
      fs.writeFileSync(
        path.join(dir, 'camstack-server.tgz'),
        tarballWith({
          'closure-pins.json': JSON.stringify({ ...PINS, '@dominevo/types': '9.9.9' }),
        }),
      )
      const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
      const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

      const result = await svc.applyServerUpdate({ version: DEV_VERSION })
      expect(result.accepted, result.message).toBe(true)
      const pkgJson = calls[0]!.stagingPackageJson as { overrides?: Record<string, string> }
      expect(pkgJson.overrides).toEqual({
        ...PINS,
        '@dominevo/types': `file:${path.join(dir, 'camstack-types.tgz')}`,
      })
      expect(calls[0]!.args.some((a) => a.startsWith('--before'))).toBe(false)
    })

    it('keeps --before when the tarball ships no pins file', async () => {
      const dir = seedDevUploads(
        DEV_VERSION,
        { '@dominevo/server': 'camstack-server.tgz' },
        BUILD_TIME,
      )
      fs.writeFileSync(path.join(dir, 'camstack-server.tgz'), tarballWith({ 'other.json': '{}' }))
      const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
      const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

      const result = await svc.applyServerUpdate({ version: DEV_VERSION })
      expect(result.accepted, result.message).toBe(true)
      expect(calls[0]!.args).toContain('--before=2026-11-24T10:05:00.000Z')
      expect(calls[0]!.stagingPackageJson).not.toHaveProperty('overrides')
    })

    it('keeps --before when the pins file is rejected', async () => {
      const dir = seedDevUploads(
        DEV_VERSION,
        { '@dominevo/server': 'camstack-server.tgz' },
        BUILD_TIME,
      )
      fs.writeFileSync(
        path.join(dir, 'camstack-server.tgz'),
        tarballWith({ 'closure-pins.json': JSON.stringify({ sharp: '^0.35.0' }) }),
      )
      const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
      const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

      const result = await svc.applyServerUpdate({ version: DEV_VERSION })
      expect(result.accepted, result.message).toBe(true)
      expect(calls[0]!.args).toContain('--before=2026-11-24T10:05:00.000Z')
    })
  })

  it('registry path is untouched when no dev-uploads dir exists', async () => {
    const { execNpm, calls } = makeInstallCapture('1.1.51')
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: '1.1.51' })
    expect(result.accepted).toBe(true)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.args).toContain('@dominevo/server@1.1.51')
    expect(call.args.some((a) => a.startsWith('--before'))).toBe(false)
    const pkgJson = call.stagingPackageJson as Record<string, unknown>
    expect(pkgJson['dependencies']).toBeUndefined()
    expect(pkgJson['overrides']).toBeUndefined()
  })

  it('REFUSES a dev-channel version whose uploads are absent on this node', async () => {
    const { execNpm, calls } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

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
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/manifest/i)
  })

  it('fails staging when the manifest lacks the root package', async () => {
    seedDevUploads(DEV_VERSION, { '@dominevo/types': 'camstack-types.tgz' })
    const { execNpm } = makeInstallCapture(DEV_VERSION)
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    const result = await svc.applyServerUpdate({ version: DEV_VERSION })
    expect(result.accepted).toBe(false)
    expect(result.message).toMatch(/@dominevo\/server/)
  })
})

describe('confirmBootHealthy — dev-uploads cleanup', () => {
  it(`keeps only the ${DEV_UPLOADS_KEEP_COUNT} most recent dev-uploads entries`, () => {
    const versions = [100, 101, 102, 103, 104].map((e) => `1.1.54-dev.${e}`)
    for (const v of versions) seedDevUploads(v, { '@dominevo/server': 'camstack-server.tgz' })
    const { execNpm } = makeInstallCapture(versions[4]!)
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)

    svc.confirmBootHealthy()

    const remaining = fs
      .readdirSync(devUploadsDir(serverRootDir(dataDir)))
      .filter((name) => !name.startsWith('.'))
      .sort()
    expect(remaining).toEqual([versions[2], versions[3], versions[4]].sort())
  })

  it('is a no-op when the dev-uploads dir does not exist', () => {
    const { execNpm } = makeInstallCapture('1.1.51')
    const svc = makeService({ DOMINEVO_SERVER_BOOT_MODE: 'data-root' }, execNpm)
    expect(() => svc.confirmBootHealthy()).not.toThrow()
  })
})
