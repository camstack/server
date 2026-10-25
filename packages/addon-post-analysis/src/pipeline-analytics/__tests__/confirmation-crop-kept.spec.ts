/**
 * The pixels the gate judged are kept — but only where they have an owner.
 *
 * The confirmation gate re-runs the detector on a crop of the birth frame and
 * can retract the track on what it finds. On device 106 it retracted 18 births
 * out of 18 in three hours, every one with `cropSource=native` (the crop
 * ARRIVED) and none with a `bestScore` (nothing compatible was found in it).
 * Whether the detector was right, or the box/frame pairing was skewed, fits
 * every number we have equally — and the one thing that settles it, the crop,
 * lived for milliseconds inside a closure and was written nowhere.
 *
 * Two halves, and the second is what keeps this honest:
 *
 *  - the GATE offers every measured candidate's crop, confirmations included.
 *    A seam that only fired on refusals could never show what a healthy crop
 *    looks like, which is half of any comparison.
 *  - the HOST keeps it only when the track SURVIVES the verdict. A crop kept
 *    beside a retracted birth is a media row owned by a track that never
 *    existed — the 18.9 GB orphan lesson of D161.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const GATE = fs.readFileSync(path.join(__dirname, '..', 'confirmation-gate.ts'), 'utf8')
/** The per-candidate birth verdict moved out of the host (Plan B, extraction 5). */
const HOST = fs.readFileSync(path.join(__dirname, '..', 'birth', 'birth-verdict.ts'), 'utf8')

describe('the gate offers the pixels it judged', () => {
  it('offers them for every measured candidate, not only refusals', () => {
    const measure = GATE.slice(GATE.indexOf('async function measure('))
    const offer = measure.indexOf('deps.keepCrop?.(')
    const redetect = measure.indexOf('await deps.redetect(')
    expect(offer).toBeGreaterThan(0)
    // BEFORE the re-detect: an inference that errors out is exactly a case
    // worth looking at, and a crop offered after it would be lost on that path.
    expect(offer).toBeLessThan(redetect)
  })

  it('is optional — a host that wants nothing pays nothing', () => {
    expect(GATE).toContain('readonly keepCrop?:')
  })
})

describe('the host keeps them only where they have an owner', () => {
  const branch = (() => {
    const at = HOST.indexOf('if (!suppressionMayRetract(source)) {')
    return HOST.slice(at, at + 2000)
  })()

  it('writes the crop inside the SURVIVING-track branch', () => {
    expect(branch).toContain("kind: 'confirmationCrop'")
    expect(branch).toContain("ownerKind: 'track'")
  })

  // The retraction path must never write one: that row would outlive its owner.
  it('never writes one beside a retracted birth', () => {
    const at = HOST.indexOf('this.trackStore?.dropActive(id)')
    const retraction = HOST.slice(at, at + 1200)
    expect(retraction).not.toContain('confirmationCrop')
  })
})
