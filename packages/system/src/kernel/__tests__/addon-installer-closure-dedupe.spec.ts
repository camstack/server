/**
 * AddonInstaller.installFromTgz — closure dedupe of the materialised tree.
 *
 * After the runtime-dep npm install, a top-level node_modules entry the
 * server closure provides at a COMPATIBLE version must be replaced by a
 * symlink into the closure — and an entry the closure serves only at an
 * incompatible major (the live case: addon tree needs zod@^3, closure ships
 * zod@4) must keep its own copy. Deps the closure lacks stay materialised.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddonInstaller } from '../addon-installer.js'

interface NpmMockState {
  calls: { args: readonly string[]; cwd: string | undefined }[]
  onInstall: (cwd: string) => void
}

const npmMock = vi.hoisted<NpmMockState>(() => ({ calls: [], onInstall: () => {} }))

vi.mock('../deps/npm-command.js', () => ({
  runNpm: async (
    args: readonly string[],
    options: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> => {
    npmMock.calls.push({ args: [...args], cwd: options.cwd })
    npmMock.onInstall(options.cwd ?? '')
    return { stdout: '', stderr: '' }
  },
}))

function writeFakePackage(
  nodeModulesDir: string,
  name: string,
  version: string,
  dependencies?: Record<string, string>,
): void {
  const dir = path.join(nodeModulesDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version,
      main: 'index.js',
      ...(dependencies ? { dependencies } : {}),
    }),
  )
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {}\n')
}

/** npm-pack-layout tarball with runtime deps declared. */
function makeTgz(tmpRoot: string): string {
  const stage = fs.mkdtempSync(path.join(tmpRoot, 'stage-'))
  const pkgDir = path.join(stage, 'package')
  const distDir = path.join(pkgDir, 'dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@camstack/addon-dedupe-test',
      version: '1.0.0',
      main: 'dist/index.js',
      dependencies: { werift: '^0.22.9', 'vendor-lib': '^1.0.0' },
      camstack: {
        runtimeDependencies: ['werift', 'vendor-lib'],
        addons: [
          {
            id: 'dedupe-test',
            name: '@camstack/addon-dedupe-test',
            version: '1.0.0',
            entry: './dist/index.js',
          },
        ],
      },
    }),
  )
  fs.writeFileSync(path.join(distDir, 'index.js'), 'module.exports = {}\n')
  const tgzPath = path.join(tmpRoot, 'addon-dedupe-test.tgz')
  execFileSync('tar', ['-czf', tgzPath, '-C', stage, 'package'])
  return tgzPath
}

describe('AddonInstaller.installFromTgz — closure dedupe', () => {
  let tmpRoot: string
  let addonsDir: string
  let closureNodeModules: string
  let savedFrameworkDir: string | undefined

  beforeEach(() => {
    // The "no closure" test must not pick up a real framework dir from the
    // host environment.
    savedFrameworkDir = process.env['CAMSTACK_FRAMEWORK_DIR']
    delete process.env['CAMSTACK_FRAMEWORK_DIR']
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-closure-dedupe-'))
    addonsDir = path.join(tmpRoot, 'addons')
    closureNodeModules = path.join(tmpRoot, 'closure', 'node_modules')
    fs.mkdirSync(addonsDir, { recursive: true })
    // The closure: werift compatible, zod at an INCOMPATIBLE major.
    writeFakePackage(closureNodeModules, 'werift', '0.22.9')
    writeFakePackage(closureNodeModules, 'zod', '4.5.4')
    npmMock.calls = []
    // The mocked npm install materialises the addon's dep tree the way the
    // real one would: declared deps flat, plus vendor-lib's transitive zod@3.
    npmMock.onInstall = (cwd) => {
      if (!npmMock.calls.at(-1)?.args.includes('install')) return
      const nm = path.join(cwd, 'node_modules')
      writeFakePackage(nm, 'werift', '0.22.9')
      writeFakePackage(nm, 'vendor-lib', '1.2.0', { zod: '^3.22.0', werift: '^0.22.9' })
      writeFakePackage(nm, 'zod', '3.25.76')
    }
  })

  afterEach(() => {
    if (savedFrameworkDir !== undefined) {
      process.env['CAMSTACK_FRAMEWORK_DIR'] = savedFrameworkDir
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('links closure-provided deps, keeps incompatible and closure-absent ones', async () => {
    const installer = new AddonInstaller({
      addonsDir,
      closureNodeModulesDir: closureNodeModules,
    })
    const tgz = makeTgz(tmpRoot)
    const result = await installer.installFromTgz(tgz)
    expect(result.name).toBe('@camstack/addon-dedupe-test')

    const nm = path.join(addonsDir, '@camstack/addon-dedupe-test', 'node_modules')
    // werift: closure-compatible → symlink into the closure.
    const weriftEntry = path.join(nm, 'werift')
    expect(fs.lstatSync(weriftEntry).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(weriftEntry)).toBe(
      fs.realpathSync(path.join(closureNodeModules, 'werift')),
    )
    // zod: closure has 4.x, the tree requires ^3 → own copy KEPT.
    const zodEntry = path.join(nm, 'zod')
    expect(fs.lstatSync(zodEntry).isSymbolicLink()).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(zodEntry, 'package.json'), 'utf-8')).version).toBe(
      '3.25.76',
    )
    // vendor-lib: not in the closure → own copy kept.
    expect(fs.lstatSync(path.join(nm, 'vendor-lib')).isSymbolicLink()).toBe(false)
  })

  it('without a closure (dev), the tree is left exactly as npm wrote it', async () => {
    const installer = new AddonInstaller({ addonsDir })
    const tgz = makeTgz(tmpRoot)
    await installer.installFromTgz(tgz)
    const nm = path.join(addonsDir, '@camstack/addon-dedupe-test', 'node_modules')
    for (const name of ['werift', 'vendor-lib', 'zod']) {
      expect(fs.lstatSync(path.join(nm, name)).isSymbolicLink()).toBe(false)
    }
  })
})
