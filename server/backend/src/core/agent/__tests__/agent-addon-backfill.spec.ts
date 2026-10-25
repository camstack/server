import { describe, expect, it, vi } from 'vitest'
import {
  BackfillAttemptTracker,
  type BackfillPlan,
  type BackfillSeam,
  computeBackfillPlan,
  confirmBackfillPlan,
  executeBackfill,
  MAX_BACKFILL_ATTEMPTS,
  type NodePackageEntry,
} from '../agent-addon-backfill'

/**
 * Unit coverage for the pure back-fill core: the plan (what a node is missing
 * relative to its own last-declared roster) and the circuit breaker that bounds
 * delivery attempts.
 *
 * The plan is deliberately pure so the "what should this node have" decision
 * can be asserted without Moleculer, a filesystem or an npm registry.
 */

const BOOTSTRAP: ReadonlySet<string> = new Set(['@camstack/system', '@camstack/addon-agent-ui'])

function pkg(name: string, version: string | null = '1.2.14'): NodePackageEntry {
  return { name, version }
}

function planInput(overrides: Partial<Parameters<typeof computeBackfillPlan>[0]> = {}) {
  return {
    recorded: [] as readonly NodePackageEntry[],
    live: [] as readonly NodePackageEntry[],
    bootstrap: BOOTSTRAP,
    undeployed: new Set<string>(),
    retired: new Set<string>(),
    hubVersions: new Map<string, string>(),
    ...overrides,
  }
}

describe('computeBackfillPlan', () => {
  it('plans every recorded package a wiped node no longer reports', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [
          pkg('@camstack/addon-pipeline'),
          pkg('@camstack/addon-ai'),
          pkg('@camstack/addon-post-analysis'),
        ],
        live: [pkg('@camstack/addon-pipeline')],
        hubVersions: new Map([
          ['@camstack/addon-ai', '2.0.0'],
          ['@camstack/addon-post-analysis', '2.0.0'],
        ]),
      }),
    )

    expect(plan.targets.map((t) => t.name)).toEqual([
      '@camstack/addon-ai',
      '@camstack/addon-post-analysis',
    ])
  })

  it('moves a node that is AHEAD of the hub down to the hub version', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-ai', '1.2.7')],
        live: [pkg('@camstack/addon-ai', '1.2.7')],
        hubVersions: new Map([['@camstack/addon-ai', '1.2.6']]),
      }),
    )
    expect(plan.targets).toEqual([
      { name: '@camstack/addon-ai', version: '1.2.6', versionSource: 'hub-installed' },
    ])
  })

  it('moves a node that is behind the hub up to the hub version', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-ai', '1.2.5')],
        live: [pkg('@camstack/addon-ai', '1.2.5')],
        hubVersions: new Map([['@camstack/addon-ai', '1.2.6']]),
      }),
    )
    expect(plan.targets).toEqual([
      { name: '@camstack/addon-ai', version: '1.2.6', versionSource: 'hub-installed' },
    ])
  })

  it('leaves an installed package alone when the hub version is unknown', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-ai', '1.2.7')],
        live: [pkg('@camstack/addon-ai', '1.2.7')],
      }),
    )
    expect(plan.targets).toEqual([])
    expect(plan.notOnHub).toEqual([])
  })

  it('is a no-op for a complete node already on the hub version', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-pipeline'), pkg('@camstack/addon-ai')],
        live: [pkg('@camstack/addon-pipeline'), pkg('@camstack/addon-ai')],
        hubVersions: new Map([
          ['@camstack/addon-pipeline', '1.2.14'],
          ['@camstack/addon-ai', '1.2.14'],
        ]),
      }),
    )

    expect(plan.targets).toEqual([])
    expect(plan.notOnHub).toEqual([])
    expect(plan.retired).toEqual([])
  })

  it('pins the hub-installed version, not the version the node last ran', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-ai', '1.0.0')],
        hubVersions: new Map([['@camstack/addon-ai', '2.5.1']]),
      }),
    )

    expect(plan.targets).toEqual([
      { name: '@camstack/addon-ai', version: '2.5.1', versionSource: 'hub-installed' },
    ])
  })

  it('never re-installs a package the hub no longer installs, whatever the node last ran', () => {
    // 2026-10-08: decoder-ffmpeg was uninstalled on the hub and the agent's copy
    // moved aside; the node's declared roster still named it at 1.0.0, and the
    // old fallback would have reinstalled it from npm on the next reconnect.
    const plan = computeBackfillPlan(
      planInput({ recorded: [pkg('@camstack/addon-decoder-ffmpeg', '1.0.0')] }),
    )

    expect(plan.targets).toEqual([])
    expect(plan.notOnHub).toEqual(['@camstack/addon-decoder-ffmpeg'])
  })

  it('reports a recorded package with no version that the hub lacks instead of guessing "latest"', () => {
    const plan = computeBackfillPlan(planInput({ recorded: [pkg('@camstack/addon-ai', null)] }))

    expect(plan.targets).toEqual([])
    expect(plan.notOnHub).toEqual(['@camstack/addon-ai'])
  })

  it('never back-fills agent bootstrap infrastructure', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/system'), pkg('@camstack/addon-agent-ui')],
        hubVersions: new Map([
          ['@camstack/system', '1.2.14'],
          ['@camstack/addon-agent-ui', '1.2.14'],
        ]),
      }),
    )

    expect(plan.targets).toEqual([])
  })

  it('never re-delivers a package undeployed in the same pass', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-ghost')],
        undeployed: new Set(['@camstack/addon-ghost']),
        hubVersions: new Map([['@camstack/addon-ghost', '1.0.0']]),
      }),
    )

    expect(plan.targets).toEqual([])
  })

  it('skips a package the circuit breaker has retired', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-ai')],
        retired: new Set(['@camstack/addon-ai']),
      }),
    )

    expect(plan.targets).toEqual([])
    expect(plan.retired).toEqual(['@camstack/addon-ai'])
  })
})

