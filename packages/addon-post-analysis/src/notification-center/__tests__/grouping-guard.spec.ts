/**
 * D692 §2.2, the hub's half: `groupingSec` belongs to an immediate DETECTION
 * rule. Refused on create for every other kind; on update the MERGED rule is
 * judged, `clear` included, and only when the patch touched what the verdict
 * reads.
 */
import { NcConfirmSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  assertGroupingApplies,
  guardPatchGrouping,
  guardRuleGrouping,
  NcGroupedConfirmRefusal,
  NcGroupingRefusal,
  type NcGroupingSubject,
} from '../grouping-guard.js'

const AUDIO = { labels: ['audio-scream'], hitPercent: 60, samplingSeconds: 10 }

const refusedShapes: ReadonlyArray<readonly [string, NcGroupingSubject]> = [
  ['track-end', { delivery: 'track-end', conditions: {}, groupingSec: 20 }],
  ['package-event', { delivery: 'package-event', conditions: {}, groupingSec: 20 }],
  ['sound', { delivery: 'immediate', conditions: { audio: AUDIO }, groupingSec: 20 }],
  ['sensor', { delivery: 'device-event', conditions: {}, groupingSec: 20 }],
  [
    'occupancy',
    {
      delivery: 'device-event',
      conditions: {
        occupancy: {
          zoneId: 'z',
          className: 'vehicle',
          op: 'became-free',
          count: 1,
          sustainSeconds: 29,
        },
      },
      groupingSec: 20,
    },
  ],
  [
    'system',
    {
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: ['node-offline'] } },
      groupingSec: 20,
    },
  ],
]

const ctx = (rec: ReturnType<typeof makeLogRecorder>) => ({
  logger: rec.logger,
  by: 'admin',
  ruleId: 'r1',
})

describe('guardRuleGrouping (create)', () => {
  it.each(refusedShapes)('refuses groupingSec on a %s rule', (_name, rule) => {
    const rec = makeLogRecorder()
    expect(() => guardRuleGrouping(rule, { logger: rec.logger, by: 'admin' })).toThrow(
      NcGroupingRefusal,
    )
    const warn = rec.entries.find((e) => e.level === 'warn')
    expect(warn?.message).toBe('nc rule refused: groupingSec on a rule that cannot group')
    expect(warn?.extras?.meta).toMatchObject({ by: 'admin' })
  })

  it('accepts an immediate detection rule', () => {
    const rec = makeLogRecorder()
    guardRuleGrouping(
      {
        delivery: 'immediate',
        conditions: { classes: ['person'] },
        groupingSec: 20,
      },
      { logger: rec.logger, by: 'admin' },
    )
    expect(rec.entries).toHaveLength(0)
  })

  it('accepts a rule with no groupingSec on any kind', () => {
    expect(() => assertGroupingApplies({ delivery: 'track-end', conditions: {} })).not.toThrow()
  })
})

describe('guardPatchGrouping (update, the MERGED rule)', () => {
  const grouped: NcGroupingSubject = {
    delivery: 'immediate',
    conditions: { classes: ['person'] },
    groupingSec: 20,
  }

  it('refuses a patch that turns a grouped rule into a sound rule', () => {
    const rec = makeLogRecorder()
    expect(() =>
      guardPatchGrouping(grouped, { conditions: { audio: AUDIO } }, [], ctx(rec)),
    ).toThrow(NcGroupingRefusal)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      ruleId: 'r1',
      by: 'admin',
    })
  })

  it('accepts the same patch when `clear` names groupingSec', () => {
    const rec = makeLogRecorder()
    guardPatchGrouping(grouped, { conditions: { audio: AUDIO } }, ['groupingSec'], ctx(rec))
    expect(rec.entries).toHaveLength(0)
  })

  it('refuses a patch that moves a grouped rule to track-end', () => {
    expect(() =>
      guardPatchGrouping(grouped, { delivery: 'track-end' }, [], ctx(makeLogRecorder())),
    ).toThrow(NcGroupingRefusal)
  })

  it('refuses a patch that adds groupingSec to a track-end rule', () => {
    expect(() =>
      guardPatchGrouping(
        { delivery: 'track-end', conditions: {} },
        { groupingSec: 30 },
        [],
        ctx(makeLogRecorder()),
      ),
    ).toThrow(NcGroupingRefusal)
  })

  it('accepts a patch that only renames a stored (inert) grouped sound rule', () => {
    const rec = makeLogRecorder()
    const inert: NcGroupingSubject = {
      delivery: 'immediate',
      conditions: { audio: AUDIO },
      groupingSec: 20,
    }
    guardPatchGrouping(inert, {}, [], ctx(rec))
    // A full-form save that re-sends the stored shape is not a touch either.
    guardPatchGrouping(
      inert,
      { delivery: 'immediate', conditions: { audio: AUDIO }, groupingSec: 20 },
      [],
      ctx(rec),
    )
    expect(rec.entries).toHaveLength(0)
  })

  it('accepts a patch on a rule that is not stored', () => {
    guardPatchGrouping(null, { groupingSec: 20 }, [], ctx(makeLogRecorder()))
  })
})

