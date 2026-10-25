/**
 * AddonInstaller.applyUpdateFromStaged — NATIVE dependency install.
 *
 * Sibling of `addon-installer-staged-runtime-deps.spec.ts`, and the same class
 * of bug one layer down. `installFromTgz` (the `camstack deploy` / upload path)
 * completes a staged tree with THREE steps before it swaps: strip + `npm
 * install` the declared runtime deps, `installManifestNativeDeps` for
 * `camstack.nativeDependencies`, and the post-install
 * `ensureAddonNativePrebuilds` pass that refuses to ship a traditional native
 * without its compiled `.node`.
 *
 * The OTA staged-swap path was given only the FIRST of the three (2026-08-12,
 * task #15 — which named this gap as out of scope). So an addon declaring
 * native deps was still broken by its first OTA update: the dist landed with no
 * ABI-matched `.node`, and every load died at `require` of the binding with
 * "Could not locate the bindings file" — indistinguishable, from the outside,
 * from a bad bundle.
 *
 * Semantics mirrored from `installFromTgz`, exactly as the runtime-dep fix
 * mirrored them: the tree is built COMPLETE first and swapped in only then, so
 * a failed native install (or a residual source-only native) aborts the update
 * with the previous version still live.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddonInstaller } from '../addon-installer.js'

interface NpmCall {
  readonly args: readonly string[]
  readonly cwd: string | undefined
}

interface NpmMockState {
  calls: NpmCall[]
  /** Runs inside the mocked npm invocation, with npm's cwd. Throw to fail it. */
  onRun: (args: readonly string[], cwd: string) => void
}

const npmMock = vi.hoisted<NpmMockState>(() => ({ calls: [], onRun: () => {} }))

vi.mock('../deps/npm-command.js', () => ({
  runNpm: async (
    args: readonly string[],
    options: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> => {
    npmMock.calls.push({ args: [...args], cwd: options.cwd })
    npmMock.onRun(args, options.cwd ?? '')
    return { stdout: '', stderr: '' }
  },
}))

interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: LogExtras | undefined
}

