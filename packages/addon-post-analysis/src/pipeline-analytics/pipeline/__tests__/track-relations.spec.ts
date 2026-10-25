/**
 * The one body behind the four cap methods and the four `debug.gt.*` actions
 * (spec §4.3). Pinned from the store contract alone:
 *
 *  - refusals by name: self-relation, unknown-track, cross-device,
 *    switch-outside-track, switch-needs-mixed;
 *  - re-marking a pair REPLACES (one row per unordered pair);
 *  - a `different-subjects` inside a same-subject chain is refused and the
 *    error names the chain; the mirror (a `same-subject` joining two
 *    components a `different-subjects` separates) too;
 *  - every mark sets `debug` on the tracks it names;
 *  - `pure` deletes the purity row;
 *  - the tables are held at their COUNT ceilings.
 *
 * Disarm: skip the chain check in `setTrackRelation` — the contradiction test
 * must fail.
 *
 * Fix round 1 additions: `clearTrackRelation` refuses a device that doesn't
 * own the stored row (disarm: skip that check — the cross-device test must
 * fail), and `setTrackPurity` refuses `switchAtMs` on anything but `mixed`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { TrackRelationsStore } from '../../store/track-relations-store.js'
import {
  clearTrackRelation,
  firstTrackFacts,
  listTrackRelations,
  setTrackPurity,
  setTrackRelation,
  TrackRelationRefusedError,
  type TrackFacts,
  type TrackRelationsDeps,
} from '../track-relations.js'

const TRACKS: Record<string, TrackFacts> = {
  A: { trackId: 'A', deviceId: 101, firstSeen: 1_000, lastSeen: 2_000 },
  B: { trackId: 'B', deviceId: 101, firstSeen: 3_000, lastSeen: 4_000 },
  C: { trackId: 'C', deviceId: 101, firstSeen: 5_000, lastSeen: 6_000 },
  D: { trackId: 'D', deviceId: 101, firstSeen: 5_500, lastSeen: 6_500 },
  X: { trackId: 'X', deviceId: 102, firstSeen: 1_000, lastSeen: 2_000 },
}

describe('track relations body', () => {
  let deps: TrackRelationsDeps
  let debugMarked: string[]

  beforeEach(async () => {
    const { ledgers } = await makeAnalyticsWorld()
    debugMarked = []
    deps = {
      store: new TrackRelationsStore({
        relationsLedger: ledgers.trackRelations,
        purityLedger: ledgers.trackPurity,
        logger: makeSilentLogger(),
        maxRelations: 3,
      }),
      resolveTrack: async (id) => TRACKS[id] ?? null,
      markDebug: async (_deviceId, trackId) => {
        debugMarked.push(trackId)
      },
      now: () => 10_000,
      author: 'operator',
    }
  })

  async function refusal(p: Promise<unknown>): Promise<string> {
    try {
      await p
    } catch (err) {
      if (err instanceof TrackRelationRefusedError) return err.code
      throw err
    }
    return 'accepted'
  }

  it('refuses by name', async () => {
    expect(
      await refusal(
        setTrackRelation(deps, {
          deviceId: 101,
          trackId: 'A',
          otherTrackId: 'A',
          relation: 'same-subject',
        }),
      ),
    ).toBe('self-relation')
    expect(
      await refusal(
        setTrackRelation(deps, {
          deviceId: 101,
          trackId: 'A',
          otherTrackId: 'Z',
          relation: 'same-subject',
        }),
      ),
    ).toBe('unknown-track')
    expect(
      await refusal(
        setTrackRelation(deps, {
          deviceId: 101,
          trackId: 'A',
          otherTrackId: 'X',
          relation: 'same-subject',
        }),
      ),
    ).toBe('cross-device')
    expect(
      await refusal(
        setTrackPurity(deps, { deviceId: 101, trackId: 'A', purity: 'mixed', switchAtMs: 9_000 }),
      ),
    ).toBe('switch-outside-track')
  })

  it('refuses switchAtMs unless purity is mixed', async () => {
    expect(
      await refusal(
        setTrackPurity(deps, {
          deviceId: 101,
          trackId: 'A',
          purity: 'not-a-subject',
          switchAtMs: 1_500,
        }),
      ),
    ).toBe('switch-needs-mixed')
    expect(
      await refusal(
        setTrackPurity(deps, { deviceId: 101, trackId: 'A', purity: 'pure', switchAtMs: 1_500 }),
      ),
    ).toBe('switch-needs-mixed')
  })

  it('refuses to clear a relation belonging to another device', async () => {
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'A',
      otherTrackId: 'B',
      relation: 'same-subject',
    })
    expect(
      await refusal(clearTrackRelation(deps, { deviceId: 102, trackId: 'A', otherTrackId: 'B' })),
    ).toBe('cross-device')
    expect((await listTrackRelations(deps, { deviceId: 101 })).relations).toHaveLength(1)
    expect(
      (await clearTrackRelation(deps, { deviceId: 101, trackId: 'A', otherTrackId: 'B' })).cleared,
    ).toBe(true)
    expect((await listTrackRelations(deps, { deviceId: 101 })).relations).toHaveLength(0)
  })

  it('stores one row per unordered pair and marks both tracks debug', async () => {
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'B',
      otherTrackId: 'A',
      relation: 'same-subject',
      presence: 'continuous',
      trackSide: 'after',
    })
    const again = await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'A',
      otherTrackId: 'B',
      relation: 'same-subject',
    })
    expect(again).toMatchObject({
      leftTrackId: 'A',
      rightTrackId: 'B',
      leftStartedAt: 1_000,
      rightStartedAt: 3_000,
      presence: null,
    })
    const listed = await listTrackRelations(deps, { deviceId: 101 })
    expect(listed.relations).toHaveLength(1)
    expect(debugMarked).toEqual(['B', 'A', 'A', 'B'])
  })

  it('refuses a different-subjects inside a same-subject chain, naming the chain', async () => {
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'A',
      otherTrackId: 'B',
      relation: 'same-subject',
    })
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'B',
      otherTrackId: 'C',
      relation: 'same-subject',
    })
    await expect(
      setTrackRelation(deps, {
        deviceId: 101,
        trackId: 'A',
        otherTrackId: 'C',
        relation: 'different-subjects',
      }),
    ).rejects.toThrow('A → B → C')
  })

  it('refuses a same-subject that joins two components kept apart', async () => {
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'A',
      otherTrackId: 'C',
      relation: 'different-subjects',
    })
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'A',
      otherTrackId: 'B',
      relation: 'same-subject',
    })
    expect(
      await refusal(
        setTrackRelation(deps, {
          deviceId: 101,
          trackId: 'B',
          otherTrackId: 'C',
          relation: 'same-subject',
        }),
      ),
    ).toBe('contradiction')
  })

  it('pure deletes the purity row', async () => {
    const mixed = await setTrackPurity(deps, {
      deviceId: 101,
      trackId: 'A',
      purity: 'mixed',
      switchAtMs: 1_500,
    })
    expect(mixed.purity).toMatchObject({
      sourceTrackId: 'A',
      purity: 'mixed',
      switchAtMs: 1_500,
      startedAt: 1_000,
    })
    expect(
      (await setTrackPurity(deps, { deviceId: 101, trackId: 'A', purity: 'pure' })).purity,
    ).toBeNull()
    expect((await listTrackRelations(deps, { deviceId: 101 })).purities).toEqual([])
  })

  it('holds the relation table at its count ceiling, oldest first', async () => {
    let t = 10_000
    deps = { ...deps, now: () => (t += 1) }
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'A',
      otherTrackId: 'B',
      relation: 'different-subjects',
    })
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'A',
      otherTrackId: 'C',
      relation: 'different-subjects',
    })
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'A',
      otherTrackId: 'D',
      relation: 'different-subjects',
    })
    await setTrackRelation(deps, {
      deviceId: 101,
      trackId: 'B',
      otherTrackId: 'C',
      relation: 'different-subjects',
    })
    const pairs = (await listTrackRelations(deps, { deviceId: 101 })).relations.map(
      (r) => `${r.leftTrackId}${r.rightTrackId}`,
    )
    expect(pairs.toSorted()).toEqual(['AC', 'AD', 'BC'])
  })
})

describe('firstTrackFacts', () => {
  it('asks each source in order and stops at the first answer', async () => {
    const asked: string[] = []
    const facts = await firstTrackFacts('A', [
      async () => {
        asked.push('live')
        return null
      },
      async () => {
        asked.push('stored')
        return TRACKS.A ?? null
      },
      async () => {
        asked.push('tape')
        return null
      },
    ])
    expect(facts?.firstSeen).toBe(1_000)
    expect(asked).toEqual(['live', 'stored'])
  })
})
