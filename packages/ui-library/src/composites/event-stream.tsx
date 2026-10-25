/**
 * EventStream — universal event viewer for ui-library.
 *
 * Hierarchical scope: agentId → addonId → deviceId (same as LogStream).
 * Two filtering layers:
 *   1. `defaultCategories` (or legacy `categories`) — initial active
 *      whitelist. The user can mutate this through the toolbar's
 *      multiselect popover; Reset restores the prop's set.
 *   2. Free-text search — case-insensitive substring match across
 *      category, source, data, and the rendered summary line.
 *
 * The backend subscription is mounted only while this component is
 * rendered, so callers can mount/unmount it on tab switches and the
 * tRPC subscription cleans up automatically. The historical query
 * input refreshes when the active category set changes.
 */
import { useEffect, useRef, useState, useMemo, useCallback, type JSX } from 'react'
import {
  X,
  Loader2,
  ArrowUpToLine,
  Check,
  Copy,
  ChevronDown,
  ChevronRight,
  Play,
  Square,
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  Download,
  Trash2,
  Upload,
  Activity,
  Scan,
  Eye,
  Mic,
  Zap,
  Target,
  Filter,
  RotateCcw,
  Search,
} from 'lucide-react'
import { EventCategory, publicEventCategories } from '@camstack/types'
import { trpc } from '../trpc-react'
import { cn } from '../lib/cn'
import { defaultUiText, useUiText, type UiTextFn } from '../contexts/ui-text'
import { useLiveBuffer, type LiveBuffer } from '../hooks/use-live-buffer'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventEntry {
  readonly id: string
  readonly timestamp: string
  readonly source: {
    readonly type: string
    readonly id: string | number
    readonly nodeId?: string
    readonly addonId?: string
    readonly deviceId?: number
  }
  readonly category: string
  readonly data: Record<string, unknown>
}

/**
 * Match an event against the (agentId / addonId / deviceId) scope. The
 * server bus only filters by category pattern; this client-side check
 * narrows the live subscription to the device the panel is mounted on.
 *
 * Each scope dimension is independent — when a prop is undefined the
 * dimension is wildcard. `source.id` is treated as the deviceId when
 * `source.type === 'device'` (the bus emits both shapes for device-
 * scoped events).
 */
function matchesScope(
  e: EventEntry,
  agentId?: string,
  addonId?: string,
  deviceId?: number,
): boolean {
  if (deviceId !== undefined) {
    const evDeviceId =
      e.source.deviceId ??
      (e.source.type === 'device' && typeof e.source.id === 'number' ? e.source.id : undefined)
    if (evDeviceId !== deviceId) return false
  }
  if (addonId !== undefined) {
    const evAddonId =
      e.source.addonId ??
      (e.source.type === 'addon' && typeof e.source.id === 'string' ? e.source.id : undefined)
    if (evAddonId !== addonId) return false
  }
  if (agentId !== undefined) {
    const evNodeId = e.source.nodeId
    if (!evNodeId || (evNodeId !== agentId && !evNodeId.startsWith(`${agentId}/`))) return false
  }
  return true
}

export interface EventStreamProps {
  // ── Scope (hierarchical, all optional) ────────────────────────────
  readonly agentId?: string
  readonly addonId?: string
  readonly deviceId?: number

  // ── Category filtering ────────────────────────────────────────────
  /** Initial whitelist — the user can mutate through the multiselect popover.
   *  Defaults to ALL EventCategory values when both this and `categories`
   *  are omitted. */
  readonly defaultCategories?: readonly string[]
  /** Legacy alias for `defaultCategories`. Kept for back-compat. */
  readonly categories?: readonly string[]
  /** Category glob/pattern passed to the backend subscription (e.g. 'addon.*'). */
  readonly category?: string

  // ── Display ───────────────────────────────────────────────────────
  readonly maxHeight?: string
  readonly limit?: number
  /** Show the multiselect filter button in the toolbar (default true). */
  readonly showCategoryFilter?: boolean
  readonly showFilters?: boolean
  /**
   * Optional controlled live buffer. When provided, the stream reads
   * + appends to this external store rather than its own `useState`,
   * so the visible list survives an unmount/remount of the component
   * (used by `DeviceActivityPanel` to keep tab content alive across
   * tab switches without keeping subscriptions open in inactive tabs).
   */
  readonly liveBuffer?: LiveBuffer<EventEntry>
  readonly onClose?: () => void
  readonly className?: string
}

// ---------------------------------------------------------------------------
// Category styling
// ---------------------------------------------------------------------------

interface CategoryStyleDef {
  readonly icon: typeof Play
  readonly color: string
  readonly labelKey: string
  readonly labelFallback: string
}

interface CategoryStyle {
  readonly icon: typeof Play
  readonly color: string
  readonly label: string
}

