import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC, type RootPackageSpec } from '../root-package-spec.js'
import {
  rootEntryPath,
  rootPackageDir,
  serverRootDir,
  versionDir,
  writeServerRootState,
} from '../root-state.js'
import { currentDir, stagingDirPath, writePendingRootSwap } from '../root-single-copy.js'
import { isHostExternal, runNodeStarter, type NodeStarterOptions } from '../starter-core.js'

/**
 * A second, distinct spec used only to prove the boot machinery is fully
 * spec-parameterized (a different package name + entry resolves correctly).
 * Post-consolidation there is one real spec (`HUB_ROOT_SPEC`); this fixture
 * keeps the DI coverage without a second production constant.
 */
const ALT_ROOT_SPEC: RootPackageSpec = {
  packageName: '@camstack/alt-root',
  entryRelPath: ['dist', 'cli.js'],
}

const ENV_NAMES = {
  bootMode: 'TEST_BOOT_MODE',
  activeRoot: 'TEST_ACTIVE_ROOT',
  activeVersion: 'TEST_ACTIVE_VERSION',
  killSwitch: 'TEST_ROOT',
} as const

const NOW = 1_700_000_000_000

let tmp: string
let dataDir: string
let seedEntry: string
let starterDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-core-'))
  dataDir = path.join(tmp, 'data')
  starterDir = path.join(tmp, 'image', 'dist')
  fs.mkdirSync(starterDir, { recursive: true })
  seedEntry = path.join(starterDir, 'launcher.js')
  fs.writeFileSync(seedEntry, '// seed', 'utf-8')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function scaffoldClosureAt(dir: string, spec: RootPackageSpec, version: string): void {
  const pkgDir = rootPackageDir(dir, spec)
  fs.mkdirSync(path.dirname(rootEntryPath(dir, spec)), { recursive: true })
  fs.writeFileSync(rootEntryPath(dir, spec), '// entry', 'utf-8')
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: spec.packageName, version }),
    'utf-8',
  )
}

function scaffoldNatives(dir: string): void {
  for (const rel of [
    'better-sqlite3/build/Release/better_sqlite3.node',
    '@img/sharp-linux-x64/lib/sharp.node',
    '@seydx/node-av-linux-x64/av.node',
  ]) {
    const full = path.join(dir, 'node_modules', ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'ELF', 'utf-8')
  }
}

function scaffoldLegacyVersion(spec: RootPackageSpec, version: string): void {
  scaffoldClosureAt(versionDir(serverRootDir(dataDir), version), spec, version)
}

function scaffoldCurrent(spec: RootPackageSpec, version: string): void {
  scaffoldClosureAt(currentDir(serverRootDir(dataDir)), spec, version)
}

interface RunResult {
  readonly loaded: string[]
  readonly resolved: string[]
  readonly env: NodeJS.ProcessEnv
}

function run(overrides: Partial<NodeStarterOptions> = {}): RunResult {
  const loaded: string[] = []
  const resolved: string[] = []
  const env: NodeJS.ProcessEnv = { ...overrides.env }
  runNodeStarter({
    spec: HUB_ROOT_SPEC,
    envNames: ENV_NAMES,
    dataDir,
    seedEntry,
    starterDir,
    loadEntry: (p) => loaded.push(p),
    now: () => NOW,
    nodeMajor: 24,
    registerResolver: (dir) => resolved.push(dir),
    ...overrides,
    env,
  })
  return { loaded, resolved, env }
}

