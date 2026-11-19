/**
 * A child the catalog stopped declaring is pruned by the kernel only on a second agreeing
 * read of a later probe, so the box devices re-probe once the box has answered.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { armRetireReprobe } from '../devices/enpal-retire-reprobe.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

function rig(initial: boolean) {
  let hasSnapshot = initial
  const listeners = new Set<() => void>()
  const reprobe = vi.fn(async () => undefined)
  const stop = armRetireReprobe({
    deviceId: 5,
    hasSnapshot: () => hasSnapshot,
    onSnapshot: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    reprobe,
    logger: quiet,
  })
  const snap = (): void => [...listeners].forEach((l) => l())
  const answer = (): void => {
    hasSnapshot = true
  }
  return { reprobe, snap, stop, listeners, answer }
}

describe('armRetireReprobe', () => {
  it('re-probes at once when the box already answered', () => {
    const { reprobe } = rig(true)
    expect(reprobe).toHaveBeenCalledTimes(1)
  })

  it('waits for the first snapshot, then re-probes exactly once', () => {
    const { reprobe, snap, listeners, answer } = rig(false)
    snap() // a failed poll: no snapshot, nothing fires
    expect(reprobe).not.toHaveBeenCalled()
    answer()
    snap()
    snap()
    expect(reprobe).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('does not re-probe after it was stopped', () => {
    const { reprobe, snap, stop } = rig(false)
    stop()
    snap()
    expect(reprobe).not.toHaveBeenCalled()
  })
})
