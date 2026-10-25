/**
 * AddonInstaller.applyUpdateFromStaged — runtime-dependency install.
 *
 * `installFromTgz` (the `camstack deploy` / upload path) installs an addon's
 * declared `camstack.runtimeDependencies` into the tree before swapping it in.
 * The OTA staged-swap path did NOT: it moved the staged dir into place and
 * stopped, so ANY addon declaring runtime deps was broken by its first OTA
 * update — the dist landed with no `node_modules`, every load threw
 * `Cannot find module`, and the retry loop replayed it forever
 * (`@camstack/addon-export-hap`, 126 failed load retries over 10.5h on
 * 2026-08-12; `@camstack/addon-remote-storage` with `@aws-sdk/*` + `webdav` is
 * the same landmine).
 *
 * Semantics mirrored from `installFromTgz`: the tree is built COMPLETE first
 * and swapped in only then, so a failed dependency install aborts the update
 * with the previous version still live — it never leaves a dependency-less
 * install running.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import { asJsonObject, parseJsonUnknown } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddonInstaller } from '../addon-installer.js'

interface NpmCall {
  readonly args: readonly string[]
  readonly cwd: string | undefined
}

interface NpmMockState {
  calls: NpmCall[]
  /** Runs inside the mocked `npm install`, with npm's cwd. Throw to fail it. */
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

const PKG = '@camstack/addon-remote-storage'

interface StagedFixture {
  /** `dependencies` as authored in the published package.json. */
  readonly dependencies?: Record<string, string>
  /** `camstack.runtimeDependencies` — the ONLY deps that survive the strip. */
  readonly runtimeDependencies?: readonly string[]
}

describe('AddonInstaller.applyUpdateFromStaged — runtime dependencies', () => {
  let tmpRoot: string
  let addonsDir: string
  let stagingDir: string
  let logs: CapturedLog[]
  let installer: AddonInstaller

  /** Staged v1.0.1 tree as the lifecycle StagingArea leaves it: raw tarball. */
  function writeStaged(fixture: StagedFixture): string {
    const staged = path.join(stagingDir, 'job-1', 'addon-remote-storage')
    fs.mkdirSync(path.join(staged, 'dist'), { recursive: true })
    fs.writeFileSync(
      path.join(staged, 'package.json'),
      JSON.stringify({
        name: PKG,
        version: '1.0.1',
        ...(fixture.dependencies ? { dependencies: fixture.dependencies } : {}),
        camstack: {
          ...(fixture.runtimeDependencies
            ? { runtimeDependencies: [...fixture.runtimeDependencies] }
            : {}),
          addons: [{ id: 'remote-storage', entry: './dist/index.js' }],
        },
      }),
    )
    fs.writeFileSync(path.join(staged, 'dist', 'index.js'), '// v1.0.1\n')
    return staged
  }

  function readInstalledManifest(): Record<string, unknown> {
    const raw = fs.readFileSync(path.join(addonsDir, PKG, 'package.json'), 'utf-8')
    const parsed = asJsonObject(parseJsonUnknown(raw))
    if (parsed == null) throw new Error('installed package.json is not an object')
    return parsed
  }

  beforeEach(() => {
    npmMock.calls = []
    npmMock.onInstall = () => {}
    logs = []
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-staged-deps-'))
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

  it('installs the declared runtimeDependencies', async () => {
    const staged = writeStaged({
      dependencies: { webdav: '^5.7.1', '@camstack/types': '^0.1.0' },
      runtimeDependencies: ['webdav'],
    })

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    expect(npmMock.calls).toHaveLength(1)
    expect(npmMock.calls[0]?.args).toContain('install')
    expect(npmMock.calls[0]?.args).toContain('--omit=dev')
  })

  it('lands the installed node_modules in the LIVE addon dir', async () => {
    const staged = writeStaged({
      dependencies: { webdav: '^5.7.1' },
      runtimeDependencies: ['webdav'],
    })
    // Stand in for npm: materialise the dep tree wherever npm was told to run.
    npmMock.onInstall = (cwd) => {
      fs.mkdirSync(path.join(cwd, 'node_modules', 'webdav'), { recursive: true })
      fs.writeFileSync(path.join(cwd, 'node_modules', 'webdav', 'index.js'), '// dep\n')
    }

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    expect(fs.existsSync(path.join(addonsDir, PKG, 'node_modules', 'webdav', 'index.js'))).toBe(
      true,
    )
  })

  it('runs the install BEFORE the swap, so the live dir is complete the moment it appears', async () => {
    const staged = writeStaged({
      dependencies: { webdav: '^5.7.1' },
      runtimeDependencies: ['webdav'],
    })
    let liveVersionDuringInstall: string | null = null
    npmMock.onInstall = () => {
      const raw = fs.readFileSync(path.join(addonsDir, PKG, 'package.json'), 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      liveVersionDuringInstall =
        parsed !== null && typeof parsed === 'object' && 'version' in parsed
          ? String(parsed.version)
          : null
    }

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    // The previous version was still installed and serving while npm ran.
    expect(liveVersionDuringInstall).toBe('1.0.0')
    expect(npmMock.calls[0]?.cwd).toBe(staged)
  })

  it('strips host-provided @camstack/* deps from the swapped-in manifest', async () => {
    const staged = writeStaged({
      dependencies: { webdav: '^5.7.1', '@camstack/types': '^0.1.0' },
      runtimeDependencies: ['webdav'],
    })

    await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    const deps = readInstalledManifest()['dependencies']
    expect(deps).toEqual({ webdav: '^5.7.1' })
  })

  it('skips npm entirely when nothing survives the strip', async () => {
    const staged = writeStaged({ dependencies: { '@camstack/types': '^0.1.0' } })

    const res = await installer.applyUpdateFromStaged(PKG, '1.0.1', staged)

    expect(npmMock.calls).toHaveLength(0)
    expect(res.version).toBe('1.0.1')
    expect(fs.readFileSync(path.join(addonsDir, PKG, 'dist', 'index.js'), 'utf-8')).toContain(
      'v1.0.1',
    )
  })

  it('aborts the update and leaves the previous version live when the install fails', async () => {
    const staged = writeStaged({
      dependencies: { webdav: '^5.7.1' },
      runtimeDependencies: ['webdav'],
    })
    npmMock.onInstall = () => {
      throw new Error('ENOTFOUND registry.npmjs.org')
    }

    await expect(installer.applyUpdateFromStaged(PKG, '1.0.1', staged)).rejects.toThrow(
      /runtime dependency install failed/,
    )

    // Previous install untouched, still tracked, nothing half-swapped.
    expect(fs.readFileSync(path.join(addonsDir, PKG, 'dist', 'index.js'), 'utf-8')).toContain(
      'v1.0.0',
    )
    const entry = installer.manifest.get(PKG)
    expect(entry?.version).toBe('1.0.0')
    expect(entry?.lastBackupDir).toBeUndefined()
  })

  it('logs loudly, naming the addon and WHY, when the install fails', async () => {
    const staged = writeStaged({
      dependencies: { webdav: '^5.7.1' },
      runtimeDependencies: ['webdav'],
    })
    npmMock.onInstall = () => {
      throw new Error('ENOTFOUND registry.npmjs.org')
    }

    await expect(installer.applyUpdateFromStaged(PKG, '1.0.1', staged)).rejects.toThrow()

    const errors = logs.filter((l) => l.level === 'error')
    expect(errors.some((l) => l.message.includes(PKG))).toBe(true)
    expect(errors.some((l) => JSON.stringify(l).includes('ENOTFOUND registry.npmjs.org'))).toBe(
      true,
    )
  })
})
