import { describe, expect, it } from 'vitest'
import { fillEmptyProfileSlots } from '../fill-empty-profile-slots.js'

describe('fillEmptyProfileSlots', () => {
  it('fills a fully empty map from the auto rank (sticky auto=false after a catalog wipe)', () => {
    expect(
      fillEmptyProfileSlots({}, { high: 'native:main', mid: 'native:slot-3', low: 'native:sub' }),
    ).toEqual({ high: 'native:main', mid: 'native:slot-3', low: 'native:sub' })
  })

  it('keeps a derived on low and fills high/mid from unused natives', () => {
    expect(
      fillEmptyProfileSlots(
        { low: 'derived:Mid to low' },
        { high: 'native:main', mid: 'native:slot-3', low: 'native:sub' },
      ),
    ).toEqual({
      high: 'native:main',
      mid: 'native:slot-3',
      low: 'derived:Mid to low',
    })
  })

  it('does not steal a stream already sitting on another slot', () => {
    expect(
      fillEmptyProfileSlots(
        { mid: 'native:main' },
        { high: 'native:main', mid: 'native:slot-3', low: 'native:sub' },
      ),
    ).toEqual({
      high: 'native:slot-3',
      mid: 'native:main',
      low: 'native:sub',
    })
  })

  it('leaves a fully populated map alone', () => {
    const current = { high: 'native:main', mid: 'native:slot-3', low: 'derived:x' }
    expect(
      fillEmptyProfileSlots(current, {
        high: 'native:main',
        mid: 'native:slot-3',
        low: 'native:sub',
      }),
    ).toEqual(current)
  })
})
