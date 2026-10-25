/**
 * WidgetRegistry — admin-ui side of the addon-widgets system.
 *
 * Backed by Module Federation (`@module-federation/runtime`). The host
 * (admin-ui) declares its shared singletons in `vite.config.ts`; every
 * widget addon publishes a remote at `dist/remoteEntry.js` (built by
 * `vite.widgets.config.ts`). At runtime we fetch the public list of
 * addon-contributed widgets via `useAddonWidgetsListWidgets()`, register
 * each remote (`registerRemotes`) once, then resolve a widget by
 * loading the exposed module (`loadRemote`) whose default export is a
 * `Record<componentKey, ComponentType>` map.
 *
 * Unified UI-contribution model (Task 10) — a widget declaration IS a
 * `UiContribution` with `kind:'remote'`. Both the device-detail path
 * (`ContributionRenderer`) and the dashboard render widgets through the
 * same `loadRemoteBundle` MF path. `loadRemoteBundle` is exported and
 * generic over `(remoteName, exposedModule, entryUrl)` so any
 * `UiContributionRemote` descriptor resolves without an aggregator-keyed
 * lookup.
 *
 * Why MF instead of raw ESM:
 *  - automatic dedup of shared deps (react/react-dom/@tanstack/etc.)
 *    against the host's instances — no more hand-rolled vendor stubs +
 *    importmap shims pointing at `window.__camstack*` globals.
 *  - version negotiation (we pin `singleton: true` everywhere; the host
 *    wins by default).
 *  - cross-bundle context invariant preserved automatically: every
 *    remote's `@camstack/ui-library` import resolves to the host's
 *    instance, so `createContext()` references match across bundles.
 *
 * Live-update — listens to `addon.widget-ready` so newly-loaded addons
 * surface their widgets without a manual page reload (the aggregator
 * stamps a fresh `?v=<mtime>` cache-buster on the entry URL).
 *
 * Cache resilience — same `staleTime: 0` + `refetchOnMount` + boot-
 * window poll fallback as `AppLayout`'s addon-pages query.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type JSX,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { registerRemotes, loadRemote } from '@module-federation/runtime'
import type { UiContributionRemote, EnrichedWidgetMetadata } from '@camstack/types'

import { createSharedContext } from '../lib/shared-context'
import { ensureMfHostInit } from '../lib/mf-runtime-init'
import { useAddonWidgetsListWidgets } from '../generated/system-hooks.js'
import { useLiveEvent } from '../hooks/use-live-event.js'
import { hubPath } from '../lib/hub-mount'

/** Standard props every addon-contributed widget receives. */
export interface WidgetProps {
  /** Stable id of THIS widget instance (form-builder field key, dashboard slot UUID, etc.). */
  readonly instanceId: string
  /** Host where this widget is rendered. */
  readonly host: 'device-tab' | 'dashboard' | 'integration-detail'
  /** Form/dashboard-supplied props. Shape depends on the widget. */
  readonly config?: Readonly<Record<string, unknown>>
  /** Provided when host has a device context. */
  readonly deviceId?: number
  /** Provided when host has an integration context. */
  readonly integrationId?: string
  /** Dashboard sizing hints (placeholder for v1 — widget can ignore). */
  readonly size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  readonly columns?: number
  readonly rows?: number
}

/** Public registry surface. */
export interface WidgetRegistry {
  /**
   * Returns the resolved widget component for `<addonId>/<stableId>`,
   * or `undefined` when the widget id is unknown to the registry, or
   * `null` while the bundle is still loading.
   *
   * @deprecated Unused by all render paths since the unified
   * UI-contribution model (Task 10). Resolve remotes through
   * `useRemoteComponent` / `<WidgetSlot>` instead. Kept for external
   * addons that may still call it.
   */
  resolve(widgetId: string): ComponentType<WidgetProps> | null | undefined
  /** Metadata lookup — used by `<WidgetSlot>` to validate `requires`. */
  metadata(widgetId: string): WidgetMetadataEntry | undefined
  /** Every contributed widget. Used by host pickers (e.g. dashboard
   *  add-widget modal) to enumerate the available widgets. */
  listAll(): readonly WidgetMetadataEntry[]
  /**
   * Resolve the versioned MF entry URL for a remote name — the
   * aggregator-stamped `bundleUrl`. Used by the unified
   * `ContributionRenderer` `kind:'remote'` path to load a remote it
   * only knows by `remoteName`. `undefined` when no widget in the
   * registry references that remote.
   */
  entryUrlFor(remoteName: string): string | undefined
}

