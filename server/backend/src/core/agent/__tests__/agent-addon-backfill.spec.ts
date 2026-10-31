import { describe, expect, it, vi } from 'vitest'
import {
  BackfillAttemptTracker,
  type BackfillPlan,
  type BackfillSeam,
  confirmBackfillPlan,
  executeBackfill,
  MAX_BACKFILL_ATTEMPTS,
  type NodePackageEntry,
} from '../agent-addon-backfill'

/**
 * Unit coverage for the delivery core: the confirmation read, the circuit
 * breaker that bounds attempts and the execution seam. What a node SHOULD have
 * is `agent-desired-set.spec.ts` (D982).
 */

function pkg(name: string, version: string | null = '1.2.14'): NodePackageEntry {
  return { name, version }
}

describe('confirmBackfillPlan', () => {
  const target = {
    name: '@camstack/addon-ai',
    version: '1.2.6',
    versionSource: 'hub-installed' as const,
  }

  it('drops a target the second read already shows at the hub version', () => {
    const { plan, contradicted } = confirmBackfillPlan(
      { targets: [target], retired: [], liveCount: 0 },
      [pkg('@camstack/addon-ai', '1.2.6')],
    )
    expect(plan.targets).toEqual([])
    expect(contradicted).toEqual([target])
  })

  it('keeps a target the second read still shows at a different version', () => {
    const { plan, contradicted } = confirmBackfillPlan(
      { targets: [target], retired: [], liveCount: 1 },
      [pkg('@camstack/addon-ai', '1.2.7')],
    )
    expect(plan.targets).toEqual([target])
    expect(contradicted).toEqual([])
  })

  it('keeps a target the second read still does not list', () => {
    const { plan } = confirmBackfillPlan({ targets: [target], retired: [], liveCount: 0 }, [])
    expect(plan.targets).toEqual([target])
  })
})

describe('BackfillAttemptTracker', () => {
  it('retires a package after MAX_BACKFILL_ATTEMPTS consecutive failures', () => {
    const tracker = new BackfillAttemptTracker()
    const results = Array.from({ length: MAX_BACKFILL_ATTEMPTS }, () =>
      tracker.recordFailure('agent-a', '@camstack/addon-ai', '2.0.0'),
    )

    expect(results.map((r) => r.retired)).toEqual([
      ...Array(MAX_BACKFILL_ATTEMPTS - 1).fill(false),
      true,
    ])
    expect([...tracker.retiredFor('agent-a')]).toEqual(['@camstack/addon-ai'])
  })

  it('scopes retirement per node', () => {
    const tracker = new BackfillAttemptTracker()
    for (let i = 0; i < MAX_BACKFILL_ATTEMPTS; i++) {
      tracker.recordFailure('agent-a', '@camstack/addon-ai', '2.0.0')
    }

    expect([...tracker.retiredFor('macmini')]).toEqual([])
  })

  it('resets the counter when the hub offers a different version', () => {
    const tracker = new BackfillAttemptTracker()
    for (let i = 0; i < MAX_BACKFILL_ATTEMPTS; i++) {
      tracker.recordFailure('agent-a', '@camstack/addon-ai', '2.0.0')
    }
    expect([...tracker.retiredFor('agent-a')]).toEqual(['@camstack/addon-ai'])

    const next = tracker.recordFailure('agent-a', '@camstack/addon-ai', '2.0.1')

    expect(next.attempts).toBe(1)
    expect(next.retired).toBe(false)
    expect([...tracker.retiredFor('agent-a')]).toEqual([])
  })

  it('clears the failure record on success', () => {
    const tracker = new BackfillAttemptTracker()
    tracker.recordFailure('agent-a', '@camstack/addon-ai', '2.0.0')
    tracker.recordSuccess('agent-a', '@camstack/addon-ai')

    expect(tracker.recordFailure('agent-a', '@camstack/addon-ai', '2.0.0').attempts).toBe(1)
  })
})

