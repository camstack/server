import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeStagingWatch, type NativeUpdaterPort } from '../native-staging-watch'

interface FakeNative extends NativeUpdaterPort {
  emit(event: string, ...args: unknown[]): void
  checks(): number
}

function fakeNative(): FakeNative {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  let checks = 0
  return {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    checkForUpdates() {
      checks += 1
    },
    emit(event, ...args) {
      for (const l of listeners.get(event) ?? []) l(...args)
    },
    checks: () => checks,
  }
}

function setup() {
  vi.useFakeTimers()
  const native = fakeNative()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const watch = createNativeStagingWatch({ native, log, retryDelayMs: 1000, maxRetries: 2 })
  return { native, log, watch }
}

afterEach(() => vi.useRealTimers())

describe('native staging watch (macOS Squirrel)', () => {
  it('re-asks the native updater when it never fetched the update, then gives up loudly', () => {
    const { native, log, watch } = setup()
    watch.expectStaging()
    expect(native.checks()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(native.checks()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(native.checks()).toBe(2)
    vi.advanceTimersByTime(1000)
    expect(native.checks()).toBe(2)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(watch.isStaged()).toBe(false)
  })

  it('stops retrying once the native updater staged the update', () => {
    const { native, watch } = setup()
    watch.expectStaging()
    vi.advanceTimersByTime(1000)
    native.emit('update-downloaded')
    expect(watch.isStaged()).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(native.checks()).toBe(1)
  })

  it('logs a native error instead of dropping it', () => {
    const { native, log } = setup()
    native.emit('error', new Error('boom'))
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })

  it('nudge asks the native updater at once when it is not staged, and logs it', () => {
    const { native, log, watch } = setup()
    expect(watch.nudgeIfNotStaged('install request')).toBe(false)
    expect(native.checks()).toBe(1)
    expect(log.warn).toHaveBeenCalled()
    native.emit('update-downloaded')
    expect(watch.nudgeIfNotStaged('install request')).toBe(true)
    expect(native.checks()).toBe(1)
  })
})
