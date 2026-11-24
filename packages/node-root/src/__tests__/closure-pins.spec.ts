/**
 * #681 — a registry install runs with the target's `closure-pins.json` as
 * `overrides`, so a third-party package published after the release was tested
 * cannot enter the closure. A target without the file installs as before.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClosurePins, readTarballEntry, withClosureOverrides } from '../closure-pins.js'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { rootPackageDir } from '../root-state.js'
import {
  RootUpdateService,
  type NpmExecFn,
  type RootUpdateEnvNames,
  type RootUpdateLogger,
} from '../root-update-service.js'

/** A gzipped ustar tarball holding `files` under `package/`. */
function makeTarball(files: Readonly<Record<string, string>>): Buffer {
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

const PINS = { '@trpc/server': '11.18.0', sharp: '0.35.2' }

describe('closure pins file', () => {
  it('reads one entry out of an npm tarball, wherever it sits', () => {
    const tgz = makeTarball({
      'package.json': '{}',
      'closure-pins.json': JSON.stringify(PINS),
      'x.js': 'x',
    })
    expect(readTarballEntry(tgz, 'package/closure-pins.json')?.toString('utf8')).toBe(
      JSON.stringify(PINS),
    )
    expect(readTarballEntry(tgz, 'package/missing.json')).toBeNull()
  })

  it('accepts exact versions only and never a @camstack pin', () => {
    expect(parseClosurePins(JSON.stringify({ ...PINS, '@camstack/sdk': '1.0.0' }))).toEqual({
      pins: PINS,
      miss: null,
    })
    expect(parseClosurePins(JSON.stringify({ a: '^1.0.0' }))).toEqual({
      pins: null,
      miss: 'non-exact-version',
    })
    expect(parseClosurePins('not json')).toEqual({ pins: null, miss: 'unparseable' })
    expect(parseClosurePins('{}')).toEqual({ pins: null, miss: 'empty' })
  })

  it('replaces the seeded overrides, and drops them when there are no pins', () => {
    const seeded = { name: 'x', overrides: { old: '1.0.0' } }
    expect(withClosureOverrides(seeded, PINS)).toEqual({ name: 'x', overrides: PINS })
    expect(withClosureOverrides(seeded, null)).toEqual({ name: 'x' })
  })
})

describe('staging a registry closure', () => {
  const ENV_NAMES: RootUpdateEnvNames = {
    bootMode: 'CAMSTACK_SERVER_BOOT_MODE',
    activeVersion: 'CAMSTACK_SERVER_ACTIVE_VERSION',
    seedDir: 'CAMSTACK_SEED_SERVER_DIR',
  }
  interface LogLine {
    readonly level: 'info' | 'warn'
    readonly message: string
    readonly meta: Readonly<Record<string, unknown>>
  }
  const lines: LogLine[] = []
  const logger: RootUpdateLogger = {
    debug: () => undefined,
    info: (message, context) => lines.push({ level: 'info', message, meta: context?.meta ?? {} }),
    warn: (message, context) => lines.push({ level: 'warn', message, meta: context?.meta ?? {} }),
    error: () => undefined,
  }
  let tmp: string
  let installManifests: Record<string, unknown>[]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-pins-'))
    installManifests = []
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  /** `pack` drops `tgz` (when given) into --pack-destination; `install` records the manifest. */
  function stub(tgz: Buffer | null): NpmExecFn {
    return async (args, opts) => {
      if (args[0] === 'pack') {
        const dest = args[args.indexOf('--pack-destination') + 1]
        if (tgz !== null && dest !== undefined) {
          fs.writeFileSync(path.join(dest, 'camstack-server-1.2.277.tgz'), tgz)
        }
        return { stdout: '' }
      }
      if (args[0] !== 'install' || opts.cwd === undefined) return { stdout: '' }
      installManifests.push(
        JSON.parse(fs.readFileSync(path.join(opts.cwd, 'package.json'), 'utf-8')) as Record<
          string,
          unknown
        >,
      )
      const pkgDir = rootPackageDir(opts.cwd, HUB_ROOT_SPEC)
      fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@camstack/server', version: '1.2.277' }),
        'utf-8',
      )
      return { stdout: '' }
    }
  }

  async function stage(execNpm: NpmExecFn): Promise<void> {
    const runningPkg = path.join(tmp, 'running-package.json')
    fs.writeFileSync(runningPkg, JSON.stringify({ name: '@camstack/server', version: '1.2.276' }))
    const service = new RootUpdateService({
      spec: HUB_ROOT_SPEC,
      envNames: ENV_NAMES,
      logger,
      restartServer: () => undefined,
      dataDir: path.join(tmp, 'data'),
      runningPackageJsonPath: runningPkg,
      workspaceProbeDir: tmp,
      execNpm,
      applyClosurePatches: async () => undefined,
      env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root', CAMSTACK_SERVER_ACTIVE_VERSION: '1.2.276' },
      now: () => 1_700_000_000_000,
    })
    await service.applyServerUpdate({ version: '1.2.277' }).catch(() => undefined)
  }

  it('writes the target pins as overrides into the manifest the install runs in', async () => {
    await stage(stub(makeTarball({ 'closure-pins.json': JSON.stringify(PINS) })))
    expect(installManifests).toHaveLength(1)
    expect(installManifests[0]?.['overrides']).toEqual(PINS)
  })

  it('installs as before, with no overrides, when the target ships no pins file', async () => {
    await stage(stub(makeTarball({ 'package.json': '{}' })))
    expect(installManifests).toHaveLength(1)
    expect(installManifests[0]).not.toHaveProperty('overrides')
  })

  it('installs as before when the pack itself yields nothing', async () => {
    await stage(stub(null))
    expect(installManifests).toHaveLength(1)
    expect(installManifests[0]).not.toHaveProperty('overrides')
  })

  it('names the reason, and warns only when a shipped pins file was rejected', async () => {
    const cases: ReadonlyArray<readonly [Buffer | null, string, 'info' | 'warn']> = [
      [null, 'no-tarball', 'info'],
      [makeTarball({ 'package.json': '{}' }), 'entry-missing', 'info'],
      [makeTarball({ 'closure-pins.json': 'not json' }), 'unparseable', 'warn'],
      [makeTarball({ 'closure-pins.json': '{"a":"^1.0.0"}' }), 'non-exact-version', 'warn'],
    ]
    for (const [tgz, reason, level] of cases) {
      installManifests = []
      lines.length = 0
      await stage(stub(tgz))
      const line = lines.find((l) => l.message.startsWith('closure install unpinned'))
      expect(line?.meta['reason'], reason).toBe(reason)
      expect(line?.level, reason).toBe(level)
    }
  })

  it('runs the pack in the staging dir, beside the manifest the install uses', async () => {
    const packCwds: Array<string | undefined> = []
    const inner = stub(makeTarball({ 'closure-pins.json': JSON.stringify(PINS) }))
    await stage(async (args, opts) => {
      if (args[0] === 'pack') packCwds.push(opts.cwd)
      return inner(args, opts)
    })
    expect(packCwds).toHaveLength(1)
    expect(packCwds[0]).toContain('.staging')
  })
})
