import { describe, expect, it } from 'vitest'
import { SPEAK_COLLAPSE_MS, SPEAK_MIN_GAP_MS } from '../speak/constants.js'
import { admitSpeech, emptySpeechLedger } from '../speak/rate-limit.js'

describe('admitSpeech', () => {
  it('collapses the same text and rate-limits a different one inside the gap', () => {
    const first = admitSpeech(emptySpeechLedger(), 'echo-1', 'Person at the door', 1_000)
    expect(first.decision).toBe('admit')
    const again = admitSpeech(first.ledger, 'echo-1', 'Person at the door', 1_000 + 1_000)
    expect(again.decision).toBe('collapsed')
    expect(again.ledger).toBe(first.ledger)
    const other = admitSpeech(
      first.ledger,
      'echo-1',
      'Vehicle in the drive',
      1_000 + SPEAK_MIN_GAP_MS - 1,
    )
    expect(other.decision).toBe('rate_limited')
    const later = admitSpeech(
      first.ledger,
      'echo-1',
      'Vehicle in the drive',
      1_000 + SPEAK_COLLAPSE_MS,
    )
    expect(later.decision).toBe('admit')
  })

  it('does not let one Echo silence another', () => {
    const first = admitSpeech(emptySpeechLedger(), 'echo-1', 'hello', 0)
    const second = admitSpeech(first.ledger, 'echo-2', 'hello', 0)
    expect(second.decision).toBe('admit')
  })
})
