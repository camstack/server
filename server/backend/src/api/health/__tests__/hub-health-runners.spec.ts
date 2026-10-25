import { describe, expect, it } from 'vitest'
import { buildHubHealth } from '../health.routes.js'

const deps = {
  agentRegistry: { listNodeLiveness: () => [] },
  hubVersion: '1.2.600',
  isReady: () => true,
}

describe('/health carries the runner boot check (D877)', () => {
  it('names a degraded node but does not flip ok (a container restart cannot fix a refusal)', async () => {
    const health = await buildHubHealth({
      ...deps,
      runnerBootCheck: () => ({
        checkedAtMs: 9,
        expected: 4,
        running: 2,
        failed: ['a'],
        refused: [{ runnerId: 'b', addonIds: ['b'], reason: 'x' }],
        missing: [],
        planKnown: true,
      }),
    })
    expect(health.ok).toBe(true)
    expect(health.runners).toEqual({
      degraded: true,
      expected: 4,
      running: 2,
      failed: 1,
      refused: 1,
      missing: 0,
      checkedAtMs: 9,
    })
  })

  it('omits `runners` until the check has run', async () => {
    const health = await buildHubHealth({ ...deps, runnerBootCheck: () => undefined })
    expect(health.runners).toBeUndefined()
  })
})