/** Widget host kinds — a widget can run on more than one host. */
export type WidgetHost = 'device-tab' | 'dashboard' | 'integration-detail'

/** Dashboard sizing hints. */
export type WidgetSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/**
 * One enriched-aggregator entry exposed to consumers.
 *
 * A widget declaration IS a `UiContribution` (`kind:'remote'`) plus
 * widget-only metadata — this entry mirrors that shape with the
 * aggregator-stamped `addonId` + `bundleUrl` added.
 */
export interface WidgetMetadataEntry {
  readonly widgetId: string // `<addonId>/<stableId>`
  readonly addonId: string
  readonly stableId: string
  // ── UiContribution core (kind:'remote') ──────────────────────────
  readonly tab: string
  readonly subTab?: string
  readonly label: string
  readonly order?: number
  readonly kind: 'remote'
  readonly remote: UiContributionRemote
  // ── Widget metadata ──────────────────────────────────────────────
  readonly description?: string
  readonly icon?: string
  readonly bundleUrl: string
  readonly hosts: readonly WidgetHost[]
  readonly requires: { readonly deviceContext: boolean; readonly integrationContext: boolean }
  readonly defaultSize: WidgetSize
  readonly allowedSizes: readonly WidgetSize[]
  readonly defaultColumns: number
  readonly defaultRows: number
}

const WidgetRegistryContext = createSharedContext<WidgetRegistry | null>(
  'camstack:widget-registry',
  null,
)

/**
 * Process-global cache for resolved remote bundles, keyed by
 * `<remoteName>::<exposedModule>`. Each cached value is the exposed
 * module's default-record map (`Record<componentKey, Component>`).
 * Survives provider remount — avoids a full re-fetch + re-init of the
 * MF remote when admin-ui's tree cycles.
 */
const bundleModuleCache = new Map<string, Record<string, ComponentType<WidgetProps>>>()
const bundleInflight = new Map<string, Promise<Record<string, ComponentType<WidgetProps>>>>()

/**
 * Set of MF remote names already passed to `registerRemotes`. Calling
 * `registerRemotes` twice with the same name is a no-op (`force` is
 * intentionally left `false`) but the bookkeeping makes intent clear
 * and avoids a chunk of plugin-internal work on every aggregator
 * update.
 */
const registeredRemotes = new Set<string>()

/** Cache key for `bundleModuleCache` — one entry per `(remote, module)`. */
function bundleCacheKey(remoteName: string, exposedModule: string): string {
  return `${remoteName}::${exposedModule}`
}

/**
 * Raw aggregator row — `WidgetMetadata` (from `addon-widgets-source`)
 * enriched by the hub aggregator with `addonId` + `bundleUrl`. Derived
 * straight from the cap's `EnrichedWidgetMetadataSchema` (`z.infer`) so
 * the registry never drifts from the wire shape.
 */
type AggregatorEntry = EnrichedWidgetMetadata

/** Shape of a remote's exposed module — a default-record of components. */
interface RemoteWidgetsModule {
  readonly default: Record<string, ComponentType<WidgetProps>>
}

function isRemoteWidgetsModule(value: unknown): value is RemoteWidgetsModule {
  if (!value || typeof value !== 'object') return false
  const def = (value as { default?: unknown }).default
  return def !== null && typeof def === 'object'
}

/** Structural snapshot of a remote module — keys + proto name, value-free. */
interface RemoteShapeSnapshot {
  readonly ownKeys: readonly string[]
  readonly allKeys: readonly string[]
  readonly proto: string | undefined
}

/** Diagnostic describe result — a `typeof` string for non-objects, or a key snapshot. */
type RemoteShapeDescription = string | RemoteShapeSnapshot

/**
 * Diagnostic-only string for the "Got: …" tail in the not-a-record
 * error. Returns a JSON-friendly snapshot of the module's keys + proto
 * name without exposing the value itself.
 */
function describeRemoteShape(mod: unknown): RemoteShapeDescription {
  if (!mod || typeof mod !== 'object') return typeof mod
  const obj = mod as Record<string, unknown>
  const proto: unknown = Object.getPrototypeOf(obj)
  const protoName =
    proto && typeof proto === 'object'
      ? (proto as { constructor?: { name?: unknown } }).constructor?.name
      : undefined
  return {
    ownKeys: Object.keys(obj),
    allKeys: Object.getOwnPropertyNames(obj),
    proto: typeof protoName === 'string' ? protoName : undefined,
  }
}

