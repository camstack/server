/**
 * `planPlacement` — the PURE weighted planner.
 *
 * The unit of placement is a (camera, profile) ASSIGNMENT, not a segment: one
 * writer run writes one directory on one filesystem, because `.rec-tmp` staging
 * lives under the chosen root so the finalize relocate is a same-fs rename.
 * Balancing therefore means choosing which location each camera-profile lands
 * on, weighted by how much each location can still absorb.
 *
 * Two properties this file exists to pin:
 *
 *   - STICKINESS. A plan that moves a camera every tick is worse than no plan:
 *     each move costs a writer restart and a recording gap. Nothing moves until
 *     a location is off its target share by more than the hysteresis band, or
 *     it must be vacated outright.
 *   - PURITY. No clock, no rotation state, no I/O (D37: the fair tie-break is a
 *     re-ranker OUTSIDE the planner, injected as `breakTie`). Same input, same
 *     plan, always.
 */
import { describe, expect, it } from 'vitest'
import {
  type PlacementCandidate,
  type PlacementDemand,
  planPlacement,
} from '../addon/placement-planner.js'

const GB = 1_000_000_000

function candidate(
  locationId: string,
  headroomGb: number,
  type = 'recordings',
): PlacementCandidate {
  return { locationId, type, headroomBytes: headroomGb * GB }
}

function demand(key: string, dailyGb: number, type = 'recordings'): PlacementDemand {
  return { key, type, dailyBytes: dailyGb * GB }
}

describe('planPlacement — the single-location invariant', () => {
  it('places every demand on the only location, and never moves anything', () => {
    const only = [candidate('recordings:default', 500)]
    const demands = [demand('101:high', 30), demand('104:high', 20), demand('102:low', 5)]

    const first = planPlacement({ candidates: only, demands, current: new Map() })
    expect([...first.assignments.values()]).toEqual([
      'recordings:default',
      'recordings:default',
      'recordings:default',
    ])

    // Re-planning from the produced state is a no-op — nothing to balance.
    const second = planPlacement({ candidates: only, demands, current: first.assignments })
    expect(second.changes).toEqual([])
    expect(second.assignments).toEqual(first.assignments)
  })

  it('a demand whose preferred type is absent falls back to the writable pool (one disk today)', () => {
    const only = [candidate('recordings:default', 500)]
    const plan = planPlacement({
      candidates: only,
      demands: [demand('101:low', 5, 'recordingsLow')],
      current: new Map(),
    })
    expect(plan.assignments.get('101:low')).toBe('recordings:default')
  })
})

describe('planPlacement — weighting by headroom', () => {
  it('splits demand in proportion to headroom, not evenly', () => {
    const candidates = [candidate('recordings:big', 900), candidate('recordings:small', 100)]
    // Ten equal cameras: 9 belong on the big disk, 1 on the small.
    const demands = Array.from({ length: 10 }, (_, i) => demand(`${600 + i}:high`, 10))

    const plan = planPlacement({ candidates, demands, current: new Map() })
    const onSmall = [...plan.assignments.values()].filter((id) => id === 'recordings:small')
    expect(onSmall).toHaveLength(1)
  })

  it('a location with NO headroom receives nothing', () => {
    const candidates = [candidate('recordings:ok', 500), candidate('recordings:full', 0)]
    const demands = [demand('101:high', 10), demand('104:high', 10)]

    const plan = planPlacement({ candidates, demands, current: new Map() })
    expect([...plan.assignments.values()]).toEqual(['recordings:ok', 'recordings:ok'])
  })

  it('falls back to an EVEN split when no location reports headroom (nothing is known yet)', () => {
    const candidates = [candidate('recordings:a', 0), candidate('recordings:b', 0)]
    const demands = [demand('101:high', 10), demand('104:high', 10)]

    const plan = planPlacement({ candidates, demands, current: new Map() })
    expect(new Set(plan.assignments.values()).size).toBe(2)
  })

  it('balances by COUNT when no byte rate has been measured yet', () => {
    const candidates = [candidate('recordings:a', 100), candidate('recordings:b', 100)]
    const demands = [demand('101:high', 0), demand('104:high', 0)]

    const plan = planPlacement({ candidates, demands, current: new Map() })
    expect(new Set(plan.assignments.values()).size).toBe(2)
  })
})

