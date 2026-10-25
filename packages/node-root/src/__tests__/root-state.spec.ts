import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HUB_ROOT_SPEC, type RootPackageSpec } from '../root-package-spec.js'
import {
  clearRestartIntentMarker,
  emptyServerRootState,
  RESTART_INTENT_FILE,
  readRestartIntentMarker,
  readServerRootState,
  restartIntentMarkerPath,
  rootEntryPath,
  rootPackageDir,
  serverRootDir,
  stateFilePath,
  validateVersionDir,
  versionDir,
  writeRestartIntentMarker,
  writeServerRootState,
  type ServerRootState,
} from '../root-state.js'

/**
 * A second, distinct spec used only to prove the layout helpers are fully
 * spec-parameterized. Post-consolidation there is one real spec
 * (`HUB_ROOT_SPEC`); this fixture keeps the DI coverage.
 */
const ALT_ROOT_SPEC: RootPackageSpec = {
  packageName: '@camstack/alt-root',
  entryRelPath: ['dist', 'cli.js'],
}

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-root-state-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('layout helpers', () => {
  it('derives the documented hub layout', () => {
    const root = serverRootDir('/data')
    expect(root).toBe(path.join('/data', 'server-root'))
    expect(versionDir(root, '1.2.3')).toBe(path.join(root, 'versions', '1.2.3'))
    expect(rootPackageDir(versionDir(root, '1.2.3'), HUB_ROOT_SPEC)).toBe(
      path.join(root, 'versions', '1.2.3', 'node_modules', '@camstack', 'server'),
    )
    expect(rootEntryPath(versionDir(root, '1.2.3'), HUB_ROOT_SPEC)).toBe(
      path.join(
        root,
        'versions',
        '1.2.3',
        'node_modules',
        '@camstack',
        'server',
        'dist',
        'launcher.js',
      ),
    )
    expect(stateFilePath(root)).toBe(path.join(root, 'state.json'))
  })

  it('derives an alternate spec layout (same dir name, different package + entry)', () => {
    const root = serverRootDir('/data')
    expect(rootPackageDir(versionDir(root, '1.2.3'), ALT_ROOT_SPEC)).toBe(
      path.join(root, 'versions', '1.2.3', 'node_modules', '@camstack', 'alt-root'),
    )
    expect(rootEntryPath(versionDir(root, '1.2.3'), ALT_ROOT_SPEC)).toBe(
      path.join(
        root,
        'versions',
        '1.2.3',
        'node_modules',
        '@camstack',
        'alt-root',
        'dist',
        'cli.js',
      ),
    )
  })
})

describe('state IO', () => {
  it('round-trips a state file', () => {
    const state: ServerRootState = {
      schemaVersion: 1,
      currentVersion: '1.1.50',
      previousVersion: '1.1.49',
      pendingBoot: {
        version: '1.1.51',
        fromVersion: '1.1.50',
        requestedAtMs: 123,
        bootAttempts: 0,
      },
      rolledBack: null,
    }
    writeServerRootState(tmp, state)
    expect(readServerRootState(tmp)).toEqual(state)
  })

  it('returns null when the state file is missing', () => {
    expect(readServerRootState(tmp)).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    fs.writeFileSync(stateFilePath(tmp), '{nope', 'utf-8')
    expect(readServerRootState(tmp)).toBeNull()
  })

  it('returns null on a shape mismatch', () => {
    fs.writeFileSync(stateFilePath(tmp), JSON.stringify({ schemaVersion: 2 }), 'utf-8')
    expect(readServerRootState(tmp)).toBeNull()
  })

  it('emptyServerRootState round-trips', () => {
    writeServerRootState(tmp, emptyServerRootState())
    expect(readServerRootState(tmp)).toEqual(emptyServerRootState())
  })
})

