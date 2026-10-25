/**
 * buildSystemExecNpm — the runNpm-backed `execNpm` adapter injected into the
 * shared `RootUpdateService` at both construction sites (hub + agent). It lets
 * root-package updates stage a closure on a host that has NO system `npm` on
 * PATH (a packaged desktop app shipping a bare bundled Node) by routing every
 * npm invocation through `@camstack/system`'s `runNpm` (system → bootstrapped
 * → bootstrap), instead of the raw `execFile('npm', ...)` default that dies
 * with ENOENT there.
 *
 * The suite injects a fake `runNpm` via the module-level DI parameter so it
 * asserts the arg/cwd/timeout mapping without touching the network or disk.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildSystemExecNpm } from '../core/server-update/system-exec-npm.js'

/** The npm runner `buildSystemExecNpm` takes in place of the real one. */
type RunNpmFn = NonNullable<Parameters<typeof buildSystemExecNpm>[1]>

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

describe('buildSystemExecNpm', () => {
  it('routes args/cwd/timeout through runNpm', async () => {
    const fakeRunNpm = vi.fn(async () => ({ stdout: 'ok', stderr: '' }))
    const execNpm = buildSystemExecNpm({ cacheDir: '/tmp/cache', logger: fakeLogger() }, fakeRunNpm)
    const out = await execNpm(['install', '@camstack/server@1.2.0'], {
      cwd: '/tmp/x',
      timeoutMs: 5000,
    })
    expect(out.stdout).toBe('ok')
    expect(fakeRunNpm).toHaveBeenCalledWith(
      ['install', '@camstack/server@1.2.0'],
      expect.objectContaining({ cacheDir: '/tmp/cache', cwd: '/tmp/x', timeout: 5000 }),
    )
  })

  it('forwards the optional registry and omits cwd when the caller gives none', async () => {
    const fakeRunNpm = vi.fn<RunNpmFn>(async () => ({ stdout: '1.2.0\n', stderr: '' }))
    const execNpm = buildSystemExecNpm(
      { cacheDir: '/tmp/cache', logger: fakeLogger(), registry: 'https://npm.example' },
      fakeRunNpm,
    )
    const out = await execNpm(['view', '@camstack/server@latest', 'version'], { timeoutMs: 20000 })
    expect(out.stdout).toBe('1.2.0\n')
    const opts = fakeRunNpm.mock.calls[0]?.[1]
    expect(opts).toMatchObject({
      cacheDir: '/tmp/cache',
      registry: 'https://npm.example',
      timeout: 20000,
    })
    expect(opts).not.toHaveProperty('cwd')
  })
})
