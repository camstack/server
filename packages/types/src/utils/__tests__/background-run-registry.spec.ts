import { describe, expect, it } from 'vitest'
import { BackgroundRunRegistry } from '../background-run-registry.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(err: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (err: Error) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let the registry's own `.then` handlers run. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

function registry(
  opts: Partial<{ maxConcurrent: number; keepFinished: number }> = {},
): BackgroundRunRegistry<{ readonly done: number }, string> {
  let t = 1000
  return new BackgroundRunRegistry({
    maxConcurrent: opts.maxConcurrent ?? 1,
    keepFinished: opts.keepFinished ?? 5,
    now: () => t++,
  })
}

describe('BackgroundRunRegistry — start then poll', () => {
  it('start returns at once with a running receipt; the result arrives through status', async () => {
    const reg = registry()
    const work = deferred<string>()
    const started = reg.start('r1', () => work.promise)
    expect(started.state).toBe('running')
    expect(started.result).toBeNull()

    work.resolve('the answer')
    await flush()

    const done = reg.status('r1')
    expect(done?.state).toBe('done')
    expect(done?.result).toBe('the answer')
    expect(done?.error).toBeNull()
    expect(done?.finishedAtMs).not.toBeNull()
  })

  it('a failed run keeps its error message — never a silent disappearance', async () => {
    const reg = registry()
    const work = deferred<string>()
    reg.start('r1', () => work.promise)
    work.reject(new Error('pool refused the model'))
    await flush()
    const status = reg.status('r1')
    expect(status?.state).toBe('failed')
    expect(status?.error).toBe('pool refused the model')
    expect(status?.result).toBeNull()
  })

  it('a run that throws synchronously is a failed run, not a thrown start', async () => {
    const reg = registry()
    reg.start('r1', () => {
      throw new Error('bad input')
    })
    await flush()
    expect(reg.status('r1')?.state).toBe('failed')
    expect(reg.status('r1')?.error).toBe('bad input')
  })

  it('progress reported by the work is visible while it runs', async () => {
    const reg = registry()
    const work = deferred<string>()
    reg.start('r1', (ctx) => {
      ctx.report({ done: 3 })
      return work.promise
    })
    expect(reg.status('r1')?.progress).toEqual({ done: 3 })
    work.resolve('ok')
    await flush()
    expect(reg.status('r1')?.progress).toEqual({ done: 3 })
  })

  it('refuses a second run past the concurrency bound, by name', () => {
    const reg = registry({ maxConcurrent: 1 })
    reg.start('r1', () => deferred<string>().promise)
    expect(() => reg.start('r2', () => deferred<string>().promise)).toThrow(/busy/)
  })

  it('refuses a duplicate run id', () => {
    const reg = registry({ maxConcurrent: 2 })
    reg.start('r1', () => deferred<string>().promise)
    expect(() => reg.start('r1', () => deferred<string>().promise)).toThrow(/already/)
  })

  it('abort signals the work and the run ends aborted, keeping what it produced', async () => {
    const reg = registry()
    const work = deferred<string>()
    let signalled = false
    reg.start('r1', (ctx) => {
      ctx.signal.addEventListener('abort', () => {
        signalled = true
        work.resolve('partial')
      })
      return work.promise
    })
    expect(reg.abort('r1')).toBe(true)
    await flush()
    expect(signalled).toBe(true)
    expect(reg.status('r1')?.state).toBe('aborted')
    expect(reg.status('r1')?.result).toBe('partial')
  })

  it('abort of an unknown or finished run answers false', async () => {
    const reg = registry()
    expect(reg.abort('nope')).toBe(false)
    reg.start('r1', async () => 'x')
    await flush()
    expect(reg.abort('r1')).toBe(false)
  })

  it('keeps a bounded number of FINISHED runs, oldest dropped first; running ones are never dropped', async () => {
    const reg = registry({ maxConcurrent: 5, keepFinished: 2 })
    reg.start('a', async () => 'a')
    await flush()
    reg.start('b', async () => 'b')
    await flush()
    const running = deferred<string>()
    reg.start('live', () => running.promise)
    reg.start('c', async () => 'c')
    await flush()
    expect(reg.status('a')).toBeNull()
    expect(reg.status('b')?.state).toBe('done')
    expect(reg.status('c')?.state).toBe('done')
    expect(reg.status('live')?.state).toBe('running')
    expect(reg.list().map((r) => r.runId)).toEqual(['live', 'c', 'b'])
  })

  it('an unknown id is null, not a fabricated status', () => {
    expect(registry().status('never-started')).toBeNull()
  })
})
