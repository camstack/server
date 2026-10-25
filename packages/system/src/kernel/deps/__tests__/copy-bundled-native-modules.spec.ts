/**
 * `copyBundledNativeModules` — propagate PREBUILT natives from a packaged
 * desktop's bundled addon copy (`<resources>/addons/<addon>/node_modules`) into
 * the freshly-copied `data/addons/@camstack/<addon>` BEFORE its runtime `npm
 * install`, so that install never re-runs the fragile `prebuild-install` and
 * leaves a source-only `better-sqlite3` shadowing the good hoisted `.node`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { copyBundledNativeModules } from '../manifest-native-deps.js'
import type { IScopedLogger } from '@camstack/types'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

let tmp: string
let source: string
let target: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-bundled-'))
  source = path.join(tmp, 'source')
  target = path.join(tmp, 'target')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(target, { recursive: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function plant(root: string, rel: string, content = 'ELF'): void {
  const full = path.join(root, 'node_modules', rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

describe('copyBundledNativeModules', () => {
  it('is a no-op when the source has no node_modules', () => {
    expect(() => copyBundledNativeModules(source, target, makeLogger())).not.toThrow()
    expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false)
  })

  it('propagates a prebuilt better-sqlite3 (traditional native) to the target', () => {
    plant(source, 'better-sqlite3/build/Release/better_sqlite3.node')
    plant(source, 'better-sqlite3/package.json', '{"name":"better-sqlite3"}')
    copyBundledNativeModules(source, target, makeLogger())
    expect(
      fs.existsSync(
        path.join(
          target,
          'node_modules',
          'better-sqlite3',
          'build',
          'Release',
          'better_sqlite3.node',
        ),
      ),
    ).toBe(true)
  })

  it('propagates an N-API platform sibling scope (sharp → @img)', () => {
    plant(source, 'sharp/package.json', '{"name":"sharp"}') // JS-only main pkg, no .node
    plant(source, '@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node')
    copyBundledNativeModules(source, target, makeLogger())
    expect(
      fs.existsSync(
        path.join(
          target,
          'node_modules',
          '@img',
          'sharp-darwin-arm64',
          'lib',
          'sharp-darwin-arm64.node',
        ),
      ),
    ).toBe(true)
  })

  it('does not overwrite a target module that already carries a .node', () => {
    plant(source, 'better-sqlite3/build/Release/better_sqlite3.node', 'SOURCE')
    plant(target, 'better-sqlite3/build/Release/better_sqlite3.node', 'EXISTING')
    copyBundledNativeModules(source, target, makeLogger())
    expect(
      fs.readFileSync(
        path.join(
          target,
          'node_modules',
          'better-sqlite3',
          'build',
          'Release',
          'better_sqlite3.node',
        ),
        'utf-8',
      ),
    ).toBe('EXISTING')
  })

  it('ignores a source native that has no .node (source-only)', () => {
    plant(source, 'better-sqlite3/package.json', '{"name":"better-sqlite3"}') // no binary
    copyBundledNativeModules(source, target, makeLogger())
    expect(fs.existsSync(path.join(target, 'node_modules', 'better-sqlite3'))).toBe(false)
  })
})
