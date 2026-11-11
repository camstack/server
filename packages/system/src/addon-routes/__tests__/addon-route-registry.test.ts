import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AddonRouteRegistry } from '../addon-route-registry.js'
import type { IAddonRouteProvider, IAddonHttpRoute } from '@camstack/types'

function createMockProvider(id: string, routes: IAddonHttpRoute[]): IAddonRouteProvider {
  return {
    id,
    getRoutes: () => routes,
  }
}

function createRoute(overrides: Partial<IAddonHttpRoute> = {}): IAddonHttpRoute {
  return {
    method: 'GET',
    path: '/test',
    access: 'public',
    handler: vi.fn(),
    ...overrides,
  }
}

describe('AddonRouteRegistry', () => {
  let registry: AddonRouteRegistry

  beforeEach(() => {
    registry = new AddonRouteRegistry()
  })

  it('registers and matches routes', () => {
    const handler = vi.fn()
    const provider = createMockProvider('my-addon', [
      createRoute({ method: 'GET', path: '/status', handler }),
    ])

    registry.registerRoutes('my-addon', provider)

    const match = registry.matchRoute('GET', '/addon/my-addon/status')
    expect(match).not.toBeNull()
    expect(match!.addonId).toBe('my-addon')
    expect(match!.route.handler).toBe(handler)
  })

  it('unregister removes routes', () => {
    const provider = createMockProvider('my-addon', [
      createRoute({ method: 'GET', path: '/status' }),
    ])

    registry.registerRoutes('my-addon', provider)
    registry.unregisterRoutes('my-addon')

    const match = registry.matchRoute('GET', '/addon/my-addon/status')
    expect(match).toBeNull()
  })

  it('matches routes with path params', () => {
    const provider = createMockProvider('items', [
      createRoute({ method: 'GET', path: '/items/:id' }),
    ])

    registry.registerRoutes('items', provider)

    const match = registry.matchRoute('GET', '/addon/items/items/abc123')
    expect(match).not.toBeNull()
    expect(match!.params.id).toBe('abc123')
  })

  it('returns null for non-matching method', () => {
    const provider = createMockProvider('my-addon', [
      createRoute({ method: 'POST', path: '/data' }),
    ])

    registry.registerRoutes('my-addon', provider)

    const match = registry.matchRoute('GET', '/addon/my-addon/data')
    expect(match).toBeNull()
  })

  it('returns null for non-matching path', () => {
    const provider = createMockProvider('my-addon', [
      createRoute({ method: 'GET', path: '/status' }),
    ])

    registry.registerRoutes('my-addon', provider)

    const match = registry.matchRoute('GET', '/addon/my-addon/unknown')
    expect(match).toBeNull()
  })

  it('listRoutes returns all registered routes', () => {
    const provider1 = createMockProvider('addon-a', [
      createRoute({ method: 'GET', path: '/foo', access: 'public' }),
    ])
    const provider2 = createMockProvider('addon-b', [
      createRoute({ method: 'POST', path: '/bar', access: 'admin' }),
      createRoute({ method: 'GET', path: '/baz', access: 'authenticated' }),
    ])

    registry.registerRoutes('addon-a', provider1)
    registry.registerRoutes('addon-b', provider2)

    const routes = registry.listRoutes()
    expect(routes).toHaveLength(3)
    expect(routes.map((r) => r.addonId)).toContain('addon-a')
    expect(routes.map((r) => r.addonId)).toContain('addon-b')
  })

  it('handles multiple addons with independent routes', () => {
    const provider1 = createMockProvider('auth-google', [
      createRoute({ method: 'GET', path: '/callback', access: 'public' }),
    ])
    const provider2 = createMockProvider('webhook', [
      createRoute({ method: 'POST', path: '/event', access: 'authenticated' }),
    ])

    registry.registerRoutes('auth-google', provider1)
    registry.registerRoutes('webhook', provider2)

    expect(registry.matchRoute('GET', '/addon/auth-google/callback')).not.toBeNull()
    expect(registry.matchRoute('POST', '/addon/webhook/event')).not.toBeNull()
    expect(registry.matchRoute('GET', '/addon/webhook/event')).toBeNull()
  })
})

describe('AddonRouteRegistry — per-instance routes (planning#415)', () => {
  let registry: AddonRouteRegistry

  beforeEach(() => {
    registry = new AddonRouteRegistry()
    registry.registerRoutes(
      'export-x',
      createMockProvider('export-x', [
        createRoute({ method: 'POST', path: '/directive', perInstance: true }),
        createRoute({ method: 'GET', path: '/items/:id', perInstance: true }),
        createRoute({ method: 'GET', path: '/health' }),
      ]),
    )
  })

  it('names the instance of a path that carries the instance segment', () => {
    const match = registry.matchRoute('POST', '/addon/export-x/instances/second/directive')
    expect(match).not.toBeNull()
    expect(match!.addonId).toBe('export-x')
    expect(match!.instanceId).toBe('second')
    expect(match!.params).toEqual({})
  })

  it('resolves the path without the segment to the default instance, whose id is the addon id', () => {
    const match = registry.matchRoute('POST', '/addon/export-x/directive')
    expect(match).not.toBeNull()
    expect(match!.instanceId).toBe('export-x')
  })

  it('keeps the route params beside the instance', () => {
    const match = registry.matchRoute('GET', '/addon/export-x/instances/second/items/42')
    expect(match!.instanceId).toBe('second')
    expect(match!.params).toEqual({ id: '42' })
  })

  it('does not serve a route that is not per-instance under an instance segment', () => {
    expect(registry.matchRoute('GET', '/addon/export-x/instances/second/health')).toBeNull()
    const plain = registry.matchRoute('GET', '/addon/export-x/health')
    expect(plain).not.toBeNull()
    expect(plain!.instanceId).toBeUndefined()
  })

  it('refuses an instance segment that is not a plain id', () => {
    expect(registry.matchRoute('POST', '/addon/export-x/instances/a%2Fb/directive')).toBeNull()
    expect(registry.matchRoute('POST', '/addon/export-x/instances//directive')).toBeNull()
  })

  it('does not read the instance segment of ANOTHER addon', () => {
    expect(registry.matchRoute('POST', '/addon/other/instances/second/directive')).toBeNull()
  })

  it('lists a per-instance route as such', () => {
    const listed = registry.listRoutes().find((r) => r.path === '/addon/export-x/directive')
    expect(listed?.perInstance).toBe(true)
  })
})
