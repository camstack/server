/**
 * Single-copy layout — swap, migration, native-prebuild assertion, sweep.
 * These are the brick-risk boot-sequence primitives (2026-07-18 collapse), so
 * every branch is exercised against real tmp-dir filesystems.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC, type RootPackageSpec } from '../root-package-spec.js'
import {
  rootPackageDir,
  serverRootDir,
  stateFilePath,
  validateClosureDir,
  versionDir,
  writeServerRootState,
} from '../root-state.js'
import {
  applyPendingRootSwap,
  currentDir,
  findMissingNativePrebuilds,
  migrateToSingleCopy,
  readPendingRootSwap,
  stagingDirPath,
  sweepTransientRootDirs,
  writePendingRootSwap,
} from '../root-single-copy.js'

const NOW = 1_700_000_000_000
const NODE_MAJOR = 24

let tmp: string
let rootDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'single-copy-'))
  rootDir = serverRootDir(path.join(tmp, 'data'))
  fs.mkdirSync(rootDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Scaffold the required native prebuilds under a closure's node_modules. */
function scaffoldNatives(closureDir: string): void {
  const nm = path.join(closureDir, 'node_modules')
  const bindings: readonly string[] = [
    'better-sqlite3/build/Release/better_sqlite3.node',
    '@img/sharp-linux-x64/lib/sharp.node',
    '@seydx/node-av-linux-x64/av.node',
  ]
  for (const rel of bindings) {
    const full = path.join(nm, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, '\x7fELF-ish', 'utf-8')
  }
}

/** Scaffold a loadable closure (entry + package.json [+ natives]) at `dir`. */
function scaffoldClosure(
  dir: string,
  version: string,
  opts: { natives?: boolean; spec?: RootPackageSpec } = {},
): void {
  const spec = opts.spec ?? HUB_ROOT_SPEC
  const pkgDir = rootPackageDir(dir, spec)
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'dist', spec.entryRelPath.at(-1) ?? 'launcher.js'), '// entry')
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: spec.packageName, version }),
  )
  if (opts.natives !== false) scaffoldNatives(dir)
}

describe('findMissingNativePrebuilds', () => {
  it('reports none when every required native prebuild is present', () => {
    const dir = path.join(rootDir, 'closure')
    scaffoldClosure(dir, '1.2.3')
    expect(findMissingNativePrebuilds(dir)).toEqual([])
  })

  it('reports the natives whose .node binding is absent', () => {
    const dir = path.join(rootDir, 'closure')
    scaffoldClosure(dir, '1.2.3', { natives: false })
    expect(findMissingNativePrebuilds(dir).sort()).toEqual(['better-sqlite3', 'node-av', 'sharp'])
  })

  it('a package dir present but without any .node counts as missing', () => {
    const dir = path.join(rootDir, 'closure')
    scaffoldClosure(dir, '1.2.3', { natives: false })
    fs.mkdirSync(path.join(dir, 'node_modules', 'better-sqlite3'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', 'better-sqlite3', 'index.js'), '// js')
    expect(findMissingNativePrebuilds(dir)).toContain('better-sqlite3')
  })
})

describe('pending-root-swap marker', () => {
  it('round-trips through write/read/validate', () => {
    writePendingRootSwap(rootDir, {
      schemaVersion: 1,
      version: '1.2.3',
      stagingPath: '/x/.staging-1.2.3',
      requestedAtMs: NOW,
    })
    expect(readPendingRootSwap(rootDir)?.version).toBe('1.2.3')
  })

  it('returns null for a missing or corrupt marker', () => {
    expect(readPendingRootSwap(rootDir)).toBeNull()
    fs.writeFileSync(path.join(rootDir, '.pending-root-swap.json'), '{ not json')
    expect(readPendingRootSwap(rootDir)).toBeNull()
  })
})

describe('applyPendingRootSwap', () => {
  it('is a no-op with no marker', () => {
    const res = applyPendingRootSwap(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('no pending swap')
  })

  it('swaps a valid staged closure into current (no prior current)', () => {
    const staging = stagingDirPath(rootDir, '2.0.0', 111, NOW)
    scaffoldClosure(staging, '2.0.0')
    writePendingRootSwap(rootDir, {
      schemaVersion: 1,
      version: '2.0.0',
      stagingPath: staging,
      requestedAtMs: NOW,
    })

    const res = applyPendingRootSwap(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res).toMatchObject({ applied: true, version: '2.0.0' })
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '2.0.0')).toBeNull()
    expect(fs.existsSync(staging)).toBe(false)
    expect(readPendingRootSwap(rootDir)).toBeNull()
  })

  it('replaces an existing current in place with no N-1 retention', () => {
    scaffoldClosure(currentDir(rootDir), '1.0.0')
    const staging = stagingDirPath(rootDir, '2.0.0', 111, NOW)
    scaffoldClosure(staging, '2.0.0')
    writePendingRootSwap(rootDir, {
      schemaVersion: 1,
      version: '2.0.0',
      stagingPath: staging,
      requestedAtMs: NOW,
    })

    applyPendingRootSwap(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '2.0.0')).toBeNull()
    // No leftover .trash-* graveyard (no rollback copy retained).
    const trash = fs.readdirSync(rootDir).filter((e) => e.startsWith('.trash-'))
    expect(trash).toEqual([])
  })

  it('discards a staged closure that fails validation — current preserved', () => {
    scaffoldClosure(currentDir(rootDir), '1.0.0')
    const staging = stagingDirPath(rootDir, '2.0.0', 111, NOW)
    scaffoldClosure(staging, '2.0.0', { natives: true })
    // Corrupt the staged package version so validation fails.
    fs.writeFileSync(
      path.join(rootPackageDir(staging, HUB_ROOT_SPEC), 'package.json'),
      JSON.stringify({ name: '@camstack/server', version: '9.9.9' }),
    )
    writePendingRootSwap(rootDir, {
      schemaVersion: 1,
      version: '2.0.0',
      stagingPath: staging,
      requestedAtMs: NOW,
    })

    const res = applyPendingRootSwap(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res.applied).toBe(false)
    // current is untouched (still 1.0.0), staging + marker cleaned up.
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '1.0.0')).toBeNull()
    expect(fs.existsSync(staging)).toBe(false)
    expect(readPendingRootSwap(rootDir)).toBeNull()
  })

  it('discards a staged closure missing native prebuilds — current preserved', () => {
    scaffoldClosure(currentDir(rootDir), '1.0.0')
    const staging = stagingDirPath(rootDir, '2.0.0', 111, NOW)
    scaffoldClosure(staging, '2.0.0', { natives: false })
    writePendingRootSwap(rootDir, {
      schemaVersion: 1,
      version: '2.0.0',
      stagingPath: staging,
      requestedAtMs: NOW,
    })

    const res = applyPendingRootSwap(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/native prebuilds/)
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '1.0.0')).toBeNull()
    expect(readPendingRootSwap(rootDir)).toBeNull()
  })

  it('self-heals a crash after the swap completed (staging gone, current already new)', () => {
    scaffoldClosure(currentDir(rootDir), '2.0.0')
    const staging = stagingDirPath(rootDir, '2.0.0', 111, NOW) // never created
    writePendingRootSwap(rootDir, {
      schemaVersion: 1,
      version: '2.0.0',
      stagingPath: staging,
      requestedAtMs: NOW,
    })
    const res = applyPendingRootSwap(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res).toMatchObject({ applied: true, version: '2.0.0', reason: 'already applied' })
    expect(readPendingRootSwap(rootDir)).toBeNull()
  })
})

