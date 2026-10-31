/**
 * Bundle candidates publish only when the built tarball differs.
 *
 * The cascade tests in publish-scope.spec.ts still require the SELECT.
 * These check the decision that follows the build.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePinnedVersion } from '../ci/pin-root-deps.mjs'
import {
  candidateReason,
  compareNormalised,
  contentHash,
  VERSION_PLACEHOLDER,
} from '../ci/publish-output-hash.mjs'
import {
  directOwners,
  finalizePublishSet,
  partitionPublishSet,
  staleRegistryPins,
} from '../ci/publish-scope.mjs'

const ROOT = new URL('../..', import.meta.url).pathname

const UI_LIBRARY_CHANGE = ['packages/ui-library/src/composites/view-switch.tsx']
const RUN_FILES = [
  'packages/ui-library/src/composites/config-form-field.tsx',
  'packages/ui-library/src/composites/view-switch.tsx',
  'packages/addon-admin-ui/src/pages/Integrations.tsx',
]

const BUNDLE_CANDIDATES = [
  'packages/addon-agent-ui',
  'packages/addon-benchmark',
  'packages/addon-model-studio',
  'packages/addon-osd-manager',
  'packages/addon-training',
]

function file(rel: string, text: string): { path: string; bytes: Buffer } {
  return { path: rel, bytes: Buffer.from(text) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('partitionPublishSet', () => {
  it('keeps a direct change and marks bundlers of that change as candidates', () => {
    const part = partitionPublishSet(directOwners(RUN_FILES, ROOT), ROOT)
    expect(part.keep).toContain('packages/ui-library')
    expect(part.keep).toContain('packages/addon-admin-ui')
    expect(part.keep).toContain('server/backend')
    expect(part.candidates).not.toContain('packages/addon-admin-ui')
    for (const dir of BUNDLE_CANDIDATES) expect(part.candidates).toContain(dir)
  })

  it('does not demote force_packages or an nx-style input to a candidate', () => {
    const part = partitionPublishSet(
      ['packages/ui-library', 'packages/addon-agent-ui', 'server/backend'],
      ROOT,
    )
    expect(part.keep).toEqual(
      expect.arrayContaining(['packages/ui-library', 'packages/addon-agent-ui', 'server/backend']),
    )
    expect(part.candidates).not.toContain('packages/addon-agent-ui')
    expect(part.serverFromClosure).toBe(false)
  })
})

describe('finalizePublishSet', () => {
  it('drops a candidate whose output is unchanged and keeps a direct change', () => {
    const part = partitionPublishSet(directOwners(UI_LIBRARY_CHANGE, ROOT), ROOT)
    const final = finalizePublishSet(part, new Set(), ROOT)
    expect(final.publish).toContain('packages/ui-library')
    expect(final.publish).toContain('server/backend')
    for (const dir of BUNDLE_CANDIDATES) {
      expect(final.publish).not.toContain(dir)
      expect(final.dropped).toContain(dir)
    }
    expect(final.publish.at(-1)).toBe('server/backend')
  })

  it('keeps a candidate whose bundled output changed', () => {
    const part = partitionPublishSet(directOwners(UI_LIBRARY_CHANGE, ROOT), ROOT)
    const final = finalizePublishSet(part, new Set(['packages/addon-agent-ui']), ROOT)
    expect(final.publish).toContain('packages/addon-agent-ui')
    expect(final.dropped).not.toContain('packages/addon-agent-ui')
    expect(final.dropped).toContain('packages/addon-benchmark')
  })

  it('pins the registry version of a dropped candidate and does not call that pin stale', () => {
    const part = partitionPublishSet(
      directOwners(['packages/types/src/capabilities/ptz.cap.ts'], ROOT),
      ROOT,
    )
    expect(part.candidates).toContain('packages/system')
    const final = finalizePublishSet(part, new Set(), ROOT)
    expect(final.publish).toContain('packages/types')
    expect(final.publish).toContain('server/backend')
    expect(final.publish).not.toContain('packages/system')
    expect(
      resolvePinnedVersion(
        '@camstack/system',
        { dir: 'packages/system', version: '9.9.9' },
        { publishSet: new Set(final.publish), lookup: () => '1.2.273' },
      ),
    ).toBe('1.2.273')
    expect(staleRegistryPins(final.publish, ROOT)).toContainEqual({
      pinned: 'packages/system',
      publishes: 'packages/types',
    })
    expect(staleRegistryPins(final.publish, ROOT, { verifiedUnchanged: final.dropped })).toEqual([])
  })
})

describe('published-output normalisation', () => {
  it('covers every stamped version field', () => {
    const local = [
      file(
        'package.json',
        JSON.stringify({
          name: '@camstack/addon-agent-ui',
          version: '1.2.275',
          dependencies: { '@camstack/ui-library': '1.2.330', react: '^19.0.0' },
          camstack: { addons: [{ version: '0.1.0' }] },
        }),
      ),
      file(
        'dist/addon.mjs',
        'export const version = "1.2.275"; // banner 1.2.330\n//#region ../../../../../packages/types/dist/event-Ab12Cd34.mjs\n//#region ../../../../../node_modules/zod/v4/core/core.js\n',
      ),
      file('assets/viewer/.viewer-version', '1.2.275+abcdef\n'),
      file(
        'dist/assets/index-Ab12Cd34.js',
        'import "./index-Ab12Cd34.js"; path /Users/dev/repo/packages/ui-library/src/x.ts\n',
      ),
      file(
        'dist/assets/index-Ab12Cd34.js.map',
        JSON.stringify({
          sources: ['/Users/dev/repo/packages/ui-library/src/x.ts'],
          sourcesContent: ['export const v = "1.2.275"\n'],
        }),
      ),
      file(
        'dist/hostInit.mjs',
        '"@camstack/ui-library": { version: "1.2.331", singleton: true }\n',
      ),
      file('dist/index.html', '<script src="/assets/index-Ab12Cd34.js"></script>\n'),
    ]
    const published = [
      file(
        'package.json',
        JSON.stringify({
          camstack: { addons: [{ version: '0.1.0' }] },
          dependencies: { react: '^19.0.0', '@camstack/ui-library': '*' },
          name: '@camstack/addon-agent-ui',
          version: '9.9.9',
        }),
      ),
      file(
        'dist/addon.mjs',
        'export const version = "9.9.9"; // banner 9.8.7\n//#region ../types/dist/event-Zz90Yy88.mjs\n//#region ../../node_modules/zod/v4/core/core.js\n',
      ),
      file('assets/viewer/.viewer-version', '9.9.9+abcdef\n'),
      file(
        'dist/assets/index-Zz90Yy88.js',
        'import "./index-Zz90Yy88.js"; path /home/runner/work/server/server/packages/ui-library/src/x.ts\n',
      ),
      file(
        'dist/assets/index-Zz90Yy88.js.map',
        JSON.stringify({
          sources: ['/home/runner/work/server/server/packages/ui-library/src/x.ts'],
          sourcesContent: ['export const v = "9.9.9"\n'],
        }),
      ),
      file(
        'dist/hostInit.mjs',
        '"@camstack/ui-library": { version: "1.2.330", singleton: true }\n',
      ),
      file('dist/index.html', '<script src="/assets/index-Zz90Yy88.js"></script>\n'),
    ]
    const stamps = ['1.2.331', '1.2.330', '1.2.275', '9.9.9', '9.8.7']
    const compared = compareNormalised(local, published, stamps, ['/Users/dev/repo'])
    expect(compared.reason).toBe('bundle unchanged')
    expect(compared.local.digest).toBe(compared.published.digest)
    const placeholder = Buffer.from(VERSION_PLACEHOLDER)
    expect(compared.local.files.some((entry) => entry.bytes.includes(placeholder))).toBe(true)
  })

  it('reports a bundled component that actually changed', () => {
    const local = [
      file('package.json', '{"name":"a","version":"1.2.3"}'),
      file('dist/addon.mjs', 'NEW\n'),
    ]
    const published = [
      file('package.json', '{"name":"a","version":"1.2.2"}'),
      file('dist/addon.mjs', 'OLD\n'),
    ]
    const compared = compareNormalised(local, published, ['1.2.3', '1.2.2'])
    expect(compared.reason).toBe(candidateReason(compared.differing.length))
    expect(compared.reason).toBe('dist differs: 1 files')
    expect(compared.differing).toEqual(['dist/addon.mjs'])
  })

  it('ignores a bare host-provided federation runtime import', () => {
    const body = 'export const page = 1\n'
    const local = [file('dist/_stub.js', `import "@module-federation/runtime";\n${body}`)]
    const published = [file('dist/_stub.js', body)]
    const same = compareNormalised(local, published, [])
    expect(same.reason).toBe('bundle unchanged')
    const changed = compareNormalised(
      [file('dist/_stub.js', `import "@module-federation/runtime";\nexport const page = 2\n`)],
      published,
      [],
    )
    expect(changed.reason).toBe('dist differs: 1 files')
  })
})

describe('embedded @camstack/types copy', () => {
  // A self-contained addon bundles the types it uses, and a page remote's
  // loadShare shim lists every export of the host-provided types. A types
  // release changes both, and every other addon is not republished for it
  // (the framework closure supplies types at runtime), so a bundler candidate
  // must not ship for it either (planning #332).
  const own = 'export const own = 1\n//#endregion\n'
  const entry = (typesBody: string, ownBody = own): string =>
    `//#region ../types/dist/event-category-Abc12345.mjs\n${typesBody}\n//#endregion\n//#region src/own.ts\n${ownBody}`
  const shim = (names: string): string =>
    `//#region \\0virtual:mf:__mfe_internal__x_page__loadShare___mf_0_camstack_mf_1_types__loadShare__.js\nconst l = [${names}]\n//#endregion\n`
  const shimPath =
    'dist/_virtual_mf___mfe_internal__x_page__loadShare___mf_0_camstack_mf_1_types__loadShare__.js-Abc12345.mjs'

  it('does not count a changed types region or types export list', () => {
    const local = [
      file('dist/x.addon.mjs', entry('const T = 2')),
      file(shimPath, shim('e.A, e.B, e.NEW')),
    ]
    const published = [
      file('dist/x.addon.mjs', entry('const T = 1')),
      file(shimPath.replace('Abc12345', 'Zyx98765'), shim('e.A, e.B')),
    ]
    expect(compareNormalised(local, published, []).reason).toBe('bundle unchanged')
  })

  it('still counts a change in the addon own code', () => {
    const local = [
      file('dist/x.addon.mjs', entry('const T = 1', 'export const own = 2\n//#endregion\n')),
    ]
    const published = [file('dist/x.addon.mjs', entry('const T = 1'))]
    expect(compareNormalised(local, published, []).reason).toBe('dist differs: 1 files')
  })
})

describe('addon-agent-ui build reproducibility', () => {
  it('hashes two builds of the same tree equal, including across a version stamp', {
    timeout: 300_000,
  }, () => {
    const dir = path.join(ROOT, 'packages/addon-agent-ui')
    const manifestPath = path.join(dir, 'package.json')
    const original = fs.readFileSync(manifestPath, 'utf8')
    const parsedOriginal: unknown = JSON.parse(original)
    if (!isRecord(parsedOriginal) || typeof parsedOriginal.version !== 'string') {
      throw new Error('addon-agent-ui package.json has no version')
    }
    const originalVersion = parsedOriginal.version
    const stamped = '9.9.9-repro'
    const build = (): void => {
      execFileSync('npm', ['run', 'build', '-w', 'packages/addon-agent-ui'], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production', VITE_AGENT_PORT: '4444' },
      })
    }
    const digest = (): string => {
      const packed = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      const start = packed.indexOf('[')
      const parsed: unknown = JSON.parse(packed.slice(start, packed.lastIndexOf(']') + 1))
      if (!Array.isArray(parsed)) throw new Error('npm pack JSON was not an array')
      const info: unknown = parsed[0]
      if (typeof info !== 'object' || info === null || !('files' in info)) {
        throw new Error('npm pack JSON has no file list')
      }
      const listed: unknown = info.files
      if (!Array.isArray(listed)) throw new Error('npm pack file list was not an array')
      const files = listed.map((entry) => {
        if (typeof entry !== 'object' || entry === null || !('path' in entry)) {
          throw new Error('npm pack file entry has no path')
        }
        const entryPath = entry.path
        if (typeof entryPath !== 'string') throw new Error('npm pack file path was not a string')
        const rel = entryPath.replace(/^package\//, '')
        return { path: rel, bytes: fs.readFileSync(path.join(dir, rel)) }
      })
      return contentHash(files, {
        stamps: [originalVersion, stamped],
        roots: [path.resolve(ROOT)],
      }).digest
    }
    try {
      build()
      const first = digest()
      build()
      expect(digest()).toBe(first)
      const rewritten = { ...parsedOriginal, version: stamped }
      fs.writeFileSync(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`)
      build()
      expect(digest()).toBe(first)
    } finally {
      fs.writeFileSync(manifestPath, original)
      build()
    }
  })
})