const CATEGORY_STYLES: Record<string, CategoryStyleDef> = {
  [EventCategory.AddonStarted]: {
    icon: Play,
    color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    labelKey: 'uiLibrary.eventStream.kindStarted',
    labelFallback: 'Started',
  },
  [EventCategory.AddonInstalled]: {
    icon: Download,
    color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    labelKey: 'uiLibrary.eventStream.kindInstalled',
    labelFallback: 'Installed',
  },
  [EventCategory.AddonRestarted]: {
    icon: RefreshCw,
    color: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    labelKey: 'uiLibrary.eventStream.kindRestarted',
    labelFallback: 'Restarted',
  },
  [EventCategory.AddonUpdated]: {
    icon: Upload,
    color: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    labelKey: 'uiLibrary.eventStream.kindUpdated',
    labelFallback: 'Updated',
  },
  [EventCategory.AddonStopped]: {
    icon: Square,
    color: 'bg-foreground-subtle/10 text-foreground-subtle border-border',
    labelKey: 'uiLibrary.eventStream.kindStopped',
    labelFallback: 'Stopped',
  },
  [EventCategory.AddonUninstalled]: {
    icon: Trash2,
    color: 'bg-foreground-subtle/10 text-foreground-subtle border-border',
    labelKey: 'uiLibrary.eventStream.kindUninstalled',
    labelFallback: 'Uninstalled',
  },
  [EventCategory.AddonCrashed]: {
    icon: AlertCircle,
    color: 'bg-red-500/15 text-red-400 border-red-500/30',
    labelKey: 'uiLibrary.eventStream.kindCrashed',
    labelFallback: 'Crashed',
  },
  [EventCategory.AddonError]: {
    icon: AlertTriangle,
    color: 'bg-red-500/15 text-red-400 border-red-500/30',
    labelKey: 'uiLibrary.eventStream.kindError',
    labelFallback: 'Error',
  },
  [EventCategory.DetectionPhaseTransition]: {
    icon: Activity,
    color: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    labelKey: 'uiLibrary.eventStream.kindPhase',
    labelFallback: 'Phase',
  },
  [EventCategory.DetectionResult]: {
    icon: Scan,
    color: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    labelKey: 'uiLibrary.eventStream.kindDetection',
    labelFallback: 'Detection',
  },
  [EventCategory.DetectionEvent]: {
    icon: Eye,
    color: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    labelKey: 'uiLibrary.eventStream.kindEvent',
    labelFallback: 'Event',
  },
  [EventCategory.DetectionCameraNative]: {
    icon: Target,
    color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
    labelKey: 'uiLibrary.eventStream.kindCameraAi',
    labelFallback: 'Camera AI',
  },
  [EventCategory.ProviderMotion]: {
    icon: Zap,
    color: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    labelKey: 'uiLibrary.eventStream.kindMotion',
    labelFallback: 'Motion',
  },
  [EventCategory.MotionOnMotionChanged]: {
    icon: Zap,
    color: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    labelKey: 'uiLibrary.eventStream.kindMotion',
    labelFallback: 'Motion',
  },
  [EventCategory.MotionAnalysis]: {
    icon: Activity,
    color: 'bg-orange-500/10 text-orange-300 border-orange-500/20',
    labelKey: 'uiLibrary.eventStream.kindMotionAnalysis',
    labelFallback: 'Motion analysis',
  },
  [EventCategory.MotionZonesRaw]: {
    icon: Activity,
    color: 'bg-orange-500/10 text-orange-300 border-orange-500/20',
    labelKey: 'uiLibrary.eventStream.kindMotionZones',
    labelFallback: 'Motion zones',
  },
  [EventCategory.ProviderDetection]: {
    icon: Target,
    color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
    labelKey: 'uiLibrary.eventStream.kindProviderDet',
    labelFallback: 'Provider Det',
  },
  [EventCategory.PipelineAudioInferenceResult]: {
    icon: Mic,
    color: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
    labelKey: 'uiLibrary.eventStream.kindAudio',
    labelFallback: 'Audio',
  },
  [EventCategory.AgentOnline]: {
    icon: Play,
    color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    labelKey: 'uiLibrary.eventStream.kindAgentOnline',
    labelFallback: 'Agent Online',
  },
  [EventCategory.AgentOffline]: {
    icon: Square,
    color: 'bg-red-500/15 text-red-400 border-red-500/30',
    labelKey: 'uiLibrary.eventStream.kindAgentOffline',
    labelFallback: 'Agent Offline',
  },
  [EventCategory.DeviceRegistered]: {
    icon: Download,
    color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    labelKey: 'uiLibrary.eventStream.kindRegistered',
    labelFallback: 'Registered',
  },
  [EventCategory.DeviceUnregistered]: {
    icon: Trash2,
    color: 'bg-red-500/15 text-red-400 border-red-500/30',
    labelKey: 'uiLibrary.eventStream.kindUnregistered',
    labelFallback: 'Unregistered',
  },
  [EventCategory.DeviceStateChanged]: {
    icon: Activity,
    color: 'bg-foreground-subtle/10 text-foreground-subtle border-border',
    labelKey: 'uiLibrary.eventStream.kindState',
    labelFallback: 'State',
  },
  [EventCategory.EventEmitted]: {
    icon: Zap,
    color: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    labelKey: 'uiLibrary.eventStream.kindEvent',
    labelFallback: 'Event',
  },
}

/**
 * Resolve the badge style + label for an event row. Most categories
 * map to a fixed entry in `CATEGORY_STYLES`; `device.state-changed` is
 * special — every cap funnels through it, so a single "State"
 * label hides the actual signal. We derive the label from
 * `data.capName` (e.g. `audio-metrics`, `motion`, `camera-streams`)
 * so the operator can scan the events tab and tell which slice
 * actually changed.
 */
