/**
 * StateValuesStream — live current-state tree for ui-library.
 *
 * Renders a single device's CURRENT runtime-state as a scrollable,
 * collapsible hierarchical tree (NOT a chronological change log).
 *
 *  - Seed: on mount, `trpc.deviceState.getAllSnapshots` returns the
 *    whole-system snapshot; we pick out this device's entry and build
 *    a `Map<capName, slice>` of its current state.
 *  - Realtime: an `EventCategory.DeviceStateChanged` tRPC subscription
 *    scoped to the device patches each cap's slice into the map in
 *    place — the matching tree node re-renders, no rows are appended.
 *  - Tree: top level = cap names (sorted, expanded by default); each
 *    cap node expands to its slice keys; nested objects/arrays expand
 *    recursively, deep nesting collapsed by default. A per-cap
 *    "updated Ns ago" indicator surfaces realtime activity.
 *  - Filter/search: cap-name multiselect popover + free-text search,
 *    both applied to the tree (filter which caps show; search matches
 *    keys/values anywhere in the slice).
 *
 * The live subscription is mounted only while this component renders,
 * so the parent can mount/unmount it on tab switches and the tRPC
 * subscription is torn down automatically when hidden.
 */
import { useEffect, useMemo, useRef, useState, useCallback, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  X,
  Loader2,
  Copy,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Filter,
  Search,
} from 'lucide-react'
import { ALL_CAPABILITY_DEFINITIONS, EventCategory } from '@camstack/types'
import { trpc } from '../trpc-react'
import { useSystem } from '../contexts/system-context'
import { useDeviceProxy } from '../hooks/use-device-proxy'
import { cn } from '../lib/cn'
import { useUiText, type UiTextFn } from '../contexts/ui-text'
import { formatLeafValue } from './format-state-value'
import type { LiveBuffer } from '../hooks/use-live-buffer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which view the State panel renders: the normalized per-cap tree
 *  (default) or the device's raw upstream blob (opt-in, only offered
 *  when `deviceOps.getRawState` resolves a non-null blob). */
type StateMode = 'normalized' | 'raw'

/** A cap's current runtime-state slice keyed by cap name. */
type CapSlice = Record<string, unknown>

/** Current-state entry for one cap: its slice plus the wall-clock
 *  time the slice was last patched (seed time for the initial fetch,
 *  event arrival time for live updates). Drives the "updated Ns ago"
 *  indicator. */
interface CapState {
  readonly slice: CapSlice
  readonly updatedAt: number
  /**
   * True for a cold placeholder seeded from the cap's `runtimeState`
   * schema (all fields null) because the device is BOUND to the cap but
   * no slice has arrived yet. Real data — the `getAllSnapshots` seed or
   * a live `DeviceStateChanged` patch — always replaces a placeholder.
   *
   * Without this marker the two seeds raced: `getBindings` resolving
   * first filled every cap with nulls, and the snapshot seed's
   * presence check (`next.has(capName)`) then skipped every one of
   * them, so the real values never landed. On a device that emits no
   * live patches (a sleeping battery camera) the panel stayed
   * all-null indefinitely while the same data rendered fine
   * everywhere else in the app.
   */
  readonly placeholder?: boolean
}

interface RawEvent {
  readonly category?: unknown
  readonly data?: {
    readonly deviceId?: unknown
    readonly capName?: unknown
    readonly slice?: unknown
  }
}

interface StateChangePayload {
  readonly capName: string
  readonly slice: CapSlice
}

/** Narrow an untrusted live-stream event to a `DeviceStateChanged`
 *  for THIS device, returning the cap name + slice it carries. */
function readStateChange(raw: unknown, deviceId: number): StateChangePayload | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as RawEvent
  if (e.category !== EventCategory.DeviceStateChanged) return null
  const data = e.data
  if (!data || typeof data !== 'object') return null
  if (data.deviceId !== deviceId) return null
  if (typeof data.capName !== 'string') return null
  if (!data.slice || typeof data.slice !== 'object') return null
  return { capName: data.capName, slice: data.slice as CapSlice }
}

/** Whole-system snapshot shape: `{ [deviceId]: { [capName]: slice } }`.
 *  `getAllSnapshots` keys devices by their numeric id stringified. */
type SystemSnapshot = Record<string, Record<string, CapSlice>>

function isSystemSnapshot(raw: unknown): raw is SystemSnapshot {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw)
}

/** Raw upstream state as returned by `deviceOps.getRawState`. */
interface RawState {
  readonly source: string
  readonly data: Record<string, unknown>
}

/** Narrow `getRawState`'s nullable result to a usable `{ source, data }`
 *  blob. `null` (device exposes no raw state) and malformed payloads fail
 *  the guard, keeping the Raw toggle hidden. */
function isRawState(raw: unknown): raw is RawState {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as { source?: unknown; data?: unknown }
  if (typeof r.source !== 'string') return false
  return !!r.data && typeof r.data === 'object' && !Array.isArray(r.data)
}

