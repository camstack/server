import type { AddonListItem as RawAddonListItem } from '@camstack/types'
import { addonProcessProblem } from '../../lib/addon-process-problem.js'
import {
  Input,
  NodePicker,
  useAddonsApplyAutoUpdateToAll,
  useAddonsForceRefresh,
  useAddonsGetAutoUpdateSettings,
  useAddonsGetLastRestart,
  useAddonsInstallPackage,
  useAddonsList,
  useAddonsListUpdates,
  useAddonsReloadPackages,
  useAddonsSearchAvailable,
  useAddonsSetAutoUpdateSettings,
  useAddonsStartJob,
  useAddonsUpdatePackage,
  useClusterNodes,
  useConfirm,
  useNodesClusterAddonStatus,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, Loader2, RefreshCw, Search } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import type { AddonListItem, BundleGroup } from '../../components/addons/AddonCard'
import { AddonCard } from '../../components/addons/AddonCard'
import {
  isTaskProgressActive,
  useAddonJobProgress,
} from '../../components/addons/AddonsJobProgress'
import { AddonUploadZone } from '../../components/addons/AddonUploadZone'
import {
  InstallAddonDialog,
  type InstallAddonTarget,
} from '../../components/addons/InstallAddonDialog'
import { NodeOnlyPackagesPanel } from '../../components/addons/NodeOnlyPackagesPanel'
import { StaleNodeNotice } from '../../components/shared/StaleNodeNotice'
import { AvailableToInstall, NpmAddonRow } from './CapabilityCatalog'
import { useNodeUrlSelection } from '../../hooks/useNodeUrlSelection'
import type { SelectableNode } from '../../lib/node-url-selection'
import { useTranslation } from 'react-i18next'

type AddonPlacement = 'hub-only' | 'agent-only' | 'any-node'

/** Source filter in `?source=` — exclusive npm vs local/dev; absent = all. */
type AddonSourceFilter = 'npm' | 'dev'

function parseAddonSourceFilter(raw: string | null): AddonSourceFilter | null {
  if (raw === 'npm' || raw === 'dev') return raw
  return null
}

/**
 * Framework/system packages (`@camstack/{system,types,sdk,shm-ring,ui-library}`)
 * are no longer operator-facing installable units — they ride inside each
 * node's root package (`@camstack/server`, hub or agent via CAMSTACK_ROLE) and are
 * managed from the "Server management" surface (runtime-updatable node
 * packages design, phase 4). They are hidden from the Addons page so there is
 * no separate "system packages" section and no legacy per-package update path.
 * `@camstack/addon-admin-ui` and every real addon stay listed.
 */
/**
 * Cadence choices for the update-availability poll. The floor mirrors the
 * server-side clamp (`MIN_UPDATE_CHECK_INTERVAL_SECONDS`, 15 min).
 */
/** Matches ui-library `DataTableFilterBar` chip toggles. */
const ADDONS_FILTER_CHIP_ON =
  'rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-[10px] text-foreground'
const ADDONS_FILTER_CHIP_OFF =
  'rounded-full border border-border px-2 py-0.5 text-[10px] text-foreground-muted hover:bg-surface-hover'

const UPDATE_CHECK_INTERVAL_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 900, label: '15m' },
  { seconds: 3600, label: '1h' },
  { seconds: 21600, label: '6h' },
  { seconds: 43200, label: '12h' },
  { seconds: 86400, label: '24h' },
]

const FRAMEWORK_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  '@camstack/system',
  '@camstack/types',
  '@camstack/sdk',
  '@camstack/shm-ring',
  '@camstack/ui-library',
])

function isFrameworkPackage(packageName: string | undefined): boolean {
  return packageName !== undefined && FRAMEWORK_PACKAGE_NAMES.has(packageName)
}

/**
 * The node this page is scoped to.
 *
 * Structurally `SelectableNode`, so the library's `ClusterNode` — the exact
 * list `NodePicker` renders — is one. Before 2026-08-30 this page built its
 * OWN node list from a second `nodes.topology` poll while the picker rendered
 * `useClusterNodes`: two lists, one page, and a selection resolved against the
 * one the operator was not looking at.
 */
type AddonsNode = SelectableNode

/**
 * The node this page falls back to before any topology has arrived.
 *
 * The hub is the one node that certainly exists — it is serving this page. It
 * is never rendered as a CHOICE (`NodePicker` draws nothing until it has a
 * topology of its own), only used to keep the page's queries pointed
 * somewhere real for the first frame.
 */
const BOOTSTRAP_HUB: AddonsNode = { id: 'hub', name: 'Hub', isHub: true, isOnline: true }

/**
 * Decide whether an addon (declared with `execution.placement`) is
 * deployable to the selected node:
 *
 *   - `hub-only` (or unset): only the hub.
 *   - `agent-only`: only nodes whose `isHub === false`.
 *   - `any-node`: every node.
 */
function isAddonForNode(placement: AddonPlacement | undefined, isHub: boolean): boolean {
  const effective: AddonPlacement = placement ?? 'hub-only'
  if (effective === 'any-node') return true
  if (effective === 'hub-only') return isHub
  return !isHub
}

/** npm registry vs dev link (`installSource === 'local'`). */
type AddonSourceBucket = 'npm' | 'dev'