/**
 * Register the MF remote (idempotent) and load one of its exposed
 * modules. Returns the resolved `Record<componentKey, Component>` map
 * (the exposed module's `default` export).
 *
 * Exported so the unified `ContributionRenderer` `kind:'remote'` path
 * can load an arbitrary `{ remoteName, exposedModule }` descriptor —
 * the same path the `WidgetRegistry` uses internally for widgets.
 */
export async function loadRemoteBundle(
  remoteName: string,
  exposedModule: string,
  entryUrl: string,
): Promise<Record<string, ComponentType<WidgetProps>>> {
  const cacheKey = bundleCacheKey(remoteName, exposedModule)
  const cached = bundleModuleCache.get(cacheKey)
  if (cached) return cached
  const inflight = bundleInflight.get(cacheKey)
  if (inflight) return inflight

  if (!registeredRemotes.has(remoteName)) {
    ensureMfHostInit()
    // `type: 'module'` is mandatory because the Vite-built remote
    // entries are ESM (use `import` statements). MF's default loader
    // injects a plain `<script>` tag which would fail with "Failed to
    // load script resource" on any module-formatted entry.
    // The aggregator stamps `bundleUrl` relative to the hub ROOT; under a
    // path-mounted relay the page has to put it back under its mount.
    registerRemotes([{ name: remoteName, entry: hubPath(entryUrl), type: 'module' }], {
      force: false,
    })
    registeredRemotes.add(remoteName)
  }

  // MF's `loadRemote` key is `<remoteName>/<module>` — strip the
  // leading `./` from the exposed-module path the descriptor carries.
  const modulePath = exposedModule.startsWith('./') ? exposedModule.slice(2) : exposedModule
  const promise = loadRemote<unknown>(`${remoteName}/${modulePath}`)
    .then((mod): Record<string, ComponentType<WidgetProps>> => {
      if (!isRemoteWidgetsModule(mod)) {
        // Surface the actual shape so devs see what's missing.
        const shape = describeRemoteShape(mod)
        throw new Error(
          `Remote ${remoteName} (${entryUrl}) does not expose a default record on '${exposedModule}'. ` +
            `Got: ${JSON.stringify(shape)}`,
        )
      }
      const map = mod.default
      bundleModuleCache.set(cacheKey, map)
      bundleInflight.delete(cacheKey)
      return map
    })
    .catch((err: unknown) => {
      bundleInflight.delete(cacheKey)
      throw err
    })
  bundleInflight.set(cacheKey, promise)
  return promise
}

/** Synchronous peek at the resolved-bundle cache — `undefined` if not yet loaded. */
function peekBundle(
  remoteName: string,
  exposedModule: string,
): Record<string, ComponentType<WidgetProps>> | undefined {
  return bundleModuleCache.get(bundleCacheKey(remoteName, exposedModule))
}

const BOOT_WINDOW_MS = 30_000
const POLL_INTERVAL_MS = 2_000

export interface WidgetRegistryProviderProps {
  readonly children: ReactNode
}

