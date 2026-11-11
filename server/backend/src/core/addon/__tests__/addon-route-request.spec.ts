import { describe, expect, it } from 'vitest'
import { buildAddonRouteRequest } from '../addon-route-request.js'

const base = { params: { id: '4' }, query: { a: '1' }, body: { x: 1 }, headers: { h: 'v' } }

describe('buildAddonRouteRequest', () => {
  it('hands the resolved instance to the handler of a public route', () => {
    const request = buildAddonRouteRequest({ ...base, instanceId: 'second' })
    expect(request.instanceId).toBe('second')
    expect(request.params).toEqual({ id: '4' })
    expect(request.user).toBeUndefined()
  })

  it('hands the resolved instance beside the verified caller', () => {
    const request = buildAddonRouteRequest({
      ...base,
      instanceId: 'export-x',
      caller: { user: { id: 'u1', username: 'admin', isAdmin: true } },
    })
    expect(request.instanceId).toBe('export-x')
    expect(request.user?.username).toBe('admin')
  })

  it('names no instance for a route that is not per-instance', () => {
    const request = buildAddonRouteRequest({ ...base, instanceId: undefined })
    expect('instanceId' in request).toBe(false)
  })
})
