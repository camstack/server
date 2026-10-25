/**
 * AddonInstaller.ensureAddonRuntimeDeps — the boot-time restore repair.
 *
 * A system backup archives no node_modules (D338), so a restored addon has
 * only dist + package.json. Before this pass existed, only BOOTSTRAP addons
 * were reinstalled at boot; every other restored addon was silently broken
 * until an operator redeployed it.
 *
 * The contract under test, in the operator's words — "a restore reinstalls
 * dependencies, but only when necessary":
 *  - a dep the server closure provides compatibly is LINKED, not installed;
 *  - a dep the closure lacks (or serves at an incompatible version) is
 *    npm-installed;
 *  - an addon whose deps are all satisfied is NOT touched at all;
 *  - a closure link that stopped holding (dangling / incompatible after a
 *    closure update) is dropped and repaired.
 */
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

/** An installed addon dir, as a restore leaves it (dist + package.json). */
function writeInstalledAddon(
  addonsDir: string,
  name: string,
  dependencies: Record<string, string>,
): string {
  const dir = path.join(addonsDir, name)
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      main: 'dist/index.js',
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      camstack: {
        addons: [
          {
            id: name.replace('@camstack/', ''),
            name,
            version: '1.0.0',
            entry: './dist/index.js',
          },
        ],
      },
    }),
  )
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'module.exports = {}\n')
  return dir
}

