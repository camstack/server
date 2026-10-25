/** The shared-cut memo holds clip bytes, so it is bounded by age and count. */
import { describe, expect, it } from 'vitest'
import {
  NC_RECORDED_CUT_MEMO_MAX,
  NC_RECORDED_CUT_MEMO_TTL_MS,
  NcRecordedCutMemo,
} from '../recorded-cut-memo.js'

const refused = () => Promise.resolve({ ok: false as const, reason: 'not-covered' as const })

describe('NcRecordedCutMemo bounds', () => {
  it('forgets a cut older than its TTL', () => {
    const m = new NcRecordedCutMemo()
    m.start('k', 0, 30_000, refused)
    expect(m.find('k', NC_RECORDED_CUT_MEMO_TTL_MS)).not.toBeNull()
    expect(m.find('k', NC_RECORDED_CUT_MEMO_TTL_MS + 1)).toBeNull()
  })

  it('holds at most MAX cuts, dropping the oldest', () => {
    const m = new NcRecordedCutMemo()
    for (let i = 0; i <= NC_RECORDED_CUT_MEMO_MAX; i += 1) m.start(`k${i}`, i, 30_000, refused)
    expect(m.find('k0', NC_RECORDED_CUT_MEMO_MAX)).toBeNull()
    expect(m.find(`k${NC_RECORDED_CUT_MEMO_MAX}`, NC_RECORDED_CUT_MEMO_MAX)).not.toBeNull()
    expect(m.find('k1', NC_RECORDED_CUT_MEMO_MAX)).not.toBeNull()
  })
})
