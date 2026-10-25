/**
 * useDeviceListUrlState — URL-first hybrid state hook for DeviceList.
 *
 *   - Source of truth: the URL query string. Reads on mount + on
 *     `popstate` (back/forward navigation). Writes via
 *     `history.replaceState` on every setter.
 *   - Fallback: `localStorage[<lsKey>:lastFilters]` — JSON object
 *     `{addon, type, q}` (NEVER page, NEVER view). Used to rehydrate when
 *     the URL has no params.
 *   - Defaults stripped from URL — when the value is the default AND
 *     not pinned by LS, it's removed (URL stays canonical).
 *
 * Two scopes:
 *   - 'root' — uses `page`, `addon`, `type`, `q`
 *   - 'nested' — uses `deviceView`, `devicePage`, `deviceType`,
 *     `deviceQ` (no `deviceAddon` — outer ?expand= locks it). Used
 *     by Integrations page expanded row.
 *
 * Page reset rule: changing addon / type / q resets page to 1.
 * `clearFilters` clears addon / type / q.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * There is ONE device list rendering: the table.
 *
 * A cards view existed alongside it and the operator chose between them. It is
 * gone — every surface is a table now, so `view` is no longer part of this
 * state and no longer written to the URL or to localStorage. A legacy
 * `?view=cards` link still opens: the parameter is simply not read, and the
 * next write drops it from the URL.
 *
 * The DataTable never swaps to cards on a phone either: it scrolls sideways
 * inside its own container.
 */
export interface DeviceListUrlState {
  readonly page: number
  /**
   * Selected integration ids. Multi-select: empty array = no integration
   * filter (show all). Serialised in the URL / localStorage as a single
   * comma-joined `addon` value so existing single-value links keep working.
   */
  readonly addons: readonly string[]
  /**
   * Selected device types. Multi-select: empty array = no type filter.
   * Serialised in the URL / localStorage as a single comma-joined `type`
   * value so existing single-value links keep working.
   */
  readonly types: readonly string[]
  readonly q: string
}

export interface UseDeviceListUrlStateOptions {
  readonly scope: 'root' | 'nested'
  /** LocalStorage key prefix, e.g. `'devices'` → `camstack:devices:lastFilters`. */
  readonly lsKey: string
}

export interface UseDeviceListUrlStateResult {
  readonly state: DeviceListUrlState
  readonly setPage: (page: number) => void
  readonly setAddons: (addons: readonly string[]) => void
  readonly setTypes: (types: readonly string[]) => void
  readonly setQ: (q: string) => void
  readonly clearFilters: () => void
}

interface PersistedFilters {
  /** Legacy: written by the version that had a cards view. Read tolerantly so
   *  an old blob does not throw, never applied. */
  readonly view?: string
  /** Comma-joined integration ids (or a single id for legacy entries). */
  readonly addon?: string | null
  readonly type?: string | null
  readonly q?: string
}

/** Parse a comma-joined param/LS value into a clean id array. */
function parseCsv(raw: string | null | undefined): readonly string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

type UrlParamKey = keyof DeviceListUrlState | 'view'

function paramKey(scope: 'root' | 'nested', base: UrlParamKey): string {
  // Multi-select state keys are plural (`addons` / `types`) but the URL params
  // stay singular + comma-joined (`addon` / `type`) so existing single-value
  // links keep resolving.
  if (scope === 'root') {
    if (base === 'addons') return 'addon'
    if (base === 'types') return 'type'
    return base
  }
  switch (base) {
    case 'view':
      return 'deviceView'
    case 'page':
      return 'devicePage'
    case 'types':
      return 'deviceType'
    case 'q':
      return 'deviceQ'
    case 'addons':
      return 'deviceAddon' // unused in practice — caller locks it
  }
}

function readFromLS(lsKey: string): PersistedFilters {
  try {
    const raw = localStorage.getItem(`camstack:${lsKey}:lastFilters`)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as PersistedFilters
  } catch {
    return {}
  }
}

function writeToLS(lsKey: string, filters: PersistedFilters): void {
  try {
    localStorage.setItem(`camstack:${lsKey}:lastFilters`, JSON.stringify(filters))
  } catch {
    /* ignore quota */
  }
}

function readUrlState(scope: 'root' | 'nested', ls: PersistedFilters): DeviceListUrlState {
  const params = new URLSearchParams(window.location.search)

  const rawPage = params.get(paramKey(scope, 'page'))
  const pageNum = rawPage ? parseInt(rawPage, 10) : 1
  const page = Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : 1

  const addons = parseCsv(params.get(paramKey(scope, 'addons')) ?? ls.addon ?? null)
  const types = parseCsv(params.get(paramKey(scope, 'types')) ?? ls.type ?? null)
  const q = params.get(paramKey(scope, 'q')) ?? ls.q ?? ''

  return { page, addons, types, q }
}

function writeUrlState(scope: 'root' | 'nested', next: DeviceListUrlState): void {
  const params = new URLSearchParams(window.location.search)
  const set = (k: string, v: string | null) => {
    if (v === null || v === '') params.delete(k)
    else params.set(k, v)
  }
  // `view` is not written any more; a legacy one in the URL is dropped here.
  set(paramKey(scope, 'view'), null)
  set(paramKey(scope, 'page'), next.page === 1 ? null : String(next.page))
  set(paramKey(scope, 'addons'), next.addons.length > 0 ? next.addons.join(',') : null)
  set(paramKey(scope, 'types'), next.types.length > 0 ? next.types.join(',') : null)
  set(paramKey(scope, 'q'), next.q || null)
  const qs = params.toString()
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  window.history.replaceState(null, '', url)
}

export function useDeviceListUrlState(
  options: UseDeviceListUrlStateOptions,
): UseDeviceListUrlStateResult {
  const { scope, lsKey } = options

  const [state, setState] = useState<DeviceListUrlState>(() => {
    const ls = readFromLS(lsKey)
    return readUrlState(scope, ls)
  })
  // Mirror state in a ref so setters batched in a single render cycle
  // see each other's writes (URL is the source of truth, not React state).
  const stateRef = useRef<DeviceListUrlState>(state)
  stateRef.current = state

  // Listen for back/forward — popstate updates state from URL.
  useEffect(() => {
    const handler = (): void => {
      const ls = readFromLS(lsKey)
      const next = readUrlState(scope, ls)
      stateRef.current = next
      setState(next)
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [scope, lsKey])

  const apply = useCallback(
    (mutate: (current: DeviceListUrlState) => DeviceListUrlState) => {
      const next = mutate(stateRef.current)
      stateRef.current = next
      setState(next)
      writeUrlState(scope, next)
      writeToLS(lsKey, {
        addon: next.addons.length > 0 ? next.addons.join(',') : null,
        type: next.types.length > 0 ? next.types.join(',') : null,
        q: next.q,
      })
    },
    [scope, lsKey],
  )

  const setPage = useCallback((page: number) => apply((s) => ({ ...s, page })), [apply])
  const setAddons = useCallback(
    (addons: readonly string[]) => apply((s) => ({ ...s, addons, page: 1 })),
    [apply],
  )
  const setTypes = useCallback(
    (types: readonly string[]) => apply((s) => ({ ...s, types, page: 1 })),
    [apply],
  )
  const setQ = useCallback((q: string) => apply((s) => ({ ...s, q, page: 1 })), [apply])
  const clearFilters = useCallback(
    () => apply((s) => ({ ...s, addons: [], types: [], q: '', page: 1 })),
    [apply],
  )

  return { state, setPage, setAddons, setTypes, setQ, clearFilters }
}
