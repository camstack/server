/**
 * AddonInstaller.installFromTgz — `@camstack/*` dependency stripping.
 *
 * Regression guard: a deployed addon (e.g. `@camstack/system`) must NOT get
 * its OWN `node_modules/@camstack/types` planted by the post-extract
 * `npm install`. Those are host-provided system packages — a local copy
 * inside the addon dir SHADOWS the host's fresh one, so a freshly-added
 * `DeviceFeature` enum value (or any type/enum change) silently never
 * reaches the running hub even though the addon dist is fresh.
 *
 * `installCopy` already strips here; this spec pins the same behaviour for
 * the tgz/upload path that `camstack deploy <pkg>` actually exercises.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import { AddonInstaller } from '../addon-installer.js'

interface TgzManifest {
  readonly name: string
  readonly version: string
  readonly dependencies?: Record<string, string>
}

/**
 * Build an npm-pack-layout tarball (`package/package.json` + `package/dist/`)
 * for `manifest` and return its path. No real `npm pack` — a hand-rolled
 * `tar` keeps the test hermetic and fast.
 */
function makeTgz(tmpRoot: string, manifest: TgzManifest): string {
  const stage = fs.mkdtempSync(path.join(tmpRoot, 'stage-'))
  const pkgDir = path.join(stage, 'package')
  const distDir = path.join(pkgDir, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        main: 'dist/index.js',
        ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
        camstack: {
          addons: [
            {
              id: manifest.name.replace('@camstack/', ''),
              name: manifest.name,
              version: manifest.version,
              entry: './dist/index.js',
            },
          ],
        },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(distDir, 'index.js'),
    `module.exports = { version: '${manifest.version}' };\n`,
  )
  const tgzPath = path.join(tmpRoot, `${manifest.name.replace('@camstack/', '')}.tgz`)
  execFileSync('tar', ['-czf', tgzPath, '-C', stage, 'package'])
  return tgzPath
}

describe('AddonInstaller.installFromTgz — @camstack/* dep stripping', () => {
  let tmpRoot: string
  let addonsDir: string
  let installer: AddonInstaller

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-tgz-strip-'))
    addonsDir = path.join(tmpRoot, 'addons')
    fs.mkdirSync(addonsDir, { recursive: true })
    installer = new AddonInstaller({ addonsDir })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('strips @camstack/* deps from the installed manifest', async () => {
    const tgz = makeTgz(tmpRoot, {
      name: '@camstack/test-core',
      version: '0.1.40',
      dependencies: { '@camstack/types': '^0.1.0' },
    })

    await installer.installFromTgz(tgz)

    const installed = JSON.parse(
      fs.readFileSync(path.join(addonsDir, '@camstack/test-core', 'package.json'), 'utf-8'),
    ) as { dependencies?: Record<string, string> }

    expect(installed.dependencies?.['@camstack/types']).toBeUndefined()
  })

  it('does NOT plant a local node_modules/@camstack/types that shadows the host', async () => {
    const tgz = makeTgz(tmpRoot, {
      name: '@camstack/test-core',
      version: '0.1.40',
      dependencies: { '@camstack/types': '^0.1.0' },
    })

    await installer.installFromTgz(tgz)

    const planted = path.join(
      addonsDir,
      '@camstack/test-core',
      'node_modules',
      '@camstack',
      'types',
    )
    expect(fs.existsSync(planted)).toBe(false)
  })

  it('keeps the addon dist and version intact', async () => {
    const tgz = makeTgz(tmpRoot, {
      name: '@camstack/test-core',
      version: '0.1.40',
      dependencies: { '@camstack/types': '^0.1.0' },
    })

    const result = await installer.installFromTgz(tgz)

    expect(result).toEqual({ name: '@camstack/test-core', version: '0.1.40' })
    expect(fs.existsSync(path.join(addonsDir, '@camstack/test-core', 'dist', 'index.js'))).toBe(
      true,
    )
  })
})
