/**
 * `resolveNpmInvocation` — how the installer obtains a working npm.
 *
 * Live incident (Mac mini, days of silent breakage up to 2026-07-16): the
 * packaged Electron agent ships a BARE node binary — no npm anywhere on the
 * host — so every `execFileAsync('npm', ...)` in the installer died with
 * ENOENT inside a "non-fatal, continuing" catch. Addons with runtime deps
 * (addon-pipeline → sharp) installed WITHOUT node_modules, reported
 * "running", and failed at first import (`Cannot find module 'sharp'`) —
 * the detection group ran with 1/3 members and the node silently dropped
 * out of the balancer pool.
 *
 * The resolver makes npm availability a solved problem:
 *  1. system npm on PATH → use it (`{command:'npm', argsPrefix:[]}`);
 *  2. else a previously-bootstrapped copy in `cacheDir` → run its
 *     `npm-cli.js` with the CURRENT node binary (`process.execPath`);
 *  3. else BOOTSTRAP: fetch the registry metadata for the `npm` package
 *     (self-contained tarball), download + extract it into `cacheDir`, and
 *     use that. Any failure here throws a clear, actionable error — never a
 *     silent fallthrough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveNpmInvocation, __clearNpmInvocationCacheForTests } from '../npm-command.js'
import type { IScopedLogger } from '@camstack/types'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

/** Lay down a fake bootstrapped npm at the path the resolver probes. */
function seedBootstrappedNpm(cacheDir: string): string {
  const cliPath = path.join(cacheDir, 'package', 'bin', 'npm-cli.js')
  fs.mkdirSync(path.dirname(cliPath), { recursive: true })
  fs.writeFileSync(cliPath, '// fake npm cli\n')
  return cliPath
}

describe('resolveNpmInvocation', () => {
  let cacheDir: string

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-cmd-spec-'))
    __clearNpmInvocationCacheForTests()
  })

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  it('uses the system npm when the probe succeeds', async () => {
    const invocation = await resolveNpmInvocation({
      cacheDir,
      logger: makeLogger(),
      probeSystemNpm: async () => true,
      fetchJson: vi.fn(async () => ({})),
      downloadTarball: vi.fn(async () => {}),
      extractTarball: vi.fn(async () => {}),
    })
    expect(invocation).toEqual({ command: 'npm', argsPrefix: [] })
  })

  it('falls back to an already-bootstrapped npm-cli.js run with the current node', async () => {
    const cliPath = seedBootstrappedNpm(cacheDir)
    const download = vi.fn(async () => {})
    const invocation = await resolveNpmInvocation({
      cacheDir,
      logger: makeLogger(),
      probeSystemNpm: async () => false,
      fetchJson: vi.fn(async () => ({})),
      downloadTarball: download,
      extractTarball: vi.fn(async () => {}),
    })
    expect(invocation.command).toBe(process.execPath)
    expect(invocation.argsPrefix).toEqual([cliPath])
    expect(download).not.toHaveBeenCalled() // cached — no re-download
  })

  it('bootstraps npm from the registry when nothing is available', async () => {
    const tarballUrl = 'https://registry.npmjs.org/npm/-/npm-11.0.0.tgz'
    const fetchJson = vi.fn(async () => ({ dist: { tarball: tarballUrl } }))
    const downloadTarball = vi.fn(async () => {})
    // The extract seam materializes the CLI exactly where a real `tar -xzf`
    // of the npm tarball would put it.
    const extractTarball = vi.fn(async (_tgz: string, destDir: string) => {
      const cli = path.join(destDir, 'package', 'bin', 'npm-cli.js')
      fs.mkdirSync(path.dirname(cli), { recursive: true })
      fs.writeFileSync(cli, '// bootstrapped\n')
    })

    const invocation = await resolveNpmInvocation({
      cacheDir,
      logger: makeLogger(),
      probeSystemNpm: async () => false,
      fetchJson,
      downloadTarball,
      extractTarball,
    })

    expect(fetchJson).toHaveBeenCalledWith('https://registry.npmjs.org/npm/latest')
    expect(downloadTarball).toHaveBeenCalledWith(tarballUrl, expect.stringContaining(cacheDir))
    expect(invocation.command).toBe(process.execPath)
    expect(invocation.argsPrefix).toEqual([path.join(cacheDir, 'package', 'bin', 'npm-cli.js')])
  })

  it('honours a custom registry for the bootstrap metadata fetch', async () => {
    const fetchJson = vi.fn(async () => ({
      dist: { tarball: 'https://mirror.example/npm/-/npm-11.0.0.tgz' },
    }))
    await resolveNpmInvocation({
      cacheDir,
      registry: 'https://mirror.example/',
      logger: makeLogger(),
      probeSystemNpm: async () => false,
      fetchJson,
      downloadTarball: vi.fn(async () => {}),
      extractTarball: vi.fn(async (_t: string, destDir: string) => {
        seedBootstrappedNpm(destDir)
      }),
    })
    expect(fetchJson).toHaveBeenCalledWith('https://mirror.example/npm/latest')
  })

  it('throws a clear, actionable error when the bootstrap fails — never silent', async () => {
    await expect(
      resolveNpmInvocation({
        cacheDir,
        logger: makeLogger(),
        probeSystemNpm: async () => false,
        fetchJson: vi.fn(async () => {
          throw new Error('registry unreachable')
        }),
        downloadTarball: vi.fn(async () => {}),
        extractTarball: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/no system npm.*bootstrap failed/i)
  })

  it('memoizes the resolution — the probe runs once per process', async () => {
    const probe = vi.fn(async () => true)
    const opts = {
      cacheDir,
      logger: makeLogger(),
      probeSystemNpm: probe,
      fetchJson: vi.fn(async () => ({})),
      downloadTarball: vi.fn(async () => {}),
      extractTarball: vi.fn(async () => {}),
    }
    await resolveNpmInvocation(opts)
    await resolveNpmInvocation(opts)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
