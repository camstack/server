/**
 * `ensureAddonNativePrebuilds` — the POST-install native-prebuild ENSURE pass an
 * addon install (`installCopy` / `installFromTgz`) runs on the INSTALLED addon
 * dir AFTER `npm install`.
 *
 * Why it exists (Mac desktop first-boot FATAL, 2026-07-21 — the copy-BEFORE-
 * install fix was empirically INSUFFICIENT): the addon's `npm install`
 * RE-CREATES a traditional native (`better-sqlite3`) SOURCE-ONLY on a
 * toolchain-less host, clobbering the good `.node` the pre-install
 * `copyBundledNativeModules` planted → the runner dies at init with a cryptic
 * bindings error. This pass runs LAST and, per referenced native still lacking
 * its compiled `.node`:
 *   1. bundled-copy-hit  → re-plant the `.node` from the bundled addon copy
 *      (offline, cheapest) → `copied`
 *   2. bundled-miss + fetch-success → fetch the prebuild for the running ABI →
 *      `fetched`
 *   3. both-miss → LOUD error naming module + addon, and THROW so the install
 *      fails at install time rather than at addon init.
 *
 * These tests exercise that pure decision with real tmp dirs + a FAKE fetcher
 * (no npm, no network) — the same style as `ensure-native-prebuilds.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ensureAddonNativePrebuilds } from '../ensure-addon-natives.js'
import type { PrebuildFetchFn, PrebuildTarget } from '../ensure-native-prebuilds.js'
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

const TARGET: PrebuildTarget = { nodeVersion: '24.16.0', arch: 'arm64' }

let tmp: string
let addonDir: string
let bundledDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-addon-native-'))
  addonDir = path.join(tmp, 'installed')
  bundledDir = path.join(tmp, 'bundled')
  fs.mkdirSync(addonDir, { recursive: true })
  fs.mkdirSync(bundledDir, { recursive: true })
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Create `<root>/node_modules/<pkg>` with a package.json and optional `.node`. */
function scaffoldModule(root: string, pkg: string, withNode: boolean): string {
  const dir = path.join(root, 'node_modules', pkg)
  fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg }))
  if (withNode) {
    fs.writeFileSync(path.join(dir, 'build', 'Release', `${pkg.replace(/-/g, '_')}.node`), 'ELF')
  }
  return dir
}

