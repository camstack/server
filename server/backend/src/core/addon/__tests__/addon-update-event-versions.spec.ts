/**
 * The `addon.updated` event states the versions that ACTUALLY happened.
 *
 * The live row, 2026-08-30, minted by this code path:
 *
 *   "@camstack/addon-terminal 0.0.0 → latest (hub)"
 *
 * The real transition was `0.1.47 → 0.1.51`, and the hub knew both numbers.
 * Two independent faults produced that sentence:
 *
 *  - `toVersion` was the literal REQUEST. `addons.updatePackage` with no
 *    version resolves to the dist-tag `'latest'`, and the lifecycle engine
 *    dropped the `resolvedVersion` the staging area had already read out of
 *    the unpacked tarball. That half is fixed and pinned ONE layer up, in
 *    `lifecycle-job-engine.spec.ts` — the engine is the single place a tag is
 *    resolved, so this method is handed a version like every other caller and
 *    the cases below pass what the fixed engine now sends.
 *  - `fromVersion` was `'0.0.0'`, the fallback of a version lookup that
 *    searched `<addonsDir>/addon-terminal/package.json` — the flat layout.
 *    Nothing has been installed flat since the scope directories landed: the
 *    package lives at `<addonsDir>/@camstack/addon-terminal/`, which is where
 *    the installer swaps it and where `packInstalledPackage` reads it. The
 *    `require.resolve` fallback then failed too (an addon is not in the hub's
 *    own node_modules) and `'0.0.0'` was emitted as if it were a version.
 *
 * A notification that states a false version is confidently wrong: the
 * operator cannot tell it from a real one. So the assertions here are on the
 * EMITTED EVENT, and an unknowable predecessor is an ABSENT field — never a
 * `0.0.0` the renderer would print.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AddonPackageService } from '../addon-package.service.js'
import { addonUpdatePayload } from '../addon-registry.service.js'

/**
 * A name with NO workspace copy, deliberately.
 *
 * The broken lookup's second chance was `require.resolve('<pkg>/package.json')`,
 * and in this repo that RESOLVES for a real addon — the worktree walks up into
 * `camstack-server/node_modules/@camstack/*`. A test named after the live
 * package therefore read `0.1.51` out of the developer's checkout and never
 * reproduced the hub, which has no addon in its own node_modules and so falls
 * all the way through to `'0.0.0'`. This name resolves nowhere, on any machine.
 */
const PACKAGE = '@camstack/addon-tapemachine'

interface UpdateEventCall {
  readonly packageName: string
  readonly fromVersion: string | null
  readonly toVersion: string
}

interface Harness {
  readonly service: AddonPackageService
  readonly updateEvents: UpdateEventCall[]
  readonly addonsDir: string
  readonly stagedPath: string
}

/**
 * Seed `addons/manifest.json` — the installer's precondition for an update
 * (`applyUpdateFromStaged` refuses a package it does not track), and exactly
 * what the live hub has after the previous install.
 */
function seedManifest(addonsDir: string, version: string): void {
  const now = new Date().toISOString()
  fs.writeFileSync(
    path.join(addonsDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      updatedAt: now,
      addons: {
        [PACKAGE]: { name: PACKAGE, version, source: 'npm', installedAt: now, updatedAt: now },
      },
    }),
  )
}

let root: string
let previousAddonsDir: string | undefined

function fakeLogger(): IScopedLogger {
  const noop = (): void => {}
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as IScopedLogger
}

/** Write a minimal, dependency-free addon tree at `dir`. */
function writePackage(dir: string, version: string): void {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      version,
      main: 'dist/index.js',
      camstack: { addons: [{ id: 'terminal', name: 'Terminal' }] },
    }),
  )
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'module.exports = {}\n')
}

/**
 * The service with the collaborators this path actually touches. Same stubbing
 * convention as `addon-auto-update.spec.ts` — the constructor holds the rest as
 * references it never calls here.
 */
