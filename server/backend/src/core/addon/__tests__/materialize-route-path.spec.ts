import { describe, expect, it } from 'vitest'
import { materializeRoutePath } from '../materialize-route-path.js'

describe('materializeRoutePath', () => {
  it('substitutes each matched param into the pattern', () => {
    expect(materializeRoutePath('/:providerId/start', { providerId: 'authentik' })).toBe(
      '/authentik/start',
    )
  })

  it('handles several params and static segments', () => {
    expect(materializeRoutePath('/a/:x/b/:y', { x: '1', y: 'two' })).toBe('/a/1/b/two')
  })

  it('leaves a static path unchanged', () => {
    expect(materializeRoutePath('/health', {})).toBe('/health')
  })

  it('keeps a placeholder whose param is missing rather than inventing one', () => {
    expect(materializeRoutePath('/:id', {})).toBe('/:id')
  })

  it('encodes a param so it stays one path segment', () => {
    expect(materializeRoutePath('/:id/x', { id: 'a/b c' })).toBe('/a%2Fb%20c/x')
  })
})