describe('executeBackfill', () => {
  function makeSeam(overrides: Partial<BackfillSeam> = {}) {
    const packed: string[] = []
    const deployed: string[] = []
    const reloads: string[] = []
    const seam: BackfillSeam = {
      pack: vi.fn(async (name: string) => {
        packed.push(name)
        return Buffer.from(`tgz:${name}`)
      }),
      deploy: vi.fn(async (_nodeId: string, name: string) => {
        deployed.push(name)
      }),
      reload: vi.fn(async (nodeId: string) => {
        reloads.push(nodeId)
      }),
      ...overrides,
    }
    return { seam, packed, deployed, reloads }
  }

  it('delivers each planned package and reloads the agent exactly once', async () => {
    const { seam, deployed, reloads } = makeSeam()
    const outcome = await executeBackfill(
      seam,
      'agent-a',
      {
        targets: [
          { name: '@camstack/addon-ai', version: '2.0.0', versionSource: 'hub-installed' },
          {
            name: '@camstack/addon-post-analysis',
            version: '2.0.0',
            versionSource: 'hub-installed',
          },
        ],
        retired: [],
        liveCount: 0,
      },
      new BackfillAttemptTracker(),
    )

    expect(deployed).toEqual(['@camstack/addon-ai', '@camstack/addon-post-analysis'])
    expect(reloads).toEqual(['agent-a'])
    expect(outcome.delivered.map((d) => d.name)).toEqual([
      '@camstack/addon-ai',
      '@camstack/addon-post-analysis',
    ])
    expect(outcome.failed).toEqual([])
  })

  it('does not reload when nothing was delivered', async () => {
    const { seam, reloads } = makeSeam()
    await executeBackfill(
      seam,
      'agent-a',
      { targets: [], retired: [], liveCount: 0 },
      new BackfillAttemptTracker(),
    )

    expect(reloads).toEqual([])
  })

  it('surfaces a failed install per package and keeps going', async () => {
    const { seam, deployed } = makeSeam({
      pack: vi.fn(async (name: string) => {
        if (name === '@camstack/addon-ai') throw new Error('404 Not Found')
        return Buffer.from(`tgz:${name}`)
      }),
    })

    const outcome = await executeBackfill(
      seam,
      'agent-a',
      {
        targets: [
          { name: '@camstack/addon-ai', version: '2.0.0', versionSource: 'hub-installed' },
          {
            name: '@camstack/addon-post-analysis',
            version: '2.0.0',
            versionSource: 'hub-installed',
          },
        ],
        retired: [],
        liveCount: 0,
      },
      new BackfillAttemptTracker(),
    )

    expect(deployed).toEqual(['@camstack/addon-post-analysis'])
    expect(outcome.failed).toHaveLength(1)
    expect(outcome.failed[0]?.name).toBe('@camstack/addon-ai')
    expect(outcome.failed[0]?.error).toContain('404 Not Found')
    expect(outcome.failed[0]?.retired).toBe(false)
  })

  it('retires a package after the bound and stops attempting it', async () => {
    const tracker = new BackfillAttemptTracker()
    const attempts: string[] = []
    const { seam } = makeSeam({
      pack: vi.fn(async (name: string) => {
        attempts.push(name)
        throw new Error('registry unreachable')
      }),
    })
    const plan: BackfillPlan = {
      targets: [{ name: '@camstack/addon-ai', version: '2.0.0', versionSource: 'hub-installed' }],
      retired: [],
      liveCount: 0,
    }

    for (let i = 0; i < MAX_BACKFILL_ATTEMPTS; i++) {
      await executeBackfill(seam, 'agent-a', plan, tracker)
    }

    expect(attempts).toHaveLength(MAX_BACKFILL_ATTEMPTS)
    expect([...tracker.retiredFor('agent-a')]).toEqual(['@camstack/addon-ai'])

    // The next round's plan excludes it (agent-desired-set.spec.ts) — the loop is
    // bounded, not endless: the breaker itself reports the pair as retired.
    expect(tracker.failuresFor('agent-a')[0]?.retired).toBe(true)
  })
})
