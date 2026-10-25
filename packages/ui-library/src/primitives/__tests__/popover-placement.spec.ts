import { describe, expect, it } from 'vitest'
import { placePopover } from '../popover'

const base = { viewportHeight: 900, offset: 4 }

describe('placePopover — a popover stays inside the viewport', () => {
  it('opens below when it fits', () => {
    const p = placePopover({ ...base, triggerTop: 100, triggerBottom: 130, contentHeight: 400 })
    expect(p.side).toBe('below')
  })

  it('flips above when it does not fit below and there is more room above', () => {
    const p = placePopover({ ...base, triggerTop: 740, triggerBottom: 770, contentHeight: 400 })
    expect(p.side).toBe('above')
    expect(p.maxHeight).toBe(740 - 4 - 8)
  })

  it('stays below when above is smaller, and caps the height to the room below', () => {
    const p = placePopover({ ...base, triggerTop: 40, triggerBottom: 70, contentHeight: 2000 })
    expect(p.side).toBe('below')
    expect(p.maxHeight).toBe(900 - 70 - 4 - 8)
  })
})
