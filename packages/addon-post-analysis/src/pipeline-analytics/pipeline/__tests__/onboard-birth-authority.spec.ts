/**
 * A second detector's silence is not a verdict on the first one's sighting.
 *
 * Device 106 on 2026-09-15: 18 births out of 18 retracted in three hours, on a
 * camera whose root detector is the firmware. The operator walked past, the
 * firmware saw `person` for ~100 s, and nothing survived — no track, no
 * thumbnail, no recording.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { suppressionMayRetract } from '../onboard-birth-authority.js'

describe('suppressionMayRetract', () => {
  // THE CASE. The ML re-detect is a different detector, and the action is
  // one-shot and destructive (D49).
  it('an onboard birth is HELD, not retracted', () => {
    expect(suppressionMayRetract('onboard')).toBe(false)
  })

  // THE CONTROL, and why this is not "never retract": on the pipeline path the
  // gate asks the SAME detector about a tighter crop, which is a coherence
  // check and the whole reason the gate earns its keep. Every other camera on
  // this fleet is here.
  it('a pipeline birth keeps the gate whole', () => {
    expect(suppressionMayRetract('pipeline')).toBe(true)
  })

  // An unknown source is not a licence to stop retracting: the rule is about
  // the ONE path where the root detector is not the one the gate re-runs.
  it('an unknown source keeps the gate whole', () => {
    expect(suppressionMayRetract('sensor')).toBe(true)
    expect(suppressionMayRetract('')).toBe(true)
  })
})

/**
 * The rule is worth nothing unless the retraction site asks it. That site is
 * one branch inside a very large method, and a future edit that reorders it
 * would silently restore the defect — every test above would stay green.
 */
describe('the retraction site consults the authority', () => {
  // The verdict loop's body moved out of the host (Plan B, extraction 5).
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'birth', 'birth-verdict.ts'),
    'utf8',
  )

  it('asks before dropping the row', () => {
    const drop = source.indexOf('this.trackStore?.dropActive(id)')
    const guard = source.indexOf('if (!suppressionMayRetract(source))')
    expect(drop).toBeGreaterThan(0)
    expect(guard).toBeGreaterThan(0)
    // ORDER, not distance. This asserted "within 900 characters" and went red
    // the moment the held branch legitimately grew (it now keeps the gate's
    // crop). A character budget is a proxy for "these have not drifted apart";
    // the real contract is that the guard comes first AND returns — which the
    // next test pins — because a guard that returns makes the drop unreachable
    // however far below it sits.
    expect(guard).toBeLessThan(drop)
  })

  it('the held branch RETURNS — a hold that falls through still drops', () => {
    const guard = source.indexOf('if (!suppressionMayRetract(source))')
    expect(guard).toBeGreaterThan(0)
    const body = source.slice(
      guard,
      source.indexOf('this.frameState.suppressedBirths.reject', guard),
    )
    // `return false`: the candidate is not born on this frame.
    expect(body).toContain('return false')
  })
})