describe('validateVersionDir', () => {
  function scaffoldVersion(version: string, pkg: Record<string, unknown>): string {
    const vDir = versionDir(tmp, version)
    const pkgDir = rootPackageDir(vDir, HUB_ROOT_SPEC)
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'dist', 'launcher.js'), '// entry', 'utf-8')
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg), 'utf-8')
    return vDir
  }

  it('accepts a well-formed version dir', () => {
    scaffoldVersion('1.1.50', { name: '@camstack/server', version: '1.1.50' })
    expect(validateVersionDir(tmp, '1.1.50', 24, HUB_ROOT_SPEC)).toBeNull()
  })

  it('rejects a missing version dir', () => {
    expect(validateVersionDir(tmp, '9.9.9', 24, HUB_ROOT_SPEC)).toMatch(/entry/i)
  })

  it('rejects a wrong package name', () => {
    scaffoldVersion('1.1.50', { name: '@camstack/other', version: '1.1.50' })
    expect(validateVersionDir(tmp, '1.1.50', 24, HUB_ROOT_SPEC)).toMatch(/name/i)
  })

  it('rejects a version mismatch', () => {
    scaffoldVersion('1.1.50', { name: '@camstack/server', version: '1.1.51' })
    expect(validateVersionDir(tmp, '1.1.50', 24, HUB_ROOT_SPEC)).toMatch(/version/i)
  })

  it('rejects when the node runtime is older than engines.node', () => {
    scaffoldVersion('1.1.50', {
      name: '@camstack/server',
      version: '1.1.50',
      engines: { node: '>=26' },
    })
    expect(validateVersionDir(tmp, '1.1.50', 24, HUB_ROOT_SPEC)).toMatch(/engines/i)
  })

  it('accepts when the node runtime satisfies engines.node', () => {
    scaffoldVersion('1.1.50', {
      name: '@camstack/server',
      version: '1.1.50',
      engines: { node: '>=22' },
    })
    expect(validateVersionDir(tmp, '1.1.50', 24, HUB_ROOT_SPEC)).toBeNull()
  })

  it('accepts an unparseable engines.node (permissive)', () => {
    scaffoldVersion('1.1.50', {
      name: '@camstack/server',
      version: '1.1.50',
      engines: { node: 'weird' },
    })
    expect(validateVersionDir(tmp, '1.1.50', 24, HUB_ROOT_SPEC)).toBeNull()
  })

  it('validates a version dir against an alternate spec', () => {
    const vDir = versionDir(tmp, '1.1.40')
    const pkgDir = rootPackageDir(vDir, ALT_ROOT_SPEC)
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'dist', 'cli.js'), '// entry', 'utf-8')
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@camstack/alt-root', version: '1.1.40', engines: { node: '>=22' } }),
      'utf-8',
    )
    expect(validateVersionDir(tmp, '1.1.40', 24, ALT_ROOT_SPEC)).toBeNull()
    // The HUB spec must reject the same dir (wrong package + entry).
    expect(validateVersionDir(tmp, '1.1.40', 24, HUB_ROOT_SPEC)).toMatch(/entry/i)
  })
})

describe('restart-intent marker', () => {
  it('derives the marker path next to state.json', () => {
    const rootDir = serverRootDir(tmp)
    expect(restartIntentMarkerPath(rootDir)).toBe(path.join(rootDir, RESTART_INTENT_FILE))
  })

  it('round-trips a written marker', () => {
    const rootDir = serverRootDir(tmp)
    writeRestartIntentMarker(rootDir, {
      requestedAtMs: 123,
      reason: 'server-update: @camstack/server@1.2.3',
    })
    const read = readRestartIntentMarker(rootDir)
    expect(read).toEqual({ requestedAtMs: 123, reason: 'server-update: @camstack/server@1.2.3' })
  })

  it('returns null when the marker is missing', () => {
    expect(readRestartIntentMarker(serverRootDir(tmp))).toBeNull()
  })

  it('returns null for a corrupt marker', () => {
    const rootDir = serverRootDir(tmp)
    fs.mkdirSync(rootDir, { recursive: true })
    fs.writeFileSync(restartIntentMarkerPath(rootDir), '{ not json', 'utf-8')
    expect(readRestartIntentMarker(rootDir)).toBeNull()
  })

  it('clears the marker idempotently', () => {
    const rootDir = serverRootDir(tmp)
    writeRestartIntentMarker(rootDir, { requestedAtMs: 1, reason: 'x' })
    clearRestartIntentMarker(rootDir)
    expect(readRestartIntentMarker(rootDir)).toBeNull()
    // Second clear on an absent marker must not throw.
    expect(() => clearRestartIntentMarker(rootDir)).not.toThrow()
  })
})
