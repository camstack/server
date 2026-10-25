import { describe, expect, it } from 'vitest'
import { parseDataPlaneEndpoints } from '../core/addon/addon-registry.service.js'

describe('parseDataPlaneEndpoints', () => {
  const base = {
    prefix: 'event-media',
    access: 'authenticated',
    baseUrl: 'http://127.0.0.1:1',
    secret: 's',
  }

  it('carries the share opt-in through, and only for known kinds', () => {
    const [ep] = parseDataPlaneEndpoints([{ ...base, share: ['events-view'] }])
    expect(ep?.share).toEqual(['events-view'])
    const [none] = parseDataPlaneEndpoints([base])
    expect(none?.share).toBeUndefined()
  })

  it('refuses an unknown share kind rather than admitting it silently', () => {
    expect(() => parseDataPlaneEndpoints([{ ...base, share: ['admin-everything'] }])).toThrow(
      /share kind/,
    )
  })
})
