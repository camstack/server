import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { bundleModulesManifest } from '../../tools/build/bundle-modules-manifest'
import { compareByBundleManifest } from '../ci/publish-output-hash.mjs'

const MANIFEST = 'dist/.bundle-modules.json'

interface Fixture {
  readonly usedSource: string
  readonly unusedSource: string
}

/** Builds a tiny page remote whose entry imports ONE ui-library module; returns the manifest tarball entry. */
async function buildManifest(fixture: Fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-manifest-'))
  try {
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
    write('packages/ui-library/src/used.ts', fixture.usedSource)
    write('packages/ui-library/src/unused.ts', fixture.unusedSource)
    write(
      'packages/addon-x/src/entry.ts',
      "import { used } from '../../ui-library/src/used'\nexport const page = used()\n",
    )
    const output = await build({
      root,
      logLevel: 'silent',
      configFile: false,
      plugins: [bundleModulesManifest()],
      build: {
        write: false,
        lib: { entry: path.join(root, 'packages/addon-x/src/entry.ts'), formats: ['es'] },
      },
    })
    const results = Array.isArray(output) ? output : [output]
    for (const result of results) {
      if (!('output' in result)) continue
      for (const asset of result.output) {
        if (asset.fileName === '.bundle-modules.json' && asset.type === 'asset') {
          return { path: MANIFEST, bytes: Buffer.from(String(asset.source)) }
        }
      }
    }
    throw new Error('no manifest emitted')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const base: Fixture = {
  usedSource: 'export const used = () => "v1"\n',
  unusedSource: 'export const unused = () => "u1"\n',
}

describe('bundle modules manifest, from a real build', () => {
  it('the same tree built twice compares equal', async () => {
    const result = compareByBundleManifest([await buildManifest(base)], [await buildManifest(base)])
    expect(result?.equal).toBe(true)
  })

  it('one byte changed in a bundled module differs, and names it', async () => {
    const changed = { ...base, usedSource: 'export const used = () => "v2"\n' }
    const result = compareByBundleManifest(
      [await buildManifest(changed)],
      [await buildManifest(base)],
    )
    expect(result?.equal).toBe(false)
    expect(result?.differing).toEqual(['packages/ui-library/src/used.ts'])
  })

  it('a change in a module the bundle does not hold compares equal', async () => {
    const changed = { ...base, unusedSource: 'export const unused = () => "u2"\n' }
    const result = compareByBundleManifest(
      [await buildManifest(changed)],
      [await buildManifest(base)],
    )
    expect(result?.equal).toBe(true)
  })
})
