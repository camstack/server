/**
 * `camstack deploy-server` — closure-set discovery + dev-version pack rewrite.
 *
 * Covers:
 *   - graph-driven discovery of the `@camstack/server` workspace closure from
 *     a fixture workspace (NOT a hardcoded list): install closure (pack set)
 *     vs build set (adds build-only workspace dev-deps), dependency order,
 *   - dev-version rewrite is temp-only — workspace package.json files are
 *     byte-identical after packing, even when packing throws,
 *   - the uniform dev version string shape.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeDevVersion,
  discoverServerClosure,
  withDevVersionPackageJson,
} from '../commands/server-closure.js'

let tmp: string

interface FixturePkg {
  readonly relDir: string
  readonly name: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

function writeFixtureWorkspace(pkgs: readonly FixturePkg[]): void {
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['packages/*', 'server/*'] }),
    'utf-8',
  )
  for (const pkg of pkgs) {
    const dir = path.join(tmp, pkg.relDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version ?? '1.0.0',
          ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
          ...(pkg.optionalDependencies ? { optionalDependencies: pkg.optionalDependencies } : {}),
          ...(pkg.peerDependencies ? { peerDependencies: pkg.peerDependencies } : {}),
          ...(pkg.devDependencies ? { devDependencies: pkg.devDependencies } : {}),
        },
        null,
        2,
      ),
      'utf-8',
    )
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-server-closure-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const FIXTURE: readonly FixturePkg[] = [
  {
    relDir: 'server/backend',
    name: '@camstack/server',
    version: '1.2.3',
    dependencies: {
      '@camstack/system': '*',
      '@camstack/shm-ring': '*',
      fastify: '^5.0.0',
    },
    devDependencies: { '@camstack/node-root': '*' },
  },
  {
    relDir: 'packages/system',
    name: '@camstack/system',
    dependencies: { '@camstack/sdk': '*' },
    peerDependencies: { '@camstack/types': '*' },
  },
  { relDir: 'packages/sdk', name: '@camstack/sdk', peerDependencies: { '@camstack/types': '*' } },
  {
    relDir: 'packages/shm-ring',
    name: '@camstack/shm-ring',
    dependencies: { '@camstack/types': '*' },
  },
  { relDir: 'packages/types', name: '@camstack/types' },
  { relDir: 'packages/node-root', name: '@camstack/node-root' },
  // In the workspace but NOT reachable from @camstack/server — must not appear.
  { relDir: 'packages/addon-unrelated', name: '@camstack/addon-unrelated' },
]

describe('discoverServerClosure', () => {
  it('walks the dependency graph from server/backend — no hardcoded list', () => {
    writeFixtureWorkspace(FIXTURE)
    const closure = discoverServerClosure(tmp)

    expect(closure.serverVersion).toBe('1.2.3')
    const packNames = closure.packSet.map((p) => p.name)
    expect([...packNames].sort()).toEqual([
      '@camstack/sdk',
      '@camstack/server',
      '@camstack/shm-ring',
      '@camstack/system',
      '@camstack/types',
    ])
    // Unreachable workspace packages and non-workspace deps never appear.
    expect(packNames).not.toContain('@camstack/addon-unrelated')
    expect(packNames).not.toContain('fastify')
    // Build-only (dev) workspace deps are NOT part of the install closure…
    expect(packNames).not.toContain('@camstack/node-root')
    // …but ARE in the build set (the server bundles them at build time).
    expect(closure.buildSet.map((p) => p.name)).toContain('@camstack/node-root')
  })

  it('orders both sets dependencies-first', () => {
    writeFixtureWorkspace(FIXTURE)
    const closure = discoverServerClosure(tmp)
    const indexOf = (set: readonly { name: string }[], name: string): number =>
      set.findIndex((p) => p.name === name)

    for (const set of [closure.packSet, closure.buildSet]) {
      expect(indexOf(set, '@camstack/types')).toBeLessThan(indexOf(set, '@camstack/sdk'))
      expect(indexOf(set, '@camstack/sdk')).toBeLessThan(indexOf(set, '@camstack/system'))
      expect(indexOf(set, '@camstack/types')).toBeLessThan(indexOf(set, '@camstack/shm-ring'))
      // The root package always comes last.
      expect(indexOf(set, '@camstack/server')).toBe(set.length - 1)
    }
  })

  it('throws a clear error when server/backend is missing', () => {
    writeFixtureWorkspace(FIXTURE.filter((p) => p.name !== '@camstack/server'))
    expect(() => discoverServerClosure(tmp)).toThrow(/server\/backend/)
  })
})

describe('computeDevVersion', () => {
  it('produces <base>-dev.<epochSeconds>', () => {
    expect(computeDevVersion('1.1.55', 1_783_970_000)).toBe('1.1.55-dev.1783970000')
  })
})

describe('withDevVersionPackageJson — temp-copy rewrite', () => {
  const INTRA = new Set(['@camstack/types', '@camstack/system'])

  it('rewrites version + intra-set dep ranges during fn, restores bytes after', () => {
    writeFixtureWorkspace(FIXTURE)
    const pkgDir = path.join(tmp, 'server/backend')
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    const originalBytes = fs.readFileSync(pkgJsonPath)

    let seen: {
      version?: unknown
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    } | null = null
    const result = withDevVersionPackageJson(pkgDir, '1.2.3-dev.42', INTRA, () => {
      seen = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'))
      return 'fn-result'
    })

    expect(result).toBe('fn-result')
    expect(seen).not.toBeNull()
    const rewritten = seen!
    expect(rewritten.version).toBe('1.2.3-dev.42')
    // Intra-set dep ranges pinned to the dev version…
    expect(rewritten.dependencies?.['@camstack/system']).toBe('1.2.3-dev.42')
    // …non-set deps untouched (workspace member not in the set + external).
    expect(rewritten.dependencies?.['@camstack/shm-ring']).toBe('*')
    expect(rewritten.dependencies?.['fastify']).toBe('^5.0.0')

    // The workspace file is byte-identical after the pack.
    expect(fs.readFileSync(pkgJsonPath).equals(originalBytes)).toBe(true)
  })

  it('restores the original bytes even when fn throws', () => {
    writeFixtureWorkspace(FIXTURE)
    const pkgDir = path.join(tmp, 'packages/system')
    const pkgJsonPath = path.join(pkgDir, 'package.json')
    const originalBytes = fs.readFileSync(pkgJsonPath)

    expect(() =>
      withDevVersionPackageJson(pkgDir, '9.9.9-dev.1', INTRA, () => {
        throw new Error('pack exploded')
      }),
    ).toThrow('pack exploded')
    expect(fs.readFileSync(pkgJsonPath).equals(originalBytes)).toBe(true)
  })
})
