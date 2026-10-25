import { describe, expect, it, vi } from 'vitest'
import { ADDON_UPDATE_COALESCE_MS, AddonUpdateCoalescer } from '../update-complete-coalescer.js'

describe('AddonUpdateCoalescer', () => {
  it('flushes every distinct package after the debounce, not once per observe', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const coalescer = new AddonUpdateCoalescer(flush)

    coalescer.observe({
      packageName: '@camstack/addon-pipeline',
      fromVersion: '1.2.3',
      toVersion: '1.2.4',
    })
    coalescer.observe({
      packageName: '@camstack/addon-pipeline',
      fromVersion: '1.2.3',
      toVersion: '1.2.4',
    })
    coalescer.observe({
      packageName: '@camstack/addon-provider-reolink',
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
    })

    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(ADDON_UPDATE_COALESCE_MS - 1)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]![0]).toEqual([
      {
        packageName: '@camstack/addon-pipeline',
        fromVersion: '1.2.3',
        toVersion: '1.2.4',
      },
      {
        packageName: '@camstack/addon-provider-reolink',
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
      },
    ])
    coalescer.dispose()
    vi.useRealTimers()
  })

  it('restarts the window on each observe so a bulk job stays one flush', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const coalescer = new AddonUpdateCoalescer(flush)

    coalescer.observe({
      packageName: '@camstack/addon-pipeline',
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
    })
    vi.advanceTimersByTime(20_000)
    coalescer.observe({
      packageName: '@camstack/addon-post-analysis',
      fromVersion: '1.0.0',
      toVersion: '1.0.1',
    })
    vi.advanceTimersByTime(20_000)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]![0]).toHaveLength(2)
    coalescer.dispose()
    vi.useRealTimers()
  })
})