describe('confirmBackfillPlan', () => {
  const target = {
    name: '@camstack/addon-ai',
    version: '1.2.6',
    versionSource: 'hub-installed' as const,
  }

  it('drops a target the second read already shows at the hub version', () => {
    const { plan, contradicted } = confirmBackfillPlan(
      { targets: [target], retired: [], notOnHub: [], liveCount: 0 },
      [pkg('@camstack/addon-ai', '1.2.6')],
    )
    expect(plan.targets).toEqual([])
    expect(contradicted).toEqual([target])
  })

  it('keeps a target the second read still shows at a different version', () => {
    const { plan, contradicted } = confirmBackfillPlan(
      { targets: [target], retired: [], notOnHub: [], liveCount: 1 },
      [pkg('@camstack/addon-ai', '1.2.7')],
    )
    expect(plan.targets).toEqual([target])
    expect(contradicted).toEqual([])
  })

  it('keeps a target the second read still does not list', () => {
    const { plan } = confirmBackfillPlan(
      { targets: [target], retired: [], notOnHub: [], liveCount: 0 },
      [],
    )
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
        notOnHub: [],
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
      { targets: [], retired: [], notOnHub: [], liveCount: 0 },
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
        notOnHub: [],
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
      notOnHub: [],
      liveCount: 0,
    }

    for (let i = 0; i < MAX_BACKFILL_ATTEMPTS; i++) {
      await executeBackfill(seam, 'agent-a', plan, tracker)
    }

    expect(attempts).toHaveLength(MAX_BACKFILL_ATTEMPTS)
    expect([...tracker.retiredFor('agent-a')]).toEqual(['@camstack/addon-ai'])

    // The next PLAN would exclude it — proving the loop is bounded, not endless.
    const nextPlan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-ai')],
        hubVersions: new Map([['@camstack/addon-ai', '2.0.0']]),
        retired: tracker.retiredFor('agent-a'),
      }),
    )
    expect(nextPlan.targets).toEqual([])
    expect(nextPlan.retired).toEqual(['@camstack/addon-ai'])
  })
})
