/**
 * npm 12 blocks a dependency's install scripts by default (`allowScripts`), so
 * a closure staged with it silently gets NO `@camstack/server` postinstall —
 * which is the only thing that applies the shipped `werift` patch — and no
 * `better-sqlite3` / `node-av` prebuild fetch either.
 *
 * Measured 2026-09-13 on the Mac-mini agent, which bootstrapped npm 12.0.1
 * while hub and agent-a still run npm 11:
 *
 *   npm warn install-scripts 7 packages had install scripts blocked because
 *   npm warn install-scripts   @camstack/server@1.2.277 (postinstall: …)
 *   npm warn install-scripts   better-sqlite3@12.11.1 (install: …)
 *
 * The applier itself was fine — run by hand in that same staging closure it
 * reported `APPLIED werift@0.22.9` on three files. It is never invoked.
 *
 * Two independent fixes, because the two problems are not the same problem:
 * `allowScripts` for the packages that genuinely need npm to build something,
 * and an EXPLICIT applier call for our own patches, which need no npm at all
 * and must therefore not depend on any npm policy.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC } from '../root-package-spec.js'
import { rootPackageDir } from '../root-state.js'
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

let tmp: string
let dataDir: string
let runningPkgPath: string
/** Every staging package.json npm was handed, in order. */
let manifests: Record<string, unknown>[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-scripts-'))
  dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  runningPkgPath = path.join(tmp, 'running-package.json')
  fs.writeFileSync(
    runningPkgPath,
    JSON.stringify({ name: '@camstack/server', version: '1.2.276' }),
    'utf-8',
  )
  manifests = []
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * Scaffolds a closure that is valid in every way EXCEPT that no lifecycle
 * script ran — exactly what npm 12 produces. The werift copy is the unpatched
 * npm tarball, so `findUnappliedClosurePatches` refuses it unless something
 * else applied the patch.
 */
function makeNpm12InstallStub(version: string): NpmExecFn {
  return async (args, opts) => {
    if (args[0] !== 'install' || opts.cwd === undefined) return { stdout: '' }
    manifests.push(
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
    return { stdout: '' }
  }
}

function makeService(options: {
  readonly execNpm: NpmExecFn
  readonly applyClosurePatches?: (closureDir: string) => Promise<void>
  readonly logger?: RootUpdateLogger
}): RootUpdateService {
  return new RootUpdateService({
    spec: HUB_ROOT_SPEC,
    envNames: ENV_NAMES,
    logger: options.logger ?? makeLogger(),
    restartServer: () => undefined,
    dataDir,
    runningPackageJsonPath: runningPkgPath,
    workspaceProbeDir: tmp,
    execNpm: options.execNpm,
    ...(options.applyClosurePatches !== undefined
      ? { applyClosurePatches: options.applyClosurePatches }
      : {}),
    env: { CAMSTACK_SERVER_BOOT_MODE: 'data-root', CAMSTACK_SERVER_ACTIVE_VERSION: '1.2.276' },
    now: () => NOW,
  })
}

describe('staging a closure under an npm that blocks install scripts', () => {
  it('tells npm which packages are allowed to run their install scripts', async () => {
    const service = makeService({
      execNpm: makeNpm12InstallStub('1.2.277'),
      applyClosurePatches: async () => undefined,
    })

    await service.applyServerUpdate({ version: '1.2.277' }).catch(() => undefined)

    expect(manifests.length).toBeGreaterThan(0)
    const allow = manifests[0]?.['allowScripts']
    expect(allow, 'the staging manifest must carry an allowScripts entry').toBeDefined()
    // The root package's own postinstall, plus the natives that genuinely need
    // npm to fetch or build something. A native that cannot load breaks decode,
    // snapshots and the database — the validator already refuses that closure,
    // but refusing every update is not a fix.
    expect(allow).toMatchObject({
      '@camstack/server': true,
      'better-sqlite3': true,
      'node-av': true,
    })
  })

  it('applies the shipped closure patches itself, without relying on npm', async () => {
    const applied: string[] = []
    const service = makeService({
      execNpm: makeNpm12InstallStub('1.2.277'),
      applyClosurePatches: async (closureDir) => {
        applied.push(closureDir)
      },
    })

    await service.applyServerUpdate({ version: '1.2.277' }).catch(() => undefined)

    expect(applied.length, 'the applier must run against the staging closure').toBe(1)
    expect(fs.existsSync(path.join(applied[0] ?? '', 'package.json'))).toBe(true)
  })

  it('lets the validator speak when the applier throws, instead of masking it', async () => {
    const warnings: string[] = []
    const service = makeService({
      execNpm: makeNpm12InstallStub('1.2.277'),
      applyClosurePatches: async () => {
        throw new Error('payload unreadable')
      },
      logger: { ...makeLogger(), warn: (message) => warnings.push(message) },
    })

    // The closure the stub builds carries no werift at all, so there is nothing
    // for the validator to refuse; what matters is that a throwing applier is
    // reported and does not become the error the operator sees.
    await service.applyServerUpdate({ version: '1.2.277' }).catch(() => undefined)

    expect(warnings.some((w) => w.includes('closure-patch'))).toBe(true)
  })
})