/**
 * Project a raw `{ source, data }` blob onto the SAME `Map<string, CapState>`
 * the normalized tree renderer consumes, so the Raw view reuses `CapNode`
 * verbatim. Each top-level key of `data` becomes a top-level node:
 * `{ state, attributes:{…} }` → nodes `state` and `attributes`. A
 * non-object top-level value is wrapped as `{ value }` so it still renders
 * as a one-key slice. `updatedAt` is the supplied fetch time, which drives
 * the per-node "updated Ns ago" label.
 */
function buildRawTree(data: Record<string, unknown>, fetchedAt: number): Map<string, CapState> {
  const out = new Map<string, CapState>()
  for (const [key, value] of Object.entries(data)) {
    const slice: CapSlice =
      value && typeof value === 'object' && !Array.isArray(value) ? (value as CapSlice) : { value }
    out.set(key, { slice, updatedAt: fetchedAt })
  }
  return out
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StateValuesStreamProps {
  /** Device whose runtime-state we want to render. Required. */
  readonly deviceId: number
  /** Initial cap-name filter — empty = all caps visible. */
  readonly defaultCaps?: readonly string[]
  /** Max height CSS class for the scrollable tree body. */
  readonly maxHeight?: string
  /**
   * @deprecated The State panel no longer keeps a chronological log,
   * so there is no historical fetch to size. Accepted but ignored;
   * retained so existing callers don't break.
   */
  readonly limit?: number
  /**
   * @deprecated The State panel now renders a live current-state tree
   * sourced from `deviceState.getAllSnapshots` + the realtime
   * subscription, so there is no append-buffer to host across
   * tab switches. Accepted but ignored; retained so `DeviceActivityPanel`
   * (which passes a buffer) keeps type-checking without a ripple edit.
   */
  readonly liveBuffer?: LiveBuffer<unknown>
  readonly onClose?: () => void
  readonly className?: string
}

/**
 * Every device-scoped cap name, sorted alphabetically — same shape
 * as `ALL_EVENT_CATEGORIES` in event-stream.tsx so the filter
 * surface is symmetric across the three live-streams (Logs, Events,
 * State). Computed once at module load.
 */
const ALL_DEVICE_CAP_NAMES: readonly string[] = Object.freeze(
  [
    ...new Set(ALL_CAPABILITY_DEFINITIONS.filter((c) => c.scope === 'device').map((c) => c.name)),
  ].toSorted(),
)

/**
 * The keys of a cap's `runtimeState` object schema, or `[]` when the cap
 * declares none / it is not an object schema. Read structurally (no Zod
 * import, no cast) so a self-contained addon's schema instance still works
 * across the bundle boundary — `ZodObject.shape` is a public getter.
 */
function runtimeStateKeys(capName: string): readonly string[] {
  const def = ALL_CAPABILITY_DEFINITIONS.find((c) => c.name === capName)
  const rs: unknown = def?.runtimeState
  if (!rs || typeof rs !== 'object') return []
  const shape: unknown = Reflect.get(rs, 'shape')
  if (!shape || typeof shape !== 'object') return []
  return Object.keys(shape)
}

/**
 * Cold placeholder slice for a bound cap that declares `runtimeState` but
 * has never written it (e.g. a doorbell that has never rung).
 * Every declared field is seeded `null` so the tree surfaces the cap's
 * presence and reads as "never" instead of the cap being OMITTED entirely.
 * Returns `null` when the cap has no runtime-state schema (nothing to seed).
 */
function coldRuntimeStateSlice(capName: string): CapSlice | null {
  const keys = runtimeStateKeys(capName)
  if (keys.length === 0) return null
  const slice: CapSlice = {}
  for (const key of keys) slice[key] = null
  return slice
}

/** Depth at which tree nodes start collapsed. Cap nodes (depth 0) and
 *  their direct slice keys (depth 1) render expanded; anything nested
 *  deeper opens on demand. */
const DEFAULT_EXPAND_DEPTH = 1

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StateValuesStream({
  deviceId,
  defaultCaps,
  maxHeight = 'max-h-96',
  onClose,
  className,
}: StateValuesStreamProps): JSX.Element | null {
  const t = useUiText()
  const initialActiveCaps = useMemo(() => new Set<string>(defaultCaps ?? []), [defaultCaps])
  const [activeCaps, setActiveCaps] = useState<Set<string>>(initialActiveCaps)
  const [searchText, setSearchText] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterSearch, setFilterSearch] = useState('')
  const [mode, setMode] = useState<StateMode>('normalized')
  const filterRootRef = useRef<HTMLDivElement>(null)

  // Current-state model: cap name → { slice, updatedAt }. Seeded from
  // `getAllSnapshots`, then patched in place by the live subscription.
  const [capStates, setCapStates] = useState<Map<string, CapState>>(new Map())
  // Per-path collapse overrides. A path absent from the map uses the
  // depth-based default; presence stores the explicit user choice.
  const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(new Map())
  // Re-render clock so the "updated Ns ago" labels tick without an
  // event. Bumped every 5s.
  const [, setNowTick] = useState(0)

  // Reset model when the device changes — the old device's slices
  // must not leak into the new one's tree.
  const prevDeviceRef = useRef(deviceId)
  useEffect(() => {
    if (prevDeviceRef.current !== deviceId) {
      prevDeviceRef.current = deviceId
      setCapStates(new Map())
      setCollapseOverrides(new Map())
    }
  }, [deviceId])

  // Seed query — whole-system snapshot. `getAllSnapshots` takes no
  // input and returns every device's state; we pick out this device's
  // entry by its stringified id. A slow path is fine: state changes
  // are not high-frequency, and `staleTime` keeps the seed stable.
  const { data: snapshot, isLoading } = trpc.deviceState.getAllSnapshots.useQuery(
    {},
    { staleTime: 30_000 },
  )

  // Apply the seed once it lands. Live patches that arrive before the
  // seed already populated their cap; we only fill caps the live
  // stream hasn't touched, so realtime data is never overwritten by a
  // stale snapshot.
  useEffect(() => {
    if (!isSystemSnapshot(snapshot)) return
    const deviceSlices = snapshot[String(deviceId)]
    if (!deviceSlices) return
    const now = Date.now()
    setCapStates((prev) => {
      let mutated = false
      const next = new Map(prev)
      for (const [capName, slice] of Object.entries(deviceSlices)) {
        // Live data always wins — but a cold placeholder is NOT data.
        // (This ran once behind a `seededRef` guard and skipped on mere
        // presence, which let a placeholder permanently mask the real
        // slice when the bindings query resolved first.)
        const existing = next.get(capName)
        if (existing && existing.placeholder !== true) continue
        next.set(capName, { slice, updatedAt: now })
        mutated = true
      }
      return mutated ? next : prev
    })
  }, [snapshot, deviceId])

  // Bound-cap presence seed. A cap the device is BOUND to but whose
  // runtime-state slice was never written (e.g. a doorbell that has never
  // rung) is absent from `getAllSnapshots`, so the tree
  // would omit it entirely. Resolve the device's bindings and seed a cold
  // placeholder slice (all-null fields) for each bound cap that DECLARES a
  // `runtimeState` and isn't already present — so the operator SEES the
  // doorbell ("never") instead of nothing. Real slices (snapshot seed or a
  // live patch) always win: we only fill caps not already in the model.
  const { data: bindings } = trpc.deviceManager.getBindings.useQuery(
    { deviceId },
    { staleTime: 30_000 },
  )
  useEffect(() => {
    const entries = bindings?.entries
    if (!entries || entries.length === 0) return
    const now = Date.now()
    setCapStates((prev) => {
      let mutated = false
      const next = new Map(prev)
      for (const entry of entries) {
        if (next.has(entry.capName)) continue
        const slice = coldRuntimeStateSlice(entry.capName)
        if (!slice) continue
        next.set(entry.capName, { slice, updatedAt: now, placeholder: true })
        mutated = true
      }
      return mutated ? next : prev
    })
  }, [bindings, deviceId])

  // Patch a single cap's slice into the normalized model. Passed to the
  // live-subscription child so the realtime stream replaces (not appends)
  // the matching cap entry.
  const patchCapState = useCallback((capName: string, slice: CapSlice) => {
    setCapStates((prev) => {
      const next = new Map(prev)
      next.set(capName, { slice, updatedAt: Date.now() })
      return next
    })
  }, [])

  // Raw upstream state is fetched through the DeviceProxy, NOT a raw
  // `trpc.deviceOps.getRawState.useQuery({ deviceId })`. `device-ops` is a
  // device-scoped cap whose providers live in the device's owning (forked)
  // runner; a direct `{ deviceId }` tRPC call routes to `hub-in-process` and
  // fails with "Capability 'device-ops' provider not available". The proxy
  // resolves the device's binding (and its `nodeId`) and routes the call to
  // the owning node. `dev.deviceOps?.getRawState` is an imperative async
  // method (present only when the binding includes device-ops), so we wrap it
  // in React Query to keep the `data`/`isFetched`/`isFetching`/`refetch`
  // surface the rest of the component relies on.
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const getRawState = dev?.deviceOps?.getRawState
  // One-shot raw query — runs once the proxy resolves to learn whether this
  // device exposes any raw upstream state. `staleTime` keeps it from
  // re-running; the Refresh button in raw mode triggers an explicit `refetch`.
  const rawQuery = useQuery({
    queryKey: ['device-raw-state', deviceId],
    queryFn: () => getRawState!({ deviceId }),
    enabled: getRawState != null,
    staleTime: 60_000,
  })
  const rawState: RawState | null = isRawState(rawQuery.data) ? rawQuery.data : null
  const rawAvailable = rawQuery.isFetched && !rawQuery.isError && rawState != null

  // Fall back to normalized if raw becomes unavailable while selected
  // (e.g. a refetch resolves null) so we never strand the user on an
  // empty raw view with no toggle to escape it.
  useEffect(() => {
    if (mode === 'raw' && !rawAvailable) setMode('normalized')
  }, [mode, rawAvailable])

  // Raw tree — same `Map<string, CapState>` shape the normalized renderer
  // consumes, rebuilt whenever the raw blob changes.
  const rawCapStates = useMemo(
    () =>
      rawState
        ? buildRawTree(rawState.data, rawQuery.dataUpdatedAt || Date.now())
        : new Map<string, CapState>(),
    [rawState, rawQuery.dataUpdatedAt],
  )

  // Tick the "updated Ns ago" labels every 5s.
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 5_000)
    return () => clearInterval(id)
  }, [])

  // Filter source — every device-scoped cap, merged with whatever cap
  // names actually appear in the device's state (defensive: a
  // freshly-added cap not yet re-codegen'd would otherwise be missing
  // from the popover).
  const visibleCaps = useMemo(() => {
    const caps = new Set<string>(ALL_DEVICE_CAP_NAMES)
    for (const capName of capStates.keys()) caps.add(capName)
    return [...caps].toSorted()
  }, [capStates])

  // The caps that actually have state, after cap-filter + search.
  const filteredCapNames = useMemo(() => {
    const needle = searchText.trim().toLowerCase()
    const names = [...capStates.keys()].toSorted()
    return names.filter((capName) => {
      if (activeCaps.size > 0 && !activeCaps.has(capName)) return false
      if (!needle) return true
      // Search matches the cap name itself, or any key/value anywhere
      // in the slice tree.
      if (capName.toLowerCase().includes(needle)) return true
      return sliceMatchesSearch(capStates.get(capName)?.slice ?? {}, needle)
    })
  }, [capStates, activeCaps, searchText])

  const toggleCap = useCallback((cap: string) => {
    setActiveCaps((prev) => {
      const next = new Set(prev)
      if (next.has(cap)) next.delete(cap)
      else next.add(cap)
      return next
    })
  }, [])

  const handleReset = useCallback(() => {
    setActiveCaps(new Set<string>(defaultCaps ?? []))
    setSearchText('')
  }, [defaultCaps])

  const handleSelectAllCaps = useCallback(() => {
    setActiveCaps(new Set(visibleCaps))
  }, [visibleCaps])

  const handleSelectNoCaps = useCallback(() => {
    setActiveCaps(new Set())
  }, [])

  // Per-node collapse toggle. The default open/closed state is
  // depth-based; toggling stores an explicit override for that path.
  const toggleNode = useCallback((path: string, currentlyOpen: boolean) => {
    setCollapseOverrides((prev) => {
      const next = new Map(prev)
      next.set(path, !currentlyOpen)
      return next
    })
  }, [])

  const isPathOpen = useCallback(
    (path: string, depth: number): boolean => {
      const override = collapseOverrides.get(path)
      if (override !== undefined) return override
      return depth < DEFAULT_EXPAND_DEPTH
    },
    [collapseOverrides],
  )

  // Copy support — toolbar copies the whole filtered tree as JSON.
  const [copiedAll, setCopiedAll] = useState(false)
  const handleCopyAll = useCallback(() => {
    const out: Record<string, CapSlice> = {}
    for (const capName of filteredCapNames) {
      const state = capStates.get(capName)
      if (state) out[capName] = state.slice
    }
    void navigator.clipboard.writeText(JSON.stringify(out, null, 2)).then(() => {
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 1500)
    })
  }, [filteredCapNames, capStates])

  const filteredPopoverCaps = useMemo(() => {
    const needle = filterSearch.trim().toLowerCase()
    if (!needle) return visibleCaps
    return visibleCaps.filter((c) => c.toLowerCase().includes(needle))
  }, [filterSearch, visibleCaps])

  const totalAvailable = visibleCaps.length
  const totalActive = activeCaps.size
  const allSelected = totalActive === 0 || totalActive === totalAvailable
  const filterLabel = allSelected
    ? t('uiLibrary.stateValuesStream.filterAll', 'All')
    : `${totalActive}/${totalAvailable}`

  // Close popover on outside click — mirrors EventStream's pattern.
  useEffect(() => {
    if (!filterOpen) return
    const onDocClick = (e: MouseEvent) => {
      const root = filterRootRef.current
      if (root && !root.contains(e.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [filterOpen])

  const searchNeedle = searchText.trim().toLowerCase()

  return (
    <div
      className={cn('h-full min-h-0 flex flex-col', className)}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Toolbar — stays fixed; only the tree body below scrolls. */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-hover/30 gap-2 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-foreground-subtle font-medium">
            {t('uiLibrary.stateValuesStream.state', 'State')}
          </span>
          <ScopeBadge
            label={t('uiLibrary.stateValuesStream.scopeDevice', 'device')}
            value={`#${deviceId}`}
          />

          {/* Normalized | Raw segmented control — shown only when the
              device exposes raw upstream state (opt-in). */}
          {rawAvailable && <ModeToggle mode={mode} onChange={setMode} />}

          {mode === 'normalized' && (
            <>
              <div className="relative" ref={filterRootRef}>
                <button
                  type="button"
                  onClick={() => setFilterOpen((v) => !v)}
                  className={cn(
                    'inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border transition-colors',
                    !allSelected
                      ? 'border-violet-500/30 bg-violet-500/10 text-violet-400'
                      : 'border-border text-foreground-subtle hover:text-foreground',
                  )}
                  title={t('uiLibrary.stateValuesStream.pickCaps', 'Pick caps to show')}
                >
                  <Filter className="h-2.5 w-2.5" />
                  {t('uiLibrary.stateValuesStream.filter', 'Filter ({{label}})', {
                    label: filterLabel,
                  })}
                </button>
                {filterOpen && (
                  <CapFilterPopover
                    search={filterSearch}
                    onSearchChange={setFilterSearch}
                    caps={filteredPopoverCaps}
                    active={activeCaps}
                    onToggle={toggleCap}
                    onSelectAll={handleSelectAllCaps}
                    onSelectNone={handleSelectNoCaps}
                    onResetDefaults={handleReset}
                  />
                )}
              </div>

              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground transition-colors"
                title={t('uiLibrary.stateValuesStream.resetFilters', 'Reset filters')}
              >
                <RotateCcw className="h-2.5 w-2.5" />
                {t('uiLibrary.stateValuesStream.reset', 'Reset')}
              </button>

              <button
                type="button"
                onClick={handleCopyAll}
                disabled={filteredCapNames.length === 0}
                className={cn(
                  'inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border transition-colors',
                  copiedAll
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-border text-foreground-subtle hover:text-foreground',
                  filteredCapNames.length === 0 && 'opacity-40 cursor-not-allowed',
                )}
                title={t('uiLibrary.stateValuesStream.copyTitle', 'Copy visible state as JSON')}
              >
                <Copy className="h-2.5 w-2.5" />
                {copiedAll
                  ? t('uiLibrary.stateValuesStream.copied', 'Copied!')
                  : t('uiLibrary.stateValuesStream.copy', 'Copy')}
              </button>

              <div className="relative">
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t('uiLibrary.stateValuesStream.search', 'Search…')}
                  className="w-32 pl-1.5 pr-5 py-0.5 rounded border border-border bg-background text-foreground text-[10px] focus:outline-none focus:border-primary/50"
                />
                {searchText && (
                  <button
                    type="button"
                    onClick={() => setSearchText('')}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground"
                    title={t('uiLibrary.stateValuesStream.clearSearch', 'Clear search')}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
              </div>

              <span className="text-[9px] text-emerald-400 font-medium inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {t('uiLibrary.stateValuesStream.live', 'live')}
              </span>
            </>
          )}

          {mode === 'raw' && rawState && (
            <>
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/15 text-sky-400 px-2 py-0.5 text-[9px] font-medium font-sans">
                {t('uiLibrary.stateValuesStream.source', 'source: {{source}}', {
                  source: rawState.source,
                })}
              </span>
              <button
                type="button"
                onClick={() => rawQuery.refetch()}
                disabled={rawQuery.isFetching}
                className={cn(
                  'inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground transition-colors',
                  rawQuery.isFetching && 'opacity-60 cursor-wait',
                )}
                title={t('uiLibrary.stateValuesStream.rereadTitle', 'Re-read raw upstream state')}
              >
                <RotateCcw className={cn('h-2.5 w-2.5', rawQuery.isFetching && 'animate-spin')} />
                {t('uiLibrary.stateValuesStream.refresh', 'Refresh')}
              </button>
            </>
          )}
        </div>

        {/* Live subscription is mounted ONLY in normalized mode — raw is a
            one-shot read, so we tear the subscription down while it shows. */}
        {mode === 'normalized' && (
          <LiveStateSubscription deviceId={deviceId} onPatch={patchCapState} />
        )}

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-foreground-subtle hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Tree body — flex-1 fills remaining panel space; overflow-auto
          bounds the scroll within the fixed-height panel. */}
      <div className={cn('flex-1 min-h-0 overflow-auto text-[10px] font-mono', maxHeight)}>
        {mode === 'raw' ? (
          rawCapStates.size === 0 ? (
            <div className="py-4 text-center text-foreground-subtle font-sans">
              {t('uiLibrary.stateValuesStream.noRawState', 'No raw state')}
            </div>
          ) : (
            <div className="py-1">
              {[...rawCapStates.entries()].map(([key, state]) => (
                <CapNode
                  key={key}
                  capName={key}
                  slice={state.slice}
                  updatedAt={state.updatedAt}
                  searchNeedle=""
                  isPathOpen={isPathOpen}
                  onToggle={toggleNode}
                />
              ))}
            </div>
          )
        ) : (
          <>
            {isLoading && capStates.size === 0 && (
              <div className="flex items-center justify-center gap-2 py-6 text-foreground-subtle font-sans">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('uiLibrary.stateValuesStream.loading', 'Loading device state...')}
              </div>
            )}
            {!isLoading && capStates.size === 0 && (
              <div className="py-4 text-center text-foreground-subtle font-sans">
                {t('uiLibrary.stateValuesStream.noRuntimeState', 'No runtime state')}
              </div>
            )}
            {!isLoading && capStates.size > 0 && filteredCapNames.length === 0 && (
              <div className="py-4 text-center text-foreground-subtle font-sans">
                {t('uiLibrary.stateValuesStream.noCapsMatch', 'No caps match the filter')}
              </div>
            )}
            {filteredCapNames.length > 0 && (
              <div className="py-1">
                {filteredCapNames.map((capName) => {
                  const state = capStates.get(capName)
                  if (!state) return null
                  return (
                    <CapNode
                      key={capName}
                      capName={capName}
                      slice={state.slice}
                      updatedAt={state.updatedAt}
                      searchNeedle={searchNeedle}
                      isPathOpen={isPathOpen}
                      onToggle={toggleNode}
                    />
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mode toggle + live subscription
// ---------------------------------------------------------------------------

interface ModeToggleProps {
  readonly mode: StateMode
  readonly onChange: (mode: StateMode) => void
}

/** Normalized | Raw segmented control. Each option is a button so the
 *  active one carries the violet accent used elsewhere in the toolbar. */
function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const t = useUiText()
  const options: readonly { readonly value: StateMode; readonly label: string }[] = [
    { value: 'normalized', label: t('uiLibrary.stateValuesStream.normalized', 'Normalized') },
    { value: 'raw', label: t('uiLibrary.stateValuesStream.raw', 'Raw') },
  ]
  return (
    <div className="inline-flex items-center rounded border border-border overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'text-[9px] px-1.5 py-0.5 transition-colors',
            mode === opt.value
              ? 'bg-violet-500/15 text-violet-400'
              : 'text-foreground-subtle hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

interface LiveStateSubscriptionProps {
  readonly deviceId: number
  readonly onPatch: (capName: string, slice: CapSlice) => void
}

/**
 * Mounts the realtime `DeviceStateChanged` tRPC subscription for the
 * device and patches each event's cap slice into the normalized model via
 * `onPatch`. Rendered ONLY while the panel is in normalized mode, so
 * switching to the one-shot Raw view tears the subscription down (and
 * remounting on switch-back re-subscribes) with no `onData` churn in raw
 * mode.
 */
function LiveStateSubscription({ deviceId, onPatch }: LiveStateSubscriptionProps) {
  trpc.systemEvents.subscribe.useSubscription(
    { deviceId, category: EventCategory.DeviceStateChanged },
    {
      onData: (raw: unknown) => {
        const change = readStateChange(raw, deviceId)
        if (!change) return
        onPatch(change.capName, change.slice)
      },
    },
  )
  return null
}

// ---------------------------------------------------------------------------
// Tree nodes
// ---------------------------------------------------------------------------

interface IsPathOpen {
  (path: string, depth: number): boolean
}

interface OnToggle {
  (path: string, currentlyOpen: boolean): void
}

interface CapNodeProps {
  readonly capName: string
  readonly slice: CapSlice
  readonly updatedAt: number
  readonly searchNeedle: string
  readonly isPathOpen: IsPathOpen
  readonly onToggle: OnToggle
}

/** Top-level tree node: one capability. Header carries the cap-name
 *  pill + an "updated Ns ago" indicator; the body expands to the
 *  slice's keys. */
function CapNode({ capName, slice, updatedAt, searchNeedle, isPathOpen, onToggle }: CapNodeProps) {
  const t = useUiText()
  const path = capName
  const open = isPathOpen(path, 0)
  const entries = Object.entries(slice)
  return (
    <div>
      <div
        className="flex items-center gap-1.5 px-3 py-1 hover:bg-surface-hover/30 cursor-pointer select-none"
        onClick={() => onToggle(path, open)}
      >
        <Chevron open={open} hasChildren={entries.length > 0} />
        <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/15 text-violet-400 px-2 py-0.5 text-[9px] font-medium font-sans">
          {capName}
        </span>
        <span className="text-[9px] text-foreground-subtle font-sans">
          {t(
            'uiLibrary.stateValuesStream.keys',
            { one: '{{count}} key', other: '{{count}} keys' },
            { count: entries.length },
          )}
        </span>
        <span className="ml-auto text-[9px] text-foreground-subtle/70 font-sans tabular-nums">
          {t('uiLibrary.stateValuesStream.updated', 'updated {{age}}', {
            age: formatAge(updatedAt, t),
          })}
        </span>
      </div>
      {open && (
        <div>
          {entries.length === 0 ? (
            <LeafEmpty
              depth={1}
              label={t('uiLibrary.stateValuesStream.emptySlice', 'empty slice')}
            />
          ) : (
            entries.map(([k, v]) => (
              <TreeNode
                key={k}
                path={`${path}.${k}`}
                nodeKey={k}
                value={v}
                depth={1}
                searchNeedle={searchNeedle}
                isPathOpen={isPathOpen}
                onToggle={onToggle}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

interface TreeNodeProps {
  readonly path: string
  readonly nodeKey: string
  readonly value: unknown
  readonly depth: number
  readonly searchNeedle: string
  readonly isPathOpen: IsPathOpen
  readonly onToggle: OnToggle
}

/** Recursive tree node. A leaf renders `key: value`; an object or
 *  array renders a collapsible branch whose children recurse one
 *  level deeper. */
function TreeNode({
  path,
  nodeKey,
  value,
  depth,
  searchNeedle,
  isPathOpen,
  onToggle,
}: TreeNodeProps) {
  const t = useUiText()
  const branch = asBranch(value)
  // Indent grows with depth; the chevron column stays aligned.
  const indentStyle = { paddingLeft: `${12 + depth * 14}px` }

  if (!branch) {
    // Epoch timestamps render as local dates — `lastFetchedAt: 1785060000000` is
    // on every runtimeState slice and unreadable as a number. `raw` is non-null
    // only when the text was rewritten, and becomes a tooltip: this is a debugging
    // panel, so the exact value has to stay reachable.
    const leaf = formatLeafValue(nodeKey, value)
    return (
      <div className="flex items-start gap-1 px-3 py-0.5" style={indentStyle}>
        <span className={cn('shrink-0', highlightCls(nodeKey, searchNeedle, 'text-primary/70'))}>
          {nodeKey}
        </span>
        <span className="text-foreground-subtle">:</span>
        <span
          className={cn('break-all', highlightCls(leaf.text, searchNeedle, valueCls(value)))}
          {...(leaf.raw === null ? {} : { title: leaf.raw })}
        >
          {leaf.text}
        </span>
      </div>
    )
  }

  const open = isPathOpen(path, depth)
  return (
    <div>
      <div
        className="flex items-center gap-1 px-3 py-0.5 hover:bg-surface-hover/30 cursor-pointer select-none"
        style={indentStyle}
        onClick={() => onToggle(path, open)}
      >
        <Chevron open={open} hasChildren={branch.entries.length > 0} />
        <span className={highlightCls(nodeKey, searchNeedle, 'text-primary/70')}>{nodeKey}</span>
        <span className="text-foreground-subtle/70 text-[9px]">{branch.summary}</span>
      </div>
      {open &&
        (branch.entries.length === 0 ? (
          <LeafEmpty
            depth={depth + 1}
            label={
              branch.kind === 'array'
                ? t('uiLibrary.stateValuesStream.emptyArray', 'empty array')
                : t('uiLibrary.stateValuesStream.emptyObject', 'empty object')
            }
          />
        ) : (
          branch.entries.map(([k, v]) => (
            <TreeNode
              key={k}
              path={`${path}.${k}`}
              nodeKey={k}
              value={v}
              depth={depth + 1}
              searchNeedle={searchNeedle}
              isPathOpen={isPathOpen}
              onToggle={onToggle}
            />
          ))
        ))}
    </div>
  )
}

/** Placeholder row for an object/array/slice with no entries. */
function LeafEmpty({ depth, label }: { readonly depth: number; readonly label: string }) {
  return (
    <div
      className="px-3 py-0.5 text-foreground-subtle/60 italic"
      style={{ paddingLeft: `${12 + depth * 14}px` }}
    >
      {label}
    </div>
  )
}

/** Expand/collapse chevron. Renders a fixed-width spacer when the node
 *  has no children so leaf and branch keys stay column-aligned. */
function Chevron({ open, hasChildren }: { readonly open: boolean; readonly hasChildren: boolean }) {
  if (!hasChildren) return <span className="inline-block w-3 shrink-0" />
  return open ? (
    <ChevronDown className="h-3 w-3 text-foreground-subtle shrink-0" />
  ) : (
    <ChevronRight className="h-3 w-3 text-foreground-subtle shrink-0" />
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Branch {
  readonly kind: 'object' | 'array'
  readonly entries: readonly (readonly [string, unknown])[]
  readonly summary: string
}

/** Classify a value as an expandable branch (plain object or array)
 *  or `null` for a leaf. Arrays expose index → element entries. */
function asBranch(value: unknown): Branch | null {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      entries: value.map((v, i): readonly [string, unknown] => [String(i), v]),
      summary: `[${value.length}]`,
    }
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return { kind: 'object', entries, summary: `{${entries.length}}` }
  }
  return null
}

/** Tailwind colour for a leaf value by JS type. */
function valueCls(v: unknown): string {
  if (v === null || v === undefined) return 'text-foreground-subtle/60'
  if (typeof v === 'number') return 'text-amber-400'
  if (typeof v === 'boolean') return v ? 'text-emerald-400' : 'text-rose-400'
  return 'text-foreground'
}

/** Append a highlight background when `text` matches the live search
 *  needle, so search hits are visible inside the tree. */
function highlightCls(text: string, needle: string, base: string): string {
  if (needle && text.toLowerCase().includes(needle)) {
    return cn(base, 'bg-violet-500/20 rounded px-0.5')
  }
  return base
}

/**
 * Deep search a slice — true when `needle` appears in any key or any leaf value
 * anywhere in the tree.
 *
 * `key` is threaded down so a leaf is matched the way it is DISPLAYED: a timestamp
 * shown as a local date has to be findable by typing part of that date. Both forms
 * match, so the raw epoch still works too — the operator should not have to know
 * which one the panel chose to render.
 */
function sliceMatchesSearch(value: unknown, needle: string, key = ''): boolean {
  if (Array.isArray(value)) {
    return value.some((v, i) => sliceMatchesSearch(v, needle, String(i)))
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase().includes(needle)) return true
      if (sliceMatchesSearch(v, needle, k)) return true
    }
    return false
  }
  const leaf = formatLeafValue(key, value)
  if (leaf.text.toLowerCase().includes(needle)) return true
  return leaf.raw !== null && leaf.raw.toLowerCase().includes(needle)
}

/** Human "Ns ago" / "Nm ago" age label for the per-cap freshness
 *  indicator. */
function formatAge(updatedAt: number, t: UiTextFn): string {
  const deltaMs = Date.now() - updatedAt
  if (deltaMs < 5_000) return t('uiLibrary.stateValuesStream.justNow', 'just now')
  const secs = Math.floor(deltaMs / 1_000)
  if (secs < 60)
    return t('uiLibrary.stateValuesStream.secondsAgo', '{{count}}s ago', { count: secs })
  const mins = Math.floor(secs / 60)
  if (mins < 60)
    return t('uiLibrary.stateValuesStream.minutesAgo', '{{count}}m ago', { count: mins })
  const hrs = Math.floor(mins / 60)
  return t('uiLibrary.stateValuesStream.hoursAgo', '{{count}}h ago', { count: hrs })
}

function ScopeBadge({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium font-sans">
      {label}: {value}
    </span>
  )
}

interface CapFilterPopoverProps {
  readonly search: string
  readonly onSearchChange: (s: string) => void
  readonly caps: readonly string[]
  readonly active: ReadonlySet<string>
  readonly onToggle: (cap: string) => void
  readonly onSelectAll: () => void
  readonly onSelectNone: () => void
  readonly onResetDefaults: () => void
}

/**
 * Cap-name multiselect popover — same shape as `CategoryFilterPopover`
 * in event-stream.tsx (search box at top, Select All / None / Defaults
 * buttons, scrollable checkbox list).
 */
function CapFilterPopover({
  search,
  onSearchChange,
  caps,
  active,
  onToggle,
  onSelectAll,
  onSelectNone,
  onResetDefaults,
}: CapFilterPopoverProps) {
  const t = useUiText()
  return (
    <div
      className="absolute z-20 top-full mt-1 left-0 w-72 max-h-80 rounded-md border border-border bg-surface shadow-lg flex flex-col font-sans"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50">
        <Search className="h-3 w-3 text-foreground-subtle" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('uiLibrary.stateValuesStream.filterCaps', 'Filter caps…')}
          className="flex-1 bg-transparent text-[10px] focus:outline-none text-foreground placeholder:text-foreground-subtle"
          autoFocus
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="text-foreground-subtle hover:text-foreground"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 text-[9px]">
        <button
          type="button"
          onClick={onSelectAll}
          className="px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground"
        >
          {t('uiLibrary.stateValuesStream.all', 'All')}
        </button>
        <button
          type="button"
          onClick={onSelectNone}
          className="px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground"
        >
          {t('uiLibrary.stateValuesStream.none', 'None')}
        </button>
        <button
          type="button"
          onClick={onResetDefaults}
          className="px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground"
        >
          {t('uiLibrary.stateValuesStream.defaults', 'Defaults')}
        </button>
      </div>
      <div className="overflow-y-auto flex-1">
        {caps.length === 0 && (
          <div className="text-[10px] text-foreground-subtle italic px-2 py-3 text-center">
            {t('uiLibrary.stateValuesStream.noMatches', 'No matches')}
          </div>
        )}
        {caps.map((cap) => {
          const checked = active.has(cap)
          return (
            <button
              key={cap}
              type="button"
              onClick={() => onToggle(cap)}
              className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-surface-hover/40 text-[10px]"
            >
              <input type="checkbox" readOnly checked={checked} className="accent-violet-500" />
              <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/15 text-violet-400 px-1.5 py-0.5 text-[9px] font-medium shrink-0">
                {cap}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
