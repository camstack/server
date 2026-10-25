/**
 * Invariants between the L2 constants (task-8 review M3). Pure: a startup
 * throw would crash a runner at import; a spec fails the commit instead.
 *
 * Disarm: `LINK_WINDOW_MS` → 50_000 turns "an arc is always decided before
 * either end is pruned" RED. The behavioural twin is `linker.spec.ts`'s "the
 * latest refusal still finds its predecessor…".
 */
import { describe, expect, it } from 'vitest'
import { TTL_SWEEP_INTERVAL_MS as SWEEP_PERIOD_MS } from '../../tracker-sweep.js'
import {
  FACE_SETTLE_HOLD_MS,
  LINK_DECIDE_MARGIN_MS,
  LINK_DECIDE_MAX_MS,
  LINK_MAX_GAP_MS,
  LINK_WINDOW_MS,
} from '../constants.js'

// `SWEEP_PERIOD_MS` is the close sweep's period (`TrackerSweep`): a silent
// camera's L2 steps only this often.
describe('L2 constants', () => {
  it('an arc is always decided before either end is pruned', () => {
    // From the predecessor's last sighting: the successor starts at the far end
    // of the gap; its first face lands just before the faceless refusal
    // (start + decide + margin); the recognition wait runs from that face, and
    // its refusal comes one margin later; a sparse step may see it one sweep late.
    const successorStarts = LINK_MAX_GAP_MS
    const lastFirstFace = successorStarts + LINK_DECIDE_MAX_MS + LINK_DECIDE_MARGIN_MS
    const latestRefusal = lastFirstFace + FACE_SETTLE_HOLD_MS + LINK_DECIDE_MARGIN_MS
    expect(latestRefusal + SWEEP_PERIOD_MS).toBeLessThanOrEqual(LINK_WINDOW_MS)
  })
})
