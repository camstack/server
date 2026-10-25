/**
 * AddonLoader — ESM module cache-busting across a redeploy.
 *
 * `importAddonModuleFresh` keyed its cache-bust query on the entry file's
 * `mtimeMs`. `npm pack` NORMALISES every file's mtime in the tarball to
 * 499162500000 (1985-10-26), and every install path here extracts that tarball
 * — so the entry file of v1.0.0 and of v1.0.99 carry the SAME mtime, the module
 * URL is byte-identical across versions, and Node hands back the previously
 * cached module forever:
 *
 *   - hub-main's static catalog (`customActions` zod schemas, addon class)
 *     stays on the OLD version after every redeploy;
 *   - a load that THREW is cached as a rejected module and replayed verbatim on
 *     every retry — 126 identical failed load retries over 10.5h for
 *     `@camstack/addon-export-hap` on 2026-08-12, none of which could ever have
 *     succeeded because the new bytes were never read.
 *
 * These tests pin the mtime to npm's normalised value so they fail against any
 * mtime-only cache key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AddonLoader, addonModuleCacheKey } from '../addon-loader.js'

/** The mtime `npm pack` stamps on every file in a tarball (1985-10-26). */
const NPM_PACK_MTIME_SEC = 499_162_500

interface AddonFixture {
  readonly version: string
  readonly entrySource: string
}

const ADDON_ID = 'export-hap'
const PACKAGE_NAME = '@camstack/addon-export-hap'

let tmpRoot: string

/**
 * Write (or overwrite) an addon package at `dir`, then pin every file's mtime
 * to npm's normalised value — exactly what a redeploy leaves on disk.
 */
function writeAddonPackage(dir: string, fixture: AddonFixture): string {
  const distDir = path.join(dir, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  const pkgJsonPath = path.join(dir, 'package.json')
  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify({
      name: PACKAGE_NAME,
      version: fixture.version,
      camstack: { addons: [{ id: ADDON_ID, entry: './dist/index.mjs' }] },
    }),
  )
  const entryPath = path.join(distDir, 'index.mjs')
  fs.writeFileSync(entryPath, fixture.entrySource)
  fs.utimesSync(entryPath, NPM_PACK_MTIME_SEC, NPM_PACK_MTIME_SEC)
  fs.utimesSync(pkgJsonPath, NPM_PACK_MTIME_SEC, NPM_PACK_MTIME_SEC)
  return entryPath
}

function addonSource(marker: string): string {
  return `export const marker = '${marker}'\nexport class Addon { async initialize() {} async shutdown() {} }\n`
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-cache-bust-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('addonModuleCacheKey', () => {
  it('changes when the installed package version changes at an identical path and mtime', () => {
    const dir = path.join(tmpRoot, 'pkg')
    const entry = writeAddonPackage(dir, { version: '1.0.0', entrySource: addonSource('A') })
    const before = addonModuleCacheKey(entry)

    // Same path, same bytes, same (npm-pack-normalised) mtime — only the
    // installed version moved. This is every OTA update.
    writeAddonPackage(dir, { version: '1.0.1', entrySource: addonSource('A') })
    const after = addonModuleCacheKey(entry)

    expect(before).not.toBeNull()
    expect(after).not.toBe(before)
  })

  it('changes when the entry bytes change at an identical version and mtime', () => {
    // `camstack deploy` of an unbumped workspace package: version identical,
    // mtime normalised by npm pack, only the code differs.
    const dir = path.join(tmpRoot, 'pkg')
    const entry = writeAddonPackage(dir, { version: '1.0.0', entrySource: addonSource('A') })
    const before = addonModuleCacheKey(entry)

    writeAddonPackage(dir, { version: '1.0.0', entrySource: addonSource('B') })
    const after = addonModuleCacheKey(entry)

    expect(after).not.toBe(before)
  })

  it('is stable when nothing changed (a random key would pass every other test)', () => {
    const dir = path.join(tmpRoot, 'pkg')
    const entry = writeAddonPackage(dir, { version: '1.0.0', entrySource: addonSource('A') })

    expect(addonModuleCacheKey(entry)).toBe(addonModuleCacheKey(entry))
  })

  it('falls back to mtime instead of throwing when the version cannot be read', () => {
    // No package.json anywhere above the entry.
    const distDir = path.join(tmpRoot, 'loose', 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    const entry = path.join(distDir, 'index.mjs')
    fs.writeFileSync(entry, addonSource('A'))
    fs.utimesSync(entry, NPM_PACK_MTIME_SEC, NPM_PACK_MTIME_SEC)

    const key = addonModuleCacheKey(entry)
    expect(key).toContain(String(NPM_PACK_MTIME_SEC * 1000))
  })

  it('returns null for an entry that cannot be stat-ed (caller does a plain import)', () => {
    expect(addonModuleCacheKey(path.join(tmpRoot, 'nope', 'index.mjs'))).toBeNull()
  })
})

describe('AddonLoader — module freshness across a redeploy', () => {
  it('loads the NEW module after a version bump that left the mtime untouched', async () => {
    const dir = path.join(tmpRoot, 'addon')
    writeAddonPackage(dir, { version: '1.0.0', entrySource: addonSource('OLD') })

    const first = new AddonLoader()
    await first.loadFromAddonDir(dir)
    expect(first.getAddon(ADDON_ID)?.module['marker']).toBe('OLD')

    // Redeploy in place: new version, new bytes, npm-pack mtime unchanged.
    writeAddonPackage(dir, { version: '1.0.1', entrySource: addonSource('NEW') })

    const second = new AddonLoader()
    await second.loadFromAddonDir(dir)
    expect(second.getAddon(ADDON_ID)?.module['marker']).toBe('NEW')
  })

  it('does NOT replay a cached module REJECTION after the version changes', async () => {
    // The export-hap outage: the first import threw, Node cached the rejected
    // module against a URL that never changed, and all 126 retries replayed the
    // same rejection — including the ones made AFTER a fixed version landed.
    const dir = path.join(tmpRoot, 'addon')
    writeAddonPackage(dir, {
      version: '1.0.0',
      entrySource: `throw new Error('boom: broken build')\n`,
    })

    const first = new AddonLoader()
    await first.loadFromAddonDir(dir)
    expect(first.hasAddon(ADDON_ID)).toBe(false)
    expect(first.listLoadFailures()).toHaveLength(1)

    // Operator ships the fix.
    writeAddonPackage(dir, { version: '1.0.1', entrySource: addonSource('FIXED') })

    const second = new AddonLoader()
    await second.loadFromAddonDir(dir)
    expect(second.listLoadFailures()).toHaveLength(0)
    expect(second.hasAddon(ADDON_ID)).toBe(true)
    expect(second.getAddon(ADDON_ID)?.module['marker']).toBe('FIXED')
  })
})
