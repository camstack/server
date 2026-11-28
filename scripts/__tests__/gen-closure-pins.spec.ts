import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script without declarations
import { buildPins, generateClosurePins } from '../gen-closure-pins.mjs'

interface LockEntry {
  version?: string
  link?: boolean
  resolved?: string
  dev?: boolean
  optional?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/**
 * Fixture lockfile: the server depends on one addon (a workspace link) and on
 * `a`; the addon depends on `b` (reached ONLY through the addon), `shared` and
 * `dup` (two versions in the closure, one nested). Per-platform optional natives
 * hang off `sharp`. `devonly` is reachable from nothing.
 */
const lock: { lockfileVersion: number; packages: Record<string, LockEntry> } = {
  lockfileVersion: 3,
  packages: {
    'server/backend': {
      dependencies: { '@dominevo/addon-x': '*', a: '^1.0.0', sharp: '^0.35.0' },
    },
    'packages/addon-x': {
      dependencies: { b: '^2.0.0', shared: '^1.0.0', dup: '^1.0.0' },
    },
    'node_modules/@dominevo/addon-x': { resolved: 'packages/addon-x', link: true },
    'node_modules/a': { version: '1.4.0', dependencies: { dup: '^2.0.0' } },
    'node_modules/a/node_modules/dup': { version: '2.0.0' },
    'node_modules/dup': { version: '1.0.0' },
    'node_modules/b': { version: '2.1.0' },
    'node_modules/shared': { version: '1.9.9' },
    'node_modules/sharp': {
      version: '0.35.2',
      optionalDependencies: {
        '@img/sharp-darwin-arm64': '0.35.2',
        '@img/sharp-linux-x64': '0.35.2',
      },
    },
    'node_modules/@img/sharp-darwin-arm64': { version: '0.35.2', optional: true },
    'node_modules/@img/sharp-linux-x64': { version: '0.35.2', optional: true },
    'node_modules/devonly': { version: '9.9.9', dev: true },
  },
}

interface PinsResult {
  readonly pins: Record<string, string>
  readonly stats: { readonly pinned: number; readonly ambiguous: readonly string[] }
}

describe('buildPins', () => {
  const { pins, stats }: PinsResult = buildPins(lock)

  it('pins a package reached only through a workspace addon', () => {
    expect(pins['b']).toBe('2.1.0')
    expect(pins['shared']).toBe('1.9.9')
  })

  it('never lists a @dominevo workspace package', () => {
    expect(Object.keys(pins).filter((n) => n.startsWith('@dominevo/'))).toEqual([])
  })

  it('keeps the per-platform optional natives for every platform', () => {
    expect(pins['@img/sharp-darwin-arm64']).toBe('0.35.2')
    expect(pins['@img/sharp-linux-x64']).toBe('0.35.2')
  })

  it('leaves out what the production closure does not reach', () => {
    expect(pins['devonly']).toBeUndefined()
  })

  it('leaves out a name resolved to two versions: an override is by name', () => {
    expect(pins['dup']).toBeUndefined()
    expect(stats.ambiguous).toEqual(['dup'])
  })
})

interface GenerateResult {
  readonly ok: boolean
  readonly written: boolean
  readonly message: string
}

describe('generateClosurePins without a usable lockfile', () => {
  function checkout(lockfile: string | null): string {
    const repo = mkdtempSync(join(tmpdir(), 'closure-pins-repo-'))
    mkdirSync(join(repo, 'server', 'backend'), { recursive: true })
    if (lockfile !== null) writeFileSync(join(repo, 'package-lock.json'), lockfile)
    return repo
  }

  it('warns and writes nothing when the lockfile is missing, so npm pack goes on', () => {
    const repo = checkout(null)
    try {
      const result: GenerateResult = generateClosurePins(repo)
      expect(result.ok).toBe(true)
      expect(result.written).toBe(false)
      expect(result.message).toContain('ships unpinned')
      expect(existsSync(join(repo, 'server', 'backend', 'closure-pins.json'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('warns and writes nothing when the lockfile has no server entry', () => {
    const repo = checkout(JSON.stringify({ lockfileVersion: 3, packages: {} }))
    try {
      const result: GenerateResult = generateClosurePins(repo)
      expect(result.ok).toBe(true)
      expect(result.written).toBe(false)
      expect(result.message).toContain('ships unpinned')
      expect(existsSync(join(repo, 'server', 'backend', 'closure-pins.json'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('still fails --check, which is the guard', () => {
    const repo = checkout(null)
    try {
      const result: GenerateResult = generateClosurePins(repo, { check: true })
      expect(result.ok).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
