import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the singleton holder so the boot entry's `getLifecycleRunner()` resolves
// to a controllable fake runner. `vi.hoisted` makes the spy available inside the
// hoisted `vi.mock` factory.
const { getLifecycleRunner } = vi.hoisted(() => ({ getLifecycleRunner: vi.fn() }))
vi.mock('../../core/lifecycle/lifecycle-runner.singleton.js', () => ({
  getLifecycleRunner,
}))

import { reconcileLifecycleJobsAtBoot } from '../reconcile-lifecycle-jobs.js'

describe('reconcileLifecycleJobsAtBoot', () => {
  beforeEach(() => {
    getLifecycleRunner.mockReset()
  })

  it('delegates to the singleton runner.reconcile() and returns its summary', async () => {
    const reconcile = vi.fn().mockResolvedValue({ resumed: 2, failed: 1 })
    getLifecycleRunner.mockReturnValue({ reconcile })

    const result = await reconcileLifecycleJobsAtBoot()

    expect(reconcile).toHaveBeenCalledOnce()
    expect(result).toEqual({ resumed: 2, failed: 1 })
  })

  it('swallows errors and returns {resumed:0,failed:0} when the runner throws', async () => {
    getLifecycleRunner.mockImplementation(() => {
      throw new Error('runner not initialized')
    })

    const result = await reconcileLifecycleJobsAtBoot()

    expect(result).toEqual({ resumed: 0, failed: 0 })
  })

  it('swallows a rejected reconcile() and returns {resumed:0,failed:0}', async () => {
    const reconcile = vi.fn().mockRejectedValue(new Error('boom'))
    getLifecycleRunner.mockReturnValue({ reconcile })

    const result = await reconcileLifecycleJobsAtBoot()

    expect(result).toEqual({ resumed: 0, failed: 0 })
  })
})