describe('migrateToSingleCopy', () => {
  it('adopts the legacy active version recorded in state.json', () => {
    scaffoldClosure(versionDir(rootDir, '1.1.50'), '1.1.50')
    writeServerRootState(rootDir, {
      schemaVersion: 1,
      currentVersion: '1.1.50',
      previousVersion: null,
      pendingBoot: null,
      rolledBack: null,
    })

    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res).toMatchObject({ migrated: true, version: '1.1.50' })
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '1.1.50')).toBeNull()
    // Legacy machinery retired.
    expect(fs.existsSync(versionDir(rootDir, '1.1.50'))).toBe(false)
    expect(fs.existsSync(stateFilePath(rootDir))).toBe(false)
  })

  it('discovers a valid legacy version by scanning versions/ when state is absent', () => {
    scaffoldClosure(versionDir(rootDir, '1.1.51'), '1.1.51')
    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res).toMatchObject({ migrated: true, version: '1.1.51' })
  })

  it('is a no-op (idempotent) when a valid current already exists', () => {
    scaffoldClosure(currentDir(rootDir), '2.0.0')
    scaffoldClosure(versionDir(rootDir, '1.1.50'), '1.1.50')
    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res.migrated).toBe(false)
    expect(res.reason).toMatch(/already/)
    // versions/ left intact — nothing was migrated.
    expect(fs.existsSync(versionDir(rootDir, '1.1.50'))).toBe(true)
  })

  it('is a no-op on a fresh install (no legacy versions to adopt)', () => {
    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res.migrated).toBe(false)
    expect(res.reason).toMatch(/no valid legacy/)
    expect(fs.existsSync(currentDir(rootDir))).toBe(false)
  })

  it('clears legacy /data/framework swap markers on migration', () => {
    const dataDir = path.dirname(rootDir)
    fs.writeFileSync(path.join(dataDir, '.pending-framework-swap.json'), '{}')
    fs.writeFileSync(path.join(dataDir, '.framework-swap-confirm.json'), '{}')
    scaffoldClosure(versionDir(rootDir, '1.1.50'), '1.1.50')
    migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(fs.existsSync(path.join(dataDir, '.pending-framework-swap.json'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, '.framework-swap-confirm.json'))).toBe(false)
  })

  // ── OLD-format in-flight pendingBoot (#17) — pre-collapse root-update-service
  // staged versions/<X> + state.json.pendingBoot but never promoted. The agents
  // still run the OLD mechanism, so the collapse migration must adopt X (not the
  // recorded active version) or the update strands ("stuck, promote manually").
  function writeLegacyPendingState(current: string | null, pending: string): void {
    writeServerRootState(rootDir, {
      schemaVersion: 1,
      currentVersion: current,
      previousVersion: null,
      pendingBoot: { version: pending, fromVersion: current, requestedAtMs: NOW, bootAttempts: 0 },
      rolledBack: null,
    })
  }

  it('adopts an in-flight OLD-format pending update over the recorded active version', () => {
    scaffoldClosure(versionDir(rootDir, '1.1.50'), '1.1.50')
    scaffoldClosure(versionDir(rootDir, '1.1.60'), '1.1.60')
    writeLegacyPendingState('1.1.50', '1.1.60')

    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res).toMatchObject({ migrated: true, version: '1.1.60' })
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '1.1.60')).toBeNull()
    expect(fs.existsSync(versionDir(rootDir, '1.1.60'))).toBe(false)
    expect(fs.existsSync(stateFilePath(rootDir))).toBe(false)
  })

  it('falls back to the active version when the pending closure is invalid', () => {
    scaffoldClosure(versionDir(rootDir, '1.1.50'), '1.1.50')
    // Pending dir exists but its package.json version mismatches the dir name.
    scaffoldClosure(versionDir(rootDir, '1.1.60'), '9.9.9')
    writeLegacyPendingState('1.1.50', '1.1.60')

    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res).toMatchObject({ migrated: true, version: '1.1.50' })
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '1.1.50')).toBeNull()
  })

  it('does NOT prefer a pending closure that is missing native prebuilds', () => {
    scaffoldClosure(versionDir(rootDir, '1.1.50'), '1.1.50')
    // Pending closure is loadable but carries no native prebuilds — adopting it
    // would brick the forked runners, so the active version must win.
    scaffoldClosure(versionDir(rootDir, '1.1.60'), '1.1.60', { natives: false })
    writeLegacyPendingState('1.1.50', '1.1.60')

    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res).toMatchObject({ migrated: true, version: '1.1.50' })
  })

  it('adopts the pending update once when pendingBoot.version == active', () => {
    scaffoldClosure(versionDir(rootDir, '1.1.60'), '1.1.60')
    writeLegacyPendingState('1.1.60', '1.1.60')

    const first = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(first).toMatchObject({ migrated: true, version: '1.1.60' })
    // Idempotent: second run sees a valid current + no state.json → no-op.
    const second = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(second.migrated).toBe(false)
  })

  it('prefers a newer in-flight pending over an already-present older current', () => {
    scaffoldClosure(currentDir(rootDir), '1.1.50')
    scaffoldClosure(versionDir(rootDir, '1.1.60'), '1.1.60')
    writeLegacyPendingState('1.1.50', '1.1.60')

    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res).toMatchObject({ migrated: true, version: '1.1.60' })
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '1.1.60')).toBeNull()
  })

  it('keeps a current that is newer than a stale pending marker', () => {
    scaffoldClosure(currentDir(rootDir), '1.2.0')
    scaffoldClosure(versionDir(rootDir, '1.1.60'), '1.1.60')
    writeLegacyPendingState('1.1.50', '1.1.60')

    const res = migrateToSingleCopy(
      rootDir,
      HUB_ROOT_SPEC,
      NODE_MAJOR,
      () => NOW,
      () => {},
    )
    expect(res.migrated).toBe(false)
    expect(validateClosureDir(currentDir(rootDir), NODE_MAJOR, HUB_ROOT_SPEC, '1.2.0')).toBeNull()
  })
})

describe('sweepTransientRootDirs', () => {
  it('removes stale .staging-*/.trash-* but keeps fresh ones', () => {
    const stale = path.join(rootDir, '.staging-old')
    const trashStale = path.join(rootDir, '.trash-old')
    const fresh = path.join(rootDir, '.staging-fresh')
    for (const d of [stale, trashStale, fresh]) fs.mkdirSync(d, { recursive: true })
    const old = NOW - 48 * 60 * 60 * 1000
    fs.utimesSync(stale, new Date(old), new Date(old))
    fs.utimesSync(trashStale, new Date(old), new Date(old))

    sweepTransientRootDirs(rootDir, NOW, 24 * 60 * 60 * 1000)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(trashStale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('never touches current/ or the marker', () => {
    scaffoldClosure(currentDir(rootDir), '1.0.0')
    sweepTransientRootDirs(rootDir, NOW, 0)
    expect(fs.existsSync(currentDir(rootDir))).toBe(true)
  })
})
