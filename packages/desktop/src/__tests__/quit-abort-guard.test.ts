import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuitAbortGuard, QUIT_ABORT_GRACE_MS } from '../quit-abort-guard'

describe('quit abort guard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(nodeRunning: boolean) {
    const calls: string[] = []
    const guard = createQuitAbortGuard({
      clearQuitting: () => calls.push('clear'),
      nodeRunning: () => nodeRunning,
      consumeRestartIntent: () => calls.push('consume'),
      startNode: () => calls.push('start'),
      log: (line) => calls.push(`log:${line}`),
    })
    return { guard, calls }
  }

  it('starts the node when the quit never happened and the node is gone', () => {
    const { guard, calls } = setup(false)
    guard.onQuitting()
    vi.advanceTimersByTime(QUIT_ABORT_GRACE_MS - 1)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls.filter((c) => !c.startsWith('log:'))).toEqual(['clear', 'consume', 'start'])
  })

  it('clears the mark but starts nothing when the node still runs', () => {
    const { guard, calls } = setup(true)
    guard.onQuitting()
    vi.advanceTimersByTime(QUIT_ABORT_GRACE_MS)
    expect(calls.filter((c) => !c.startsWith('log:'))).toEqual(['clear', 'consume'])
  })

  it('arms once per quit and can arm again after it fired', () => {
    const { guard, calls } = setup(false)
    guard.onQuitting()
    guard.onQuitting()
    vi.advanceTimersByTime(QUIT_ABORT_GRACE_MS)
    expect(calls.filter((c) => c === 'start')).toHaveLength(1)
    guard.onQuitting()
    vi.advanceTimersByTime(QUIT_ABORT_GRACE_MS)
    expect(calls.filter((c) => c === 'start')).toHaveLength(2)
  })
})