describe('ensureAddonNativePrebuilds', () => {
  it('is a no-op when the installed native already carries its .node', async () => {
    scaffoldModule(addonDir, 'better-sqlite3', true)
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => undefined)
    const results = await ensureAddonNativePrebuilds(addonDir, {
      addonName: '@camstack/system',
      logger: makeLogger(),
      target: TARGET,
      fetchPrebuild,
    })
    expect(fetchPrebuild).not.toHaveBeenCalled()
    expect(results).toEqual([{ pkg: 'better-sqlite3', outcome: 'already-present' }])
  })

  it('skips a native that is absent from the installed addon (relies on hoist)', async () => {
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => undefined)
    const results = await ensureAddonNativePrebuilds(addonDir, {
      addonName: '@camstack/system',
      logger: makeLogger(),
      target: TARGET,
      fetchPrebuild,
    })
    expect(fetchPrebuild).not.toHaveBeenCalled()
    expect(results).toEqual([])
  })

  it('bundled-copy-hit: re-plants a source-only native from the bundled copy (no fetch)', async () => {
    // npm install left better-sqlite3 SOURCE-ONLY in the installed addon dir.
    scaffoldModule(addonDir, 'better-sqlite3', false)
    // The bundled addon copy carries the good prebuilt .node for this machine.
    scaffoldModule(bundledDir, 'better-sqlite3', true)
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => undefined)

    const results = await ensureAddonNativePrebuilds(addonDir, {
      addonName: '@camstack/system',
      logger: makeLogger(),
      bundledSourceDir: bundledDir,
      target: TARGET,
      fetchPrebuild,
    })

    expect(fetchPrebuild).not.toHaveBeenCalled() // offline-first — no network
    expect(results).toEqual([{ pkg: 'better-sqlite3', outcome: 'copied' }])
    expect(
      fs.existsSync(
        path.join(
          addonDir,
          'node_modules',
          'better-sqlite3',
          'build',
          'Release',
          'better_sqlite3.node',
        ),
      ),
    ).toBe(true)
  })

  it('bundled-miss + fetch-success: fetches the prebuild for the running ABI', async () => {
    scaffoldModule(addonDir, 'better-sqlite3', false)
    // Bundled copy is ALSO source-only (or the addon is npm-installed, no bundle).
    scaffoldModule(bundledDir, 'better-sqlite3', false)
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async (dir, target) => {
      expect(target).toEqual(TARGET)
      fs.writeFileSync(path.join(dir, 'build', 'Release', 'better_sqlite3.node'), 'ELF')
    })

    const results = await ensureAddonNativePrebuilds(addonDir, {
      addonName: '@camstack/system',
      logger: makeLogger(),
      bundledSourceDir: bundledDir,
      target: TARGET,
      fetchPrebuild,
    })

    expect(fetchPrebuild).toHaveBeenCalledTimes(1)
    expect(results).toEqual([{ pkg: 'better-sqlite3', outcome: 'fetched' }])
  })

  it('fetches when no bundled source dir is provided (npm/tgz install path)', async () => {
    scaffoldModule(addonDir, 'better-sqlite3', false)
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async (dir) => {
      fs.writeFileSync(path.join(dir, 'build', 'Release', 'better_sqlite3.node'), 'ELF')
    })

    const results = await ensureAddonNativePrebuilds(addonDir, {
      addonName: '@camstack/system',
      logger: makeLogger(),
      target: TARGET,
      fetchPrebuild,
    })

    expect(fetchPrebuild).toHaveBeenCalledTimes(1)
    expect(results).toEqual([{ pkg: 'better-sqlite3', outcome: 'fetched' }])
  })

  it('both-miss: logs a LOUD error naming module + addon and THROWS', async () => {
    scaffoldModule(addonDir, 'better-sqlite3', false)
    scaffoldModule(bundledDir, 'better-sqlite3', false) // bundled has no .node either
    const logger = makeLogger()
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => undefined) // fetch deposits nothing

    await expect(
      ensureAddonNativePrebuilds(addonDir, {
        addonName: '@camstack/system',
        logger,
        bundledSourceDir: bundledDir,
        target: TARGET,
        fetchPrebuild,
      }),
    ).rejects.toThrow(/@camstack\/system.*better-sqlite3/)

    expect(logger.error).toHaveBeenCalled()
    const errCall = (logger.error as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('MISSING'),
    )
    expect(errCall).toBeDefined()
    expect(errCall?.[1]).toMatchObject({
      meta: expect.objectContaining({ addon: '@camstack/system', pkg: 'better-sqlite3' }),
    })
  })

  it('both-miss with fetch throwing: still THROWS loud (never a silent swallow)', async () => {
    scaffoldModule(addonDir, 'better-sqlite3', false)
    const logger = makeLogger()
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => {
      throw new Error('network down')
    })

    await expect(
      ensureAddonNativePrebuilds(addonDir, {
        addonName: '@camstack/system',
        logger,
        target: TARGET,
        fetchPrebuild,
      }),
    ).rejects.toThrow(/better-sqlite3/)
    expect(logger.error).toHaveBeenCalled()
  })

  it('honours a custom package set and reports each outcome', async () => {
    scaffoldModule(addonDir, 'my-native', false)
    scaffoldModule(bundledDir, 'my-native', true)
    const results = await ensureAddonNativePrebuilds(addonDir, {
      addonName: '@camstack/addon-x',
      logger: makeLogger(),
      bundledSourceDir: bundledDir,
      target: TARGET,
      packages: ['my-native'],
      fetchPrebuild: vi.fn<PrebuildFetchFn>(async () => undefined),
    })
    expect(results).toEqual([{ pkg: 'my-native', outcome: 'copied' }])
  })
})
