/**
 * How full is the VOLUME — the question the Recordings → Storage cards exist to
 * answer, and the one the first version of them got wrong.
 *
 * The bar used to plot `usedBytes / totalBytes`: the share of the disk taken by
 * RECORDINGS. On a 4 TB array holding 92.9 GB of footage next to everything
 * else, that renders 2% while the volume is at 99% and the next write is the
 * ENOSPC. Volume fill is `(total - available) / total` — recordings are one
 * tenant of the disk, not the disk.
 */
import { describe, expect, it } from 'vitest'
import {
  FILL_CRITICAL_FRACTION,
  FILL_WARN_FRACTION,
  fillSeverity,
  resolveVolumeFill,
  summarizeVolumeFill,
} from '../storage-fill'

const TB = 1_000_000_000_000

describe('fillSeverity', () => {
  it('ok below the warn threshold', () => {
    expect(fillSeverity(0)).toBe('ok')
    expect(fillSeverity(0.8499)).toBe('ok')
  })

  it('warn AT the threshold, not one byte past it', () => {
    expect(fillSeverity(FILL_WARN_FRACTION)).toBe('warn')
    expect(fillSeverity(0.9)).toBe('warn')
  })

  it('critical AT the threshold, not one byte past it', () => {
    expect(fillSeverity(FILL_CRITICAL_FRACTION)).toBe('critical')
    expect(fillSeverity(1)).toBe('critical')
  })
})

describe('resolveVolumeFill', () => {
  it('measures the VOLUME, not the recordings share of it', () => {
    // 4 TB disk, 40 GB free, of which recordings are only 92.9 GB: the disk is
    // 99% full and the footage explains almost none of it.
    const fill = resolveVolumeFill({
      usedBytes: 92_900_000_000,
      availableBytes: 40_000_000_000,
      totalBytes: 4 * TB,
    })
    expect(fill).not.toBeNull()
    expect(fill?.fraction).toBeCloseTo(0.99, 4)
    expect(fill?.severity).toBe('critical')
    expect(fill?.freeBytes).toBe(40_000_000_000)
    expect(fill?.totalBytes).toBe(4 * TB)
    // The recordings share is still reported — it is what Prune/Delete can free.
    expect(fill?.recordingsFraction).toBeCloseTo(0.0232, 4)
  })

  it('a volume that did not report free bytes has NO fill — not a fill of zero', () => {
    expect(
      resolveVolumeFill({ usedBytes: 1_000, availableBytes: null, totalBytes: 4 * TB }),
    ).toBeNull()
  })

  it('a volume that did not report capacity has no fill', () => {
    expect(resolveVolumeFill({ usedBytes: 1_000, availableBytes: 10, totalBytes: null })).toBeNull()
  })

  it('a zero-byte capacity is not a full disk — it is an unusable reading', () => {
    expect(resolveVolumeFill({ usedBytes: 0, availableBytes: 0, totalBytes: 0 })).toBeNull()
  })

  it('clamps a free figure larger than the capacity instead of going negative', () => {
    const fill = resolveVolumeFill({ usedBytes: 0, availableBytes: 2 * TB, totalBytes: TB })
    expect(fill?.fraction).toBe(0)
    expect(fill?.severity).toBe('ok')
  })
})

describe('summarizeVolumeFill', () => {
  it('adds up the volumes that answered and reports the WORST of them', () => {
    const summary = summarizeVolumeFill([
      { usedBytes: 10, availableBytes: 900, totalBytes: 1_000 }, // 10% — ok
      { usedBytes: 10, availableBytes: 30, totalBytes: 1_000 }, // 97% — critical
    ])
    expect(summary).toEqual({
      knownVolumes: 2,
      unknownVolumes: 0,
      totalBytes: 2_000,
      freeBytes: 930,
      severity: 'critical',
    })
  })

  it('counts the volumes that did not answer instead of folding them in as empty', () => {
    const summary = summarizeVolumeFill([
      { usedBytes: 10, availableBytes: 900, totalBytes: 1_000 },
      { usedBytes: 10, availableBytes: null, totalBytes: null },
    ])
    expect(summary?.knownVolumes).toBe(1)
    expect(summary?.unknownVolumes).toBe(1)
    expect(summary?.totalBytes).toBe(1_000)
    expect(summary?.severity).toBe('ok')
  })

  it('no volume answered — a count, and no severity to render', () => {
    const summary = summarizeVolumeFill([{ usedBytes: 10, availableBytes: null, totalBytes: null }])
    expect(summary?.knownVolumes).toBe(0)
    expect(summary?.severity).toBeNull()
  })

  it('an old hub that reports no locations at all degrades to nothing to render', () => {
    expect(summarizeVolumeFill([])).toBeNull()
  })
})