describe('planPlacement — hysteresis', () => {
  const candidates = [candidate('recordings:a', 500), candidate('recordings:b', 500)]

  it('keeps a mildly off-target assignment rather than churning a live writer', () => {
    // 55/45 against a 50/50 target: 5pp off, well inside the 15pp band.
    const demands = [demand('101:high', 55), demand('104:high', 25), demand('102:high', 20)]
    const current = new Map([
      ['101:high', 'recordings:a'],
      ['104:high', 'recordings:b'],
      ['102:high', 'recordings:b'],
    ])

    const plan = planPlacement({ candidates, demands, current })
    expect(plan.changes).toEqual([])
    expect(plan.assignments).toEqual(current)
  })

  it('holds still even when a move WOULD improve the split, while inside the band', () => {
    // 58/42 against 50/50 — 8pp off, and moving the 13 GB camera really would
    // land at 45/55. The band is the ONLY thing holding it: without it this
    // plan churns a writer for 5 percentage points.
    const demands = [
      demand('101:high', 30),
      demand('104:high', 15),
      demand('102:high', 13),
      demand('618:high', 22),
      demand('619:high', 20),
    ]
    const current = new Map([
      ['101:high', 'recordings:a'],
      ['104:high', 'recordings:a'],
      ['102:high', 'recordings:a'],
      ['618:high', 'recordings:b'],
      ['619:high', 'recordings:b'],
    ])

    expect(planPlacement({ candidates, demands, current }).changes).toEqual([])
    // Drop the band and the same input moves — proof the band, not the
    // improvement check, is what held it.
    const eager = planPlacement({ candidates, demands, current, offTargetPp: 0 })
    expect(eager.changes.map((c) => c.key)).toEqual(['102:high'])
  })

  it('rebalances once a location is off target by MORE than the band', () => {
    // Everything on `a`: 100% against a 50% target.
    const demands = [demand('101:high', 25), demand('104:high', 25), demand('102:high', 25)]
    const current = new Map([
      ['101:high', 'recordings:a'],
      ['104:high', 'recordings:a'],
      ['102:high', 'recordings:a'],
    ])

    const plan = planPlacement({ candidates, demands, current })
    expect(plan.changes.length).toBeGreaterThan(0)
    expect(plan.changes.every((c) => c.reason === 'off-target')).toBe(true)
    expect(new Set(plan.assignments.values())).toEqual(new Set(['recordings:a', 'recordings:b']))
  })

  it('the band is configurable, and a wider one holds more still', () => {
    const demands = [demand('101:high', 25), demand('104:high', 25), demand('102:high', 25)]
    const current = new Map([
      ['101:high', 'recordings:a'],
      ['104:high', 'recordings:a'],
      ['102:high', 'recordings:a'],
    ])
    expect(planPlacement({ candidates, demands, current, offTargetPp: 100 }).changes).toEqual([])
  })
})

describe('planPlacement — locations that must be vacated', () => {
  const candidates = [candidate('recordings:a', 500), candidate('recordings:b', 500)]

  it('moves off an evacuating location immediately, hysteresis or not', () => {
    const demands = [demand('101:high', 10)]
    const current = new Map([['101:high', 'recordings:a']])

    const plan = planPlacement({
      candidates,
      demands,
      current,
      evacuate: new Set(['recordings:a']),
    })
    expect(plan.assignments.get('101:high')).toBe('recordings:b')
    expect(plan.changes[0]?.reason).toBe('evacuate')
  })

  it('moves off a location that no longer exists', () => {
    const demands = [demand('101:high', 10)]
    const current = new Map([['101:high', 'recordings:gone']])

    const plan = planPlacement({ candidates, demands, current })
    expect(plan.assignments.get('101:high')).toBe('recordings:a')
    expect(plan.changes[0]?.reason).toBe('gone')
  })

  it('an evacuating location still takes work when it is the ONLY one — never nowhere', () => {
    const plan = planPlacement({
      candidates: [candidate('recordings:a', 0)],
      demands: [demand('101:high', 10)],
      current: new Map([['101:high', 'recordings:a']]),
      evacuate: new Set(['recordings:a']),
    })
    expect(plan.assignments.get('101:high')).toBe('recordings:a')
  })

  it('no candidates at all yields no assignments (the caller throws — loudly)', () => {
    const plan = planPlacement({
      candidates: [],
      demands: [demand('101:high', 10)],
      current: new Map(),
    })
    expect(plan.assignments.size).toBe(0)
  })
})

describe('planPlacement — determinism and the injected tie-break', () => {
  it('is deterministic: the same input always yields the same plan', () => {
    const candidates = [candidate('recordings:a', 100), candidate('recordings:b', 100)]
    const demands = [demand('101:high', 10), demand('104:high', 10)]
    const a = planPlacement({ candidates, demands, current: new Map() })
    const b = planPlacement({ candidates, demands, current: new Map() })
    expect([...a.assignments]).toEqual([...b.assignments])
  })

  it('defers a genuine tie to the injected re-ranker (D37: rotation lives OUTSIDE)', () => {
    const candidates = [candidate('recordings:a', 100), candidate('recordings:b', 100)]
    const seen: string[][] = []
    const plan = planPlacement({
      candidates,
      demands: [demand('101:high', 10)],
      current: new Map(),
      breakTie: (tied) => {
        seen.push([...tied])
        return tied[tied.length - 1]!
      },
    })
    expect(seen).toEqual([['recordings:a', 'recordings:b']])
    expect(plan.assignments.get('101:high')).toBe('recordings:b')
  })

  it('never consults the re-ranker when the capacity signal separates the candidates', () => {
    const candidates = [candidate('recordings:a', 900), candidate('recordings:b', 100)]
    let consulted = 0
    planPlacement({
      candidates,
      demands: [demand('101:high', 10)],
      current: new Map(),
      breakTie: (tied) => {
        consulted += 1
        return tied[0]!
      },
    })
    expect(consulted).toBe(0)
  })
})

