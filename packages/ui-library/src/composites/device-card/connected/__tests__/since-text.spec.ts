import { describe, expect, it } from 'vitest'
import { defaultUiText } from '../../../../contexts/ui-text'
import { sinceText } from '../since-text'

const NOW = 1_700_000_000_000

describe('sinceText', () => {
  const t = defaultUiText

  it('says nothing for a seeded or missing change time, and names a real one', () => {
    expect(sinceText(1, NOW, t)).toBeUndefined()
    expect(sinceText(0, NOW, t)).toBeUndefined()
    expect(sinceText(NOW + 60_000, NOW, t)).toBeUndefined()
    expect(sinceText(NOW - 2 * 60_000, NOW, t)).toBe('2 min')
  })
})