describe('a grouped rule cannot confirm an expectation a single tile never meets', () => {
  const two = NcConfirmSchema.parse({ enabled: true, expect: { op: '>=', count: 2 } })
  const groupedWith = (confirm: NcGroupingSubject['confirm']): NcGroupingSubject => ({
    delivery: 'immediate',
    conditions: { classes: ['person'] },
    groupingSec: 20,
    ...(confirm !== undefined ? { confirm } : {}),
  })

  it('refuses a create that groups and expects 2 or more, and says why at WARN', () => {
    const rec = makeLogRecorder()
    expect(() => guardRuleGrouping(groupedWith(two), { logger: rec.logger, by: 'admin' })).toThrow(
      NcGroupedConfirmRefusal,
    )
    expect(() => assertGroupingApplies(groupedWith(two))).toThrow(/each tile/)
    expect(rec.entries.find((e) => e.level === 'warn')?.extras?.meta).toMatchObject({
      by: 'admin',
      expect: '>= 2',
    })
  })

  it.each([
    ['== 2', { op: '==', count: 2 }],
    ['> 1', { op: '>', count: 1 }],
    ['== 0', { op: '==', count: 0 }],
  ] as const)('refuses %s, which one subject cannot meet', (_name, want) => {
    expect(() => assertGroupingApplies(groupedWith({ enabled: true, expect: want }))).toThrow(
      NcGroupedConfirmRefusal,
    )
  })

  it('accepts an expectation one subject meets, a disabled gate, and an ungrouped rule', () => {
    assertGroupingApplies(groupedWith({ enabled: true, expect: { op: '>=', count: 1 } }))
    assertGroupingApplies(groupedWith({ enabled: true, expect: { op: '==', count: 1 } }))
    assertGroupingApplies(groupedWith({ enabled: false, expect: { op: '>=', count: 2 } }))
    assertGroupingApplies(groupedWith({ enabled: true }))
    assertGroupingApplies({
      delivery: 'immediate',
      conditions: { classes: ['person'] },
      confirm: two,
    })
  })

  it('judges the MERGED rule on update: a patch that adds the expectation, or the grouping', () => {
    const ctxOf = ctx(makeLogRecorder())
    expect(() => guardPatchGrouping(groupedWith(undefined), { confirm: two }, [], ctxOf)).toThrow(
      NcGroupedConfirmRefusal,
    )
    expect(() =>
      guardPatchGrouping(
        { delivery: 'immediate', conditions: { classes: ['person'] }, confirm: two },
        { groupingSec: 20 },
        [],
        ctxOf,
      ),
    ).toThrow(NcGroupedConfirmRefusal)
  })

  it('accepts the same patch when `clear` removes the confirm block or the grouping', () => {
    const rec = makeLogRecorder()
    guardPatchGrouping(
      groupedWith(two),
      { conditions: { classes: ['dog'] } },
      ['confirm'],
      ctx(rec),
    )
    guardPatchGrouping(
      groupedWith(two),
      { conditions: { classes: ['dog'] } },
      ['groupingSec'],
      ctx(rec),
    )
    expect(rec.entries).toHaveLength(0)
  })

  it('a rename of a stored (inert) rule that already holds both is not re-judged', () => {
    const rec = makeLogRecorder()
    const stored = groupedWith(two)
    guardPatchGrouping(stored, {}, [], ctx(rec))
    guardPatchGrouping(stored, { confirm: two, groupingSec: 20 }, [], ctx(rec))
    expect(rec.entries).toHaveLength(0)
  })

  it('a confirm-only change on a stored rule that cannot group runs no grouping check', () => {
    const rec = makeLogRecorder()
    const inertTrackEnd: NcGroupingSubject = {
      delivery: 'track-end',
      conditions: {},
      groupingSec: 20,
    }
    guardPatchGrouping(inertTrackEnd, { confirm: two }, [], ctx(rec))
    expect(rec.entries).toHaveLength(0)
  })

  it('a confirm-only change on a rule that groups is still judged on the confirm alone', () => {
    expect(() =>
      guardPatchGrouping(groupedWith(undefined), { confirm: two }, [], ctx(makeLogRecorder())),
    ).toThrow(NcGroupedConfirmRefusal)
  })

  it('the confirm WARN says the expectation is one a single subject cannot meet', () => {
    const rec = makeLogRecorder()
    expect(() => guardRuleGrouping(groupedWith(two), { logger: rec.logger, by: 'admin' })).toThrow()
    expect(rec.entries.find((e) => e.level === 'warn')?.message).toBe(
      'nc rule refused: a grouped rule cannot confirm an expectation a single subject cannot meet',
    )
  })
})

describe('the grouping refusal tells an older editor how to leave', () => {
  it('names the way out: clear groupingSec in an editor that shows it', () => {
    expect(() =>
      assertGroupingApplies({ delivery: 'track-end', conditions: {}, groupingSec: 20 }),
    ).toThrow(/turn grouping off in an editor that shows it \(clear groupingSec\)/)
  })
})
