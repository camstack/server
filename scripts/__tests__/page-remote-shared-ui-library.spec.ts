import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { federation } from '@module-federation/vite'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleModulesManifest } from '../../tools/build/bundle-modules-manifest'
import { compareByBundleManifest } from '../ci/publish-output-hash.mjs'

/**
 * A page remote shares ui-library and types with the host (`import: false`) and
 * does NOT compile them in. A `resolve.alias` of either to its `src` rewrites the
 * specifier before the sharing layer sees it and bundles the whole library, so a
 * ui-library edit republishes every page addon (planning #332).
 *
 * The fixture is a miniature workspace built with the same federation shape the
 * page configs use: `packages/*` linked under `node_modules/@camstack/*`.
 */

const MANIFEST = 'dist/.bundle-modules.json'

interface Fixture {
  readonly uiLibrarySource: string
  readonly aliasUiLibrary: boolean
}

interface Built {
  readonly manifest: { readonly path: string; readonly bytes: Buffer }
  readonly keys: readonly string[]
  readonly files: readonly string[]
}

async function buildRemote(fixture: Fixture): Promise<Built> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-remote-'))
  try {
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), text)
    }
    write('package.json', JSON.stringify({ name: 'fixture', version: '0.0.0', type: 'module' }))
    for (const [name, source] of [
      ['ui-library', fixture.uiLibrarySource],
      ['types', 'export const KINDS = ["a", "b"]\n'],
    ] as const) {
      write(
        `packages/${name}/package.json`,
        JSON.stringify({
          name: `@camstack/${name}`,
          version: '1.2.3',
          type: 'module',
          exports: { '.': { import: './dist/index.js' } },
        }),
      )
      // Like a real install: the package resolves to its BUILT entry; the source is only reachable by path.
      write(`packages/${name}/dist/index.js`, source)
      write(`packages/${name}/src/index.ts`, source)
      fs.mkdirSync(path.join(root, 'node_modules/@camstack'), {
        recursive: true,
      })
      fs.symlinkSync(
        path.join(root, `packages/${name}`),
        path.join(root, `node_modules/@camstack/${name}`),
      )
    }
    write(
      'packages/addon-x/src/page.tsx',
      "import { Button } from '@camstack/ui-library'\nimport { KINDS } from '@camstack/types'\nexport default function Page() { return Button() + KINDS.join() }\n",
    )
    const output = await build({
      root,
      logLevel: 'silent',
      configFile: false,
      plugins: [
        bundleModulesManifest(),
        federation({
          name: 'addon_x_page',
          filename: 'remoteEntry.js',
          dts: false,
          exposes: { './page': './packages/addon-x/src/page.tsx' },
          shared: {
            '@camstack/ui-library': {
              singleton: true,
              requiredVersion: '>=1.2.3',
              import: false,
            },
            '@camstack/types': {
              singleton: true,
              requiredVersion: false,
              import: false,
            },
          },
        }),
      ],
      resolve: fixture.aliasUiLibrary
        ? {
            alias: {
              '@camstack/ui-library': path.join(root, 'packages/ui-library/src'),
            },
          }
        : {},
      build: {
        write: false,
        target: 'es2022',
        lib: {
          entry: path.join(root, 'packages/addon-x/src/page.tsx'),
          formats: ['es'],
          fileName: () => '_stub.js',
        },
      },
    })
    const results = Array.isArray(output) ? output : [output]
    const files: string[] = []
    let manifest: Built['manifest'] | undefined
    for (const result of results) {
      if (!('output' in result)) continue
      for (const asset of result.output) {
        files.push(asset.fileName)
        if (asset.fileName === '.bundle-modules.json' && asset.type === 'asset') {
          manifest = {
            path: MANIFEST,
            bytes: Buffer.from(String(asset.source)),
          }
        }
      }
    }
    if (manifest === undefined) throw new Error('no manifest emitted')
    const keys = Object.keys(JSON.parse(manifest.bytes.toString()))
    return { manifest, keys, files }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const base: Fixture = {
  uiLibrarySource: 'export const Button = () => "v1"\n',
  aliasUiLibrary: false,
}

describe('a page remote shares ui-library, from a real build', () => {
  // The federation plugin switches itself off under a test runner; this IS the build under test.
  const previous = process.env.MFE_VITE_NO_TEST_ENV_CHECK
  beforeAll(() => {
    process.env.MFE_VITE_NO_TEST_ENV_CHECK = 'true'
  })
  afterAll(() => {
    if (previous === undefined) delete process.env.MFE_VITE_NO_TEST_ENV_CHECK
    else process.env.MFE_VITE_NO_TEST_ENV_CHECK = previous
  })

  it('holds neither ui-library nor types in its bundle, and loads ui-library through the share', async () => {
    const built = await buildRemote(base)
    expect(built.keys.filter((key) => key.startsWith('packages/ui-library/'))).toEqual([])
    expect(built.keys.filter((key) => key.startsWith('packages/types/'))).toEqual([])
    expect(built.keys).toContain('packages/addon-x/src/page.tsx')
    expect(built.files.filter((file) => /ui_mf_2_library__loadShare/.test(file))).not.toEqual([])
  })

  it('a ui-library-only source edit leaves the manifest equal', async () => {
    const edited = {
      ...base,
      uiLibrarySource: 'export const Button = () => "v2"\n',
    }
    const result = compareByBundleManifest(
      [(await buildRemote(edited)).manifest],
      [(await buildRemote(base)).manifest],
    )
    expect(result?.equal).toBe(true)
  })

  it('with a resolve.alias to the source, ui-library is bundled and an edit differs (what the guard forbids)', async () => {
    const aliased = { ...base, aliasUiLibrary: true }
    const built = await buildRemote(aliased)
    expect(built.keys).toContain('packages/ui-library/src/index.ts')
    const edited = {
      ...aliased,
      uiLibrarySource: 'export const Button = () => "v2"\n',
    }
    const result = compareByBundleManifest([(await buildRemote(edited)).manifest], [built.manifest])
    expect(result?.equal).toBe(false)
  })
})
