/**
 * Multi-file blocks: migrate `code` → `files[entry]`, compile two files, and
 * patch prefs through `core-blocks:settings`.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DEFAULT_CORE_BLOCK_ENTRY,
  normalizeCoreBlockWrite,
  resolveCoreBlockFiles,
  type ConfigUISchema,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { materializeBlock } from '../block-package.js'
import { BlockSettingsStore } from '../block-settings-store.js'
import { type BlockTranspiler, compileBlock } from '../compile-block.js'
import {
  blockSettingsStoreHarness,
  coreBlockStoreHarness,
  fakeSettingsStore,
  recordingLogger,
} from './fixtures.js'

const { logger } = recordingLogger()

describe('resolveCoreBlockFiles / normalizeCoreBlockWrite', () => {
  it('treats legacy code as files[main.ts]', () => {
    const resolved = resolveCoreBlockFiles({ code: 'export default () => {}' })
    expect(resolved.entry).toBe(DEFAULT_CORE_BLOCK_ENTRY)
    expect(resolved.files).toEqual({ [DEFAULT_CORE_BLOCK_ENTRY]: 'export default () => {}' })
  })

  it('derives code from files[entry] on write', () => {
    const normalized = normalizeCoreBlockWrite({
      files: {
        'main.ts': 'export { helper } from "./util.ts"\nexport default () => {}',
        'util.ts': 'export const helper = 1',
      },
      entry: 'main.ts',
    })
    expect(normalized.code).toContain('export default')
    expect(normalized.files?.['util.ts']).toBe('export const helper = 1')
    expect(normalized.entry).toBe('main.ts')
  })
})

describe('CoreBlockStore multi-file', () => {
  it('persists files and derives code from the entry', async () => {
    const store = await coreBlockStoreHarness(logger, { now: () => 1_000, newId: () => 'b1' })
    await store.load()
    const block = await store.create(
      {
        name: 'Multi',
        enabled: true,
        placement: 'hub',
        files: {
          'main.ts': 'import { n } from "./lib.ts"\nexport default () => n',
          'lib.ts': 'export const n = 2',
        },
        entry: 'main.ts',
      },
      'u1',
    )
    expect(block.code).toContain('import { n }')
    expect(block.files?.['lib.ts']).toBe('export const n = 2')
    expect(block.entry).toBe('main.ts')
  })

  it('updates files[entry] when a multi-file block is patched with code only', async () => {
    const store = await coreBlockStoreHarness(logger, { now: () => 1_000, newId: () => 'b1' })
    await store.load()
    await store.create(
      {
        name: 'Multi',
        enabled: true,
        placement: 'hub',
        files: { 'main.ts': 'export default () => 1', 'lib.ts': 'export const x = 1' },
      },
      'u1',
    )
    const updated = await store.update('b1', { code: 'export default () => 2' })
    expect(updated.files?.['main.ts']).toBe('export default () => 2')
    expect(updated.files?.['lib.ts']).toBe('export const x = 1')
    expect(updated.code).toBe('export default () => 2')
  })
})

describe('compileBlock with two files', () => {
  it('bundles a relative import via esbuild.build', async () => {
    const written = new Map<string, string>()
    const transpiler: BlockTranspiler = {
      transform: async (code) => ({ code }),
      build: async (options) => {
        // Read what compileBlock wrote and emit a concatenated stand-in for
        // a real bundle — the contract under test is "all files reach disk
        // and build is invoked from the entry".
        for (const rel of await walkRel(options.absWorkingDir)) {
          written.set(rel, await fs.readFile(path.join(options.absWorkingDir, rel), 'utf-8'))
        }
        const entry = options.entryPoints[0]!
        const entrySrc = await fs.readFile(path.join(options.absWorkingDir, entry), 'utf-8')
        await fs.mkdir(path.dirname(options.outfile), { recursive: true })
        await fs.writeFile(
          options.outfile,
          `/* bundled from ${entry} */\n${entrySrc}\nexport const __files = ${JSON.stringify([...written.keys()])}`,
          'utf-8',
        )
        return { errors: [] }
      },
    }
    const res = await compileBlock(transpiler, {
      files: {
        'main.ts': 'import { n } from "./lib.ts"\nexport default async function () { return n }',
        'lib.ts': 'export const n = 42',
      },
      entry: 'main.ts',
    })
    expect(res.ok).toBe(true)
    expect(res.js).toContain('bundled from main.ts')
    expect(written.get('main.ts')).toContain('import { n }')
    expect(written.get('lib.ts')).toBe('export const n = 42')
  })
})

describe('materializeBlock writes all source files', () => {
  it('lands every path under src/ next to the bundle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'block-files-'))
    await materializeBlock({
      root,
      blockId: 'b1',
      blockName: 'Multi',
      js: 'export default () => {}',
      files: { 'main.ts': 'export default 1', 'helpers/util.ts': 'export const x = 1' },
    })
    expect(await fs.readFile(path.join(root, 'b1', 'src', 'main.ts'), 'utf-8')).toBe(
      'export default 1',
    )
    expect(await fs.readFile(path.join(root, 'b1', 'src', 'helpers', 'util.ts'), 'utf-8')).toBe(
      'export const x = 1',
    )
    expect(await fs.readFile(path.join(root, 'b1', 'dist', 'block.js'), 'utf-8')).toContain(
      'export default',
    )
  })
})

describe('BlockSettingsStore prefs patch', () => {
  let prefs: BlockSettingsStore
  let rows: Map<string, Record<string, unknown>>

  beforeEach(async () => {
    const settings = fakeSettingsStore()
    rows = settings.addonRows
    prefs = (await blockSettingsStoreHarness(() => null, settings)).prefs
  })

  it('merges a patch into the block addon rows', async () => {
    await prefs.mergeValues('b1', undefined, { channel: 'tv', volume: 3 })
    await prefs.mergeValues('b1', undefined, { volume: 5 })
    expect(await prefs.readStored('b1')).toEqual({ channel: 'tv', volume: 5 })
  })

  it('keeps ONE copy: addon-settings ROWS (D870), and nothing in core-blocks:settings (D880)', async () => {
    const settings = fakeSettingsStore()
    const { prefs: store } = await blockSettingsStoreHarness(() => null, settings)
    await store.mergeValues('b1', undefined, { channel: 'tv', volume: 3 })
    const ids = [...settings.addonRows.keys()]
    expect(ids).toHaveLength(2)
    expect(ids.every((id) => id.includes('.'))).toBe(true)
    expect([...settings.addonRows.values()].map((d) => d['key']).toSorted()).toEqual([
      'channel',
      'volume',
    ])
    expect(settings.rows.size).toBe(0)
  })

  it('a failed write FAILS the prefs write - it is not swallowed', async () => {
    const settings = fakeSettingsStore()
    Reflect.deleteProperty(settings.client, 'transact')
    const { prefs: broken } = await blockSettingsStoreHarness(() => null, settings)
    await expect(broken.mergeValues('b1', undefined, { channel: 'tv' })).rejects.toThrow()
  })

  it('starts empty for an unknown block', async () => {
    expect(await prefs.readStored('missing')).toEqual({})
    expect(rows.size).toBe(0)
  })
})

describe('getBlockSettings hydration contract', () => {
  it('hydrateSchema fills values from the stored rows', async () => {
    const { hydrateSchema } = await import('@camstack/types')
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'main',
          title: 'Main',
          fields: [
            { type: 'text', key: 'channel', label: 'Channel', default: '1' },
            { type: 'number', key: 'volume', label: 'Volume', default: 1 },
          ],
        },
      ],
    }
    const settings = fakeSettingsStore()
    const { prefs } = await blockSettingsStoreHarness(() => null, settings)
    await prefs.mergeValues('b1', schema, { channel: '5' })
    const hydrated = hydrateSchema(schema, await prefs.readStored('b1'))
    const fields = hydrated.sections[0]!.fields
    expect(fields.find((f) => 'key' in f && f.key === 'channel')).toMatchObject({ value: '5' })
    expect(fields.find((f) => 'key' in f && f.key === 'volume')).toMatchObject({ value: 1 })
  })
})

async function walkRel(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (ent.name === '.bundle') continue
      const rel = prefix.length === 0 ? ent.name : `${prefix}/${ent.name}`
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), rel)
      else out.push(rel)
    }
  }
  await walk(root, '')
  return out
}