describe('AddonInstaller.ensureAddonRuntimeDeps', () => {
  let tmpRoot: string
  let addonsDir: string
  let closureNodeModules: string
  let installer: AddonInstaller
  let savedFrameworkDir: string | undefined

  beforeEach(() => {
    savedFrameworkDir = process.env['CAMSTACK_FRAMEWORK_DIR']
    delete process.env['CAMSTACK_FRAMEWORK_DIR']
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-ensure-deps-'))
    addonsDir = path.join(tmpRoot, 'addons')
    closureNodeModules = path.join(tmpRoot, 'closure', 'node_modules')
    fs.mkdirSync(addonsDir, { recursive: true })
    writeFakePackage(closureNodeModules, 'werift', '0.22.9')
    npmMock.calls = []
    npmMock.onInstall = () => {}
    installer = new AddonInstaller({ addonsDir, closureNodeModulesDir: closureNodeModules })
  })

  afterEach(() => {
    if (savedFrameworkDir !== undefined) {
      process.env['CAMSTACK_FRAMEWORK_DIR'] = savedFrameworkDir
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('links a restored addon dep from the closure — no npm', async () => {
    writeInstalledAddon(addonsDir, '@camstack/addon-cam', { werift: '^0.22.9' })

    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.linked).toEqual(['@camstack/addon-cam:werift'])
    expect(result.reinstalled).toEqual([])
    expect(result.failed).toEqual([])
    expect(npmMock.calls).toEqual([])
    const entry = path.join(addonsDir, '@camstack/addon-cam', 'node_modules', 'werift')
    expect(fs.lstatSync(entry).isSymbolicLink()).toBe(true)
  })

  it('npm-installs a dep the closure does not provide', async () => {
    writeInstalledAddon(addonsDir, '@camstack/addon-mqtt', { aedes: '^0.51.3' })
    npmMock.onInstall = (cwd) => {
      writeFakePackage(path.join(cwd, 'node_modules'), 'aedes', '0.51.3')
    }

    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.reinstalled).toEqual(['@camstack/addon-mqtt'])
    expect(result.failed).toEqual([])
    expect(npmMock.calls).toHaveLength(1)
    expect(npmMock.calls[0]!.cwd).toBe(path.join(addonsDir, '@camstack/addon-mqtt'))
    expect(npmMock.calls[0]!.args).toContain('install')
    expect(
      fs.existsSync(
        path.join(addonsDir, '@camstack/addon-mqtt', 'node_modules', 'aedes', 'package.json'),
      ),
    ).toBe(true)
  })

  it('refuses to link when the closure version is incompatible — npm instead', async () => {
    writeFakePackage(closureNodeModules, 'zod', '4.5.4')
    writeInstalledAddon(addonsDir, '@camstack/addon-legacy', { zod: '^3.22.0' })
    npmMock.onInstall = (cwd) => {
      writeFakePackage(path.join(cwd, 'node_modules'), 'zod', '3.25.76')
    }

    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.linked).toEqual([])
    expect(result.reinstalled).toEqual(['@camstack/addon-legacy'])
    const entry = path.join(addonsDir, '@camstack/addon-legacy', 'node_modules', 'zod')
    expect(fs.lstatSync(entry).isSymbolicLink()).toBe(false)
  })

  it('does NOT touch an addon whose deps are already satisfied', async () => {
    const dir = writeInstalledAddon(addonsDir, '@camstack/addon-ok', { aedes: '^0.51.3' })
    writeFakePackage(path.join(dir, 'node_modules'), 'aedes', '0.51.3')

    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.linked).toEqual([])
    expect(result.reinstalled).toEqual([])
    expect(result.failed).toEqual([])
    expect(npmMock.calls).toEqual([])
    expect(fs.lstatSync(path.join(dir, 'node_modules', 'aedes')).isSymbolicLink()).toBe(false)
  })

  it('an addon with no runtime deps is a no-op', async () => {
    writeInstalledAddon(addonsDir, '@camstack/addon-selfcontained', {})

    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.checked).toBe(1)
    expect(result.linked).toEqual([])
    expect(result.reinstalled).toEqual([])
    expect(npmMock.calls).toEqual([])
  })

  it('repairs a dangling closure link', async () => {
    const dir = writeInstalledAddon(addonsDir, '@camstack/addon-stale', { werift: '^0.22.9' })
    const nm = path.join(dir, 'node_modules')
    fs.mkdirSync(nm, { recursive: true })
    // Link into the closure at a name that no longer exists there.
    fs.symlinkSync(path.join(closureNodeModules, 'gone-lib'), path.join(nm, 'gone-lib'))

    npmMock.onInstall = (cwd) => {
      writeFakePackage(path.join(cwd, 'node_modules'), 'werift', '0.22.9')
    }
    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.reinstalled).toEqual(['@camstack/addon-stale'])
    expect(fs.existsSync(path.join(nm, 'gone-lib'))).toBe(false)
  })

  it('drops a closure link the tree ranges no longer accept (closure moved a major)', async () => {
    const dir = writeInstalledAddon(addonsDir, '@camstack/addon-pinned', { werift: '^0.22.9' })
    const nm = path.join(dir, 'node_modules')
    fs.mkdirSync(nm, { recursive: true })
    fs.symlinkSync(path.join(closureNodeModules, 'werift'), path.join(nm, 'werift'))
    // The closure updates werift past what this addon accepts.
    fs.rmSync(path.join(closureNodeModules, 'werift'), { recursive: true, force: true })
    writeFakePackage(closureNodeModules, 'werift', '1.0.0')

    npmMock.onInstall = (cwd) => {
      writeFakePackage(path.join(cwd, 'node_modules'), 'werift', '0.22.9')
    }
    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.reinstalled).toEqual(['@camstack/addon-pinned'])
    // The repaired tree carries its own compatible copy, not the closure's 1.0.0.
    expect(fs.lstatSync(path.join(nm, 'werift')).isSymbolicLink()).toBe(false)
    expect(
      JSON.parse(fs.readFileSync(path.join(nm, 'werift', 'package.json'), 'utf-8')).version,
    ).toBe('0.22.9')
  })

  it('a workspace-symlinked addon dir is skipped entirely', async () => {
    const real = writeInstalledAddon(addonsDir, '@camstack/addon-real', { werift: '^0.22.9' })
    const workspaceCopy = path.join(tmpRoot, 'workspace-addon')
    fs.cpSync(real, workspaceCopy, { recursive: true })
    fs.rmSync(real, { recursive: true, force: true })
    fs.symlinkSync(workspaceCopy, real)

    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.linked).toEqual([])
    expect(result.reinstalled).toEqual([])
    expect(npmMock.calls).toEqual([])
    expect(fs.existsSync(path.join(workspaceCopy, 'node_modules'))).toBe(false)
  })

  it('a failed npm install is loud but does not abort the sweep', async () => {
    writeInstalledAddon(addonsDir, '@camstack/addon-broken', { 'gone-from-npm': '^1.0.0' })
    writeInstalledAddon(addonsDir, '@camstack/addon-fine', { werift: '^0.22.9' })
    npmMock.onInstall = (cwd) => {
      if (cwd.includes('addon-broken')) throw new Error('npm exploded')
    }

    const result = await installer.ensureAddonRuntimeDeps()

    expect(result.failed).toEqual(['@camstack/addon-broken'])
    expect(result.linked).toEqual(['@camstack/addon-fine:werift'])
  })
})