export function WidgetRegistryProvider({
  children,
}: WidgetRegistryProviderProps): JSX.Element | null {
  const queryClient = useQueryClient()
  const mountedAtRef = useRef(Date.now())

  const { data: rawWidgets } = useAddonWidgetsListWidgets(undefined, {
    // Same boot-time race protection as AppLayout's addon-pages
    // query — see the extensive note there for the bug a long
    // staleTime introduces.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) => {
      const data = query.state.data
      if (data && data.length > 0) return false
      const elapsed = Date.now() - mountedAtRef.current
      if (elapsed >= BOOT_WINDOW_MS) return false
      return POLL_INTERVAL_MS
    },
  })

  // Re-emit on `addon.widget-ready` so newly-loaded addons surface
  // their widgets without a page reload. Same key shape as AppLayout.
  useLiveEvent('addon.widget-ready', () => {
    queryClient.invalidateQueries({ queryKey: [['addonWidgets', 'listWidgets']] })
  })

  // Force a re-render whenever a bundle finishes loading — the
  // resolved component lives in the global cache; the registry surface
  // only needs a tick to flip from `null` (loading) to the component.
  const [resolvedTick, setResolvedTick] = useState(0)

  // Stable reference — `rawWidgets ?? []` would mint a fresh `[]` on
  // every render while the query is loading (`rawWidgets` undefined),
  // churning the downstream `useEffect` + registry `useMemo` and
  // re-rendering every consumer. Memoize so the empty case is one array.
  const widgets: readonly AggregatorEntry[] = useMemo(() => rawWidgets ?? [], [rawWidgets])

  // Register every remote we don't have yet and kick off its exposed-
  // module load. Dedup'd via `registeredRemotes` + `bundleInflight` so
  // flapping aggregator updates don't multi-load.
  useEffect(() => {
    if (widgets.length === 0) return
    let cancelled = false
    const seen = new Set<string>()
    for (const w of widgets) {
      const key = bundleCacheKey(w.remote.remoteName, w.remote.exposedModule)
      if (seen.has(key)) continue
      seen.add(key)
      if (bundleModuleCache.has(key)) continue
      const entryUrl = w.bundleUrl
      void loadRemoteBundle(w.remote.remoteName, w.remote.exposedModule, entryUrl)
        .then(() => {
          if (!cancelled) setResolvedTick((t) => t + 1)
        })
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err)
          // Surface to the host's logger if available — admin-ui's
          // logger capture hooks `window.console`. Avoid a hard
          // `console.*` dependency at module scope (eslint forbids it).
          const host =
            typeof globalThis !== 'undefined'
              ? (globalThis as { console?: { error?: (...args: unknown[]) => void } }).console
              : undefined
          host?.error?.('[WidgetRegistry] Failed to load widget remote', {
            remoteName: w.remote.remoteName,
            exposedModule: w.remote.exposedModule,
            entryUrl,
            reason,
          })
        })
    }
    return () => {
      cancelled = true
    }
  }, [widgets])

  const registry: WidgetRegistry = useMemo(() => {
    const byId = new Map<string, AggregatorEntry>()
    const entryUrlByRemote = new Map<string, string>()
    for (const w of widgets) {
      byId.set(`${w.addonId}/${w.stableId}`, w)
      entryUrlByRemote.set(w.remote.remoteName, w.bundleUrl)
    }
    const toMetadata = (widgetId: string, entry: AggregatorEntry): WidgetMetadataEntry => ({
      widgetId,
      addonId: entry.addonId,
      stableId: entry.stableId,
      tab: entry.tab,
      subTab: entry.subTab,
      label: entry.label,
      order: entry.order,
      kind: entry.kind,
      remote: entry.remote,
      description: entry.description,
      icon: entry.icon,
      bundleUrl: entry.bundleUrl,
      hosts: entry.hosts,
      requires: entry.requires,
      defaultSize: entry.defaultSize,
      allowedSizes: entry.allowedSizes,
      defaultColumns: entry.defaultColumns,
      defaultRows: entry.defaultRows,
    })
    return {
      resolve: (widgetId: string): ComponentType<WidgetProps> | null | undefined => {
        const entry = byId.get(widgetId)
        if (!entry) return undefined
        const bundle = peekBundle(entry.remote.remoteName, entry.remote.exposedModule)
        if (!bundle) return null
        // The MF map is keyed by `componentKey` (= the widget stableId).
        const componentKey = entry.remote.componentKey ?? entry.stableId
        const Component = bundle[componentKey]
        if (!Component) return undefined
        return Component
      },
      metadata: (widgetId: string): WidgetMetadataEntry | undefined => {
        const entry = byId.get(widgetId)
        if (!entry) return undefined
        return toMetadata(widgetId, entry)
      },
      listAll: (): readonly WidgetMetadataEntry[] => {
        const out: WidgetMetadataEntry[] = []
        for (const [widgetId, entry] of byId) out.push(toMetadata(widgetId, entry))
        return out
      },
      entryUrlFor: (remoteName: string): string | undefined => entryUrlByRemote.get(remoteName),
    }
    // resolvedTick is intentionally in deps — flips re-memo when a bundle
    // finishes loading so `resolve()` returns the component instead of `null`.
  }, [widgets, resolvedTick])

  return (
    <WidgetRegistryContext.Provider value={registry}>{children}</WidgetRegistryContext.Provider>
  )
}

/**
 * Returns the registered widget component, `null` while loading, or
 * `undefined` if unknown.
 *
 * @deprecated Unused by all render paths since the unified
 * UI-contribution model (Task 10). Use `useRemoteComponent` /
 * `<WidgetSlot>` instead. Kept for external addons that may import it.
 */
export function useWidget(widgetId: string): ComponentType<WidgetProps> | null | undefined {
  const reg = useWidgetRegistry()
  return reg.resolve(widgetId)
}

