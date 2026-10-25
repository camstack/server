import { describe, expect, it, vi } from 'vitest'
import { createDiskReconcileJobRunner } from '../disk-reconcile-job.js'

describe('createDiskReconcileJobRunner', () => {
  it('returns immediately in running state and finishes in the background', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = createDiskReconcileJobRunner(() => 1000)
    const started = runner.start({
      listDeviceIds: async () => [7, 9],
      rescanRecordings: async () => {
        await gate
      },
      reconcileAnalytics: async () => ({ mediaDropped: 1, tracks: 2, events: 3 }),
    })
    expect(started.state).toBe('running')
    expect(started.startedAtMs).toBe(1000)
    expect(runner.snapshot().state).toBe('running')

    release()
    await new Promise((r) => setTimeout(r, 20))
    const done = runner.snapshot()
    expect(done.state).toBe('done')
    expect(done.completed).toBe(2)
    expect(done.total).toBe(2)
    expect(done.mediaDropped).toBe(2)
    expect(done.tracks).toBe(4)
    expect(done.events).toBe(6)
    expect(done.failed).toEqual([])
  })

  it('does not start a second job while one is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = createDiskReconcileJobRunner()
    let starts = 0
    const deps = {
      listDeviceIds: async () => {
        starts += 1
        return [1]
      },
      rescanRecordings: async () => {
        await gate
      },
      reconcileAnalytics: async () => ({ mediaDropped: 0, tracks: 0, events: 0 }),
    }
    runner.start(deps)
    runner.start(deps)
    expect(starts).toBe(1)
    release()
    await new Promise((r) => setTimeout(r, 20))
  })

  it('retries a timed-out camera once and logs per-camera progress', async () => {
    const log = vi.fn()
    let rescanCalls = 0
    const runner = createDiskReconcileJobRunner(() => 1000)
    runner.start({
      listDeviceIds: async () => [4],
      rescanRecordings: async () => {
        rescanCalls += 1
        if (rescanCalls === 1) throw new Error('Request timed out after 60000ms')
      },
      reconcileAnalytics: async () => ({ mediaDropped: 1, tracks: 0, events: 2 }),
      log,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(rescanCalls).toBe(2)
    expect(runner.snapshot().state).toBe('done')
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      'pipeline disk reconcile started',
      'pipeline disk reconcile camera',
      'pipeline disk reconcile',
    ])
  })
})