function getStyle(t: UiTextFn, category: string, data?: Record<string, unknown>): CategoryStyle {
  const def = CATEGORY_STYLES[category]
  const base: CategoryStyle = def
    ? { icon: def.icon, color: def.color, label: t(def.labelKey, def.labelFallback) }
    : {
        icon: Play,
        color: 'bg-foreground-subtle/10 text-foreground-subtle border-border',
        label: category.split('.').pop() ?? category,
      }
  if (
    category === EventCategory.DeviceStateChanged &&
    data &&
    typeof data['capName'] === 'string'
  ) {
    const capName = data['capName'] as string
    return { ...base, label: capName }
  }
  return base
}

/** Every PUBLIC EventCategory value, sorted alphabetically — the owner-only
 *  categories the routers refuse (D224) are not offered, a filter that can
 *  never match is not a filter. Computed once at module load — drives the
 *  multiselect popover. */
const ALL_EVENT_CATEGORIES: readonly string[] = Object.freeze([...publicEventCategories()])

/**
 * Categories that are emitted at high frequency (~1 Hz per camera /
 * per node / per engine) and pollute the live events tab without
 * conveying anything an operator scans an event log to see. They
 * still fan out to dedicated UI panels that subscribe by name
 * (StreamPanel for stream-broker.metrics-snapshot, NodeDetailHeader
 * for pipeline.runner-load-snapshot, etc.) — the events-tab default
 * just opts them out of the catch-all "All" view. The operator can
 * opt back in via the multiselect popover.
 *
 * Mirrors `RING_BUFFER_DENY_PATTERNS` in `addon-context-factory.ts`
 * — same set, same rationale: high-frequency, low-value-for-the-
 * operator categories. Kept in sync manually because the UI bundle
 * doesn't import the kernel server module.
 */
const LIVE_NOISE_CATEGORIES: readonly string[] = Object.freeze([
  EventCategory.PipelineCameraMetricsSnapshot,
  EventCategory.PipelineRunnerLoadSnapshot,
  EventCategory.PipelineEngineMetricsSnapshot,
  EventCategory.PipelineInferenceResult,
  EventCategory.PipelineTrace,
  EventCategory.PipelineProgress,
  EventCategory.StreamBrokerMetricsSnapshot,
  EventCategory.MetricsNodeResourcesSnapshot,
  EventCategory.MetricsNodeProcessesSnapshot,
  EventCategory.ClusterTopologySnapshot,
  EventCategory.MotionAnalysis,
  EventCategory.MotionZonesRaw,
  EventCategory.DetectionResult,
  EventCategory.PipelineAudioInferenceResult,
  EventCategory.PlatformProbePhase,
  EventCategory.BenchmarkProgress,
  EventCategory.ModelDownloadProgress,
  // A camera's RAW motion push (D673, ~1 Hz): the bridge's MotionOnMotionChanged is the one to scan.
  EventCategory.ProviderMotion,
])

const LIVE_NOISE_SET: ReadonlySet<string> = new Set(LIVE_NOISE_CATEGORIES)

/** Categories visible in the events tab by default. The "All" badge
 *  reflects this set, not the raw enum. */
export const DEFAULT_EVENT_CATEGORIES: readonly string[] = Object.freeze(
  ALL_EVENT_CATEGORIES.filter((c) => !LIVE_NOISE_SET.has(c)),
)

// ---------------------------------------------------------------------------
// Helpers — extract readable summary from event data
// ---------------------------------------------------------------------------

/**
 * "Detection session started by …" — the motion the orchestrator dispatched the
 * session on (D672): an attached sensor by its name (or its device id when the
 * name was not known), otherwise the motion source. An attach with no trigger
 * (an occupancy burst, a standing always-on camera, an older orchestrator)
 * says only that a session started.
 */
function describeSessionStart(
  source: string | null,
  triggeredBy: unknown,
  sensorName: unknown,
  t: UiTextFn,
): string {
  if (
    typeof triggeredBy === 'object' &&
    triggeredBy !== null &&
    'kind' in triggeredBy &&
    triggeredBy.kind === 'sensor'
  ) {
    const id = 'deviceId' in triggeredBy ? triggeredBy.deviceId : undefined
    const who =
      typeof sensorName === 'string' && sensorName.length > 0
        ? sensorName
        : t('uiLibrary.eventStream.summary.sensorFallback', 'sensor #{{id}}', {
            id: String(id ?? '?'),
          })
    return t(
      'uiLibrary.eventStream.summary.sessionBySensor',
      'Detection session started by {{who}} motion — phase active',
      { who },
    )
  }
  if (source !== null) {
    return t(
      'uiLibrary.eventStream.summary.sessionBySensor',
      'Detection session started by {{who}} motion — phase active',
      {
        who: source,
      },
    )
  }
  return t(
    'uiLibrary.eventStream.summary.sessionStarted',
    'Detection session started — phase active',
  )
}

