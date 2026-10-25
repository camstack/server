/**
 * How the file-host client ENDS a thread (D851).
 *
 * A forced teardown of the real thread — `terminate()` or `process.exit` while
 * it lives — segfaulted the whole process on macOS arm64 (SIGSEGV in the
 * isolate's teardown GC, measured on Node 24.17, with and without tsx, with
 * the connection already closed). A thread that is asked to stop answers,
 * closes its port and ends itself; the client waits for that and terminates
 * only a thread that does not leave. These specs pin the ordering on a fake
 * thread (the structural `FileHostThread`), so they cannot crash the runner.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileHostClient, type FileHostThread } from '../file-host-client.js'
import { recordingLogger, type LoggedLine } from './support/owned-files-harness.js'

class FakeThread extends EventEmitter implements FileHostThread {
  readonly posted: unknown[] = []
  terminated = 0
  /** Whether the thread answers `stop` (it does, unless a spec says otherwise). */
  answersStop = true

  postMessage(message: unknown): void {
    this.posted.push(message)
    if (!isStop(message) || !this.answersStop) return
    queueMicrotask(() =>
      this.emit('message', { kind: 'result', id: message.id, ok: true, result: undefined }),
    )
  }

  terminate(): Promise<number> {
    this.terminated += 1
    queueMicrotask(() => this.emit('exit', 1))
    return Promise.resolve(1)
  }

  /** The thread ends on its own, as it does after closing its port. */
  endNaturally(): void {
    this.emit('exit', 0)
  }
}

function isStop(message: unknown): message is { id: number; kind: 'stop' } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'kind' in message &&
    message.kind === 'stop' &&
    'id' in message &&
    typeof message.id === 'number'
  )
}

function open(): {
  client: FileHostClient
  thread: FakeThread
  lines: LoggedLine[]
  fatal: string[]
} {
  const thread = new FakeThread()
  const lines: LoggedLine[] = []
  const fatal: string[] = []
  const client = new FileHostClient({
    spec: {
      databaseId: 'events',
      livePath: '/nonexistent/events.db',
      thread: 'worker',
      autoVacuum: 'incremental',
      loadVectorExtension: false,
    },
    logger: recordingLogger(lines),
    onFatal: (reason) => fatal.push(reason),
    threadFactory: () => thread,
  })
  return { client, thread, lines, fatal }
}

describe('file host client: ending a thread', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the thread to end itself and never terminates it', async () => {
    const { client, thread, fatal } = open()
    let settled = false
    const stopped = client.stop().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    // Answered, but the thread has not left: still waiting, nothing forced.
    expect(thread.posted).toHaveLength(1)
    expect(settled).toBe(false)
    expect(thread.terminated).toBe(0)

    thread.endNaturally()
    await stopped
    expect(thread.terminated).toBe(0)
    expect(fatal).toEqual([])
  })

  it('terminates only a thread that does not leave in time, and says so', async () => {
    const { client, thread, lines } = open()
    const stopped = client.stop()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(thread.terminated).toBe(0)
    await vi.advanceTimersByTimeAsync(2)
    await stopped
    expect(thread.terminated).toBe(1)
    const warning = lines.find((l) => l.message.includes('did not leave after stop'))
    expect(warning?.level).toBe('warn')
    expect(warning?.extras?.tags?.['database']).toBe('events')
  })

  it('does not wait out the grace when the thread already left before the answer', async () => {
    const { client, thread } = open()
    thread.answersStop = false
    const stopped = client.stop()
    thread.endNaturally()
    // No answer will ever come; the exit itself must not strand the stop.
    await expect(
      Promise.race([
        stopped.then(() => 'stopped'),
        vi.advanceTimersByTimeAsync(10_000).then(() => 'late'),
      ]),
    ).resolves.toBe('stopped')
    expect(thread.terminated).toBe(0)
  })
})
