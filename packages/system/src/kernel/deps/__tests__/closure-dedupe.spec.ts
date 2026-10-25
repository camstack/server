/**
 * Closure dedupe — plan rules + executor.
 *
 * The planning tests replay the LIVE hub state measured 2026-09-04:
 * closure `zod@4.5.4` / `werift@0.22.9` / `mediabunny@1.55.6`, while
 * provider-reolink carried `zod@3.25.76` (required at `^3` by
 * `@apocaliss92/nodelink-js`) plus its own `werift@0.22.9` and
 * `mediabunny@1.55.6`. The correct plan links werift + mediabunny and
 * REFUSES zod — a link there would silently downgrade a dependent across a
 * major.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  closureSatisfiesRange,
  collectAddonTreeState,
  executeClosureDedupe,
  isClosureLinkTarget,
  planClosureDedupe,
  readClosureVersions,
  resolveClosureNodeModulesDir,
  sameCompatLine,
} from '../closure-dedupe.js'

const silentLogger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger
  },
  withTags() {
    return silentLogger
  },
}

interface FakePackage {
  readonly name: string
  readonly version: string
  readonly dependencies?: Record<string, string>
}

function writePackage(nodeModulesDir: string, pkg: FakePackage): string {
  const dir = path.join(nodeModulesDir, pkg.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      main: 'index.js',
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { version: '${pkg.version}' };\n`)
  return dir
}

describe('closureSatisfiesRange — conservative semver', () => {
  it.each([
    // range, version, expected
    ['1.2.3', '1.2.3', true],
    ['=1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['^1.2.3', '1.9.0', true],
    ['^1.2.3', '1.2.2', false],
    ['^1.2.3', '2.0.0', false],
    ['^3.22.0', '4.5.4', false], // the live zod case
    ['^0.22.9', '0.22.9', true],
    ['^0.22.9', '0.22.15', true],
    ['^0.22.9', '0.23.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
    ['~1.2.3', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    // Unprovable forms must refuse.
    ['*', '1.0.0', false],
    ['>=1.0.0', '1.5.0', false],
    ['^1.0.0 || ^2.0.0', '2.0.0', false],
    ['latest', '1.0.0', false],
    ['1.x', '1.2.0', false],
    ['^1.2.3-beta.1', '1.3.0', false],
  ])('range %s vs %s → %s', (range, version, expected) => {
    expect(closureSatisfiesRange(range, version)).toBe(expected)
  })

  it('a prerelease closure version satisfies only an exact match', () => {
    expect(closureSatisfiesRange('^1.2.0', '1.3.0-dev.1')).toBe(false)
    expect(closureSatisfiesRange('1.3.0-dev.1', '1.3.0-dev.1')).toBe(true)
  })
})

describe('sameCompatLine', () => {
  it('requires the same major, and the same minor while major is 0', () => {
    expect(sameCompatLine('1.2.3', '1.9.9')).toBe(true)
    expect(sameCompatLine('1.2.3', '2.0.0')).toBe(false)
    expect(sameCompatLine('0.22.9', '0.22.15')).toBe(true)
    expect(sameCompatLine('0.22.9', '0.23.0')).toBe(false)
  })
})

describe('planClosureDedupe', () => {
  it('links what the closure serves compatibly, refuses the incompatible major (live hub scenario)', () => {
    const plan = planClosureDedupe({
      candidates: [
        { name: 'zod', version: '3.25.76' },
        { name: 'werift', version: '0.22.9' },
        { name: 'mediabunny', version: '1.55.5' },
        { name: 'onvif', version: '0.8.1' },
      ],
      closureVersions: new Map([
        ['zod', '4.5.4'],
        ['werift', '0.22.9'],
        ['mediabunny', '1.55.6'],
      ]),
      requirements: new Map([
        ['zod', ['^3.22.0']],
        ['werift', ['^0.22.9']],
        ['mediabunny', ['^1.50.0']],
        ['onvif', ['^0.8.1']],
      ]),
      neverLink: new Set(),
    })

    expect(plan.links.map((l) => l.name).toSorted()).toEqual(['mediabunny', 'werift'])
    expect(plan.keeps).toContainEqual({ name: 'zod', reason: 'version-incompatible' })
    expect(plan.keeps).toContainEqual({ name: 'onvif', reason: 'not-in-closure' })
  })

  it('never links @camstack/* or declared native dependencies', () => {
    const plan = planClosureDedupe({
      candidates: [
        { name: '@camstack/types', version: '1.0.0' },
        { name: 'onnxruntime-node', version: '1.20.0' },
      ],
      closureVersions: new Map([
        ['@camstack/types', '1.0.0'],
        ['onnxruntime-node', '1.20.0'],
      ]),
      requirements: new Map(),
      neverLink: new Set(['onnxruntime-node']),
    })
    expect(plan.links).toEqual([])
    expect(plan.keeps).toContainEqual({ name: '@camstack/types', reason: 'camstack-package' })
    expect(plan.keeps).toContainEqual({ name: 'onnxruntime-node', reason: 'never-link' })
  })

  it('a version difference with NO recorded requirement range keeps the copy', () => {
    const plan = planClosureDedupe({
      candidates: [{ name: 'lib', version: '1.2.0' }],
      closureVersions: new Map([['lib', '1.3.0']]),
      requirements: new Map(),
      neverLink: new Set(),
    })
    expect(plan.keeps).toEqual([{ name: 'lib', reason: 'version-incompatible' }])
  })

  it('identical versions always link, even without a recorded range', () => {
    const plan = planClosureDedupe({
      candidates: [{ name: 'lib', version: '1.2.0' }],
      closureVersions: new Map([['lib', '1.2.0']]),
      requirements: new Map(),
      neverLink: new Set(),
    })
    expect(plan.links).toEqual([{ name: 'lib', closureVersion: '1.2.0' }])
  })
})

describe('collectAddonTreeState', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-dedupe-state-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('reads candidates, ranges, and skips ranges shadowed by a nested override', () => {
    const addonDir = path.join(tmpRoot, 'addon')
    fs.mkdirSync(addonDir, { recursive: true })
    fs.writeFileSync(
      path.join(addonDir, 'package.json'),
      JSON.stringify({
        name: '@camstack/addon-x',
        version: '1.0.0',
        dependencies: { 'vendor-lib': '^1.0.0' },
      }),
    )
    const nm = path.join(addonDir, 'node_modules')
    const vendorDir = writePackage(nm, {
      name: 'vendor-lib',
      version: '1.2.0',
      dependencies: { zod: '^3.22.0', werift: '^0.22.9' },
    })
    writePackage(nm, { name: 'werift', version: '0.22.9' })
    // vendor-lib carries a NESTED zod — its ^3 range must NOT be recorded
    // against the (hypothetical) flat copy.
    writePackage(path.join(vendorDir, 'node_modules'), { name: 'zod', version: '3.25.76' })
    // A pre-existing symlink is not a candidate.
    fs.symlinkSync(vendorDir, path.join(nm, 'linked-lib'))

    const state = collectAddonTreeState(addonDir)
    expect(state.candidates.map((c) => c.name).toSorted()).toEqual(['vendor-lib', 'werift'])
    // Recorded twice: once from vendor-lib itself and once through the
    // symlinked entry that resolves to the same manifest — symlink ranges are
    // deliberately included (conservative; can only block, never wrongly link).
    expect(state.requirements.get('werift')).toEqual(['^0.22.9', '^0.22.9'])
    expect(state.requirements.get('zod')).toBeUndefined()
    expect(state.requirements.get('vendor-lib')).toEqual(['^1.0.0'])
    expect(state.existingLinks.map((l) => l.name)).toEqual(['linked-lib'])
  })
})

describe('executeClosureDedupe', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-dedupe-exec-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('replaces the copy with a symlink Node resolution follows', () => {
    const closureNm = path.join(tmpRoot, 'closure', 'node_modules')
    writePackage(closureNm, { name: 'werift', version: '0.22.9' })
    const addonDir = path.join(tmpRoot, 'addon')
    fs.mkdirSync(path.join(addonDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(addonDir, 'dist', 'entry.js'), 'module.exports = {}\n')
    writePackage(path.join(addonDir, 'node_modules'), { name: 'werift', version: '0.22.9' })

    const linked = executeClosureDedupe(
      addonDir,
      closureNm,
      { links: [{ name: 'werift', closureVersion: '0.22.9' }], keeps: [] },
      silentLogger,
    )

    expect(linked).toEqual(['werift'])
    const entry = path.join(addonDir, 'node_modules', 'werift')
    expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true)
    // Node resolution from inside the addon must reach the closure copy.
    const requireFromAddon = createRequire(path.join(addonDir, 'dist', 'entry.js'))
    const resolved = requireFromAddon.resolve('werift/package.json')
    expect(fs.realpathSync(resolved)).toBe(
      fs.realpathSync(path.join(closureNm, 'werift', 'package.json')),
    )
  })

  it('creates node_modules + scope dirs when the addon has none (restored tree)', () => {
    const closureNm = path.join(tmpRoot, 'closure', 'node_modules')
    writePackage(closureNm, { name: '@scope/lib', version: '2.0.0' })
    const addonDir = path.join(tmpRoot, 'addon')
    fs.mkdirSync(addonDir, { recursive: true })

    const linked = executeClosureDedupe(
      addonDir,
      closureNm,
      { links: [{ name: '@scope/lib', closureVersion: '2.0.0' }], keeps: [] },
      silentLogger,
    )
    expect(linked).toEqual(['@scope/lib'])
    expect(
      fs.lstatSync(path.join(addonDir, 'node_modules', '@scope', 'lib')).isSymbolicLink(),
    ).toBe(true)
  })

  it('keeps the copy when the closure changed under the plan', () => {
    const closureNm = path.join(tmpRoot, 'closure', 'node_modules')
    writePackage(closureNm, { name: 'werift', version: '0.23.0' }) // moved!
    const addonDir = path.join(tmpRoot, 'addon')
    writePackage(path.join(addonDir, 'node_modules'), { name: 'werift', version: '0.22.9' })

    const linked = executeClosureDedupe(
      addonDir,
      closureNm,
      { links: [{ name: 'werift', closureVersion: '0.22.9' }], keeps: [] },
      silentLogger,
    )
    expect(linked).toEqual([])
    expect(fs.lstatSync(path.join(addonDir, 'node_modules', 'werift')).isSymbolicLink()).toBe(false)
  })
})

describe('helpers', () => {
  it('readClosureVersions reads only what exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-dedupe-vers-'))
    try {
      writePackage(tmp, { name: 'zod', version: '4.5.4' })
      const versions = readClosureVersions(tmp, ['zod', 'missing'])
      expect(versions.get('zod')).toBe('4.5.4')
      expect(versions.has('missing')).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('isClosureLinkTarget matches only paths inside the closure node_modules', () => {
    expect(isClosureLinkTarget('/closure/node_modules/zod', '/closure/node_modules')).toBe(true)
    expect(isClosureLinkTarget('/elsewhere/zod', '/closure/node_modules')).toBe(false)
    expect(isClosureLinkTarget('', '/closure/node_modules')).toBe(false)
  })

  it('resolveClosureNodeModulesDir prefers the explicit seam and requires existence', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-dedupe-root-'))
    try {
      expect(resolveClosureNodeModulesDir(tmp)).toBe(tmp)
      expect(resolveClosureNodeModulesDir(path.join(tmp, 'missing'))).toBeNull()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