export function summarizeEvent(
  category: string,
  data: Record<string, unknown>,
  t: UiTextFn = defaultUiText,
): string | null {
  if (category === EventCategory.DetectionPhaseTransition) {
    const to = data['to']
    const from = data['from']
    const source = typeof data['source'] === 'string' ? data['source'] : null
    const cooldownMs = typeof data['cooldownMs'] === 'number' ? data['cooldownMs'] : null
    const detail = cooldownMs
      ? t('uiLibrary.eventStream.summary.cooldown', '{{source}}, {{seconds}}s cooldown', {
          source: source ?? '',
          seconds: Math.round(cooldownMs / 1000),
        })
      : source
    const suffix = source ? ` (${detail})` : ''
    // An attach / detach is not motion: every on-motion detection SESSION
    // attaches always-on, so this is what a session open and close look like.
    const cause = data['cause']
    if (cause === 'attach')
      return describeSessionStart(source, data['triggeredBy'], data['sensorName'], t)
    if (cause === 'detach')
      return t(
        'uiLibrary.eventStream.summary.sessionEnded',
        'Detection session ended — phase watching',
      )
    if (to === 'active')
      return t(
        'uiLibrary.eventStream.summary.motionActive',
        'Motion detected — phase active{{suffix}}',
        { suffix },
      )
    if (to === 'watching') {
      return t(
        'uiLibrary.eventStream.summary.cooldownExpired',
        'Cooldown expired — phase watching{{suffix}}',
        { suffix },
      )
    }
    return t('uiLibrary.eventStream.summary.phaseChange', 'Phase: {{from}} → {{to}}{{suffix}}', {
      from: String(from),
      to: String(to),
      suffix,
    })
  }

  if (category === EventCategory.DetectionResult) {
    const frame = data['frame'] as Record<string, unknown> | undefined
    const detections = (frame?.['detections'] ?? []) as readonly Record<string, unknown>[]
    if (detections.length === 0) return null
    const counts = new Map<string, number>()
    for (const d of detections) {
      const obj = d as { class?: unknown; macroClass?: unknown }
      const rawClass = obj.class ?? obj.macroClass
      const cls = typeof rawClass === 'string' ? rawClass : ''
      if (cls) counts.set(cls, (counts.get(cls) ?? 0) + 1)
    }
    return [...counts.entries()].map(([c, n]) => (n > 1 ? `${c} ×${n}` : c)).join(', ')
  }

  if (category === EventCategory.PipelineAudioInferenceResult) {
    const frame = data['frame'] as Record<string, unknown> | undefined
    const detections = (frame?.['detections'] ?? []) as readonly Record<string, unknown>[]
    if (detections.length === 0) return null
    return detections
      .map((d) => {
        const obj = d as { class?: unknown; macroClass?: unknown; label?: unknown; score?: number }
        const rawLabel = obj.macroClass ?? obj.class ?? obj.label
        const label = typeof rawLabel === 'string' ? rawLabel : ''
        const score = obj.score
        return score ? `${label} (${Math.round(score * 100)}%)` : label
      })
      .filter(Boolean)
      .join(', ')
  }

  if (category === EventCategory.DetectionEvent) {
    const label = data['label'] ?? data['class']
    const score = data['score'] ?? data['confidence']
    const parts: string[] = []
    if (typeof label === 'string') parts.push(label)
    if (typeof score === 'number') parts.push(`${Math.round(score * 100)}%`)
    return parts.length > 0 ? parts.join(' — ') : null
  }

  if (category === EventCategory.ProviderMotion) {
    return data['detected'] === true
      ? t('uiLibrary.eventStream.summary.motionStart', 'motion start')
      : t('uiLibrary.eventStream.summary.motionStop', 'motion stop')
  }

  if (category === EventCategory.DeviceStateChanged) {
    // The badge already shows the capName (see getStyle). Surface the
    // top-level slice keys so the row body conveys what *changed*
    // (e.g. "fps, queue") instead of a generic "State".
    const slice = data['slice'] as Record<string, unknown> | undefined
    if (slice && typeof slice === 'object') {
      const keys = Object.keys(slice).filter((k) => k !== 'lastFetchedAt' && k !== 'ts')
      if (keys.length > 0) return keys.slice(0, 4).join(', ') + (keys.length > 4 ? '…' : '')
    }
    return null
  }

  if (category === EventCategory.EventEmitted) {
    const eventType = typeof data['eventType'] === 'string' ? data['eventType'] : null
    return eventType ?? null
  }

  if (category === EventCategory.MotionOnMotionChanged) {
    const detected = data['detected']
    const source = typeof data['source'] === 'string' ? data['source'] : null
    const verb = detected === true ? 'motion start' : detected === false ? 'motion stop' : 'motion'
    return source ? `${verb} (${source})` : verb
  }

  if (
    category === EventCategory.ProviderDetection ||
    category === EventCategory.DetectionCameraNative
  ) {
    const detections = (data['detections'] ?? []) as readonly Record<string, unknown>[]
    if (!Array.isArray(detections) || detections.length === 0) {
      // Fall through — provider events sometimes carry the AI class
      // as a top-level `class` field instead of a detections array.
      const cls = typeof data['class'] === 'string' ? data['class'] : null
      return cls ?? null
    }
    const counts = new Map<string, number>()
    for (const d of detections) {
      const obj = d as { class?: unknown; macroClass?: unknown }
      const rawClass = obj.class ?? obj.macroClass
      const cls = typeof rawClass === 'string' ? rawClass : ''
      if (cls) counts.set(cls, (counts.get(cls) ?? 0) + 1)
    }
    return [...counts.entries()].map(([c, n]) => (n > 1 ? `${c} ×${n}` : c)).join(', ')
  }

  // Generic: try common fields
  const addonId = data['addonId'] as string | undefined
  const error = data['error'] as string | undefined
  if (error) return error
  if (addonId) return `addon: ${addonId}`
  return null
}

