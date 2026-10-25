/**
 * The gallery audit: which of a person's enrolled samples do not look like the
 * rest of that person.
 *
 * The rules under test are all about NOT accusing a sample without cause — a
 * removal is destructive and the operator will act on this list.
 */
import { describe, expect, it } from 'vitest'

import { auditIdentitySamples, type AuditSampleInput } from '../identity-audit.js'

/** The live setting on 2026-09-08. The flag means "this sample would
 *  auto-assign to that other person", so it is the recogniser's own bar. */
const AUTO_ASSIGN = 0.4

const MODEL = 'auraface-r100'

/** Unit vectors on a circle: cosine is cos(a−b), so agreement is exact. */
function at(deg: number, _modelId: string = MODEL): readonly number[] {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}

function sample(id: string, deg: number, modelId: string = MODEL): AuditSampleInput {
  return { sampleId: id, embedding: at(deg), modelId, enrolledAt: 1, deviceId: 101 }
}

describe('auditIdentitySamples', () => {
  it('puts the sample that agrees least with its own person first', () => {
    const own = [sample('a', 0), sample('b', 5), sample('c', 10), sample('odd', 88)]
    const report = auditIdentitySamples({
      identityId: 'p1',
      samples: own,
      others: [],
      modelId: MODEL,
      autoAssignThreshold: AUTO_ASSIGN,
    })
    expect(report.rows[0]?.sampleId).toBe('odd')
    expect(report.rows[0]?.selfMean).toBeLessThan(report.rows[1]?.selfMean ?? 1)
  })

  it('names the OTHER person a sample looks like, which is the actionable half', () => {
    const own = [sample('a', 0), sample('b', 4), sample('impostor', 90)]
    const report = auditIdentitySamples({
      identityId: 'p1',
      samples: own,
      others: [{ identityId: 'p2', name: 'Dave', samples: [sample('x', 91)] }],
      modelId: MODEL,
      autoAssignThreshold: AUTO_ASSIGN,
    })
    const row = report.rows.find((r) => r.sampleId === 'impostor')
    expect(row?.bestForeign?.identityId).toBe('p2')
    expect(row?.bestForeign?.name).toBe('Dave')
    expect(row?.bestForeign?.score ?? 0).toBeGreaterThan(0.99)
    // And it outranks a merely-lonely sample: looking like someone ELSE is
    // stronger evidence than not looking like anyone.
    expect(report.rows[0]?.sampleId).toBe('impostor')
  })

  it('says nothing about a person whose samples all agree', () => {
    const own = [sample('a', 0), sample('b', 3), sample('c', 6)]
    const report = auditIdentitySamples({
      identityId: 'p1',
      samples: own,
      others: [],
      modelId: MODEL,
      autoAssignThreshold: AUTO_ASSIGN,
    })
    expect(report.rows.every((r) => r.suspicion === 0)).toBe(true)
    expect(report.flagged).toBe(0)
  })

  it('flags only what could STEAL a match, not what merely scores oddly', () => {
    // The calibration this rule was rewritten for. On the live gallery,
    // 2026-09-08: `selfMean` median 0.188, p90 0.235 — so an absolute reading
    // of "does not look like itself" fires on everything, and the first
    // version flagged 56 of 106 samples. `bestForeign` separates: median
    // 0.283, p95 0.376, one outlier at 0.612. The flag is the recogniser's own
    // threshold, so it means something an operator can act on: this sample
    // would be auto-assigned to somebody else.
    const own = [sample('a', 0), sample('b', 4), sample('c', 8), sample('impostor', 90)]
    const others = [
      { identityId: 'p2', name: 'Dave', samples: [sample('x', 91)] },
      // A distant person: every sample scores SOMETHING against them, and none
      // of it is grounds for an accusation.
      { identityId: 'p3', name: 'Nobody', samples: [sample('z', 200)] },
    ]
    const report = auditIdentitySamples({
      identityId: 'p1',
      samples: own,
      others,
      modelId: MODEL,
      autoAssignThreshold: AUTO_ASSIGN,
    })
    expect(report.flagged).toBe(1)
    expect(report.rows[0]?.sampleId).toBe('impostor')
  })

  it('refuses to score a sample from a DIFFERENT model instead of inventing one', () => {
    // A cosine across feature spaces is a well-formed float with no meaning
    // (`face-rescore`'s model gate, same rule). It must read as "cannot say",
    // never as an accusation and never as a clean bill.
    const own = [sample('a', 0), sample('b', 5), sample('old', 0, 'arcface-r100')]
    const report = auditIdentitySamples({
      identityId: 'p1',
      samples: own,
      others: [],
      modelId: MODEL,
      autoAssignThreshold: AUTO_ASSIGN,
    })
    const row = report.rows.find((r) => r.sampleId === 'old')
    expect(row?.comparable).toBe(false)
    expect(row?.selfMean).toBeNull()
    expect(row?.suspicion).toBe(0)
  })

  it('cannot judge a person with a single sample, and says so', () => {
    // One sample has nothing to disagree with. Reporting it as an outlier
    // would delete the only sample a new person has.
    const report = auditIdentitySamples({
      identityId: 'p1',
      samples: [sample('only', 0)],
      others: [],
      modelId: MODEL,
      autoAssignThreshold: AUTO_ASSIGN,
    })
    expect(report.rows[0]?.selfMean).toBeNull()
    expect(report.rows[0]?.suspicion).toBe(0)
    expect(report.comparableSamples).toBe(1)
  })

  it('counts what it flagged, so the UI can say "3 of 67 worth a look"', () => {
    const own = [sample('a', 0), sample('b', 4), sample('c', 8), sample('odd', 95)]
    const report = auditIdentitySamples({
      identityId: 'p1',
      samples: own,
      others: [{ identityId: 'p2', name: 'Other', samples: [sample('y', 96)] }],
      modelId: MODEL,
      autoAssignThreshold: AUTO_ASSIGN,
    })
    expect(report.flagged).toBe(1)
    expect(report.totalSamples).toBe(4)
  })

  it('reports the threshold it judged against, not a constant of its own', () => {
    const own = [sample('a', 0), sample('b', 4), sample('edge', 70)]
    const others = [{ identityId: 'p2', name: 'Other', samples: [sample('y', 71)] }]
    const strict = auditIdentitySamples({
      identityId: 'p1',
      samples: own,
      others,
      modelId: MODEL,
      autoAssignThreshold: 0.95,
    })
    const loose = auditIdentitySamples({
      identityId: 'p1',
      samples: own,
      others,
      modelId: MODEL,
      autoAssignThreshold: 0.2,
    })
    // Same gallery, same ranking — only the bar moves.
    expect(strict.rows[0]?.sampleId).toBe(loose.rows[0]?.sampleId)
    expect(loose.flagged).toBeGreaterThan(strict.flagged)
  })
})
