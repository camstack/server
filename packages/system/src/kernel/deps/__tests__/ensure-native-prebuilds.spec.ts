/**
 * `ensureNativePrebuilds` — the post-install native-prebuild ENSURE step the
 * shared RootUpdateService runs while staging a `@camstack/server` closure,
 * BEFORE `findMissingNativePrebuilds` validates it.
 *
 * On a toolchain-less packaged desktop the closure's `npm install` can leave
 * the traditional native `better-sqlite3` SOURCE-ONLY; this step re-fetches the
 * prebuild for the running ABI so the swap is not needlessly refused. These
 * tests exercise the pure decision (fetch iff missing) + the injectable fetcher
 * seam with a FAKE fetcher — no npm, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ensureNativePrebuilds,
  type PrebuildFetchFn,
  type PrebuildTarget,
} from '../ensure-native-prebuilds.js'
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

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-native-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Create `<closure>/node_modules/<pkg>` with an optional `.node`. */
function scaffoldModule(closure: string, pkg: string, withNode: boolean): string {
  const dir = path.join(closure, 'node_modules', pkg)
  fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg }))
  if (withNode) fs.writeFileSync(path.join(dir, 'build', 'Release', `${pkg}.node`), 'ELF')
  return dir
}

describe('ensureNativePrebuilds', () => {
  it('is a no-op when the native already carries its .node', async () => {
    scaffoldModule(tmp, 'better-sqlite3', true)
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => undefined)
    const fetched = await ensureNativePrebuilds(tmp, {
      logger: makeLogger(),
      target: TARGET,
      fetchPrebuild,
    })
    expect(fetchPrebuild).not.toHaveBeenCalled()
    expect(fetched).toEqual([])
  })

  it('skips a native that is absent from the closure', async () => {
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => undefined)
    const fetched = await ensureNativePrebuilds(tmp, {
      logger: makeLogger(),
      target: TARGET,
      fetchPrebuild,
    })
    expect(fetchPrebuild).not.toHaveBeenCalled()
    expect(fetched).toEqual([])
  })

  it('fetches the prebuild for a source-only native (the desktop staging heal)', async () => {
    const moduleDir = scaffoldModule(tmp, 'better-sqlite3', false)
    // Fake fetcher deposits the .node for the requested target, like a real
    // `prebuild-install --target <node> --arch <arch>` would.
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async (dir, target) => {
      expect(target).toEqual(TARGET)
      fs.writeFileSync(path.join(dir, 'build', 'Release', 'better_sqlite3.node'), 'ELF')
    })
    const fetched = await ensureNativePrebuilds(tmp, {
      logger: makeLogger(),
      target: TARGET,
      fetchPrebuild,
    })
    expect(fetchPrebuild).toHaveBeenCalledWith(moduleDir, TARGET)
    expect(fetched).toEqual(['better-sqlite3'])
  })

  it('does not throw and reports nothing fetched when the fetch fails', async () => {
    scaffoldModule(tmp, 'better-sqlite3', false)
    const logger = makeLogger()
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => {
      throw new Error('network down')
    })
    const fetched = await ensureNativePrebuilds(tmp, { logger, target: TARGET, fetchPrebuild })
    expect(fetched).toEqual([])
    expect(logger.error).toHaveBeenCalled()
  })

  it('reports nothing fetched when the fetch runs but deposits no .node', async () => {
    scaffoldModule(tmp, 'better-sqlite3', false)
    const logger = makeLogger()
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async () => undefined) // no-op fetch
    const fetched = await ensureNativePrebuilds(tmp, { logger, target: TARGET, fetchPrebuild })
    expect(fetched).toEqual([])
    expect(logger.error).toHaveBeenCalled()
  })

  it('honours a custom package set', async () => {
    scaffoldModule(tmp, 'my-native', false)
    const fetchPrebuild = vi.fn<PrebuildFetchFn>(async (dir) => {
      fs.writeFileSync(path.join(dir, 'build', 'Release', 'my.node'), 'ELF')
    })
    const fetched = await ensureNativePrebuilds(tmp, {
      logger: makeLogger(),
      target: TARGET,
      packages: ['my-native'],
      fetchPrebuild,
    })
    expect(fetched).toEqual(['my-native'])
  })
})
