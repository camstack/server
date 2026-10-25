/**
 * D406 — WHEN a detail result's frame earns the semantic best-shot tier.
 *
 * Track `718acf29` (device 102, a Car, 9.6 s): the plate DNJE230 was read at
 * `1788879992717` and attributed — the row carries
 * `subLabel: 'DNJE230'`, `subLabelMeta.decidedAt: 1788879992717`. The stored
 * best shot is from `1788879987020`, 5.7 s EARLIER, and the keyFrame from
 * `1788879987158`. Operator: "il frame al momento della targa è decisamente
 * migliore come best shot" [the frame at the moment of the plate is decidedly better as best shot].
 *
 * The promotion sat behind `applied.trackWritten` — the TIERED LABEL WRITE. A
 * plate read is a recognition on its own: it proved what the frame shows the
 * moment the OCR came back, and whether its text then wins a slot against an
 * earlier read, a gallery vehicle name or a same-tier higher score is a
 * different question with a different answer. Gating a one-shot promotion on
 * that second, fallible decision is the D49 shape, one domain over.
 */
import { describe, expect, it } from 'vitest'
import { detailSemanticTrigger } from '../detail-semantic-gate.js'

describe('detailSemanticTrigger', () => {
  it('promotes a PLATE on the read itself, not on the label write', () => {
    expect(detailSemanticTrigger('plate')).toBe('recognition')
  })

  it('keeps a fine CLASSIFICATION on the label write — a refused class proved nothing kept', () => {
    expect(detailSemanticTrigger('vehicle')).toBe('label-write')
    expect(detailSemanticTrigger('dog')).toBe('label-write')
    expect(detailSemanticTrigger('')).toBe('label-write')
  })

  it('is exhaustive: every class has exactly one trigger, so no path promotes twice', () => {
    for (const className of ['plate', 'vehicle', 'person', 'package']) {
      const trigger = detailSemanticTrigger(className)
      expect(['recognition', 'label-write']).toContain(trigger)
    }
  })
})
