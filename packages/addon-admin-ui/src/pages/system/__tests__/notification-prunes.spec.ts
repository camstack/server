/**
 * The banner on a rule the deleted-device prune switched off.
 *
 * The server keeps a rule whose LAST device was deleted (removing it would
 * widen the rule to every camera) and switches it off, recording why in
 * `nc.listPrunes`. Without the banner, a rule that turned itself off reads as
 * a bug. With a wrong banner, a rule the OPERATOR switched off would be blamed
 * on a deletion — so it shows only while the rule is still off, and only for
 * the outcome that really switched it off.
 */
import { describe, expect, it } from 'vitest'
import {
  type NcPruneView,
  parsePrunes,
  pruneBannerFor,
  pruneBannerText,
} from '../notification-prunes'

const KEPT: NcPruneView = {
  kind: 'rule',
  ruleId: 'r1',
  subjectKind: 'device',
  subject: '102',
  field: 'conditions.devices',
  outcome: 'kept-disabled',
  at: Date.UTC(2026, 8, 25, 10, 0),
}

describe('parsePrunes', () => {
  it('reads the action answer', () => {
    expect(parsePrunes({ prunes: [{ ...KEPT, source: 'event' }] })).toEqual([KEPT])
  })

  it('answers null for a shape this build cannot read — never an empty list', () => {
    expect(parsePrunes(null)).toBeNull()
    expect(parsePrunes({ produced: 1 })).toBeNull()
  })

  it('skips a row it cannot read and keeps the rest', () => {
    expect(parsePrunes({ prunes: [KEPT, { kind: 'rule' }] })).toEqual([KEPT])
  })
})

describe('pruneBannerFor', () => {
  it('names the kept-disabled prune of a rule that is still off', () => {
    expect(pruneBannerFor([KEPT], 'rule', 'r1', false, KEPT.at)).toEqual(KEPT)
  })

  it('shows nothing once the operator switched the rule back on', () => {
    expect(pruneBannerFor([KEPT], 'rule', 'r1', true, KEPT.at)).toBeNull()
  })

  it('shows nothing for a removal, or a rule that was already off', () => {
    expect(
      pruneBannerFor([{ ...KEPT, outcome: 'removed' }], 'rule', 'r1', false, KEPT.at),
    ).toBeNull()
    expect(pruneBannerFor([{ ...KEPT, outcome: 'kept' }], 'rule', 'r1', false, KEPT.at)).toBeNull()
  })

  it('a LATER prune write on the same still-disabled rule keeps the banner', () => {
    const later = {
      ...KEPT,
      subject: 't-x',
      subjectKind: 'target' as const,
      field: 'targets',
      outcome: 'removed' as const,
      at: KEPT.at + 5_000,
    }
    // The later prune write bumped the rule's updatedAt past the kept row.
    expect(pruneBannerFor([KEPT, later], 'rule', 'r1', false, KEPT.at + 4_000)).toEqual(KEPT)
  })

  it('an operator edit after EVERY prune hides it', () => {
    const later = {
      ...KEPT,
      subject: 't-x',
      subjectKind: 'target' as const,
      field: 'targets',
      outcome: 'removed' as const,
      at: KEPT.at + 5_000,
    }
    expect(pruneBannerFor([KEPT, later], 'rule', 'r1', false, KEPT.at + 6_000)).toBeNull()
  })

  it('a rule touched AFTER the prune (re-enabled, then off again) gets no banner', () => {
    expect(pruneBannerFor([KEPT], 'rule', 'r1', false, KEPT.at + 60_000)).toBeNull()
  })

  it('never borrows another rule, or another kind with the same id', () => {
    expect(pruneBannerFor([KEPT], 'rule', 'r2', false, KEPT.at)).toBeNull()
    expect(pruneBannerFor([KEPT], 'timelapse', 'r1', false, KEPT.at)).toBeNull()
  })

  it('picks the newest when several subjects were kept', () => {
    const older = { ...KEPT, subject: '600', at: KEPT.at - 1 }
    expect(pruneBannerFor([older, KEPT], 'rule', 'r1', false, KEPT.at)?.subject).toBe('102')
  })
})

describe('pruneBannerText', () => {
  it('says when, which device, and that it was deleted', () => {
    expect(pruneBannerText(KEPT, () => '25/09/2026')).toBe(
      'Disabled on 25/09/2026: its last device (#102) was deleted.',
    )
  })

  it('says target for a deleted delivery target', () => {
    expect(pruneBannerText({ ...KEPT, subjectKind: 'target', subject: 'ntfy-1' }, () => 'd')).toBe(
      'Disabled on d: its last delivery target (ntfy-1) was deleted.',
    )
  })
})
