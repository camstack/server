/**
 * `native-staging.mjs` — the pure DMG-build helpers that plant hoisted native
 * prebuilds into each bundled addon copy and VERIFY every referenced native
 * carries its `.node`. Regression guard for the fresh CamStack.app first-boot
 * FATAL (better-sqlite3 hoisted away from the `@camstack/system` copy).
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addonMissingNatives,
  bundledAddonSourceDirs,
  hasDotNode,
  referencedNativePackages,
  stageNativeIntoAddon,
} from '../../scripts/native-staging.mjs'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-staging-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function plant(root: string, rel: string): void {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, 'ELF')
}

describe('referencedNativePackages', () => {
  it('detects natives from dependencies + optionalDependencies', () => {
    expect(referencedNativePackages({ dependencies: { 'better-sqlite3': '^12.0.0' } })).toEqual([
      'better-sqlite3',
    ])
    expect(
      referencedNativePackages({
        dependencies: { sharp: '^0.34.0' },
        optionalDependencies: { 'node-av': '^1.0.0' },
      }).sort(),
    ).toEqual(['node-av', 'sharp'])
  })

  it('returns [] for an addon that references no native', () => {
    expect(referencedNativePackages({ dependencies: { zod: '^4.0.0' } })).toEqual([])
    expect(referencedNativePackages({})).toEqual([])
  })
})

describe('stageNativeIntoAddon + addonMissingNatives', () => {
  it('self-contains a traditional native (better-sqlite3) from the hoisted copy', () => {
    const stageModules = path.join(tmp, 'stage', 'node_modules')
    plant(stageModules, 'better-sqlite3/build/Release/better_sqlite3.node')
    fs.writeFileSync(
      path.join(stageModules, 'better-sqlite3', 'package.json'),
      '{"name":"better-sqlite3"}',
    )
    const addonDir = path.join(tmp, 'addons', 'system')
    fs.mkdirSync(addonDir, { recursive: true })

    // Before staging the addon copy is MISSING the native (the reported bug).
    expect(addonMissingNatives(addonDir, ['better-sqlite3'])).toEqual(['better-sqlite3'])

    const copied = stageNativeIntoAddon(stageModules, addonDir, 'better-sqlite3')
    expect(copied.length).toBeGreaterThan(0)
    expect(addonMissingNatives(addonDir, ['better-sqlite3'])).toEqual([])
    expect(hasDotNode(path.join(addonDir, 'node_modules', 'better-sqlite3'))).toBe(true)
  })

  it('self-contains an N-API native via its platform sibling scope (sharp → @img)', () => {
    const stageModules = path.join(tmp, 'stage', 'node_modules')
    plant(stageModules, 'sharp/package.json') // main pkg (no .node)
    plant(stageModules, '@img/sharp-darwin-arm64/lib/sharp.node')
    plant(stageModules, '@img/sharp-libvips-darwin-arm64/lib/libvips.42.dylib')
    const addonDir = path.join(tmp, 'addons', 'pipeline')
    fs.mkdirSync(addonDir, { recursive: true })

    stageNativeIntoAddon(stageModules, addonDir, 'sharp')
    // `.node` lives in the @img sibling — the verifier must look there too.
    expect(addonMissingNatives(addonDir, ['sharp'])).toEqual([])
    expect(
      fs.existsSync(
        path.join(addonDir, 'node_modules', '@img', 'sharp-darwin-arm64', 'lib', 'sharp.node'),
      ),
    ).toBe(true)
  })

  it('flags an addon copy still missing a native after a failed stage', () => {
    const emptyStage = path.join(tmp, 'empty', 'node_modules')
    fs.mkdirSync(emptyStage, { recursive: true })
    const addonDir = path.join(tmp, 'addons', 'system')
    fs.mkdirSync(addonDir, { recursive: true })
    stageNativeIntoAddon(emptyStage, addonDir, 'better-sqlite3') // nothing to copy
    expect(addonMissingNatives(addonDir, ['better-sqlite3'])).toEqual(['better-sqlite3'])
  })
})

describe('bundledAddonSourceDirs', () => {
  /** A `@camstack/<short>` package dir inside a staged closure. */
  function pkg(scope: string, short: string, name: string): string {
    const dir = path.join(scope, short)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    return dir
  }

  it('is every @camstack package in the staged closure — the seed source, not a second tree', () => {
    // The list used to be derived from the `extraResources` entries whose `to`
    // started with `addons/`. Those entries are GONE (2026-08-25): the packaged
    // app seeds from `Resources/node_modules/@camstack`, so the dirs that must
    // carry their natives are the closure's own package dirs.
    const scope = path.join(tmp, 'node_modules', '@camstack')
    pkg(scope, 'addon-pipeline', '@camstack/addon-pipeline')
    pkg(scope, 'system', '@camstack/system')
    pkg(scope, 'addon-decoder-nodeav', '@camstack/addon-decoder-nodeav')
    expect(
      bundledAddonSourceDirs(path.join(tmp, 'node_modules')).map((d) => path.basename(d)),
    ).toEqual(['addon-decoder-nodeav', 'addon-pipeline', 'system'])
  })

  it('skips a dir with no package.json — a stray, not a package', () => {
    const scope = path.join(tmp, 'node_modules', '@camstack')
    pkg(scope, 'system', '@camstack/system')
    fs.mkdirSync(path.join(scope, '.bin'), { recursive: true })
    expect(
      bundledAddonSourceDirs(path.join(tmp, 'node_modules')).map((d) => path.basename(d)),
    ).toEqual(['system'])
  })

  it('is [] when the closure has no @camstack scope dir', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true })
    expect(bundledAddonSourceDirs(path.join(tmp, 'node_modules'))).toEqual([])
  })
})
