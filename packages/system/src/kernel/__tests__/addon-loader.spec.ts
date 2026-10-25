import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { StorageLocationDeclaration } from '@camstack/types'
import {
  AddonLoader,
  extractStorageLocationDeclarations,
  type RegisteredAddon,
} from '../addon-loader.js'

const FIXTURE_MODULE = fileURLToPath(
  new URL('./fixtures/storage-loc-addon.fixture.mjs', import.meta.url),
)

function makeRegistered(
  id: string,
  storageLocations?: readonly StorageLocationDeclaration[],
): RegisteredAddon {
  return {
    declaration: {
      id,
      entry: 'index.js',
      slot: 'detector',
      ...(storageLocations !== undefined ? { storageLocations } : {}),
    },
    packageName: `@camstack/${id}`,
    packageVersion: '1.0.0',
    addonClass: class {
      async initialize(): Promise<void> {}
      async shutdown(): Promise<void> {}
    } as unknown as RegisteredAddon['addonClass'],
    module: {},
  }
}

describe('extractStorageLocationDeclarations', () => {
  it('returns one inner array per addon that declared locations, omitting empties', () => {
    const recordings: StorageLocationDeclaration = {
      id: 'recordings',
      displayName: 'Recordings',
      cardinality: 'multi',
    }
    const addons = [
      makeRegistered('recorder', [recordings]),
      makeRegistered('no-storage'), // declares nothing → omitted
      makeRegistered('empty-storage', []), // empty array → omitted
    ]

    expect(extractStorageLocationDeclarations(addons)).toEqual([[recordings]])
  })

  it('returns an empty result when no addon declares storage locations', () => {
    expect(extractStorageLocationDeclarations([makeRegistered('a'), makeRegistered('b')])).toEqual(
      [],
    )
  })

  it('copies each declaration array (does not alias the addon declaration)', () => {
    const decls: StorageLocationDeclaration[] = [
      { id: 'logs', displayName: 'Logs', cardinality: 'single' },
    ]
    const out = extractStorageLocationDeclarations([makeRegistered('logger', decls)])
    expect(out[0]).not.toBe(decls)
    expect(out[0]).toEqual(decls)
  })
})

describe('AddonLoader.listStorageLocationDeclarations', () => {
  it('surfaces the declared storageLocations from a registered addon', async () => {
    const loader = new AddonLoader()
    const recordings: StorageLocationDeclaration = {
      id: 'recordings',
      displayName: 'Recordings',
      cardinality: 'multi',
    }

    await loader.loadFromPath('recorder', FIXTURE_MODULE, '@camstack/recorder', {
      storageLocations: [recordings],
    })
    await loader.loadFromPath('no-storage', FIXTURE_MODULE, '@camstack/no-storage')

    expect(loader.listStorageLocationDeclarations()).toEqual([[recordings]])
  })

  it('returns an empty array when no registered addon declares any', async () => {
    const loader = new AddonLoader()
    await loader.loadFromPath('plain', FIXTURE_MODULE, '@camstack/plain')
    expect(loader.listStorageLocationDeclarations()).toEqual([])
  })
})

/**
 * The addons dir is SCANNED, not read from a list — so what is in it is loaded,
 * whatever it is called. The house convention for retiring a package is to
 * rename it `.quarantine-<name>-<date>`, and that convention did nothing: the
 * scan kept loading it and it kept appearing in `addons.list` through a full
 * hub restart. (The same rename also broke the by-NAME runner spawn for any
 * addon still listed in `manifest.json`, taking down every addon co-located in
 * its runner — 2026-08-09.)
 */
describe('AddonLoader.loadFromDirectory', () => {
  /**
   * A REAL loadable addon per directory — an entry module that exists and
   * exports an addon class. Anything less proves nothing: a fixture whose entry
   * is missing fails to load either way, so "nothing registered" would hold
   * with the scan deleted entirely.
   */
  async function scopedDir(dirNames: readonly string[]): Promise<{
    root: string
    cleanup: () => Promise<void>
  }> {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'camstack-addons-'))
    for (const dirName of dirNames) {
      const dir = path.join(root, '@camstack', dirName)
      await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
      const addonId = dirName.replace(/^\.quarantine-/, '').replace(/-\d+$/, '')
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: `@camstack/${addonId}`,
          version: '1.0.0',
          camstack: { addons: [{ id: addonId, entry: './dist/index.mjs' }] },
        }),
      )
      await fs.writeFile(
        path.join(dir, 'dist', 'index.mjs'),
        'export class Addon { async initialize() {} async shutdown() {} }\n',
      )
    }
    return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
  }

  it('loads a normally-named directory', async () => {
    const { root, cleanup } = await scopedDir(['addon-real'])
    try {
      const loader = new AddonLoader()
      await loader.loadFromDirectory(root)
      expect(loader.listAddons().map((a) => a.declaration.id)).toEqual(['addon-real'])
    } finally {
      await cleanup()
    }
  })

  it('SKIPS a dot-prefixed directory — a quarantined package is not loaded', async () => {
    const { root, cleanup } = await scopedDir([
      'addon-real',
      '.quarantine-addon-export-ha-mqtt-20260809',
    ])
    try {
      const loader = new AddonLoader()
      await loader.loadFromDirectory(root)
      const ids = loader.listAddons().map((a) => a.declaration.id)
      expect(ids).toEqual(['addon-real'])
      expect(ids).not.toContain('addon-export-ha-mqtt')
    } finally {
      await cleanup()
    }
  })
})
