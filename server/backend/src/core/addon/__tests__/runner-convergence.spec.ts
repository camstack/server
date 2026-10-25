import { describe, expect, it } from 'vitest'
import { planRunnerConvergence, type RunnerProcessSnapshot } from '../runner-convergence.js'

/**
 * The `detection` co-location group: pipeline-runner + detection-pipeline +
 * motion-wasm share ONE runner so the decode→detect frame hop resolves
 * in-process (zero copy) instead of transiting the hub-main UDS parent.
 */
const DETECTION_ROSTER = ['pipeline-runner', 'detection-pipeline', 'motion-wasm'] as const

describe('planRunnerConvergence', () => {
  describe('groupless addon (roster of one) — byte-identical to the solo path', () => {
    it('spawns when nothing is running', () => {
      const plan = planRunnerConvergence('recorder', ['recorder'], [], { restart: false })
      expect(plan).toEqual({ stop: [], action: 'spawn' })
    })

    it('is a no-op when already up with the right roster and no restart asked', () => {
      const running: RunnerProcessSnapshot[] = [{ name: 'recorder', addonIds: ['recorder'] }]
      const plan = planRunnerConvergence('recorder', ['recorder'], running, { restart: false })
      expect(plan).toEqual({ stop: [], action: 'none' })
    })

    it('restarts in place on the deploy hot-reload path', () => {
      const running: RunnerProcessSnapshot[] = [{ name: 'recorder', addonIds: ['recorder'] }]
      const plan = planRunnerConvergence('recorder', ['recorder'], running, { restart: true })
      expect(plan).toEqual({ stop: [], action: 'restart' })
    })
  })

  describe('detection group — the co-location target', () => {
    it('spawns the whole group when nothing is running (fresh install)', () => {
      const plan = planRunnerConvergence('detection', DETECTION_ROSTER, [], { restart: false })
      expect(plan.action).toBe('spawn')
      expect(plan.stop).toEqual([])
    })

    it('CONVERGES three stale solo runners into one group runner', () => {
      // The exact symptom: the group manifest shipped, but the runners were
      // spawned solo at the previous boot. A deploy must stop all three solos
      // and spawn the group.
      const running: RunnerProcessSnapshot[] = [
        { name: 'pipeline-runner', addonIds: ['pipeline-runner'] },
        { name: 'detection-pipeline', addonIds: ['detection-pipeline'] },
        { name: 'motion-wasm', addonIds: ['motion-wasm'] },
      ]
      const plan = planRunnerConvergence('detection', DETECTION_ROSTER, running, { restart: false })
      expect(plan.action).toBe('spawn')
      expect([...plan.stop].sort()).toEqual(
        ['detection-pipeline', 'motion-wasm', 'pipeline-runner'].sort(),
      )
    })

    it('converges a PARTIAL group (one member still solo) into the full group', () => {
      const running: RunnerProcessSnapshot[] = [
        { name: 'detection', addonIds: ['pipeline-runner', 'detection-pipeline'] },
        { name: 'motion-wasm', addonIds: ['motion-wasm'] },
      ]
      const plan = planRunnerConvergence('detection', DETECTION_ROSTER, running, { restart: false })
      // The same-id runner carries the WRONG roster → it must be stopped too
      // (restart would respawn its stale 2-addon roster), then group re-spawned.
      expect(plan.action).toBe('spawn')
      expect([...plan.stop].sort()).toEqual(['detection', 'motion-wasm'].sort())
    })

    it('is a no-op when the group is already up with the exact roster', () => {
      const running: RunnerProcessSnapshot[] = [
        { name: 'detection', addonIds: ['pipeline-runner', 'detection-pipeline', 'motion-wasm'] },
        { name: 'recorder', addonIds: ['recorder'] },
      ]
      const plan = planRunnerConvergence('detection', DETECTION_ROSTER, running, { restart: false })
      expect(plan).toEqual({ stop: [], action: 'none' })
    })

    it('restarts the group in place (deploy) — respawns all members from new disk code', () => {
      const running: RunnerProcessSnapshot[] = [
        { name: 'detection', addonIds: ['pipeline-runner', 'detection-pipeline', 'motion-wasm'] },
      ]
      const plan = planRunnerConvergence('detection', DETECTION_ROSTER, running, { restart: true })
      expect(plan).toEqual({ stop: [], action: 'restart' })
    })

    it('roster order does not matter for the exact-match check', () => {
      const running: RunnerProcessSnapshot[] = [
        { name: 'detection', addonIds: ['motion-wasm', 'pipeline-runner', 'detection-pipeline'] },
      ]
      const plan = planRunnerConvergence('detection', DETECTION_ROSTER, running, { restart: false })
      expect(plan).toEqual({ stop: [], action: 'none' })
    })
  })
})