/** Returns the metadata entry for a widget, or `undefined` if unknown. */
export function useWidgetMetadata(widgetId: string): WidgetMetadataEntry | undefined {
  const reg = useWidgetRegistry()
  return reg.metadata(widgetId)
}

/** Returns every contributed widget — host pickers (dashboard
 *  add-widget modal, settings UI palette) consume this to enumerate
 *  the registry. Filter on the call site by `metadata.hosts.includes()`. */
export function useAllWidgets(): readonly WidgetMetadataEntry[] {
  const reg = useWidgetRegistry()
  return reg.listAll()
}

/**
 * Resolve a `kind:'remote'` `UiContributionRemote` descriptor to a
 * React component. Drives the unified `ContributionRenderer`
 * `kind:'remote'` path — both device-detail contributions and dashboard
 * widgets resolve through the same MF `loadRemoteBundle` loader.
 *
 * Returns:
 *  - `undefined` — the remote couldn't be resolved (no entry URL known,
 *    or the remote exposed no component for `componentKey`),
 *  - `null` — the bundle is still loading,
 *  - the component otherwise.
 *
 * `entryUrl` may be passed explicitly; when omitted it's resolved from
 * the registry's aggregator-stamped `bundleUrl` for `remote.remoteName`.
 */
export function useRemoteComponent(
  remote: UiContributionRemote,
  entryUrl?: string,
): ComponentType<WidgetProps> | null | undefined {
  const reg = useOptionalWidgetRegistry()
  const resolvedEntryUrl = entryUrl ?? reg?.entryUrlFor(remote.remoteName)
  const [tick, setTick] = useState(0)
  // Separate failure state — a failed load must NOT bump `tick`
  // (peekBundle stays `undefined`, so a `tick` bump would memo back to
  // `null` = "still loading" forever). `loadFailed` makes the resolving
  // memo return `undefined` so the caller surfaces its error UI.
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (!resolvedEntryUrl) return
    // A new remote identity clears any prior failure.
    setLoadFailed(false)
    // Cached already — the resolving memo picks it up synchronously on
    // first render; no async load and no forced re-memo needed.
    if (peekBundle(remote.remoteName, remote.exposedModule)) return
    let cancelled = false
    void loadRemoteBundle(remote.remoteName, remote.exposedModule, resolvedEntryUrl)
      .then(() => {
        if (!cancelled) setTick((t) => t + 1)
      })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err)
        const host =
          typeof globalThis !== 'undefined'
            ? (globalThis as { console?: { error?: (...args: unknown[]) => void } }).console
            : undefined
        host?.error?.('[WidgetRegistry] Failed to load remote component', {
          remoteName: remote.remoteName,
          exposedModule: remote.exposedModule,
          entryUrl: resolvedEntryUrl,
          reason,
        })
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [remote.remoteName, remote.exposedModule, resolvedEntryUrl])

  return useMemo(() => {
    if (!resolvedEntryUrl) return undefined
    if (loadFailed) return undefined
    const bundle = peekBundle(remote.remoteName, remote.exposedModule)
    if (!bundle) return null
    const componentKey = remote.componentKey
    if (componentKey === undefined) {
      // Single-component remote — the default export IS the component.
      // The bundle map is `{ default: Component }` only when the remote
      // exposes one component; fall back to the first entry otherwise.
      const first = Object.values(bundle)[0]
      return first ?? undefined
    }
    return bundle[componentKey] ?? undefined
    // `tick` re-memos once the bundle resolves; `loadFailed` re-memos
    // to `undefined` so the caller shows its "unresolvable" branch.
  }, [
    remote.remoteName,
    remote.exposedModule,
    remote.componentKey,
    resolvedEntryUrl,
    tick,
    loadFailed,
  ])
}

/** Read the registry instance — throws when no provider is mounted. */
export function useWidgetRegistry(): WidgetRegistry {
  const ctx = useOptionalWidgetRegistry()
  if (!ctx) {
    throw new Error('useWidgetRegistry(): no <WidgetRegistryProvider> in tree')
  }
  return ctx
}

/** Variant returning `null` when no provider is mounted — for boot splash etc. */
export function useOptionalWidgetRegistry(): WidgetRegistry | null {
  // Late import avoids the implicit-any from `Context<unknown>` typing
  // round-trips inside cross-bundle shared contexts.
  return useContextSafe(WidgetRegistryContext)
}

// ── Helpers ──────────────────────────────────────────────────────────

import { useContext } from 'react'
import type { Context } from 'react'

function useContextSafe<T>(ctx: Context<T>): T {
  return useContext(ctx)
}