describe('runNodeStarter (single-copy model)', () => {
  it('boots the baked seed when nothing is installed', () => {
    const r = run()
    expect(r.loaded).toEqual([seedEntry])
    expect(r.env[ENV_NAMES.bootMode]).toBe('baked')
    expect(r.resolved).toEqual([])
  })

  it('defers to plain resolution in a workspace checkout', () => {
    fs.writeFileSync(
      path.join(tmp, 'image', 'package.json'),
      JSON.stringify({ name: 'ws', workspaces: ['packages/*'] }),
      'utf-8',
    )
    scaffoldCurrent(HUB_ROOT_SPEC, '1.1.51')
    const r = run()
    expect(r.loaded).toEqual([seedEntry])
    expect(r.env[ENV_NAMES.bootMode]).toBe('workspace')
  })

  it('honors the kill switch (<killSwitch>=off boots the seed)', () => {
    scaffoldCurrent(HUB_ROOT_SPEC, '1.1.51')
    const r = run({ env: { [ENV_NAMES.killSwitch]: 'off' } })
    expect(r.loaded).toEqual([seedEntry])
    expect(r.env[ENV_NAMES.bootMode]).toBe('baked')
  })

  it('boots the single current copy and exports the active-root markers', () => {
    scaffoldCurrent(HUB_ROOT_SPEC, '1.1.51')
    const r = run()
    const cDir = currentDir(serverRootDir(dataDir))
    expect(r.loaded).toEqual([rootEntryPath(cDir, HUB_ROOT_SPEC)])
    expect(r.env[ENV_NAMES.bootMode]).toBe('data-root')
    // activeRoot IS the single copy — the node entry derives the framework dir
    // (forked-runner resolver + NODE_PATH) from it.
    expect(r.env[ENV_NAMES.activeRoot]).toBe(cDir)
    expect(r.env[ENV_NAMES.activeVersion]).toBe('1.1.51')
    expect(r.resolved).toEqual([cDir])
  })

  it('migrates a legacy versions/<X> layout to the single copy, then boots it', () => {
    scaffoldLegacyVersion(HUB_ROOT_SPEC, '1.1.50')
    writeServerRootState(serverRootDir(dataDir), {
      schemaVersion: 1,
      currentVersion: '1.1.50',
      previousVersion: null,
      pendingBoot: null,
      rolledBack: null,
    })
    const r = run()
    const cDir = currentDir(serverRootDir(dataDir))
    expect(r.loaded).toEqual([rootEntryPath(cDir, HUB_ROOT_SPEC)])
    expect(r.env[ENV_NAMES.activeVersion]).toBe('1.1.50')
    // Legacy layout retired.
    expect(fs.existsSync(versionDir(serverRootDir(dataDir), '1.1.50'))).toBe(false)
  })

  it('applies a staged pending swap at boot, then boots the swapped copy', () => {
    scaffoldCurrent(HUB_ROOT_SPEC, '1.1.50')
    const staging = stagingDirPath(serverRootDir(dataDir), '1.1.60', 42, NOW)
    scaffoldClosureAt(staging, HUB_ROOT_SPEC, '1.1.60')
    scaffoldNatives(staging)
    writePendingRootSwap(serverRootDir(dataDir), {
      schemaVersion: 1,
      version: '1.1.60',
      stagingPath: staging,
      requestedAtMs: NOW,
    })
    const r = run()
    const cDir = currentDir(serverRootDir(dataDir))
    expect(r.loaded).toEqual([rootEntryPath(cDir, HUB_ROOT_SPEC)])
    expect(r.env[ENV_NAMES.activeVersion]).toBe('1.1.60')
    expect(fs.existsSync(staging)).toBe(false)
  })

  it('boots the baked seed when the current copy is corrupt', () => {
    // current dir exists but has no loadable entry.
    fs.mkdirSync(currentDir(serverRootDir(dataDir)), { recursive: true })
    const r = run()
    expect(r.loaded).toEqual([seedEntry])
    expect(r.env[ENV_NAMES.bootMode]).toBe('baked')
  })

  it('boots an alternate spec entry (dist/cli.js) — proves full spec parameterization', () => {
    scaffoldCurrent(ALT_ROOT_SPEC, '1.1.40')
    const r = run({ spec: ALT_ROOT_SPEC })
    const cDir = currentDir(serverRootDir(dataDir))
    expect(r.loaded).toEqual([rootEntryPath(cDir, ALT_ROOT_SPEC)])
    expect(r.loaded[0]).toMatch(/dist[/\\]cli\.js$/)
  })
})

describe('isHostExternal', () => {
  it('matches exact and subpath specifiers only', () => {
    expect(isHostExternal('@camstack/system')).toBe(true)
    expect(isHostExternal('@camstack/system/dist/addon-runner.js')).toBe(true)
    expect(isHostExternal('zod')).toBe(true)
    expect(isHostExternal('zod-to-json-schema')).toBe(false)
    expect(isHostExternal('@camstack/systemx')).toBe(false)
    expect(isHostExternal('fastify')).toBe(false)
  })
})
