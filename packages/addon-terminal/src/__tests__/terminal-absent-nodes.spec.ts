import { describe, expect, it, vi } from 'vitest'
import {
  TerminalInstanceMutationQueue,
  TerminalInstanceReconcileCoordinator,
} from '../terminal-instances.js'
import { AbsentNodeAlerts, type AbsentNodeEntry } from '../terminal-absent-nodes.js'

const entry = (absent: boolean): AbsentNodeEntry => ({
  instanceId: 'i1',
  instanceName: 'Glances macmini',
  nodeId: 'MinidiGianluca.localdomain',
  deviceId: 3219,
  absent,
})

const within = async <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  Promise.race([promise, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])

function io() {
  return {
    raise: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    log: vi.fn(),
  }
}

describe('AbsentNodeAlerts', () => {
  it('raises one alert for an absent node, logs with the deviceId tag, and never deletes', async () => {
    const sink = io()
    const alerts = new AbsentNodeAlerts(sink)
    await alerts.sync([entry(true)])
    await alerts.sync([entry(true)])
    expect(sink.raise).toHaveBeenCalledTimes(1)
    expect(sink.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'terminal-node-missing:i1',
        category: 'terminal',
        status: 'active',
        source: { type: 'device', id: '3219' },
      }),
    )
    expect(sink.log).toHaveBeenCalledWith(
      expect.stringContaining('not in the cluster'),
      expect.objectContaining({ tags: { deviceId: 3219 } }),
    )
  })

  it('clears the alert when the node is back or the instance was re-pointed', async () => {
    const sink = io()
    const alerts = new AbsentNodeAlerts(sink)
    await alerts.sync([entry(true)])
    await alerts.sync([entry(false)])
    expect(sink.clear).toHaveBeenCalledWith('terminal-node-missing:i1')
    await alerts.sync([entry(false)])
    expect(sink.clear).toHaveBeenCalledTimes(1)
  })
})

describe('reconcile lane', () => {
  // The old reconcile ran inside the queue and queued a delete on the same
  // queue: the outer task waited on the inner forever. This pins the trap, so
  // the absent-node pass is never again allowed to call `run` while holding it.
  it('a nested queue.run inside a held reconcile never completes', async () => {
    const queue = new TerminalInstanceMutationQueue()
    const coordinator = new TerminalInstanceReconcileCoordinator(queue)
    const nested = coordinator.request(async () => {
      await queue.run(async () => undefined)
    })
    expect(await within(nested, 100)).toBe('timeout')
  })

  it('an absent-node pass inside the reconcile completes and a following mutation resolves', async () => {
    const queue = new TerminalInstanceMutationQueue()
    const coordinator = new TerminalInstanceReconcileCoordinator(queue)
    const sink = io()
    const alerts = new AbsentNodeAlerts(sink)
    const pass = coordinator.request(async () => {
      await alerts.sync([entry(true)])
    })
    expect(await within(pass, 500)).toBeUndefined()
    const mutation = queue.run(async () => 'created')
    expect(await within(mutation, 500)).toBe('created')
  })
})
