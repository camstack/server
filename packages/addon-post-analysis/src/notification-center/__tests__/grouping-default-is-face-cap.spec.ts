/** D692 §2.1: the editor default IS the tracker's face-settle cap (D683 (f)), one value. */
import { NC_GROUPING_DEFAULT_SEC } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FACE_SETTLE_HOLD_MS } from '../../pipeline-analytics/pipeline/tracker-v2/constants.js'

describe('NC_GROUPING_DEFAULT_SEC equals the tracker face cap', () => {
  it('is FACE_SETTLE_HOLD_MS in seconds', () => {
    expect(NC_GROUPING_DEFAULT_SEC * 1000).toBe(FACE_SETTLE_HOLD_MS)
  })
})