function makeCapturingLogger(sink: CapturedLog[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (message, extras) => void sink.push({ level: 'debug', message, extras }),
    info: (message, extras) => void sink.push({ level: 'info', message, extras }),
    warn: (message, extras) => void sink.push({ level: 'warn', message, extras }),
    error: (message, extras) => void sink.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const PKG = '@camstack/addon-export-hap'
/** Not resolvable anywhere on the host — never satisfied from a hoisted copy. */
const NATIVE = 'camstack-fake-native'
const NATIVE_RANGE = '^1.2.3'

interface StagedFixture {
  /** `camstack.nativeDependencies` — name → semver range. */
  readonly nativeDependencies?: Record<string, string>
  /** `dependencies` as authored (only survives the strip via runtimeDependencies). */
  readonly dependencies?: Record<string, string>
  readonly runtimeDependencies?: readonly string[]
}

/** A native npm call is the `--no-save` install `installManifestNativeDeps` makes. */
function nativeInstallCalls(): NpmCall[] {
  return npmMock.calls.filter((c) => c.args.includes('install') && c.args.includes('--no-save'))
}

describe('AddonInstaller.applyUpdateFromStaged — native dependencies', () => {
  let tmpRoot: string
  let addonsDir: string
  let stagingDir: string
  let logs: CapturedLog[]
  let installer: AddonInstaller

  /** Staged v1.0.1 tree as the lifecycle StagingArea leaves it: raw tarball. */
  function writeStaged(fixture: StagedFixture): string {
    const staged = path.join(stagingDir, 'job-1', 'addon-export-hap')
    fs.mkdirSync(path.join(staged, 'dist'), { recursive: true })
    fs.writeFileSync(
      path.join(staged, 'package.json'),
      JSON.stringify({
        name: PKG,
        version: '1.0.1',
        ...(fixture.dependencies ? { dependencies: fixture.dependencies } : {}),
        camstack: {
          ...(fixture.nativeDependencies
            ? { nativeDependencies: { ...fixture.nativeDependencies } }
            : {}),
          ...(fixture.runtimeDependencies
            ? { runtimeDependencies: [...fixture.runtimeDependencies] }
            : {}),
          addons: [{ id: 'export-hap', entry: './dist/index.js' }],
        },
      }),
    )
    fs.writeFileSync(path.join(staged, 'dist', 'index.js'), '// v1.0.1\n')
    return staged
  }

  /** Plant `<dir>/node_modules/<pkg>`, optionally carrying a compiled `.node`. */
  function plantModule(dir: string, pkg: string, options: { readonly withBinary: boolean }): void {
    const moduleDir = path.join(dir, 'node_modules', pkg)
    fs.mkdirSync(moduleDir, { recursive: true })
    fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: pkg }))
    if (options.withBinary) {
      const release = path.join(moduleDir, 'build', 'Release')
      fs.mkdirSync(release, { recursive: true })
      fs.writeFileSync(path.join(release, `${pkg}.node`), 'ELF')
    }
  }

  function liveVersion(): string {
    return fs.readFileSync(path.join(addonsDir, PKG, 'dist', 'index.js'), 'utf-8')
  }

  beforeEach(() => {
    npmMock.calls = []
    npmMock.onRun = () => {}
    logs = []
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-staged-native-'))
    addonsDir = path.join(tmpRoot, 'addons')
    stagingDir = path.join(tmpRoot, 'staging')
    fs.mkdirSync(addonsDir, { recursive: true })
    fs.mkdirSync(stagingDir, { recursive: true })

    const curDir = path.join(addonsDir, PKG)
    fs.mkdirSync(path.join(curDir, 'dist'), { recursive: true })
    fs.writeFileSync(
      path.join(curDir, 'package.json'),
      JSON.stringify({ name: PKG, version: '1.0.0' }),
    )
    fs.writeFileSync(path.join(curDir, 'dist', 'index.js'), '// v1.0.0\n')

    installer = new AddonInstaller({ addonsDir }, makeCapturingLogger(logs))
    installer.manifest.upsert(PKG, { version: '1.0.0', source: 'npm' })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('installs the declared nativeDependencies into the staged tree', async () => {
    const staged = writeStaged({ nativeDependencies: { [NATIVE]: NATIVE_RANGE } })

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    const installs = nativeInstallCalls()
    expect(installs).toHaveLength(1)
    expect(installs[0]?.args).toContain(`${NATIVE}@${NATIVE_RANGE}`)
    expect(installs[0]?.cwd).toBe(staged)
  })

  it('rebuilds the native against the host ABI', async () => {
    const staged = writeStaged({ nativeDependencies: { [NATIVE]: NATIVE_RANGE } })

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    const rebuilds = npmMock.calls.filter((c) => c.args[0] === 'rebuild')
    expect(rebuilds).toHaveLength(1)
    expect(rebuilds[0]?.args).toContain(NATIVE)
    expect(rebuilds[0]?.cwd).toBe(staged)
  })

  it('lands the installed native module in the LIVE addon dir', async () => {
    const staged = writeStaged({ nativeDependencies: { [NATIVE]: NATIVE_RANGE } })
    // Stand in for npm: materialise the native wherever npm was told to run.
    npmMock.onRun = (args, cwd) => {
      if (args.includes('--no-save')) plantModule(cwd, NATIVE, { withBinary: true })
    }

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    expect(
      fs.existsSync(
        path.join(addonsDir, PKG, 'node_modules', NATIVE, 'build', 'Release', `${NATIVE}.node`),
      ),
    ).toBe(true)
  })

  it('runs the native install BEFORE the swap, so the live dir is complete the moment it appears', async () => {
    const staged = writeStaged({ nativeDependencies: { [NATIVE]: NATIVE_RANGE } })
    let liveDuringInstall: string | null = null
    npmMock.onRun = (args) => {
      if (args.includes('--no-save')) liveDuringInstall = liveVersion()
    }

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    expect(liveDuringInstall).toContain('v1.0.0')
    expect(liveVersion()).toContain('v1.0.1')
  })

  it('skips the native install entirely when the manifest declares none', async () => {
    const staged = writeStaged({})

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    expect(nativeInstallCalls()).toHaveLength(0)
    expect(liveVersion()).toContain('v1.0.1')
  })

  it('aborts the update and leaves the previous version live when the native install fails', async () => {
    const staged = writeStaged({ nativeDependencies: { [NATIVE]: NATIVE_RANGE } })
    npmMock.onRun = (args) => {
      if (args.includes('--no-save')) throw new Error('ENOTFOUND registry.npmjs.org')
    }

    await expect(installer.applyUpdateFromStaged(PKG, '1.0.1', staged)).rejects.toThrow(
      /native deps install failed/,
    )

    expect(liveVersion()).toContain('v1.0.0')
    const entry = installer.manifest.get(PKG)
    expect(entry?.version).toBe('1.0.0')
    expect(entry?.lastBackupDir).toBeUndefined()
  })

  it('logs loudly, naming the addon and WHY, when the native install fails', async () => {
    const staged = writeStaged({ nativeDependencies: { [NATIVE]: NATIVE_RANGE } })
    npmMock.onRun = (args) => {
      if (args.includes('--no-save')) throw new Error('ENOTFOUND registry.npmjs.org')
    }

    await expect(installer.applyUpdateFromStaged(PKG, '1.0.1', staged)).rejects.toThrow()

    const errors = logs.filter((l) => l.level === 'error')
    expect(errors.some((l) => l.message.includes(PKG))).toBe(true)
    expect(errors.some((l) => JSON.stringify(l).includes('ENOTFOUND registry.npmjs.org'))).toBe(
      true,
    )
  })

  it('refuses to swap in a tree whose traditional native is still source-only', async () => {
    const staged = writeStaged({})
    // The published tarball carried better-sqlite3 WITHOUT its compiled binary —
    // the toolchain-less-host shape. No prebuild-install lives in this tree, so
    // the fetch fallback fails and the ensure pass must abort the update.
    plantModule(staged, 'better-sqlite3', { withBinary: false })

    await expect(installer.applyUpdateFromStaged(PKG, '1.0.1', staged)).rejects.toThrow(
      /missing a compiled \.node/,
    )

    expect(liveVersion()).toContain('v1.0.0')
    expect(installer.manifest.get(PKG)?.version).toBe('1.0.0')
  })

  it('swaps a tree whose traditional native carries its compiled .node', async () => {
    const staged = writeStaged({})
    plantModule(staged, 'better-sqlite3', { withBinary: true })

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    expect(liveVersion()).toContain('v1.0.1')
    expect(
      fs.existsSync(
        path.join(addonsDir, PKG, 'node_modules', 'better-sqlite3', 'build', 'Release'),
      ),
    ).toBe(true)
  })
})