function makeHarness(installedVersion: string | null): Harness {
  const addonsDir = path.join(root, 'addons')
  fs.mkdirSync(addonsDir, { recursive: true })
  if (installedVersion !== null) {
    writePackage(path.join(addonsDir, '@camstack', 'addon-tapemachine'), installedVersion)
  }
  // What the lifecycle engine staged: the unpacked tarball of the new version.
  const stagedPath = path.join(root, 'staged')
  writePackage(stagedPath, '0.1.51')

  const updateEvents: UpdateEventCall[] = []
  const loggingService = { createLogger: () => fakeLogger() }
  const eventBus = { emit: () => undefined }
  const config = { get: () => root }
  const addonRegistry = {
    refreshPackageVersion: () => undefined,
    emitUpdateEvent: (packageName: string, fromVersion: string | null, toVersion: string) => {
      updateEvents.push({ packageName, fromVersion, toVersion })
    },
    restartPackage: async () => ({ success: true, restarted: ['terminal'], errors: [] }),
  }
  const notificationService = { notify: async () => undefined }
  const toastService = { broadcast: () => undefined }

  const service = new AddonPackageService(
    loggingService as never,
    eventBus as never,
    config as never,
    addonRegistry as never,
    notificationService as never,
    toastService as never,
  )
  return { service, updateEvents, addonsDir, stagedPath }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-update-versions-'))
  previousAddonsDir = process.env['CAMSTACK_ADDONS_DIR']
  process.env['CAMSTACK_ADDONS_DIR'] = path.join(root, 'addons')
})

afterEach(() => {
  if (previousAddonsDir === undefined) delete process.env['CAMSTACK_ADDONS_DIR']
  else process.env['CAMSTACK_ADDONS_DIR'] = previousAddonsDir
  fs.rmSync(root, { recursive: true, force: true })
})

describe('applyStagedAddonUpdate emits the versions that happened', () => {
  it('names the version that WAS installed, read from the scoped install dir', async () => {
    const h = makeHarness('0.1.47')
    seedManifest(h.addonsDir, '0.1.47')

    const result = await h.service.applyStagedAddonUpdate(PACKAGE, '0.1.51', h.stagedPath)

    expect(result.success).toBe(true)
    expect(h.updateEvents).toHaveLength(1)
    expect(h.updateEvents[0]).toEqual({
      packageName: PACKAGE,
      fromVersion: '0.1.47',
      toVersion: '0.1.51',
    })
  })

  it('an UNREADABLE predecessor is absent, never a 0.0.0 that reads as a version', async () => {
    // The install dir is there (the installer requires it) but carries no
    // readable package.json, so the previous version is genuinely unknown.
    // `0.0.0` here would be a number the operator could take for real; the
    // honest answer is "unknown", and the renderer omits it.
    const h = makeHarness(null)
    fs.mkdirSync(path.join(h.addonsDir, '@camstack', 'addon-tapemachine'), { recursive: true })
    seedManifest(h.addonsDir, '0.1.47')

    await h.service.applyStagedAddonUpdate(PACKAGE, '0.1.51', h.stagedPath)

    expect(h.updateEvents[0]?.fromVersion).toBeNull()
    expect(h.updateEvents[0]?.toVersion).toBe('0.1.51')
  })
})

describe('the addon.updated payload never states a version it does not have', () => {
  /*
   * The event DATA, not the argument. The suite above stubs
   * `addonRegistry.emitUpdateEvent`, so it pins that the service HANDS OVER
   * `null` — and would pass just as well if the registry then wrote
   * `fromVersion: null` onto the wire. This is the other half.
   */
  it('omits the key entirely when the predecessor is unknown', () => {
    const payload = addonUpdatePayload(null, '0.1.51')
    expect(payload).toEqual({ toVersion: '0.1.51' })
    expect('fromVersion' in payload).toBe(false)
  })

  it('carries both when both are known', () => {
    expect(addonUpdatePayload('0.1.47', '0.1.51')).toEqual({
      fromVersion: '0.1.47',
      toVersion: '0.1.51',
    })
  })
})
