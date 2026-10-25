/**
 * The generated package is the contract between a stored block and the addon
 * runner, and the runner reads it off disk with no schema in front of it. So
 * these tests assert the SHAPE the runner actually consumes — `package.json` →
 * `camstack.addons[].entry` → a file that exists — rather than that some files
 * were written.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ConfigUISchema } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  blockAddonId,
  blockIdFromAddonId,
  materializeBlock,
  removeBlockPackage,
  renderBlockWrapper,
} from '../block-package.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'block-package-'))
})

describe('the generated addon id', () => {
  it('round-trips', () => {
    expect(blockIdFromAddonId(blockAddonId('abc-123'))).toBe('abc-123')
  })

  it('does not claim an ordinary addon', () => {
    expect(blockIdFromAddonId('pipeline-orchestrator')).toBeNull()
    // The bare prefix names no block — treating it as one would have the
    // supervisor stop a runner called `core-block-`.
    expect(blockIdFromAddonId('core-block-')).toBeNull()
  })
})

describe('materializeBlock', () => {
  it('writes a manifest whose declared entry exists', async () => {
    const { addonDir, addonId } = await materializeBlock({
      root,
      blockId: 'b1',
      blockName: 'Porta',
      js: 'export default () => {}',
    })

    const manifest = JSON.parse(
      await fs.readFile(path.join(addonDir, 'package.json'), 'utf-8'),
    ) as {
      type: string
      camstack: { addons: Array<{ id: string; entry: string }> }
    }
    const declared = manifest.camstack.addons[0]!
    expect(declared.id).toBe(addonId)
    // ESM: the wrapper and the author's code both use `import`, so a package
    // without this runs as CJS and dies on the first line.
    expect(manifest.type).toBe('module')
    await expect(fs.access(path.resolve(addonDir, declared.entry))).resolves.toBeUndefined()
  })

  it('rewrites the code on the second pass instead of leaving the old file', async () => {
    await materializeBlock({ root, blockId: 'b1', blockName: 'A', js: 'const v = 1' })
    await materializeBlock({ root, blockId: 'b1', blockName: 'A', js: 'const v = 2' })

    const js = await fs.readFile(path.join(root, 'b1', 'dist', 'block.js'), 'utf-8')
    expect(js).toBe('const v = 2')
  })

  it('carries the block identity into the wrapper', async () => {
    // The wrapper's error message is the only thing an author sees when their
    // module exports nothing usable, so the name has to be IN it.
    const wrapper = renderBlockWrapper('b1', 'Luci garden')
    expect(wrapper).toContain('"b1"')
    expect(wrapper).toContain('"Luci garden"')
    // `super({})` is the omission that killed CoreBlocksAddon in production
    // while the build stayed green — it is generated so no author can drop it.
    expect(wrapper).toContain('super({})')
  })

  it('imports the author module defensively', () => {
    // A DEFAULT import of a module with no default export is a link-time
    // SyntaxError — the wrapper never executes, so its friendly "no default
    // export function" message never reaches the author. Pinned because the
    // obvious spelling is the broken one.
    const wrapper = renderBlockWrapper('b1', 'A')
    expect(wrapper).toContain("import * as blockModule from './block.js'")
    expect(wrapper).not.toMatch(/^import\s+\w+\s+from\s+'\.\/block\.js'/m)
  })

  it('escapes a name that would otherwise break the generated source', async () => {
    const wrapper = renderBlockWrapper('b1', 'He said "stop"\n; process.exit(1)')
    // JSON.stringify is the escape; the assertion is that the injected name
    // cannot terminate the string literal it lives in.
    expect(wrapper).toContain(String.raw`"He said \"stop\"\n; process.exit(1)"`)
  })
})

describe('the settings form in the wrapper (D880)', () => {
  const schema: ConfigUISchema = {
    sections: [
      {
        id: 'main',
        title: 'Cost $& ($1)',
        fields: [{ type: 'password', key: 'password', label: 'Password' }],
      },
    ],
  }

  function embedded(wrapper: string): unknown {
    const line = wrapper.split('\n').find((l) => l.startsWith('const BLOCK_SETTINGS_SCHEMA = '))
    if (line === undefined) throw new Error('the wrapper embeds no schema line')
    return JSON.parse(line.slice('const BLOCK_SETTINGS_SCHEMA = '.length))
  }

  it('embeds the block schema verbatim, so the SDK derives its keychain secret tree from it', () => {
    const wrapper = renderBlockWrapper('b1', 'A', schema)
    expect(embedded(wrapper)).toEqual(schema)
    expect(wrapper).toContain('globalSettingsSchema() {\n    return BLOCK_SETTINGS_SCHEMA')
  })

  it('embeds null for a block that declares none', () => {
    expect(embedded(renderBlockWrapper('b1', 'A'))).toBeNull()
  })

  it('materialize writes the schema into dist/index.js', async () => {
    await materializeBlock({
      root,
      blockId: 'b1',
      blockName: 'A',
      js: 'const v = 1',
      settingsSchema: schema,
    })
    const written = await fs.readFile(path.join(root, 'b1', 'dist', 'index.js'), 'utf-8')
    expect(embedded(written)).toEqual(schema)
  })
})

describe('removeBlockPackage', () => {
  it('removes the package and tolerates a second call', async () => {
    await materializeBlock({ root, blockId: 'b1', blockName: 'A', js: 'const v = 1' })
    await removeBlockPackage(root, 'b1')
    await removeBlockPackage(root, 'b1')

    await expect(fs.access(path.join(root, 'b1'))).rejects.toThrow()
  })
})
