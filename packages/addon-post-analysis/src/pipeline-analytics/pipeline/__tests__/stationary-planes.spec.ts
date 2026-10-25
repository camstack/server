/**
 * Both ROOT detectors park objects. Neither sensor nor audio can.
 *
 * On device 106 the stationary machinery never ran, because five separate
 * `source === 'pipeline'` comparisons each said the gate "runs on that plane".
 * The reason was where the flood it was written for had been measured (102,
 * the ML plane) — never an argument that the firmware's boxes were unfit.
 *
 * The bill: a still object is never promoted, so it holds `hasLiveTrack` true
 * for as long as it sits there, and every detection session runs to its 120 s
 * cap instead of closing on cooldown (`closed at the max-hold cap with a
 * subject still present`, measured 17:23:49 with `sinceSubjectSeenMs=90`).
 * The camera's lazy stream is torn down and rebuilt on the next detection —
 * on a battery camera.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { planeRunsStationary } from '../stationary-planes.js'

describe('planeRunsStationary', () => {
  it('runs on the ML root', () => {
    expect(planeRunsStationary('pipeline')).toBe(true)
  })

  it('runs on the firmware root — the same plane, a different door', () => {
    expect(planeRunsStationary('onboard')).toBe(true)
  })

  // A plane with no geometry has nothing to park, and admitting one would feed
  // the registry rows it can never confirm or retire.
  it('does not run on planes that carry no boxes', () => {
    expect(planeRunsStationary('sensor')).toBe(false)
    expect(planeRunsStationary('audio')).toBe(false)
    expect(planeRunsStationary('')).toBe(false)
  })
})

/**
 * Five copies of a rule drift. This repo has already paid for that with two
 * authorities on one function (D62), so the copies must not come back.
 */
describe('one authority, not five comparisons', () => {
  it('no bare pipeline-only comparison remains in the analytics host', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.ts'), 'utf8')
    expect(src).not.toContain("source === 'pipeline'")
  })
})