function addonSourceBucket(installSource: string | undefined): AddonSourceBucket {
  return installSource === 'local' ? 'dev' : 'npm'
}

// ---------------------------------------------------------------------------
// Normalise raw addon to typed AddonListItem
// ---------------------------------------------------------------------------

function normaliseAddon(raw: unknown): AddonListItem | null {
  // The cap-router's wire type for `addons.list` is loose — admin-ui
  // narrows + casts to the canonical `RawAddonListItem` here.
  const typed = raw as RawAddonListItem | null
  if (!typed?.manifest) return null
  const manifest: AddonListItem['manifest'] = {
    ...typed.manifest,
    name: typed.manifest.name ?? typed.manifest.id,
    version: typed.manifest.version ?? '0.0.0',
    capabilities: typed.manifest.capabilities ?? [],
  }
  // Process state from the cap-router wire shape (server reports
  // pid + mode + state — see addons.cap.ts AddonProcessSchema).
  const rawProcess = (
    typed as { process?: { pid?: number; mode?: string; state?: string; reason?: string } }
  ).process
  const process = rawProcess
    ? {
        pid: rawProcess.pid,
        mode: (rawProcess.mode === 'forked' ? 'forked' : 'in-process') as 'forked' | 'in-process',
        state: rawProcess.state ?? 'unknown',
        ...(rawProcess.reason !== undefined ? { reason: rawProcess.reason } : {}),
      }
    : undefined
  // Health snapshot from the kernel's AddonHealthMonitor — drives the
  // failure banner + Retry button on the AddonCard.
  const rawHealth = (typed as { health?: AddonListItem['health'] }).health
  // Execution placement — the authoritative source is
  // `declaration.execution.placement`. `manifest.execution` is kept
  // only as a harmless fallback (the cap-router wire shape may not
  // surface `declaration` in every code path).
  const declExec = typed.declaration?.execution
  const manifestExec = (typed.manifest as { execution?: { placement?: AddonPlacement } }).execution
  const placement: AddonPlacement | undefined = declExec?.placement ?? manifestExec?.placement
  return {
    manifest,
    enabled: true,
    source: typed.source as 'core' | 'installed',
    installSource: typed.installSource,
    installedOn: [],
    ...(process ? { process } : {}),
    hasBackup: typed.hasBackup,
    ...(rawHealth ? { health: rawHealth } : {}),
    ...(placement ? { placement } : {}),
  }
}

// ---------------------------------------------------------------------------
// Package grouping
// ---------------------------------------------------------------------------

function groupByPackage(
  addons: AddonListItem[],
): Array<{ bundle: BundleGroup; representative: AddonListItem } | AddonListItem> {
  const packageMap = new Map<string, BundleGroup>()
  const ungrouped: AddonListItem[] = []

  for (const addon of addons) {
    const pkgName = addon.manifest.packageName
    if (!pkgName) {
      ungrouped.push(addon)
      continue
    }
    const existing = packageMap.get(pkgName)
    if (existing) {
      existing.addons.push(addon)
    } else {
      // Phase C: prefer the manifest's `camstack.bundle.displayName`
      // when set — that's the operator-facing label for multi-entry
      // npm packages (`@camstack/addon-pipeline` → "Pipeline"). Falls
      // back to legacy `packageDisplayName`, then to the first addon's
      // own name for single-entry cases.
      const bundleMeta = addon.manifest.bundle
      const groupEntry: BundleGroup = {
        packageName: pkgName,
        displayName:
          bundleMeta?.displayName ?? addon.manifest.packageDisplayName ?? addon.manifest.name,
        version: addon.manifest.packageVersion,
        addons: [addon],
        ...(addon.installSource !== undefined ? { installSource: addon.installSource } : {}),
        ...(bundleMeta !== undefined ? { bundle: bundleMeta } : {}),
      }
      packageMap.set(pkgName, groupEntry)
    }
  }

  const result: Array<{ bundle: BundleGroup; representative: AddonListItem } | AddonListItem> = []
  for (const group of packageMap.values()) {
    // A bundle is rendered when:
    // - the manifest declares `camstack.bundle` (operator's explicit
    //   intent, even if today it has only 1 entry — useful for future
    //   expansion without churn), OR
    // - the package ships ≥ 2 addon entries.
    const isBundle = group.bundle !== undefined || group.addons.length >= 2
    if (isBundle) {
      result.push({ bundle: group, representative: group.addons[0]! })
    } else {
      result.push(group.addons[0]!)
    }
  }
  result.push(...ungrouped)
  return result
}

function isBundled(
  item: { bundle: BundleGroup; representative: AddonListItem } | AddonListItem,
): item is { bundle: BundleGroup; representative: AddonListItem } {
  return 'bundle' in item
}

// ---------------------------------------------------------------------------
// Installed tab
// ---------------------------------------------------------------------------

interface InstalledTabProps {
  addons: AddonListItem[]
  clusterStatus?: Record<
    string,
    {
      hubVersion: string
      nodes: readonly {
        nodeId: string
        name: string
        version: string
        status: string
        synced: boolean
      }[]
    }
  >
  selectedNode: AddonsNode
  onRefresh: () => void
  /** pending = the roster has not answered; that is not "no addons". */
  listPhase: 'pending' | 'error' | 'ready'
}

