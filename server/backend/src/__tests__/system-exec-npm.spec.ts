/**
 * buildSystemExecNpm — the `execNpm` adapter injected into the shared
 * `RootUpdateService` at both construction sites (hub + agent). It resolves a
 * working npm through `@dominevo/server/system` (system → bootstrapped →
 * bootstrap), so a packaged desktop with no npm on PATH can still stage.
 *
 * It must ALSO run that npm under the install watcher. On 2026-11-15 the prod
 * hub's `npm install @dominevo/server@1.2.881` sat 28 minutes in node-av's
 * ffmpeg postinstall: this adapter ran npm through `execFile` with the 3 h
 * ceiling as its only timeout, so the 5-minute stall cut in
 * `npm-install-watch` never ran on a hub or an agent, and a cut would have
 * left the postinstall grandchild alive.
 */
import type { IScopedLogger } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import type { NpmInvocation } from '@dominevo/server/system'
import { NPM_INSTALL_STALL_MS, type RunWatchedCommandOptions } from '../server-root/index.js'
import { buildSystemExecNpm } from '../core/server-update/system-exec-npm.js'

function fakeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const SYSTEM_NPM: NpmInvocation = { command: 'npm', argsPrefix: [] }

function harness(invocation: NpmInvocation): {
  readonly calls: RunWatchedCommandOptions[]
  readonly execNpm: ReturnType<typeof buildSystemExecNpm>
} {
  const calls: RunWatchedCommandOptions[] = []
  const execNpm = buildSystemExecNpm(
    { cacheDir: '/tmp/cache', logger: fakeLogger(), registry: 'https://npm.example' },
    {
      resolveInvocation: vi.fn(async () => invocation),
      runWatched: async (options) => {
        calls.push(options)
        return { stdout: 'ok' }
      },
      progressDirs: async () => ['/tmp/npm-cache'],
    },
  )
  return { calls, execNpm }
}

describe('buildSystemExecNpm', () => {
  it('runs an install into a staging directory under the stall watcher', async () => {
    const { calls, execNpm } = harness(SYSTEM_NPM)
    const out = await execNpm(['install', '@dominevo/server@1.2.0'], {
      cwd: '/tmp/staging',
      timeoutMs: 5000,
    })
    expect(out.stdout).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      command: 'npm',
      args: ['install', '@dominevo/server@1.2.0'],
      cwd: '/tmp/staging',
      watchProgress: true,
      stallMs: NPM_INSTALL_STALL_MS,
      ceilingMs: 5000,
      progressDirs: ['/tmp/npm-cache'],
    })
  })

  it('prefixes a bootstrapped npm and puts the running node first on PATH', async () => {
    const { calls, execNpm } = harness({
      command: process.execPath,
      argsPrefix: ['/tmp/cache/npm/bin/npm-cli.js'],
    })
    await execNpm(['install', 'x@1.0.0'], { cwd: '/tmp/staging', timeoutMs: 1000 })
    expect(calls[0]?.command).toBe(process.execPath)
    expect(calls[0]?.args).toEqual(['/tmp/cache/npm/bin/npm-cli.js', 'install', 'x@1.0.0'])
    const pathVar = calls[0]?.env?.['PATH'] ?? ''
    expect(pathVar.startsWith(process.execPath.slice(0, process.execPath.lastIndexOf('/')))).toBe(
      true,
    )
  })

  it('does not walk progress for npm view without a directory', async () => {
    const { calls, execNpm } = harness(SYSTEM_NPM)
    await execNpm(['view', '@dominevo/server@latest', 'version'], { timeoutMs: 20000 })
    expect(calls[0]).toMatchObject({ watchProgress: false, ceilingMs: 20000 })
    expect(calls[0]?.progressDirs).toBeUndefined()
  })
})