describe('planPlacement — independent pools per location type', () => {
  it('balances recordingsLow demands only across recordingsLow locations', () => {
    const candidates = [
      candidate('recordings:a', 500),
      candidate('recordingsLow:x', 100, 'recordingsLow'),
      candidate('recordingsLow:y', 100, 'recordingsLow'),
    ]
    const demands = [
      demand('101:high', 30),
      demand('101:low', 5, 'recordingsLow'),
      demand('104:low', 5, 'recordingsLow'),
    ]
    const plan = planPlacement({ candidates, demands, current: new Map() })

    expect(plan.assignments.get('101:high')).toBe('recordings:a')
    expect(new Set([plan.assignments.get('101:low'), plan.assignments.get('104:low')])).toEqual(
      new Set(['recordingsLow:x', 'recordingsLow:y']),
    )
  })
})

/**
 * The operator adds a second, empty disk to a nearly-full one. D387.
 *
 * The live shape, verbatim: `recordings:default` is 89% full (~24 GB of
 * headroom left once its 10% floor is honoured) and holds all 19 recordings
 * assignments; `recordings:recordings-high-4tb` is a fresh 4 TB disk with
 * ~3.25 TB of headroom and holds none. The plan MUST move work onto it.
 *
 * What made it not: `dailyBytes` is a MEASURED rate and it is 0 for every
 * camera the RAM index has not accounted for yet (D287 — the index holds the
 * live tail plus whatever a reader hydrated, so a camera nobody has viewed
 * since boot measures nothing). Phase C moves the SMALLEST demand on the
 * overloaded location, which is one of those zero-byte ones; moving 0 bytes
 * changes neither side's distance from target, the strict-improvement check
 * therefore fails, and the loop `break`s on its FIRST iteration. One measured
 * camera in the pool was enough to make every unmeasured one weightless and
 * wedge the whole rebalance — permanently, on every 30 s tick, in silence.
 */
describe('planPlacement — a demand nobody has measured is not weightless (D387)', () => {
  const NEARLY_FULL = candidate('recordings:default', 24)
  const FRESH_4TB = candidate('recordings:recordings-high-4tb', 3250)

  /** 19 recordings assignments, all on the nearly-full disk. */
  function liveFleet(measuredKeys: ReadonlySet<string>): {
    demands: PlacementDemand[]
    current: Map<string, string>
  } {
    const demands: PlacementDemand[] = []
    const current = new Map<string, string>()
    for (let i = 0; i < 19; i += 1) {
      const key = `${String(600 + i)}:high`
      demands.push(demand(key, measuredKeys.has(key) ? 30 : 0))
      current.set(key, 'recordings:default')
    }
    return { demands, current }
  }

  it('rebalances onto the fresh disk when ONE camera in the pool has a measured rate', () => {
    const { demands, current } = liveFleet(new Set(['600:high']))

    const plan = planPlacement({ candidates: [NEARLY_FULL, FRESH_4TB], demands, current })

    const onFresh = [...plan.assignments.values()].filter(
      (id) => id === 'recordings:recordings-high-4tb',
    )
    expect(plan.changes.length).toBeGreaterThan(0)
    expect(onFresh.length).toBeGreaterThan(0)
    for (const change of plan.changes) {
      expect(change.to).toBe('recordings:recordings-high-4tb')
      expect(change.reason).toBe('off-target')
    }
  })

  it('rebalances the same fleet when NOTHING has been measured (count balancing)', () => {
    const { demands, current } = liveFleet(new Set())

    const plan = planPlacement({ candidates: [NEARLY_FULL, FRESH_4TB], demands, current })

    expect(plan.changes.length).toBeGreaterThan(0)
  })

  it('an unmeasured demand weighs a MEASURED peer, so it can never wedge the loop', () => {
    // One measured 30 GB/day camera and one unmeasured, on a 50/50 pool that
    // holds both on the same side. The unmeasured one is the smaller demand,
    // so it is the one Phase C reaches for — and it has to carry weight.
    const even = [candidate('recordings:a', 500), candidate('recordings:b', 500)]
    const demands = [demand('101:high', 0), demand('104:high', 30)]
    const current = new Map([
      ['101:high', 'recordings:a'],
      ['104:high', 'recordings:a'],
    ])

    const plan = planPlacement({ candidates: even, demands, current })

    expect(plan.assignments.get('101:high')).toBe('recordings:b')
  })
})
