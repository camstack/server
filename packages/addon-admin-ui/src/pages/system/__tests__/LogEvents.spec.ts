import { describe, expect, it } from 'vitest'
import { parseCategoriesParam } from '../LogEvents'

describe('parseCategoriesParam', () => {
  it('reads exact ids and prefix patterns', () => {
    expect(parseCategoriesParam('addon.started, homematic.*')).toEqual([
      'addon.started',
      'homematic.*',
    ])
  })

  it('answers undefined for an absent or empty parameter so the stream keeps its defaults', () => {
    expect(parseCategoriesParam(null)).toBeUndefined()
    expect(parseCategoriesParam('')).toBeUndefined()
    expect(parseCategoriesParam(' , ')).toBeUndefined()
  })
})
