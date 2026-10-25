/**
 * The initialize() stall watchdog.
 *
 * The failure it exists for (2026-08-14, `pipeline-analytics`) produced NO
 * diagnostic at all: eight capabilities were offline cluster-wide for over half
 * an hour while the runner logged its 30 s tick as if nothing were wrong. So
 * the assertions here are about the LINE — that it fires, that it names the
 * addon and the capabilities nobody can reach, and that it stops the moment
 * initialize() returns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INIT_WATCHDOG_FIRST_MS,
  INIT_WATCHDOG_REPEAT_MS,
  type InitWatchdogWarn,
  startInitWatchdog,
} from '../../moleculer/init-watchdog.js'

interface WarnCall {
  readonly message: string
  readonly meta: Record<string, unknown>
}

interface WarnSink {
  readonly calls: readonly WarnCall[]
  readonly warn: InitWatchdogWarn
}

function makeWarnSink(): WarnSink {
  const calls: WarnCall[] = []
  return {
    calls,
    warn: (message, meta) => {
      calls.push({ message, meta })
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startInitWatchdog', () => {
  it('says nothing while initialize() is still inside the grace window', () => {
    vi.useFakeTimers()
    const sink = makeWarnSink()
    const handle = startInitWatchdog({
      addonId: 'pipeline-analytics',
      declaredCapabilities: ['notification-rules'],
      warn: sink.warn,
    })

    vi.advanceTimersByTime(INIT_WATCHDOG_FIRST_MS - 1)

    expect(sink.calls).toHaveLength(0)
    handle.clear()
  })

  it('names the addon and every capability the stall is holding offline', () => {
    vi.useFakeTimers()
    const sink = makeWarnSink()
    const handle = startInitWatchdog({
      addonId: 'pipeline-analytics',
      declaredCapabilities: ['notification-rules', 'videoclips', 'face-gallery'],
      warn: sink.warn,
    })

    vi.advanceTimersByTime(INIT_WATCHDOG_FIRST_MS)

    expect(sink.calls).toHaveLength(1)
    const [first] = sink.calls
    expect(first?.message).toContain('pipeline-analytics')
    expect(first?.message).toContain('notification-rules')
    expect(first?.message).toContain('videoclips')
    expect(first?.message).toContain('face-gallery')
    expect(first?.meta.addonId).toBe('pipeline-analytics')
    expect(first?.meta.unpublishedCapabilities).toEqual([
      'notification-rules',
      'videoclips',
      'face-gallery',
    ])
    handle.clear()
  })

  it('keeps warning on the repeat interval — a stall that lasts an hour is reported all hour', () => {
    vi.useFakeTimers()
    const sink = makeWarnSink()
    const handle = startInitWatchdog({
      addonId: 'pipeline-analytics',
      declaredCapabilities: ['notification-rules'],
      warn: sink.warn,
    })

    vi.advanceTimersByTime(INIT_WATCHDOG_FIRST_MS + INIT_WATCHDOG_REPEAT_MS * 3)

    expect(sink.calls).toHaveLength(4)
    handle.clear()
  })

  it('reports the elapsed time, so a reader can tell a slow boot from a wedge', () => {
    vi.useFakeTimers()
    const sink = makeWarnSink()
    const handle = startInitWatchdog({
      addonId: 'pipeline-analytics',
      declaredCapabilities: ['notification-rules'],
      warn: sink.warn,
      firstMs: 1_000,
      repeatMs: 1_000,
    })

    vi.advanceTimersByTime(3_000)

    expect(sink.calls).toHaveLength(3)
    const elapsed = sink.calls.map((c) => c.meta.elapsedMs)
    expect(elapsed).toEqual([1_000, 2_000, 3_000])
    handle.clear()
  })

  it('goes quiet once initialize() returns — the healthy boot stays silent', () => {
    vi.useFakeTimers()
    const sink = makeWarnSink()
    const handle = startInitWatchdog({
      addonId: 'pipeline-analytics',
      declaredCapabilities: ['notification-rules'],
      warn: sink.warn,
      firstMs: 1_000,
      repeatMs: 1_000,
    })

    vi.advanceTimersByTime(1_000)
    expect(sink.calls).toHaveLength(1)

    handle.clear()
    vi.advanceTimersByTime(60_000)

    expect(sink.calls).toHaveLength(1)
  })

  it('is idempotent on clear() — a finally that runs twice must not throw', () => {
    vi.useFakeTimers()
    const sink = makeWarnSink()
    const handle = startInitWatchdog({
      addonId: 'a',
      declaredCapabilities: [],
      warn: sink.warn,
      firstMs: 1_000,
    })

    handle.clear()
    handle.clear()
    vi.advanceTimersByTime(60_000)

    expect(sink.calls).toHaveLength(0)
  })
})
