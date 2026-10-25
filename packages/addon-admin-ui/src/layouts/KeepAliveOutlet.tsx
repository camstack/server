/**
 * KeepAliveOutlet — AppLayout replacement for `<Outlet />` that keeps visited
 * `/addon/*` pages mounted (hidden) instead of unmounting them on navigate.
 *
 * Addon pages hold drafts in local `useState` (OSD template editor, etc.). A
 * single `<Outlet />` destroys that state whenever the operator leaves and
 * returns. QueryClient `gcTime: 0` amplifies the loss for query-backed drafts;
 * keep-alive keeps observers alive so the global defaults can stay as they are.
 *
 * Non-addon routes still use a live outlet (unmount on leave) so the LRU budget
 * is reserved for addon pages. Hidden panes use `display: none` + `hidden` /
 * `aria-hidden`. Timers and react-query `refetchInterval` on a kept-alive page
 * keep running while hidden — pages with aggressive polling should gate on
 * `useKeepAliveActive()`.
 *
 * Frozen `UNSAFE_LocationContext` + `UNSAFE_RouteContext` keep `useParams` /
 * `useLocation` correct for inactive panes (otherwise they would see the
 * active route's match).
 */
import {
  createContext,
  useContext,
  useRef,
  type ContextType,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
  useLocation,
  useNavigationType,
  useOutlet,
  type Location,
  type NavigationType,
} from 'react-router-dom'

/** Max visited `/addon/*` instances retained (LRU). Bounds memory. */
export const DEFAULT_KEEP_ALIVE_MAX = 6

export const KeepAliveActiveContext = createContext(true)

/** `true` when this keep-alive pane is the visible route. Hidden panes are `false`. */
export function useKeepAliveActive(): boolean {
  return useContext(KeepAliveActiveContext)
}

export function shouldKeepAlivePath(pathname: string): boolean {
  return pathname === '/addon' || pathname.startsWith('/addon/') // hub-path-ok: router pathname compare (basename-relative), not a URL
}

interface CacheEntry {
  readonly key: string
  readonly outlet: ReactElement | null
  readonly location: Location
  readonly navigationType: NavigationType
  readonly routeContext: ContextType<typeof UNSAFE_RouteContext>
}

export interface KeepAliveOutletProps {
  /** LRU cap for kept `/addon/*` panes. Default {@link DEFAULT_KEEP_ALIVE_MAX}. */
  readonly maxCached?: number
}

function touchLru(order: readonly string[], key: string, maxCached: number): string[] {
  const next = [...order.filter((k) => k !== key), key]
  return next.length <= maxCached ? next : next.slice(next.length - maxCached)
}

export function KeepAliveOutlet({
  maxCached = DEFAULT_KEEP_ALIVE_MAX,
}: KeepAliveOutletProps): ReactNode {
  const outlet = useOutlet()
  const location = useLocation()
  const navigationType = useNavigationType()
  const routeContext = useContext(UNSAFE_RouteContext)
  const key = location.pathname
  const keep = shouldKeepAlivePath(key)

  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const orderRef = useRef<string[]>([])

  if (keep) {
    cacheRef.current.set(key, {
      key,
      outlet,
      location,
      navigationType,
      routeContext,
    })
    const nextOrder = touchLru(orderRef.current, key, maxCached)
    const retained = new Set(nextOrder)
    for (const cachedKey of cacheRef.current.keys()) {
      if (!retained.has(cachedKey)) cacheRef.current.delete(cachedKey)
    }
    orderRef.current = nextOrder
  }

  return (
    <>
      {orderRef.current.map((cachedKey) => {
        const entry = cacheRef.current.get(cachedKey)
        if (entry?.outlet == null) return null
        const active = keep && cachedKey === key
        return (
          <div
            key={cachedKey}
            className={active ? 'h-full min-h-0' : undefined}
            style={active ? undefined : { display: 'none' }}
            hidden={!active}
            aria-hidden={!active}
          >
            <KeepAliveActiveContext.Provider value={active}>
              <UNSAFE_LocationContext.Provider
                value={{ location: entry.location, navigationType: entry.navigationType }}
              >
                <UNSAFE_RouteContext.Provider value={entry.routeContext}>
                  {entry.outlet}
                </UNSAFE_RouteContext.Provider>
              </UNSAFE_LocationContext.Provider>
            </KeepAliveActiveContext.Provider>
          </div>
        )
      })}
      {!keep && outlet != null ? (
        <div key={key} className="h-full min-h-0">
          {outlet}
        </div>
      ) : null}
    </>
  )
}
