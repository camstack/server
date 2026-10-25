import { describe, expect, it } from 'vitest'
import { createReconnectRunner } from '../agent-reconnect.js'

interface FakeBroker {
  readonly id: string
  started: boolean
  stopped: boolean
}

describe('reconnect generation guard', () => {
  it('SECURITY: a reconnect stuck in the OLD broker.stop() past its deadline does not build a second broker when it resumes', async () => {
    const built: FakeBroker[] = []
    let assigned: FakeBroker = { id: 'B0', started: true, stopped: false }
    const first = assigned
    let releaseFirstStop: () => void = () => undefined
    const superseded: string[] = []

    const run = createReconnectRunner<FakeBroker>({
      current: () => assigned,
      assign: (b) => {
        assigned = b
      },
      stop: async (b) => {
        if (b === first && !b.stopped) {
          // job 1's stop() hangs until the test releases it (past the queue's deadline)
          await new Promise<void>((resolve) => {
            releaseFirstStop = resolve
          })
        }
        b.stopped = true
      },
      prepare: () => undefined,
      build: () => {
        const b: FakeBroker = { id: `B${built.length + 1}`, started: false, stopped: false }
        built.push(b)
        return b
      },
      start: async (b) => {
        b.started = true
      },
      onSuperseded: (stage) => void superseded.push(stage),
    })

    const job1 = run() // stuck in stop() of B0
    await new Promise((r) => setImmediate(r))
    // The queue abandoned job 1 at its deadline and started job 2: stop() of B0 is still pending,
    // so job 2 (which stops the current broker too) waits on nothing and builds B1.
    first.stopped = true // the old broker is torn down by the deadline handler
    const job2 = run()
    await job2
    expect(built.map((b) => b.id)).toEqual(['B1'])
    expect(assigned.id).toBe('B1')
    expect(assigned.started).toBe(true)

    // Job 1 finally resumes: it must build NOTHING and leave B1 assigned and running.
    releaseFirstStop()
    await job1
    expect(built.map((b) => b.id)).toEqual(['B1'])
    expect(assigned.id).toBe('B1')
    expect(assigned.stopped).toBe(false)
    expect(superseded).toEqual(['before-build'])
  })

  it('a run superseded while its broker is STARTING stops what it started', async () => {
    const built: FakeBroker[] = []
    let assigned: FakeBroker = { id: 'B0', started: true, stopped: false }
    let finishFirstStart: () => void = () => undefined
    const run = createReconnectRunner<FakeBroker>({
      current: () => assigned,
      assign: (b) => {
        assigned = b
      },
      stop: async (b) => {
        b.stopped = true
      },
      prepare: () => undefined,
      build: () => {
        const b: FakeBroker = { id: `B${built.length + 1}`, started: false, stopped: false }
        built.push(b)
        return b
      },
      start: async (b) => {
        if (b.id === 'B1') {
          await new Promise<void>((resolve) => {
            finishFirstStart = resolve
          })
        }
        b.started = true
      },
    })
    const job1 = run()
    await new Promise((r) => setImmediate(r))
    const job2 = run() // job 1 is stuck in start(); a newer run takes over
    await job2
    finishFirstStart()
    await job1
    expect(assigned.id).toBe('B2')
    expect(built.find((b) => b.id === 'B1')?.stopped).toBe(true)
    expect(assigned.stopped).toBe(false)
  })
})
