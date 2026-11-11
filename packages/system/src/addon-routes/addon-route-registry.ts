import { type IAddonHttpRoute, type IAddonRouteProvider, isAddonInstanceId } from '@camstack/types'

interface RouteMatch {
  readonly route: IAddonHttpRoute
  readonly addonId: string
  readonly params: Record<string, string>
  /**
   * The instance a `perInstance` route was asked for: the path's instance
   * segment, or the addon id (the default instance) when the path has none.
   * Absent for a route that is not per-instance.
   */
  readonly instanceId?: string
}

/** The path segment that introduces an instance id: `/addon/<addonId>/instances/<instanceId>/…`. */
export const ADDON_INSTANCE_SEGMENT = 'instances'

/** A request path read as "this addon, this instance, this route path". */
export interface AddonInstancePath {
  readonly instanceId: string
  /** The same path with the instance segment removed: `/addon/<addonId>/<rest>`. */
  readonly routePath: string
}

/**
 * The ONE reading of an instance in an addon path (planning#415).
 * `/addon/<addonId>/instances/<instanceId>/<rest>` names that instance; any
 * other path under the addon names the default instance, whose id is the
 * addon id. The form without the segment is permanent: it is the address
 * third parties hold for the default instance.
 *
 * `null` when the path is not under this addon, or carries an instance
 * segment whose id is not a plain id.
 */
export function resolveAddonInstancePath(addonId: string, path: string): AddonInstancePath | null {
  const parts = path.split('/')
  // ['', 'addon', addonId, …]
  if (parts[0] !== '' || parts[1] !== 'addon' || parts[2] !== addonId) return null
  if (parts[3] !== ADDON_INSTANCE_SEGMENT) return { instanceId: addonId, routePath: path }
  const instanceId = parts[4]
  if (instanceId === undefined || !isAddonInstanceId(instanceId)) return null
  return { instanceId, routePath: ['', 'addon', addonId, ...parts.slice(5)].join('/') }
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

        if (entry.route.perInstance === true) {
          const instancePath = resolveAddonInstancePath(entry.addonId, path)
          if (instancePath === null) continue
          const instanceParams = matchPath(entry.fullPath, instancePath.routePath)
          if (instanceParams === null) continue
          return {
            route: entry.route,
            addonId: entry.addonId,
            params: instanceParams,
            instanceId: instancePath.instanceId,
          }
        }

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
    perInstance?: boolean
  }> {
    const result: Array<{
      addonId: string
      method: string
      path: string
      access: string
      description?: string
      perInstance?: boolean
    }> = []
    for (const registeredRoutes of this.routes.values()) {
      for (const entry of registeredRoutes) {
        result.push({
          addonId: entry.addonId,
          method: entry.route.method,
          path: entry.fullPath,
          access: entry.route.access,
          description: entry.route.description,
          ...(entry.route.perInstance === true ? { perInstance: true } : {}),
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
