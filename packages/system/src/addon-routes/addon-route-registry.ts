import type { IAddonHttpRoute, IAddonRouteProvider } from '@camstack/types'

interface RouteMatch {
  readonly route: IAddonHttpRoute
  readonly addonId: string
  readonly params: Record<string, string>
}

interface RegisteredRoute {
  readonly addonId: string
  readonly route: IAddonHttpRoute
  /** Full path including /addon/{addonId}/ prefix */
  readonly fullPath: string
}

/**
 * Registry for dynamic HTTP routes registered by addons.
 * Framework-agnostic — the server HTTP layer queries this registry to dispatch requests.
 */
export class AddonRouteRegistry {
  private readonly routes = new Map<string, RegisteredRoute[]>()

  /**
   * Register all routes from an addon's route provider.
   */
  registerRoutes(addonId: string, provider: IAddonRouteProvider): void {
    const addonRoutes = provider.getRoutes()
    const registered: RegisteredRoute[] = addonRoutes.map((route) => {
      const normalizedPath = route.path.startsWith('/') ? route.path : `/${route.path}`
      return {
        addonId,
        route,
        fullPath: `/addon/${addonId}${normalizedPath}`,
      }
    })
    this.routes.set(addonId, registered)
  }

  /**
   * Unregister all routes for an addon.
   */
  unregisterRoutes(addonId: string): void {
    this.routes.delete(addonId)
  }

  /**
   * Match an incoming request method + path to a registered route.
   * Supports simple path parameters (e.g., /items/:id).
   */
  matchRoute(method: string, path: string): RouteMatch | null {
    const normalizedMethod = method.toUpperCase()

    for (const registeredRoutes of this.routes.values()) {
      for (const entry of registeredRoutes) {
        if (entry.route.method !== normalizedMethod) continue

        const params = matchPath(entry.fullPath, path)
        if (params !== null) {
          return {
            route: entry.route,
            addonId: entry.addonId,
            params,
          }
        }
      }
    }

    return null
  }

  /**
   * List all registered routes across all addons.
   */
  listRoutes(): ReadonlyArray<{
    addonId: string
    method: string
    path: string
    access: string
    description?: string
  }> {
    const result: Array<{
      addonId: string
      method: string
      path: string
      access: string
      description?: string
    }> = []
    for (const registeredRoutes of this.routes.values()) {
      for (const entry of registeredRoutes) {
        result.push({
          addonId: entry.addonId,
          method: entry.route.method,
          path: entry.fullPath,
          access: entry.route.access,
          description: entry.route.description,
        })
      }
    }
    return result
  }
}

/**
 * Match a route pattern against an actual path.
 * Supports :param segments (e.g., /addon/:addonId/items/:id).
 * Returns extracted params or null if no match.
 */
function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = path.split('/').filter(Boolean)

  if (patternParts.length !== pathParts.length) {
    return null
  }

  const params: Record<string, string> = {}

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i]!
    const pathPart = pathParts[i]!

    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = pathPart
    } else if (patternPart !== pathPart) {
      return null
    }
  }

  return params
}