function InstalledTab({
  addons,
  clusterStatus,
  selectedNode,
  onRefresh,
  listPhase,
}: InstalledTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [searchInput, setSearchInput] = useState('')
  const deferredSearch = useDeferredValue(searchInput)
  const [showSearch, setShowSearch] = useState(false)
  const searchContainerRef = useRef<HTMLDivElement>(null)

  // Close search dropdown on click outside
  useEffect(() => {
    if (!showSearch) return
    const handler = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSearch(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSearch])

  // Fetch available updates from npm for the selected node — hub or a
  // specific agent (`nodeId` keys the query, so switching nodes
  // refetches that node's roster).
  const { data: updates } = useAddonsListUpdates({ nodeId: selectedNode.id })

  // Map packageName → latestVersion for quick lookup
  const updateMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of updates ?? []) {
      map.set(u.name, u.latestVersion)
    }
    return map
  }, [updates])

  // Real-addon updates only — framework/system packages are managed from the
  // Server-management surface (phase 4), so they never count toward "Update all".
  const nonSystemUpdateCount = useMemo(
    () => (updates ?? []).filter((u) => !u.isSystem).length,
    [updates],
  )

  // Per-package update tracking (F4). The old single `updatingPackage`
  // string + single `updateError` were CLOBBERED by concurrent updates:
  // the second update's onMutate overwrote the first's name, and either
  // one settling nulled the shared state — the first addon's progress
  // vanished. Both are now keyed by package name.
  const [updatingPackages, setUpdatingPackages] = useState<ReadonlySet<string>>(() => new Set())
  const [updateErrors, setUpdateErrors] = useState<ReadonlyMap<string, string>>(() => new Map())

  const markUpdating = useCallback((name: string): void => {
    setUpdatingPackages((prev) => new Set(prev).add(name))
  }, [])
  const clearUpdating = useCallback((name: string): void => {
    setUpdatingPackages((prev) => {
      if (!prev.has(name)) return prev
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }, [])
  const setErrorFor = useCallback((name: string, message: string): void => {
    setUpdateErrors((prev) => new Map(prev).set(name, message))
  }, [])
  const clearErrorFor = useCallback((name: string): void => {
    setUpdateErrors((prev) => {
      if (!prev.has(name)) return prev
      const next = new Map(prev)
      next.delete(name)
      return next
    })
  }, [])

  const updateMutation = useAddonsUpdatePackage({
    onMutate: (variables) => {
      markUpdating(variables.name)
      clearErrorFor(variables.name)
    },
    onSuccess: (result, variables) => {
      clearUpdating(variables.name)
      // Cap returns `{success, version, error?}` even on TRPC-success. Surface
      // the wrapped error (e.g. dev-mode npm gate, npm registry 404, …) — was
      // previously swallowed and the operator had to dig in server logs.
      const r = result as { success: boolean; error?: string } | undefined
      if (r && r.success === false) {
        setErrorFor(
          variables.name,
          r.error ?? 'Update failed (no error message returned by server)',
        )
        return
      }
      queryClient.invalidateQueries({ queryKey: [['addons']] })
      queryClient.invalidateQueries({ queryKey: [['addons', 'listUpdates']] })
    },
    onError: (err, variables) => {
      clearUpdating(variables.name)
      setErrorFor(variables.name, err instanceof Error ? err.message : String(err))
    },
  })

  // F4: live per-package lifecycle-job progress — jobs are keyed by jobId
  // upstream (event snapshots + listJobs seed), so concurrent updates
  // ("Update all", two single updates at once) never overwrite each other.
  const jobProgressByPackage = useAddonJobProgress()

  // When a job leaves the active set, refresh the roster + pending updates —
  // this is what makes engine-driven bulk updates ("Update all") reflect on
  // the page without a manual refresh.
  const prevActiveJobPackagesRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const active = new Set<string>()
    for (const [pkg, progress] of jobProgressByPackage) {
      if (isTaskProgressActive(progress)) active.add(pkg)
    }
    const someCompleted = [...prevActiveJobPackagesRef.current].some((pkg) => !active.has(pkg))
    prevActiveJobPackagesRef.current = active
    if (someCompleted) {
      queryClient.invalidateQueries({ queryKey: [['addons']] })
      queryClient.invalidateQueries({ queryKey: [['addons', 'listUpdates']] })
    }
  }, [jobProgressByPackage, queryClient])

  const { data: autoUpdateSettings } = useAddonsGetAutoUpdateSettings(undefined)

  const setAutoUpdateMutation = useAddonsApplyAutoUpdateToAll({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['addons', 'getAutoUpdateSettings']] })
    },
  })

  // Cadence of the "an update is available" notification poll. Separate from
  // the auto-update channel on purpose: it runs even on `off`, which is the
  // whole point ("tell me, don't install").
  const setCheckIntervalMutation = useAddonsSetAutoUpdateSettings({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [['addons', 'getAutoUpdateSettings']] })
    },
  })

  const { data: searchResults, isFetching: isSearching } = useAddonsSearchAvailable(
    { query: deferredSearch || undefined },
    {
      enabled: showSearch,
    },
  )

  // ── "Update all" via the lifecycle job engine ─────────────────────────────
  // F3 removed the in-memory bulk-update coordinator; F4 (above) restores
  // live progress per addon over the engine's `AddonsJobProgress` events —
  // each card renders its own job-task phase while the bulk job runs.
  const startJobMutation = useAddonsStartJob()

  // Post-restart toast for framework-bulk-update
  const { data: lastRestart } = useAddonsGetLastRestart(undefined)
  const lastRestartReqAt = lastRestart?.requestedAt
  const [bulkRestartToastShownAt, setBulkRestartToastShownAt] = useState<number | null>(null)
  const [showBulkRestartToast, setShowBulkRestartToast] = useState(false)
  useEffect(() => {
    if (
      lastRestart?.kind === 'framework-bulk-update' &&
      lastRestart.requestedAt !== bulkRestartToastShownAt
    ) {
      setBulkRestartToastShownAt(lastRestart.requestedAt)
      setShowBulkRestartToast(true)
      const timer = window.setTimeout(() => setShowBulkRestartToast(false), 6000)
      return () => window.clearTimeout(timer)
    }
  }, [lastRestartReqAt, bulkRestartToastShownAt, lastRestart])

  const confirm = useConfirm()

  const handleUpdateAll = useCallback(async (): Promise<void> => {
    // Framework/system packages are excluded — they are managed from the
    // Server-management surface, not the Addons page (phase 4). Only real
    // addon updates are batched here.
    const pending = (updates ?? []).filter((u) => !u.isSystem)
    if (pending.length === 0) return
    if (!selectedNode.isHub) {
      // The lifecycle job engine is HUB-LOCAL — it ignores `nodeIds`. Sending
      // an agent id here applied every target to the hub while this page
      // rendered agent-labelled progress, so "Update all" on an agent looked
      // like it worked and the agent stayed pending (2026-08-11: two agents
      // held 8 stale addons each). Agents converge one package at a time
      // through `updatePackage`, which ships a packed tarball over
      // `$agent.deploy`. Serially: a parallel fan-out would have the agent
      // reload once per package.
      for (const u of pending) {
        await updateMutation.mutateAsync({
          name: u.name,
          version: u.latestVersion,
          nodeId: selectedNode.id,
        })
      }
      return
    }
    // Hub: route through the lifecycle job engine — one durable bulk job that
    // fetches addons in parallel and applies them serially. `version` is the
    // resolved latest from listUpdates.
    await startJobMutation.mutateAsync({
      kind: 'update',
      targets: pending.map((u) => ({ name: u.name, version: u.latestVersion })),
      nodeIds: [selectedNode.id],
    })
    // Live per-step progress renders per card via useAddonJobProgress (F4).
  }, [updates, selectedNode.id, selectedNode.isHub, startJobMutation, updateMutation])

  const [installTarget, setInstallTarget] = useState<InstallAddonTarget | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const openInstall = (target: InstallAddonTarget): void => {
    setInstallError(null)
    setInstallTarget(target)
  }
  const installMutation = useAddonsInstallPackage({
    onSuccess: () => {
      setInstallTarget(null)
      setInstallError(null)
      queryClient.invalidateQueries({ queryKey: [['addons']] })
      queryClient.invalidateQueries({ queryKey: [['addonPages']] })
      queryClient.invalidateQueries({ queryKey: [['capabilities']] })
      queryClient.invalidateQueries({ queryKey: [['integrations']] })
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Install failed'
      setInstallError(message)
    },
  })

  const [sortBy, setSortBy] = useState<'type' | 'name' | 'source'>('type')
  // Layout: `grouped` shows multi-addon packages as collapsed bundle
  // cards; `flat` renders every addon as its own card regardless of
  // package. Persisted in localStorage so the choice survives reloads.
  const [viewMode, setViewMode] = useState<'grouped' | 'flat'>(() => {
    if (typeof window === 'undefined') return 'grouped'
    const stored = window.localStorage.getItem('camstack.addons.viewMode')
    return stored === 'flat' ? 'flat' : 'grouped'
  })
  const handleSetViewMode = (mode: 'grouped' | 'flat'): void => {
    setViewMode(mode)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('camstack.addons.viewMode', mode)
    }
  }

  // Filters live in the URL (`?updatable=1`, `?source=npm|dev`) so they
  // survive node switches — InstalledTab unmounts while the per-node list
  // refetches, and `useNodeUrlSelection` preserves every param except `node`.
  // Capability filter from integration install pills: `?capability=<name>`.
  const [searchParams, setSearchParams] = useSearchParams()
  const capabilityFilter = searchParams.get('capability')
  const updatableOnly = searchParams.get('updatable') === '1'
  const errorOnly = searchParams.get('error') === '1'
  const sourceFilter = parseAddonSourceFilter(searchParams.get('source'))

  const setUpdatableOnly = useCallback(
    (next: boolean): void => {
      const params = new URLSearchParams(searchParams)
      if (next) params.set('updatable', '1')
      else params.delete('updatable')
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const setErrorOnly = useCallback(
    (next: boolean): void => {
      const params = new URLSearchParams(searchParams)
      if (next) params.set('error', '1')
      else params.delete('error')
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const setSourceFilter = useCallback(
    (next: AddonSourceFilter | null): void => {
      const params = new URLSearchParams(searchParams)
      if (next === null) params.delete('source')
      else params.set('source', next)
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  // Addons whose runner is failed / refused / missing (truthful process state).
  const errorCount = useMemo(
    () => addons.filter((a) => addonProcessProblem(a.process) !== null).length,
    [addons],
  )

  const filteredAddons = useMemo(() => {
    // Framework/system packages are never operator-facing here (phase 4) —
    // hide them so there is no "system packages" section and no legacy
    // per-package update path on the Addons page.
    let result = addons.filter((addon) => !isFrameworkPackage(addon.manifest.packageName))
    if (!selectedNode.isHub) {
      result = result.filter((addon) => isAddonForNode(addon.placement, selectedNode.isHub))
    }
    if (capabilityFilter) {
      result = result.filter((addon) => {
        const caps = addon.manifest.capabilities ?? []
        return caps.some((c) => (typeof c === 'string' ? c : c.name) === capabilityFilter)
      })
    }
    if (updatableOnly) {
      result = result.filter((addon) => {
        const pkg = addon.manifest.packageName
        return pkg !== undefined && updateMap.has(pkg)
      })
    }
    if (sourceFilter !== null) {
      result = result.filter((addon) => addonSourceBucket(addon.installSource) === sourceFilter)
    }
    if (errorOnly) {
      result = result.filter((addon) => addonProcessProblem(addon.process) !== null)
    }
    return result
  }, [
    addons,
    selectedNode.isHub,
    capabilityFilter,
    updatableOnly,
    sourceFilter,
    errorOnly,
    updateMap,
  ])

  const clearCapabilityFilter = (): void => {
    const next = new URLSearchParams(searchParams)
    next.delete('capability')
    setSearchParams(next, { replace: true })
  }

  // Flat mode bypasses bundle grouping — every addon ends up as its
  // own row even when its sibling addons share the same npm package.
  const packageGrouped =
    viewMode === 'flat'
      ? (filteredAddons as Array<
          { bundle: BundleGroup; representative: AddonListItem } | AddonListItem
        >)
      : groupByPackage(filteredAddons)

  const sortedGrouped = useMemo(() => {
    const items = [...packageGrouped]
    switch (sortBy) {
      case 'type':
        // Bundles first, then singles
        items.sort((a, b) => {
          const aBundle = isBundled(a) ? 0 : 1
          const bBundle = isBundled(b) ? 0 : 1
          if (aBundle !== bBundle) return aBundle - bBundle
          const aName = isBundled(a) ? a.bundle.displayName : a.manifest.name
          const bName = isBundled(b) ? b.bundle.displayName : b.manifest.name
          return aName.localeCompare(bName)
        })
        break
      case 'name':
        items.sort((a, b) => {
          const aName = isBundled(a) ? a.bundle.displayName : a.manifest.name
          const bName = isBundled(b) ? b.bundle.displayName : b.manifest.name
          return aName.localeCompare(bName)
        })
        break
      case 'source':
        items.sort((a, b) => {
          const aSource = isBundled(a) ? (a.bundle.installSource ?? '') : (a.installSource ?? '')
          const bSource = isBundled(b) ? (b.bundle.installSource ?? '') : (b.installSource ?? '')
          return aSource.localeCompare(bSource)
        })
        break
    }
    return items
  }, [packageGrouped, sortBy])

  // Filter search results: hide already installed

  return (
    <div className="space-y-3">
      {[...updateErrors.entries()].map(([name, message]) => (
        <div
          key={name}
          className="rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[11px]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <div className="font-medium text-danger">
                {t('systemPage.addons.updateFailed', { name })}
              </div>
              <div className="text-foreground-subtle font-mono">{message}</div>
            </div>
            <button
              type="button"
              onClick={() => clearErrorFor(name)}
              className="text-foreground-subtle hover:text-foreground text-[10px]"
            >
              {t('common.dismiss')}
            </button>
          </div>
        </div>
      ))}
      {/* Toolbar row 1: sort, auto-update, actions */}
      <div className="flex items-center gap-x-2 gap-y-1.5 flex-wrap">
        {/* Sort selector */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-foreground-subtle">
            {t('admin.system.addons.sort', 'Sort:')}
          </span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-foreground focus:outline-none focus:border-primary/50"
          >
            <option value="type">{t('admin.system.addons.bundlesFirst', 'Bundles first')}</option>
            <option value="name">{t('admin.system.addons.name', 'Name')}</option>
            <option value="source">
              {t('admin.system.addons.installSource', 'Install source')}
            </option>
          </select>
        </div>

        {/* View toggle: grouped (per package) vs flat (per addon) */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-foreground-subtle">
            {t('admin.system.addons.view', 'View:')}
          </span>
          <div className="flex rounded-md border border-border overflow-hidden text-[10px] font-medium">
            {(['grouped', 'flat'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => handleSetViewMode(mode)}
                className={`px-2 py-1 transition-colors capitalize ${
                  viewMode === mode
                    ? 'bg-primary/10 text-primary'
                    : 'bg-transparent text-foreground-subtle hover:bg-surface-hover'
                }`}
                title={
                  mode === 'grouped'
                    ? t(
                        'admin.system.addons.groupMultiAddonPackagesInto',
                        'Group multi-addon packages into a bundle card',
                      )
                    : t(
                        'admin.system.addons.showEveryAddonAsIts',
                        'Show every addon as its own card',
                      )
                }
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {/* Auto-update channel selector — auto-update is a hub-scoped
            scheduler with no per-agent equivalent, so it is hidden when
            an agent node is selected. */}
        {selectedNode.isHub && (
          <div className="flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3 text-foreground-subtle" />
            <span className="text-[10px] text-foreground-subtle">
              {t('admin.system.addons.autoUpdate', 'Auto-Update:')}
            </span>
            <div className="flex rounded-md border border-border overflow-hidden text-[10px] font-medium">
              {(['off', 'latest', 'beta'] as const).map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => setAutoUpdateMutation.mutate({ channel: ch })}
                  disabled={setAutoUpdateMutation.isPending}
                  className={`px-2 py-1 transition-colors capitalize ${
                    autoUpdateSettings?.channel === ch
                      ? ch === 'off'
                        ? 'bg-gray-700 text-gray-200'
                        : ch === 'latest'
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-amber-500/20 text-amber-400'
                      : 'bg-transparent text-foreground-subtle hover:bg-surface-hover'
                  } ${ch !== 'off' ? 'border-l border-border' : ''}`}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Update-check cadence — the availability poll, independent of the
            auto-apply channel above. Hub-scoped like the channel selector. */}
        {selectedNode.isHub && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-foreground-subtle">
              {t('admin.system.addons.checkEvery', 'Check every:')}
            </span>
            <select
              className="rounded-md border border-border bg-transparent px-1.5 py-1 text-[10px] font-medium text-foreground-subtle"
              value={autoUpdateSettings?.updateCheckIntervalSeconds ?? 21600}
              disabled={setCheckIntervalMutation.isPending || autoUpdateSettings === undefined}
              onChange={(event) => {
                if (autoUpdateSettings === undefined) return
                setCheckIntervalMutation.mutate({
                  channel: autoUpdateSettings.channel,
                  updateCheckIntervalSeconds: Number(event.target.value),
                })
              }}
            >
              {UPDATE_CHECK_INTERVAL_CHOICES.map((choice) => (
                <option key={choice.seconds} value={choice.seconds}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Update All button (only when real-addon updates are available) */}
        {nonSystemUpdateCount > 0 && (
          <button
            type="button"
            onClick={() => void handleUpdateAll()}
            disabled={startJobMutation.isPending}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/30 disabled:opacity-50 transition-colors font-medium"
          >
            {startJobMutation.isPending ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Download className="w-3 h-3" />
            )}
            {startJobMutation.isPending
              ? t('admin.system.addons.updating', 'Updating…')
              : t('admin.system.addons.updateAll', 'Update All ({{nonSystemUpdateCount}})', {
                  nonSystemUpdateCount,
                })}
          </button>
        )}
      </div>

      {/* Two filters: update status + source (npm XOR local/dev). URL-backed. */}
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={t('admin.system.addons.filterInstalledAddons', 'Filter installed addons')}
      >
        <span className="text-[10px] text-foreground-subtle">
          {t('admin.system.addons.filter', 'Filter:')}
        </span>
        {(
          [
            {
              id: 'updatable' as const,
              label: t('admin.system.addons.updatable', 'Updatable'),
              pressed: updatableOnly,
              toggle: () => setUpdatableOnly(!updatableOnly),
            },
            {
              id: 'error' as const,
              label: t('admin.system.addons.inError', 'In error ({{count}})', {
                count: errorCount,
              }),
              pressed: errorOnly,
              toggle: () => setErrorOnly(!errorOnly),
            },
            {
              id: 'npm' as const,
              label: 'npm', // i18n-ignore: package registry name
              pressed: sourceFilter === 'npm',
              toggle: () => setSourceFilter(sourceFilter === 'npm' ? null : 'npm'),
            },
            {
              id: 'dev' as const,
              label: t('admin.system.addons.dev', 'Dev'),
              pressed: sourceFilter === 'dev',
              toggle: () => setSourceFilter(sourceFilter === 'dev' ? null : 'dev'),
            },
          ] as const
        ).map((chip) => (
          <button
            key={chip.id}
            type="button"
            aria-pressed={chip.pressed}
            onClick={chip.toggle}
            className={chip.pressed ? ADDONS_FILTER_CHIP_ON : ADDONS_FILTER_CHIP_OFF}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Toolbar row 2: search + upload. Stacks on narrow viewports so the
          search field (and its results dropdown, width-bound to it) gets the
          full row instead of splitting it with the upload zone. */}
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
        {/* Search input + results dropdown */}
        <div className="relative flex-1 min-w-0 sm:min-w-[200px]" ref={searchContainerRef}>
          <Input
            type="text"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value)
              setShowSearch(true)
            }}
            onFocus={() => setShowSearch(true)}
            placeholder={t('admin.system.addons.searchAddonsOnNpm', 'Search addons on npm...')}
            aria-label={t('admin.system.addons.searchAddonsOnNpm2', 'Search addons on npm')}
            disabled={startJobMutation.isPending}
            leftSlot={<Search className="h-3.5 w-3.5" aria-hidden />}
            rightSlot={isSearching ? <Loader2 className="h-3 w-3 animate-spin" /> : undefined}
          />

          {/* Floating search results */}
          {showSearch && searchResults && searchResults.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-40 rounded-md border border-border bg-surface shadow-xl overflow-hidden">
              {searchResults.length > 0 && (
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-foreground-subtle border-b border-border">
                  {t('systemPage.addons.npmResults', { count: searchResults.length })}
                </div>
              )}
              {searchResults && searchResults.length > 0 && (
                <div className="max-h-72 overflow-auto divide-y divide-border">
                  {searchResults.map((addon) => (
                    <NpmAddonRow
                      key={addon.name}
                      addon={addon}
                      installing={installMutation.isPending}
                      onInstall={(addon) =>
                        openInstall({
                          name: addon.name,
                          version: addon.version,
                          description: addon.description,
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Upload zone */}
        <AddonUploadZone
          onUploadSuccess={() => {
            queryClient.invalidateQueries({ queryKey: [['addons']] })
            onRefresh()
          }}
        />
      </div>

      {/* Capability filter chip — visible when ?capability=<name>
          was passed in the URL (typically from a collection page's
          "Add addon" CTA). Dismissible. */}
      {capabilityFilter && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-primary/10 border border-primary/30 text-xs">
          <span className="text-foreground-subtle">
            {t('admin.system.addons.filteringByCapability', 'Filtering by capability:')}
          </span>
          <span className="font-mono text-primary font-semibold">{capabilityFilter}</span>
          <button
            type="button"
            onClick={clearCapabilityFilter}
            className="ml-auto text-xs text-foreground-subtle hover:text-foreground underline"
          >
            {t('admin.system.addons.clear', 'Clear')}
          </button>
        </div>
      )}

      {/* "Available to install": the npm packages that declare the capability
          the link asked for. The installed addons below are the other group. */}
      {capabilityFilter && (
        <AvailableToInstall
          capability={capabilityFilter}
          installing={installMutation.isPending}
          onInstall={(addon) =>
            openInstall({
              name: addon.name,
              version: addon.version,
              description: addon.description,
            })
          }
        />
      )}

      {capabilityFilter && filteredAddons.length > 0 && (
        <h2 className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('admin.system.addons.installed', 'Installed')}
        </h2>
      )}

      {/* Post-restart bulk-update toast. `position: fixed` resolves against
          the viewport, which under `viewport-fit=cover` starts behind the
          iOS notch — so the safe-area offsets are what keep this off the
          status bar. They collapse to `1rem` where the insets are 0. */}
      {showBulkRestartToast && (
        <div className="fixed top-[calc(env(safe-area-inset-top)+1rem)] right-[calc(env(safe-area-inset-right)+1rem)] z-50 flex items-start gap-2 px-3 py-2.5 rounded-md border border-green-500/30 bg-green-500/10 shadow-lg backdrop-blur-sm max-w-sm pointer-events-auto">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-green-400" />
          <div>
            <div className="text-[11px] font-semibold text-foreground">
              {t('admin.system.addons.bulkUpdateCompleted', 'Bulk update completed')}
            </div>
            <div className="text-[10px] text-foreground-subtle mt-0.5">
              {t(
                'admin.system.addons.systemPackagesUpdatedHubRestarted',
                'System packages updated — hub restarted successfully.',
              )}
            </div>
          </div>
        </div>
      )}

      {listPhase === 'pending' && (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('admin.system.addons.loadingInstalled', 'Loading installed addons…')}
        </div>
      )}
      {listPhase === 'error' && (
        <div className="text-xs text-danger">
          {t('admin.system.addons.failedToLoadAddons', 'Failed to load addons')}
        </div>
      )}

      {/* Empty state — only after the roster has answered. */}
      {listPhase === 'ready' && filteredAddons.length === 0 && (
        <div className="text-xs text-foreground-subtle">
          {addons.length === 0
            ? t('admin.system.addons.noAddonsInstalled', 'No addons installed')
            : capabilityFilter
              ? t(
                  'admin.system.addons.noInstalledAddonDeclaresThe',
                  'No installed addon declares the "{{capabilityFilter}}" capability. Any addon you can install appears under "Available to install" above.',
                  { capabilityFilter },
                )
              : t(
                  'admin.system.addons.noAddonsCompatibleWithPlacement',
                  'No addons compatible with {{name}} (placement filter active)',
                  { name: selectedNode.name },
                )}
        </div>
      )}

      {/* Installed addon cards. Real addons only — framework/system packages
          are hidden (managed from Server management, phase 4). */}
      <div className="space-y-1.5">
        {listPhase === 'ready' &&
          sortedGrouped.map((item) => {
            const pkgName = isBundled(item) ? item.bundle.packageName : item.manifest.packageName
            const update = updateMap.get(pkgName)
            const representative = isBundled(item) ? item.representative : item
            // `version` is the SELECTED version from the card's version
            // selector (defaults to the latest available).
            const onUpdate = update
              ? (version: string) =>
                  updateMutation.mutate({
                    name: pkgName,
                    version,
                    nodeId: selectedNode.id,
                  })
              : undefined
            // F4: per-package lifecycle-job progress (engine-driven updates —
            // "Update all", auto-update — plus the phases of single updates).
            const jobProgress = jobProgressByPackage.get(pkgName) ?? null
            const jobActive = jobProgress !== null && isTaskProgressActive(jobProgress)
            return (
              <AddonCard
                key={isBundled(item) ? pkgName : item.manifest.id}
                addon={representative}
                clusterStatus={clusterStatus?.[representative.manifest.id]}
                bundle={isBundled(item) ? item.bundle : undefined}
                availableUpdate={update}
                isUpdating={updatingPackages.has(pkgName) || jobActive}
                jobProgress={jobProgress}
                onUpdate={onUpdate}
                disabledByBulk={startJobMutation.isPending}
                selectedNode={selectedNode}
              />
            )
          })}
      </div>
      {installTarget !== null && (
        <InstallAddonDialog
          target={installTarget}
          installing={installMutation.isPending}
          installError={installError}
          onClose={() => setInstallTarget(null)}
          onInstall={(packageName, version) => installMutation.mutate({ packageName, version })}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function AddonsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: clusterStatus } = useNodesClusterAddonStatus(undefined)

  // The SAME list `NodePicker` renders (it calls this hook itself), so the
  // node the operator sees selected and the node this page queries can never
  // be two different answers. It is event-driven — the 10 s topology poll this
  // replaced was a second source with its own latency.
  const { nodes: clusterNodes } = useClusterNodes()
  const nodes: readonly AddonsNode[] = clusterNodes.length > 0 ? clusterNodes : [BOOTSTRAP_HUB]

  // The selection is in `?node=`, the same contract the Cluster page uses
  // (`lib/node-url-selection.ts`). It has to be: an `addon-update-available`
  // notification taps straight into this page with the node embedded, and a
  // `?node=` held in component state is a `?node=` nobody reads.
  const { selection, selectNode, requestedNodeId } = useNodeUrlSelection(nodes)
  const selectedNode: AddonsNode = selection.node ?? BOOTSTRAP_HUB
  const selectedNodeId = selectedNode.id
  // Only claim a link named a node we do not have once the topology has
  // actually arrived — before that, "unknown" is the truth, not "gone".
  const staleNodeId = clusterNodes.length > 0 ? selection.staleNodeId : null

  // Per-node roster — `nodeId` is part of the React Query key so switching
  // nodes never reuses the hub cache. Hub accepts omit or `'hub'`; we always
  // pass the selected id (same contract as listUpdates).
  const { data: rawAddons, isLoading, isError } = useAddonsList({ nodeId: selectedNodeId })

  const forceRefreshMutation = useAddonsForceRefresh()
  const reloadPackagesMutation = useAddonsReloadPackages()
  const reloadIsPending = forceRefreshMutation.isPending || reloadPackagesMutation.isPending
  const reload = async (): Promise<void> => {
    await forceRefreshMutation.mutateAsync({ nodeId: selectedNodeId })
    await reloadPackagesMutation.mutateAsync()
    queryClient.invalidateQueries({ queryKey: [['addons']] })
  }

  // Force a fresh update-check whenever the operator navigates to the
  // Addons page. The server-side TTL caps the registry-hit cost (10
  // min) but the on-mount kick guarantees that immediately after an
  // `npm publish` the operator's first visit to this page surfaces
  // the new version — no waiting for the cache to expire. Held in a
  // ref so the effect's empty-deps form (intentional: mount-only)
  // doesn't trigger re-runs on each render.
  const onMountRefreshRef = useRef(forceRefreshMutation)
  onMountRefreshRef.current = forceRefreshMutation
  // Read from the URL, not from the resolved selection: at mount the topology
  // has usually not arrived, so the resolution is still the bootstrap hub
  // while the link plainly names an agent. Checking the wrong node's registry
  // is the one thing this kick must not do.
  const mountNodeIdRef = useRef(requestedNodeId ?? 'hub')
  useEffect(() => {
    onMountRefreshRef.current.mutate({ nodeId: mountNodeIdRef.current })
  }, [])

  const addonList: AddonListItem[] = (rawAddons ?? [])
    .map(normaliseAddon)
    .filter((a): a is AddonListItem => a !== null)

  return (
    <AdminPage>
      {/* Toolbar — inline with content so the buttons don't dangle in
          isolation in the top-right when the AdminPage header is empty. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <NodePicker selectedNodeId={selectedNodeId} onSelect={selectNode} />
        <div className="flex items-center gap-2 flex-wrap">
          {!isLoading && !isError && (
            <span className="text-[10px] rounded-full bg-primary/10 text-primary px-2 py-0.5 font-medium">
              {t('systemPage.addons.installedCount', { count: addonList.length })}
            </span>
          )}
          <button
            type="button"
            onClick={() => void reload()}
            disabled={reloadIsPending}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-surface hover:bg-surface-hover border border-border disabled:opacity-50 transition-colors"
            title={t(
              'admin.system.addons.reFetchAddonsCheckNpm',
              'Re-fetch addons + check npm for new versions',
            )}
          >
            <RefreshCw className={`w-3 h-3 ${reloadIsPending ? 'animate-spin' : ''}`} />
            {t('admin.system.addons.checkForUpdates', 'Check for updates')}
          </button>
        </div>
      </div>

      <StaleNodeNotice staleNodeId={staleNodeId} shownNodeName={selectedNode.name} />

      {/* Agent packages the hub does not install — invisible in the card list
          (list overlays agent versions onto hub manifests only). */}
      <NodeOnlyPackagesPanel selectedNode={selectedNode} />

      <InstalledTab
        addons={addonList}
        clusterStatus={clusterStatus}
        selectedNode={selectedNode}
        onRefresh={() => void reload()}
        listPhase={isLoading ? 'pending' : isError ? 'error' : 'ready'}
      />
    </AdminPage>
  )
}
