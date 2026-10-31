import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHILD_PROBE_BOUND_MS,
  CHILD_SHUTDOWN_DEADLINE_MS,
  CHILD_TAIL_LINES,
  createChildShutdownWatch,
} from '../node-shutdown-watch'

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

  it('arms from the restart-intent marker with NO child output and kills after the deadline', () => {
    const { watch, kill, logs } = make()
    watch.onRestartIntent()
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS - 1)
    expect(kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes('restart-intent marker appeared'))).toBe(true)
  })

  it('a child exiting before the deadline cancels the marker-armed kill', () => {
    const { watch, kill } = make()
    watch.onRestartIntent()
    vi.advanceTimersByTime(5_000)
    watch.onChildExit()
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS * 2)
    expect(kill).not.toHaveBeenCalled()
  })

  it('marker plus the child shutdown line share one deadline', () => {
    const { watch, kill } = make()
    watch.onRestartIntent()
    vi.advanceTimersByTime(5_000)
    watch.onChildLine('[Agent] shutdown started by SIGTERM')
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS - 5_000 + 1)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('keeps the shutdown-related lines and dumps the last child lines with pid and wait before the kill', () => {
    const logs: string[] = []
    const kill = vi.fn()
    const watch = createChildShutdownWatch({
      log: (l) => logs.push(l),
      forceKill: kill,
      pid: () => 4242,
    })
    watch.onChildLine('[Agent] agent restart requested — exiting for supervisor relaunch')
    for (let i = 0; i < CHILD_TAIL_LINES + 10; i++) watch.onChildLine(`noise ${i}`)
    watch.onRestartIntent()
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS + 1)
    expect(logs.some((l) => l.includes('agent restart requested'))).toBe(true)
    const tail = logs.filter((l) => l.startsWith('[node-tail] '))
    expect(tail).toHaveLength(CHILD_TAIL_LINES)
    expect(tail[tail.length - 1]).toContain(`noise ${CHILD_TAIL_LINES + 9}`)
    expect(logs.some((l) => l.includes('pid 4242') && l.includes('20000ms'))).toBe(true)
  })

  it('takes the probe before the kill, and never waits past its bound', () => {
    const kill = vi.fn()
    const probe = vi.fn(() => new Promise<void>(() => undefined))
    const watch = createChildShutdownWatch({ log: () => undefined, forceKill: kill, probe })
    watch.onRestartIntent()
    vi.advanceTimersByTime(CHILD_SHUTDOWN_DEADLINE_MS + 1)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(kill).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CHILD_PROBE_BOUND_MS + 1)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('kills as soon as the probe finishes', async () => {
    const kill = vi.fn()
    const watch = createChildShutdownWatch({
      log: () => undefined,
      forceKill: kill,
      probe: () => Promise.resolve(),
    })
    watch.onRestartIntent()
    await vi.advanceTimersByTimeAsync(CHILD_SHUTDOWN_DEADLINE_MS + 1)
    expect(kill).toHaveBeenCalledTimes(1)
  })
})
