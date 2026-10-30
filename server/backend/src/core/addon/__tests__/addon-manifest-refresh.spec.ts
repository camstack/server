/**
 * After an addon update the hub row must show the NEW manifest.
 *
 * Live: velux 0.2.150 on disk declared `assets/icon.png`, `addons.list` still
 * served `assets/icon.svg` captured at boot, and the admin UI 404'd. The only
 * refresh was `loadNewAddons()`; the update paths changed `packageVersion` only.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeclaration, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddonRegistryService } from '../addon-registry.service.js'

const PACKAGE = '@camstack/addon-iconchange'
const ADDON_ID = 'iconchange'

function logger(): IScopedLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

function writePackage(dir: string, version: string, icon: string): void {
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: PACKAGE,
      version,
      main: 'dist/index.js',
      camstack: {
        addons: [{ id: ADDON_ID, name: 'Icon Change', icon, entry: 'dist/index.js' }],
      },
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'dist', 'index.js'),
    'module.exports = class { initialize() {} }\n',
  )
}

let root: string
let previousAddonsDir: string | undefined

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-manifest-refresh-'))
  previousAddonsDir = process.env['CAMSTACK_ADDONS_DIR']
  process.env['CAMSTACK_ADDONS_DIR'] = path.join(root, 'addons')
})

afterEach(() => {
  if (previousAddonsDir === undefined) delete process.env['CAMSTACK_ADDONS_DIR']
  else process.env['CAMSTACK_ADDONS_DIR'] = previousAddonsDir
  fs.rmSync(root, { recursive: true, force: true })
})

function makeRegistry(oldDeclaration: AddonDeclaration): AddonRegistryService {
  const loggingService = { createLogger: () => logger() }
  const noop = { emit: () => undefined, subscribe: () => () => undefined }
  const registry = new AddonRegistryService(
    loggingService as never,
    noop as never,
    { get: () => undefined } as never,
    {} as never,
    { setRegistry: () => undefined } as never,
    {
      broker: {},
      childRegistry: {},
      setRunnerIdResolver: () => undefined,
    } as never,
    {} as never,
  )
  const entries = Reflect.get(registry, 'addonEntries')
  entries.set(ADDON_ID, {
    addon: { manifest: { id: ADDON_ID, name: 'Icon Change' } },
    initialized: true,
    source: 'builtin',
    packageName: PACKAGE,
    packageVersion: '0.2.149',
    declaredCapabilities: [],
    declaration: oldDeclaration,
  })
  return registry
}

describe('listAddons after a package swap', () => {
  it('serves the icon of the NEW package.json once the package is refreshed', async () => {
    const pkgDir = path.join(root, 'addons', PACKAGE)
    writePackage(pkgDir, '0.2.150', 'assets/icon.png')
    const registry = makeRegistry({
      id: ADDON_ID,
      name: 'Icon Change',
      icon: 'assets/icon.svg',
    } as AddonDeclaration)

    expect(registry.listAddons()[0]?.manifest.icon).toBe('assets/icon.svg')

    await registry.refreshPackageFromDisk(PACKAGE)

    const row = registry.listAddons()[0]
    expect(row?.manifest.icon).toBe('assets/icon.png')
    expect(row?.manifest.packageVersion).toBe('0.2.150')
  })
})
