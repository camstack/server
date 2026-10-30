import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHILD_SHUTDOWN_DEADLINE_MS, createChildShutdownWatch } from '../node-shutdown-watch'

describe('child shutdown watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make() {
    const logs: string[] = []
    const kill = vi.fn()
    const watch = createChildShutdownWatch({ log: (l) => logs.push(l), forceKill: kill })
    return { watch, logs, kill }
  }

  it('records the child shutdown line in the shell log', () => {
    const { watch, logs } = make()
    watch.onChildLine('[Agent] shutdown started by SIGTERM')
    expect(logs.some((l) => l.includes('shutdown started by SIGTERM'))).toBe(true)
  })

  it('force-kills a child that announced shutdown and never exited', () => {
    const { watch, kill, logs } = make()
    watch.onChildLine('[Agent] shutdown started by SIGTERM')
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS - 1)
    expect(kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('did not exit'))).toBe(true)
  })

  it('does not kill a child that exited in time', () => {
    const { watch, kill } = make()
    watch.onChildLine('[Agent] shutdown started by SIGTERM')
    watch.onChildExit()
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS * 2)
    expect(kill).not.toHaveBeenCalled()
  })

  it('ignores unrelated lines and does not stack deadlines', () => {
    const { watch, kill } = make()
    watch.onChildLine('[Agent] connected to hub')
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS * 2)
    expect(kill).not.toHaveBeenCalled()
    watch.onChildLine('[Agent] shutdown started by SIGTERM')
    vi.advanceTimersByTime(5_000)
    watch.onChildLine('[Agent] shutdown started by SIGINT')
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS - 5_000 + 1)
    expect(kill).toHaveBeenCalledTimes(1)
  })
})
