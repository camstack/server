import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { scheduleSelfRestart } from '../restart-coordinator.js'

/**
 * Dev touch-reload branch of `scheduleSelfRestart`.
 *
 * Under `tsx watch`, a clean `process.exit(0)` is NOT respawned — the
 * watcher only restarts on a file change, so the hub stays down until an
 * unrelated source edit. The `serve` (watch) npm script sets
 * `CAMSTACK_RESTART_TOUCH_FILE` to the watched entry; when present, the
 * coordinator touches that file (clean tsx reload that re-reads freshly
 * installed dist) instead of exiting. `serve:once` and production leave it
 * unset and fall through to the real exit path.
 */
describe('scheduleSelfRestart — dev touch-reload', () => {
  const ENV_KEY = 'CAMSTACK_RESTART_TOUCH_FILE'
  const originalEnv = process.env[ENV_KEY]
  let tmpDir: string
  let touchFile: string
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-touch-'))
    touchFile = path.join(tmpDir, 'launcher.ts')
    fs.writeFileSync(touchFile, '// dev entry\n')
    // process.exit is mocked to a noop so the "exit" path doesn't kill the
    // test runner. Cast is test-only (process.exit's signature returns never).
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((): never => undefined as never) as unknown as ReturnType<typeof vi.spyOn>
  })

  afterEach(() => {
    exitSpy.mockRestore()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = originalEnv
  })

  it('touches the watched entry file and does NOT exit when the env var is set', async () => {
    process.env[ENV_KEY] = touchFile
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(touchFile, past, past)
    const before = fs.statSync(touchFile).mtimeMs

    scheduleSelfRestart({ delayMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(fs.statSync(touchFile).mtimeMs).toBeGreaterThan(before)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('calls process.exit(0) when the env var is unset (production / serve:once)', async () => {
    delete process.env[ENV_KEY]
    scheduleSelfRestart({ delayMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('falls through to process.exit when the touch target is missing', async () => {
    process.env[ENV_KEY] = path.join(tmpDir, 'does-not-exist.ts')
    scheduleSelfRestart({ delayMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
