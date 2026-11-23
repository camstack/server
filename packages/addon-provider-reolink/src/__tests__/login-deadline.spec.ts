import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoginDeadlineError, loginWithin } from '../login-deadline.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('loginWithin', () => {
  it('rejects and closes the pending client when the camera never answers', async () => {
    vi.useFakeTimers()
    const onExpire = vi.fn()
    const outcome = loginWithin(() => new Promise<void>(() => {}), 1_000, onExpire).catch(
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await outcome).toBeInstanceOf(LoginDeadlineError)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('a login that finishes in time is untouched', async () => {
    vi.useFakeTimers()
    const onExpire = vi.fn()
    await loginWithin(async () => undefined, 1_000, onExpire)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('a login that fails in time keeps its own error', async () => {
    await expect(
      loginWithin(() => Promise.reject(new Error('bad credentials')), 1_000, vi.fn()),
    ).rejects.toThrow('bad credentials')
  })
})

describe('ensureApi bounds its login', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

  it('logs in through loginWithin and warns when it expires', () => {
    const start = source.indexOf('async ensureApi(')
    const body = source.slice(start, start + 12_000)
    expect(body).toMatch(/loginWithin\(\s*\(\) => api\.login\(\)/)
    expect(body).not.toMatch(/await api\.login\(\)/)
    expect(body).toMatch(/instanceof LoginDeadlineError/)
  })
})