/** Returns false for detection/audio events with empty frames. */
function hasContent(entry: EventEntry): boolean {
  const cat = entry.category
  if (cat === EventCategory.DetectionResult || cat === EventCategory.PipelineAudioInferenceResult) {
    return summarizeEvent(cat, entry.data) !== null
  }
  return true
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LIVE_ENTRIES = 300

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventStream({
  agentId,
  addonId,
  deviceId,
  defaultCategories,
  categories: legacyCategories,
  category: propsCategory,
  maxHeight = 'max-h-96',
  limit = 50,
  showCategoryFilter = true,
  showFilters: _showFilters = false,
  liveBuffer: externalBuffer,
  onClose,
  className,
}: EventStreamProps): JSX.Element | null {
  const t = useUiText()
  // Defaults: explicit prop wins, then the legacy alias, then "all".
  const defaultsArray = useMemo<readonly string[]>(
    () => defaultCategories ?? legacyCategories ?? DEFAULT_EVENT_CATEGORIES,
    [defaultCategories, legacyCategories],
  )
  const defaultsKey = useMemo(() => [...defaultsArray].toSorted().join(','), [defaultsArray])
  const [activeCategories, setActiveCategories] = useState<Set<string>>(
    () => new Set(defaultsArray),
  )
  // Re-seed when the prop set changes (e.g. parent provides a new whitelist).
  const prevDefaultsKey = useRef(defaultsKey)
  useEffect(() => {
    if (prevDefaultsKey.current !== defaultsKey) {
      prevDefaultsKey.current = defaultsKey
      setActiveCategories(new Set(defaultsArray))
    }
  }, [defaultsKey, defaultsArray])

  // Always-live fallback buffer keeps the hook order stable. When the
  // parent provides an external buffer (DeviceActivityPanel) the local
  // one stays empty; when no parent provides one, the component still
  // works standalone with its own buffer.
  const fallbackBuffer = useLiveBuffer<EventEntry>(MAX_LIVE_ENTRIES)
  const buffer = externalBuffer ?? fallbackBuffer
  const liveEvents = buffer.entries
  const [autoScroll, setAutoScroll] = useState(true)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [searchText, setSearchText] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [categorySearch, setCategorySearch] = useState('')
  const [clearedAt, setClearedAt] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const filterRootRef = useRef<HTMLDivElement>(null)

  // Reset on scope change
  const scopeKey = `${agentId ?? ''}:${addonId ?? ''}:${String(deviceId ?? '')}:${propsCategory ?? ''}`
  const prevScopeRef = useRef(scopeKey)
  useEffect(() => {
    if (prevScopeRef.current !== scopeKey) {
      prevScopeRef.current = scopeKey
      buffer.reset()
      setExpandedRows(new Set())
      setClearedAt(0)
    }
  }, [scopeKey, buffer])

  // Close the filter popover when clicking outside.
  useEffect(() => {
    if (!filterOpen) return
    const onDocClick = (e: MouseEvent) => {
      const root = filterRootRef.current
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        setFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [filterOpen])

  const scopeInput = useMemo(() => {
    const s: Record<string, unknown> = {}
    if (agentId) s.agentId = agentId
    if (addonId) s.addonId = addonId
    if (deviceId !== undefined) s.deviceId = deviceId
    if (propsCategory) s.category = propsCategory
    return s
  }, [agentId, addonId, deviceId, propsCategory])

  // Historical query — pass the active category set so the server's
  // ring buffer pre-filters to what the user wants. Without this,
  // noisy categories saturate the last-N window.
  //
  // The scope travels unchanged: when `deviceId` is set the server does
  // NOT filter the global ring (a 16 events/s fleet evicts a quiet
  // camera out of it in ~10 minutes) — it answers from that device's own
  // ring, where the mirror categories are coalesced to their latest
  // value and each retained payload is capped. A payload that was cut
  // carries `__truncated: true`, so a short `data` and a cut one are
  // distinguishable in the row detail.
  const activeArray = useMemo(() => [...activeCategories].toSorted(), [activeCategories])
  const activeKey = useMemo(() => activeArray.join(','), [activeArray])
  // `activeKey` is a stable hash of `activeArray` — depending on
  // `activeKey` is functionally equivalent to depending on
  // `activeArray` but avoids a useMemo re-eval each time React makes
  // a new identity for the array even though its content is the
  // same.
  const getRecentInput = useMemo(() => {
    const s: Record<string, unknown> = { ...scopeInput, limit }
    if (activeArray.length > 0 && activeArray.length < ALL_EVENT_CATEGORIES.length) {
      s.category = activeArray
    }
    return s
  }, [scopeInput, limit, activeKey, activeArray])
  const { data: initialEvents, isLoading } = trpc.systemEvents.getRecent.useQuery(getRecentInput, {
    staleTime: 30_000,
  })

  // Live subscription — see backend filter `matchesEventFilter`. Category
  // glob from props is forwarded; multi-category filtering is client-side
  // because the bus subscriber API is single-pattern.
  //
  // Pre-cap filter: drop events that don't match `activeCategories`
  // BEFORE pushing into the live buffer. The buffer is a fixed-size
  // ring (MAX_LIVE_ENTRIES=300); without this gate a noisy
  // background category (audio-metrics, motion-analysis, …) fills
  // the ring with rows the operator hides anyway, evicting the
  // matching entries they actually filtered for. The result was
  // "filter loses entries over time" — the live ring still rotated,
  // just with the wrong content.
  //
  // The activeCategories Set is read through a ref so the
  // subscription callback always sees the current filter without
  // resubscribing on toggle.
  const activeCategoriesRef = useRef(activeCategories)
  useEffect(() => {
    activeCategoriesRef.current = activeCategories
  }, [activeCategories])
  const subInput: Record<string, unknown> = scopeInput
  trpc.systemEvents.subscribe.useSubscription(subInput, {
    onData: (raw: unknown) => {
      const entry = raw as EventEntry
      if (!entry?.id) return
      if (!matchesScope(entry, agentId, addonId, deviceId)) return
      // Skip categories the user has filtered out. Prevents the
      // 300-slot ring from being clobbered by background noise.
      if (!activeCategoriesRef.current.has(entry.category)) return
      buffer.append(entry)
    },
  })

  // Auto-scroll preserves the user's reading position. New entries
  // prepend (list is sorted desc by timestamp); when the user is at
  // the top we follow new entries, but if they've scrolled down we
  // increment scrollTop by the new rows' height so the visible
  // anchor row stays on screen instead of being pushed down.
  const prevLiveCountRef = useRef(liveEvents.length)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) {
      prevLiveCountRef.current = liveEvents.length
      return
    }
    const prevCount = prevLiveCountRef.current
    prevLiveCountRef.current = liveEvents.length
    if (liveEvents.length <= prevCount) return
    if (autoScroll && el.scrollTop <= 8) {
      el.scrollTo({ top: 0 })
    } else if (!autoScroll && el.scrollTop > 0) {
      const firstRow = el.firstElementChild?.firstElementChild
      const rowHeight = firstRow instanceof HTMLElement ? firstRow.offsetHeight : 28
      el.scrollTop += rowHeight * (liveEvents.length - prevCount)
    }
  }, [liveEvents.length, autoScroll])

  // Merged + filtered (client-side)
  const allEvents = useMemo(() => {
    const byId = new Map<string, EventEntry>()
    for (const e of (initialEvents ?? []) as EventEntry[]) byId.set(e.id, e)
    for (const e of liveEvents) byId.set(e.id, e)

    let list = [...byId.values()].filter((e) => activeCategories.has(e.category)).filter(hasContent)
    if (clearedAt > 0) {
      list = list.filter((e) => new Date(e.timestamp).getTime() > clearedAt)
    }
    const needle = searchText.trim().toLowerCase()
    if (needle) {
      list = list.filter((e) => {
        // Raw category string (e.g. "motion.on-motion-changed") +
        // the rendered badge label (e.g. "Motion", "Camera AI") so
        // operators can search by either the wire identifier OR
        // the user-facing text they see on the row.
        if (e.category.toLowerCase().includes(needle)) return true
        const style = getStyle(t, e.category, e.data)
        if (style.label.toLowerCase().includes(needle)) return true
        const summary = summarizeEvent(e.category, e.data, t)
        if (summary && summary.toLowerCase().includes(needle)) return true
        // Formatted timestamp ("20:14:36") so a user can paste a
        // log-line time into the search and pin it on the events tab.
        try {
          if (new Date(e.timestamp).toLocaleTimeString().toLowerCase().includes(needle)) return true
        } catch {
          /* invalid timestamp — skip */
        }
        try {
          if (JSON.stringify(e.data).toLowerCase().includes(needle)) return true
          if (JSON.stringify(e.source).toLowerCase().includes(needle)) return true
        } catch {
          /* ignore */
        }
        return false
      })
    }
    return list.toSorted(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )
  }, [initialEvents, liveEvents, activeCategories, searchText, clearedAt, t])

  const toggleRow = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleCategory = useCallback((cat: string) => {
    setActiveCategories((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }, [])

  const handleReset = useCallback(() => {
    setActiveCategories(new Set(defaultsArray))
    setSearchText('')
    setClearedAt(0)
  }, [defaultsArray])

  const handleClear = useCallback(() => {
    setClearedAt(Date.now())
    buffer.reset()
  }, [buffer])

  // Copy support — toolbar Copy-All flashes the toolbar button,
  // per-row Copy flashes the row icon. Two distinct flags so they
  // don't overwrite each other when the user copies a row right
  // after copying the whole list.
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null)
  const formatEventForCopy = useCallback(
    (event: EventEntry): string => {
      const time = new Date(event.timestamp).toISOString()
      const summary = summarizeEvent(event.category, event.data, t) ?? ''
      const summaryStr = summary ? `  ${summary}` : ''
      // i18n-ignore: machine-readable log line for the clipboard
      return `${time} [${event.category}]${summaryStr}  data=${JSON.stringify(event.data)}`
    },
    [t],
  )
  const handleCopyAll = useCallback(() => {
    const lines = allEvents.map(formatEventForCopy)
    void navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopiedAll(true)
      setTimeout(() => setCopiedAll(false), 1500)
    })
  }, [allEvents, formatEventForCopy])
  const copyOne = useCallback(
    (event: EventEntry) => {
      void navigator.clipboard.writeText(formatEventForCopy(event)).then(() => {
        setCopiedRowId(event.id)
        setTimeout(() => setCopiedRowId((prev) => (prev === event.id ? null : prev)), 1200)
      })
    },
    [formatEventForCopy],
  )

  const handleSelectAll = useCallback(() => {
    setActiveCategories(new Set(ALL_EVENT_CATEGORIES))
  }, [])

  const handleSelectNone = useCallback(() => {
    setActiveCategories(new Set())
  }, [])

  // Categories filtered by the in-popover search box
  const filteredPopoverCategories = useMemo(() => {
    const needle = categorySearch.trim().toLowerCase()
    if (!needle) return ALL_EVENT_CATEGORIES
    return ALL_EVENT_CATEGORIES.filter((c) => c.toLowerCase().includes(needle))
  }, [categorySearch])

  const totalAvailable = ALL_EVENT_CATEGORIES.length
  const totalActive = activeCategories.size
  const allSelected = totalActive === totalAvailable
  const filterLabel = allSelected ? 'All' : `${totalActive}/${totalAvailable}`

  return (
    <div
      className={cn('h-full min-h-0 flex flex-col', className)}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-hover/30 gap-2 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-foreground-subtle font-medium">
            {t('uiLibrary.eventStream.title', 'Events')}
          </span>
          {/* i18n-ignore-start: scope field names, shown verbatim */}
          {agentId && <ScopeBadge label="agent" value={agentId} />}
          {addonId && <ScopeBadge label="addon" value={addonId} />}
          {deviceId !== undefined && <ScopeBadge label="device" value={`#${deviceId}`} />}
          {propsCategory && <ScopeBadge label="category" value={propsCategory} />}
          {/* i18n-ignore-end */}

          <button
            type="button"
            onClick={() => {
              setAutoScroll((a) => !a)
              if (!autoScroll && scrollRef.current)
                scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' })
            }}
            className={cn(
              'inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border transition-colors',
              autoScroll
                ? 'border-border text-foreground-subtle hover:text-foreground'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-400',
            )}
          >
            <ArrowUpToLine className="h-2.5 w-2.5" />
            {autoScroll
              ? t('uiLibrary.eventStream.auto', 'Auto')
              : t('uiLibrary.eventStream.paused', 'Paused')}
          </button>

          {showCategoryFilter && (
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
                title={t('uiLibrary.eventStream.pickEvents', 'Pick events to track')}
              >
                <Filter className="h-2.5 w-2.5" />
                {t('uiLibrary.eventStream.filter', 'Filter ({{label}})', { label: filterLabel })}
              </button>
              {filterOpen && (
                <CategoryFilterPopover
                  search={categorySearch}
                  onSearchChange={setCategorySearch}
                  categories={filteredPopoverCategories}
                  active={activeCategories}
                  onToggle={toggleCategory}
                  onSelectAll={handleSelectAll}
                  onSelectNone={handleSelectNone}
                  onResetDefaults={handleReset}
                />
              )}
            </div>
          )}

          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground transition-colors"
            title={t('uiLibrary.eventStream.resetTitle', 'Reset filters to defaults')}
          >
            <RotateCcw className="h-2.5 w-2.5" />
            {t('uiLibrary.eventStream.reset', 'Reset')}
          </button>

          <button
            type="button"
            onClick={handleClear}
            className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground transition-colors"
            title={t('uiLibrary.eventStream.clearTitle', 'Clear visible entries')}
          >
            <Trash2 className="h-2.5 w-2.5" />
            {t('uiLibrary.eventStream.clear', 'Clear')}
          </button>

          <button
            type="button"
            onClick={handleCopyAll}
            disabled={allEvents.length === 0}
            className={cn(
              'inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border transition-colors',
              copiedAll
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-border text-foreground-subtle hover:text-foreground',
              allEvents.length === 0 && 'opacity-40 cursor-not-allowed',
            )}
            title={t('uiLibrary.eventStream.copyAllTitle', 'Copy all visible events')}
          >
            <Copy className="h-2.5 w-2.5" />
            {copiedAll
              ? t('uiLibrary.eventStream.copied', 'Copied!')
              : t('uiLibrary.eventStream.copy', 'Copy')}
          </button>

          <div className="relative">
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={t('uiLibrary.eventStream.search', 'Search…')}
              className="w-32 pl-1.5 pr-5 py-0.5 rounded border border-border bg-background text-foreground text-[10px] focus:outline-none focus:border-primary/50"
            />
            {searchText && (
              <button
                type="button"
                onClick={() => setSearchText('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground"
                title={t('uiLibrary.eventStream.clearSearch', 'Clear search')}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </div>

          {liveEvents.length > 0 && (
            <span className="text-[9px] text-emerald-400 font-medium">
              {t('uiLibrary.eventStream.live', '+{{count}} live', { count: liveEvents.length })}
            </span>
          )}
        </div>

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

      {/* Events content — flex-1 fills the panel; max-h-* applied
          on the panel root drives the actual height bound. */}
      <div ref={scrollRef} className={cn('flex-1 min-h-0 overflow-auto text-[10px]', maxHeight)}>
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('uiLibrary.eventStream.loading', 'Loading events...')}
          </div>
        )}
        {!isLoading && allEvents.length === 0 && (
          <div className="py-4 text-center text-foreground-subtle">
            {t('uiLibrary.eventStream.empty', 'No events found')}
          </div>
        )}
        {allEvents.length > 0 && (
          <div className="divide-y divide-border/30">
            {allEvents.map((event) => {
              const style = getStyle(t, event.category, event.data)
              const Icon = style.icon
              const summary = summarizeEvent(event.category, event.data, t)
              const expanded = expandedRows.has(event.id)
              return (
                <div
                  key={event.id}
                  className="flex items-start gap-2 px-3 py-1.5 hover:bg-surface-hover/30 cursor-pointer"
                  onClick={() => toggleRow(event.id)}
                >
                  <span className="text-foreground-subtle whitespace-nowrap w-[70px] shrink-0 pt-0.5">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                  <RowCopyButton copied={copiedRowId === event.id} onCopy={() => copyOne(event)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      {expanded ? (
                        <ChevronDown className="h-3 w-3 text-foreground-subtle shrink-0" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-foreground-subtle shrink-0" />
                      )}
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-medium',
                          style.color,
                        )}
                      >
                        <Icon className="h-2.5 w-2.5" />
                        {style.label}
                      </span>
                      {event.source.nodeId && event.source.nodeId !== 'hub' && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-foreground-subtle/10 text-foreground-subtle font-mono">
                          {event.source.nodeId}
                        </span>
                      )}
                    </div>
                    {summary && (
                      <p className="text-foreground-subtle text-[10px] mt-0.5 ml-5">{summary}</p>
                    )}
                    {expanded && (
                      <div className="mt-1 ml-5 text-[9px] bg-surface rounded px-2 py-1.5 space-y-0.5 font-mono overflow-x-auto">
                        <div>
                          <span className="text-primary/70">
                            {/* i18n-ignore: event field name */}source
                          </span>
                          <span className="text-foreground-subtle">: </span>
                          <span className="text-foreground">{JSON.stringify(event.source)}</span>
                        </div>
                        <div>
                          <span className="text-primary/70">
                            {/* i18n-ignore: event field name */}category
                          </span>
                          <span className="text-foreground-subtle">: </span>
                          <span className="text-foreground">{event.category}</span>
                        </div>
                        {Object.entries(event.data).map(([k, v]) => (
                          <div key={k}>
                            <span className="text-primary/70">{k}</span>
                            <span className="text-foreground-subtle">: </span>
                            <span className="text-foreground break-all">
                              {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Multiselect popover
// ---------------------------------------------------------------------------

interface CategoryFilterPopoverProps {
  readonly search: string
  readonly onSearchChange: (next: string) => void
  readonly categories: readonly string[]
  readonly active: ReadonlySet<string>
  readonly onToggle: (cat: string) => void
  readonly onSelectAll: () => void
  readonly onSelectNone: () => void
  readonly onResetDefaults: () => void
}

function CategoryFilterPopover({
  search,
  onSearchChange,
  categories,
  active,
  onToggle,
  onSelectAll,
  onSelectNone,
  onResetDefaults,
}: CategoryFilterPopoverProps) {
  const t = useUiText()
  return (
    <div
      className="absolute z-20 top-full mt-1 left-0 w-72 max-h-80 rounded-md border border-border bg-surface shadow-lg flex flex-col"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50">
        <Search className="h-3 w-3 text-foreground-subtle" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('uiLibrary.eventStream.filterCategories', 'Filter categories…')}
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
          {t('uiLibrary.eventStream.all', 'All')}
        </button>
        <button
          type="button"
          onClick={onSelectNone}
          className="px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground"
        >
          {t('uiLibrary.eventStream.none', 'None')}
        </button>
        <button
          type="button"
          onClick={onResetDefaults}
          className="px-1.5 py-0.5 rounded border border-border text-foreground-subtle hover:text-foreground"
        >
          {t('uiLibrary.eventStream.defaults', 'Defaults')}
        </button>
      </div>
      <div className="overflow-y-auto flex-1">
        {categories.length === 0 && (
          <div className="text-[10px] text-foreground-subtle italic px-2 py-3 text-center">
            {t('uiLibrary.eventStream.noMatches', 'No matches')}
          </div>
        )}
        {categories.map((cat) => {
          const checked = active.has(cat)
          const style = getStyle(t, cat)
          const Icon = style.icon
          return (
            <button
              key={cat}
              type="button"
              onClick={() => onToggle(cat)}
              className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-surface-hover/40 text-[10px]"
            >
              <input type="checkbox" readOnly checked={checked} className="accent-violet-500" />
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium shrink-0',
                  style.color,
                )}
              >
                <Icon className="h-2.5 w-2.5" />
                {style.label}
              </span>
              <span className="text-foreground-subtle font-mono truncate">{cat}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Floating variant
// ---------------------------------------------------------------------------

export interface FloatingEventStreamProps extends EventStreamProps {
  readonly position?: 'bottom' | 'overlay'
}

export function FloatingEventStream({
  position = 'bottom',
  className,
  ...props
}: FloatingEventStreamProps): JSX.Element | null {
  const posClass =
    position === 'bottom'
      ? 'absolute bottom-0 left-0 right-0 z-10 border-t border-border bg-surface/95 backdrop-blur-sm'
      : 'absolute inset-x-2 bottom-2 z-10 rounded-lg border border-border bg-surface/95 backdrop-blur-sm shadow-xl'

  return (
    <div className={cn(posClass, className)}>
      <EventStream maxHeight="max-h-48" {...props} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ScopeBadge({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
      {label}: {value}
    </span>
  )
}

/**
 * Per-row Copy icon — same shape as the one in log-stream.tsx so
 * the three live-streams look symmetric. Stops propagation so the
 * click doesn't toggle the row's expand state. Flashes a Check
 * for ~1s after copy.
 */
function RowCopyButton({
  copied,
  onCopy,
}: {
  readonly copied: boolean
  readonly onCopy: () => void
}) {
  const t = useUiText()
  return (
    <button
      type="button"
      title={t('uiLibrary.eventStream.copyOne', 'Copy this event')}
      onClick={(e) => {
        e.stopPropagation()
        onCopy()
      }}
      className={cn(
        'rounded p-0.5 transition-colors mt-0.5',
        copied
          ? 'text-emerald-400'
          : 'text-foreground-subtle/60 hover:text-foreground hover:bg-surface-hover',
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}
