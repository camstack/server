/**
 * LogStream — universal log viewer for ui-library.
 *
 * Hierarchical scope: agentId → addonId → deviceId.
 * Props lock the top levels; child selectors appear for unlocked levels.
 * Features: level filter, expandable metadata, copy all, load-more,
 * capped live buffer (ring), auto-scroll toggle.
 *
 * Used inline (tabs, cards) and as a floating panel via FloatingLogStream.
 */
import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, type JSX } from 'react'
import {
  X,
  Loader2,
  AlertTriangle,
  Info,
  AlertCircle,
  Bug,
  ArrowDownToLine,
  Check,
  Copy,
  Trash2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
} from 'lucide-react'
import { trpc } from '../trpc-react'
import { cn } from '../lib/cn'
import { useUiText } from '../contexts/ui-text'
import { useLiveBuffer, type LiveBuffer } from '../hooks/use-live-buffer'
import { useDebouncedString } from '../hooks/use-debounced-string'
import { useLogHistory, type LogHistoryLevel } from '../hooks/use-log-history'
import { Button } from '../primitives/button'
import { Select } from '../primitives/select'
import { isPinnedToBottom, PIN_THRESHOLD_PX } from './log-stream-scroll'
import { logEntryKey, mergeLogEntries, type LogWireEntry } from './log-history-paging'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogEntry = LogWireEntry

/** Format a `meta` value for inline display. Strings pass through;
 * everything else gets JSON.stringified so structured payloads stay
 * readable instead of rendering as `[object Object]`. */
function formatMetaValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export interface LogStreamProps {
  // ── Scope (hierarchical, all optional) ────────────────────────────
  /** Lock to a specific agent. When set, the agent selector is hidden. */
  readonly agentId?: string
  /** Lock to a specific addon. When set, the addon selector is hidden. */
  readonly addonId?: string
  /** Lock to a specific device. When set, the device selector is hidden. */
  readonly deviceId?: number
  /**
   * Lock to a container SUBTREE: filters by `containerDeviceId`, returning the
   * container's own logs AND every accessory child's logs in one view (each
   * child stamps its parent's id; a container stamps its own). Pass this
   * INSTEAD of `deviceId` for a container's Logs tab.
   */
  readonly containerDeviceId?: number
  /**
   * Lock to a specific integration. Filter is ALWAYS applied when
   * provided — current providers don't yet tag loggers with
   * `integrationId`, so the result will be empty until they do, but
   * the filter lets us light up integration-scoped logs incrementally
   * without changing the call sites here.
   */
  readonly integrationId?: string
  /**
   * Correlation id for short-lived operations that have no `deviceId`
   * yet (e.g. a creation-field probe). The matching surface (the
   * Add-Device modal) generates the id once per dialog open and the
   * provider plumbs it into its own scoped logger so the user sees
   * live socket / handshake lines streaming during the test.
   */
  readonly requestId?: string

  // ── Display ───────────────────────────────────────────────────────
  /** Initial log level filter. */
  readonly level?: 'debug' | 'info' | 'warn' | 'error'
  /** Max height CSS class (default: 'max-h-96'). */
  readonly maxHeight?: string
  /** Show the scope column. */
  readonly showScope?: boolean
  /**
   * Render an inline per-row device chip (`name #id` / `#id`) when the
   * entry carries a `deviceId` tag. Meant for addon- or agent-scoped
   * streams (orchestrator / runner logs) where lines interleave across
   * many cameras and the operator needs the device at a glance without
   * expanding each row. Off by default — device-scoped streams already
   * imply the device.
   */
  readonly showDeviceChip?: boolean
  /** Show the filter bar with selectors. Set false for compact inline use. */
  readonly showFilters?: boolean
  /** Show the history source selector (default: follows `showFilters`). */
  readonly showSourceSelect?: boolean
  /** Entries per history page (default: 100). */
  readonly limit?: number
  /**
   * Optional controlled live buffer. When provided, the stream reads
   * + appends to this external store rather than its own `useState`,
   * so visible logs survive an unmount/remount of the component
   * (used by `DeviceActivityPanel` to preserve content across tab
   * switches without keeping subscriptions open in inactive tabs).
   */
  readonly liveBuffer?: LiveBuffer<LogEntry>
  /** Close button handler — when provided, renders a close button. */
  readonly onClose?: () => void
  readonly className?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEVEL_STYLES: Record<string, { icon: typeof Info; color: string }> = {
  error: { icon: AlertCircle, color: 'text-red-400' },
  warn: { icon: AlertTriangle, color: 'text-amber-400' },
  info: { icon: Info, color: 'text-blue-400' },
  debug: { icon: Bug, color: 'text-gray-500' },
}

// No 'all' option — it was synonymous with 'debug' (severity 0 → shows everything).
// The level filter always has a concrete floor; the default is 'info'.
const LEVEL_OPTIONS = ['debug', 'info', 'warn', 'error'] as const

/** Max live entries kept in the ring buffer. */
const MAX_LIVE_ENTRIES = 500

/** Text filter debounce before it goes to the server. */
const TEXT_DEBOUNCE_MS = 300
/** Distance from the top (px) that asks for the next older page. */
const TOP_LOAD_THRESHOLD_PX = 24
const BYTES_PER_MB = 1024 * 1024

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LogStream({
  agentId: propsAgentId,
  addonId: propsAddonId,
  deviceId: propsDeviceId,
  containerDeviceId: propsContainerDeviceId,
  integrationId: propsIntegrationId,
  requestId: propsRequestId,
  level: initialLevel,
  maxHeight = 'max-h-96',
  showScope = false,
  showDeviceChip = false,
  showFilters = true,
  showSourceSelect,
  limit = 100,
  liveBuffer: externalBuffer,
  onClose,
  className,
}: LogStreamProps): JSX.Element {
  const t = useUiText()
  const sourceSelectOn = showSourceSelect ?? showFilters
  // ── Local filter state (for unlocked scope levels) ────────────────
  const [localAddonId, setLocalAddonId] = useState<string>('')
  const [localDeviceId, setLocalDeviceId] = useState<string>('')
  // Default 'info' when no explicit level prop is given.
  const [levelFilter, setLevelFilter] = useState<LogHistoryLevel>(initialLevel ?? 'info')
  // History source picked by the operator; undefined = the server default.
  const [sourceChoice, setSourceChoice] = useState<string | undefined>(undefined)

  // Effective scope: props override local selectors
  const agentId = propsAgentId
  const addonId = propsAddonId ?? (localAddonId || undefined)
  const deviceId = propsDeviceId ?? (localDeviceId ? Number(localDeviceId) : undefined)
  const integrationId = propsIntegrationId
  const requestId = propsRequestId

  // Tags for the backend query.
  //
  // `deviceId` MUST stay a number — log entries carry it as a number
  // (`tags: { deviceId: this.id }` on every device-scoped emitter) and
  // the bus's `matchesLogTags` does a strict `!==` comparison, so
  // stringifying here would silently filter every entry out and the
  // Logs tab would render empty.
  const tags = useMemo(() => {
    const tags: Record<string, string | number> = {}
    if (agentId) tags.agentId = agentId
    if (addonId) tags.addonId = addonId
    // A container subtree filter (containerDeviceId) is used INSTEAD of deviceId:
    // it returns the container + all its children. deviceId would over-constrain
    // (AND) to just the container's own lines.
    if (propsContainerDeviceId !== undefined && Number.isFinite(propsContainerDeviceId)) {
      tags.containerDeviceId = propsContainerDeviceId
    } else if (deviceId !== undefined && Number.isFinite(deviceId)) {
      tags.deviceId = deviceId
    }
    if (integrationId) tags.integrationId = integrationId
    if (requestId) tags.requestId = requestId
    return Object.keys(tags).length > 0 ? tags : undefined
  }, [agentId, addonId, deviceId, propsContainerDeviceId, integrationId, requestId])

  // ── Data ──────────────────────────────────────────────────────────
  const fallbackBuffer = useLiveBuffer<LogEntry>(MAX_LIVE_ENTRIES)
  const buffer = externalBuffer ?? fallbackBuffer
  const liveLogs = buffer.entries
  const [clearedAt, setClearedAt] = useState(0)
  // Follow-the-tail — the SINGLE source of truth for whether the viewport
  // tracks the newest line. The list is chronological (newest at the
  // BOTTOM, terminal-style). `follow` is driven by exactly one signal:
  // whether the operator is pinned to the bottom. A genuine scroll-up
  // (distance past the threshold) sets it false; scrolling back to the
  // bottom sets it true again. Burst appends never touch it — the append
  // path captures the pinned-state from the layout BEFORE the rows grow
  // (see the useLayoutEffect below) and re-pins programmatically, so a
  // scroll event fired BY that append is ignored (see programmaticScrollRef).
  // Defaults ON so the panel opens on the newest line.
  const [follow, setFollow] = useState(true)
  // Set true immediately before any scroll WE perform (`scrollTo` /
  // `scrollTop =`). The scroll handler consumes the flag and skips its
  // follow-recompute for that one event, so our own programmatic scrolls
  // can never be mistaken for a user scrolling up. Without this, the
  // scroll event a burst-append triggers would falsely disable follow.
  const programmaticScrollRef = useRef(false)
  // Expand-all override: when true every row with context renders its
  // metadata as `key=value` lines regardless of the per-row Set, so
  // freshly streamed entries come in expanded too.
  const [expandAll, setExpandAll] = useState(false)
  const [copied, setCopied] = useState(false)
  // Tracks which rows are expanded. Keyed by a stable per-entry id
  // (timestamp + message + scope), NOT by list index — when a new log
  // streams in the merged list shifts down by one and an index-keyed
  // Set would silently switch the open row to whatever entry now sits
  // at the previously-expanded position. Stable keys keep the user on
  // the row they actually opened across arbitrary live churn.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [searchText, setSearchText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Reset live logs + expanded when scope changes
  const scopeKey = `${agentId ?? ''}:${addonId ?? ''}:${String(deviceId ?? '')}:${String(propsContainerDeviceId ?? '')}:${integrationId ?? ''}:${requestId ?? ''}`
  const prevScopeRef = useRef(scopeKey)
  useEffect(() => {
    if (prevScopeRef.current !== scopeKey) {
      prevScopeRef.current = scopeKey
      buffer.reset()
      setClearedAt(0)
      setExpandedRows(new Set<string>())
      setExpandAll(false)
    }
  }, [scopeKey, buffer])

  // Filters that the SERVER applies to history and to the live push. The
  // text is debounced so typing does not fire a query per keystroke.
  const debouncedText = useDebouncedString(searchText, TEXT_DEBOUNCE_MS).trim()
  const sourcesQuery = trpc.logs.sources.useQuery(undefined, { staleTime: 60_000 })
  const readableSources = useMemo(
    () => (sourcesQuery.data ?? []).filter((source) => source.readable),
    [sourcesQuery.data],
  )
  const historyQuery = useMemo(
    () => ({
      ...(sourceChoice ? { source: sourceChoice } : {}),
      level: levelFilter,
      ...(debouncedText ? { text: debouncedText } : {}),
      ...(tags ? { tags } : {}),
    }),
    [sourceChoice, levelFilter, debouncedText, tags],
  )
  const history = useLogHistory(historyQuery, limit)

  // Live subscription — entries arrive already filtered by the same level,
  // text and tags.
  trpc.logs.subscribe.useSubscription(
    {
      level: levelFilter,
      ...(debouncedText ? { text: debouncedText } : {}),
      ...(tags ? { tags } : {}),
    },
    {
      onData: (entry) => {
        buffer.append(entry as LogEntry)
      },
    },
  )

  // A changed filter restarts history; live rows accepted under the old filter
  // are dropped with it and the view returns to the tail.
  const filterKey = `${sourceChoice ?? ''}|${levelFilter}|${debouncedText}`
  const prevFilterRef = useRef(filterKey)
  useEffect(() => {
    if (prevFilterRef.current === filterKey) return
    prevFilterRef.current = filterKey
    buffer.reset()
    setFollow(true)
  }, [filterKey, buffer])

  // ── Merged log list (chronological, newest last) ──────────────────
  const allLogs = useMemo(() => {
    const merged = mergeLogEntries(history.entries, liveLogs)
    return clearedAt > 0
      ? merged.filter((log) => new Date(log.timestamp).getTime() > clearedAt)
      : merged
  }, [history.entries, liveLogs, clearedAt])

  // Older rows are prepended above the viewport: remember the geometry before
  // the request and restore the offset once they commit, so the rows the
  // operator is reading do not jump.
  const prependAnchorRef = useRef<{ readonly height: number; readonly top: number } | null>(null)
  const requestOlder = useCallback(() => {
    if (history.status === 'loading' || history.done) return
    const el = scrollRef.current
    if (el) prependAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    history.loadOlder()
  }, [history])
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const el = scrollRef.current
    if (!anchor || !el || history.status !== 'idle') return
    prependAnchorRef.current = null
    const next = anchor.top + (el.scrollHeight - anchor.height)
    if (Math.abs(next - el.scrollTop) < 1) return
    programmaticScrollRef.current = true
    el.scrollTop = next
  }, [history.status, history.entries.length])

  // Imperatively scroll to the newest line, flagging the scroll as
  // programmatic so the scroll handler ignores the event it triggers.
  const scrollToBottom = useCallback((behavior?: ScrollBehavior) => {
    const el = scrollRef.current
    if (!el) return
    programmaticScrollRef.current = true
    el.scrollTo({ top: el.scrollHeight, ...(behavior ? { behavior } : {}) })
  }, [])

  // Follow the tail. Keyed on the row COUNT and run in a layout effect so
  // it executes synchronously AFTER the new rows commit to the DOM but
  // BEFORE the browser paints. Crucially the follow decision is NOT taken
  // here from the post-growth geometry — it's the `follow` state, which
  // was last set from a real USER scroll against the PRE-growth layout.
  // So a burst of appends (which only grows scrollHeight) re-pins to the
  // bottom iff the operator was already following, and never recomputes
  // "did the user scroll up?" from geometry the append itself changed.
  // True when rows arrived while NOT following — drives the "Jump to
  // latest" affordance. Cleared the instant the operator re-follows.
  const [hasNewWhilePaused, setHasNewWhilePaused] = useState(false)
  // Keyed on the NEWEST row, not the count: older pages prepended at the top
  // grow the list without adding anything at the tail.
  const lastKey = allLogs.length > 0 ? logEntryKey(allLogs[allLogs.length - 1]!) : ''
  const prevLastKeyRef = useRef(lastKey)
  useLayoutEffect(() => {
    const newestChanged = lastKey !== '' && lastKey !== prevLastKeyRef.current
    prevLastKeyRef.current = lastKey
    if (!newestChanged) return
    if (follow) scrollToBottom()
    else setHasNewWhilePaused(true)
  }, [lastKey, follow, scrollToBottom])

  // Clear the "new lines below" badge as soon as we're following again
  // (whether re-armed by the toolbar toggle, the jump button, or the user
  // scrolling back to the bottom). Single source of truth: `follow`.
  useEffect(() => {
    if (follow && hasNewWhilePaused) setHasNewWhilePaused(false)
  }, [follow, hasNewWhilePaused])

  // Re-enable following AND jump to the newest line. Wired to both the
  // toolbar toggle (when turning follow back on) and the floating
  // "Jump to latest" affordance.
  const resumeFollow = useCallback(() => {
    setFollow(true)
    scrollToBottom('smooth')
  }, [scrollToBottom])

  // User-scroll handler — the ONLY place `follow` is recomputed from
  // geometry. If the event was triggered by one of our own programmatic
  // scrolls, consume the flag and bail (never mistake it for the operator
  // scrolling up). Otherwise re-pin/un-pin from the genuine scroll
  // position: scrolling up past the threshold disables follow, returning
  // to the bottom re-enables it. Only flips on a transition to avoid a
  // re-render per scroll pixel.
  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false
      return
    }
    const el = scrollRef.current
    if (!el) return
    const pinned = isPinnedToBottom(el, PIN_THRESHOLD_PX)
    setFollow((prev) => (prev === pinned ? prev : pinned))
    if (el.scrollTop <= TOP_LOAD_THRESHOLD_PX) requestOlder()
  }, [requestOlder])

  // ── Expand-all ────────────────────────────────────────────────────
  // Keys of every currently-visible row that carries tags/meta. Used to
  // decide whether the toolbar button reads "expand" or "collapse" and
  // to seed the per-row Set when the user collapses out of expand-all.
  const expandableKeys = useMemo(
    () =>
      allLogs
        .filter(
          (log) =>
            (log.tags && Object.keys(log.tags).length > 0) ||
            (log.meta && Object.keys(log.meta).length > 0),
        )
        .map(logEntryKey),
    [allLogs],
  )
  const toggleExpandAll = useCallback(() => {
    setExpandAll((prev) => {
      // Leaving expand-all collapses everything (clear the per-row Set);
      // entering it relies on the `expandAll` override so new rows expand
      // too without having to track their keys.
      if (prev) setExpandedRows(new Set<string>())
      return !prev
    })
  }, [])

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCopyAll = useCallback(() => {
    const lines = allLogs.map((log) => {
      const time = new Date(log.timestamp).toLocaleTimeString()
      const tagsStr = log.tags
        ? ' ' +
          Object.entries(log.tags)
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
        : ''
      return `${time} [${log.level.toUpperCase()}]${log.scope ? ` [${log.scope}]` : ''}${tagsStr} ${log.message}`
    })
    void navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [allLogs])

  // Server-side mutation: drops matching entries from the log ring
  // buffer so closing+reopening the panel doesn't re-fetch the rows
  // we just cleared. The mutation is best-effort — if the user is a
  // viewer (no admin role) the server rejects and we still wipe the
  // local buffer, matching the prior behaviour.
  const clearMutation = trpc.logs.clear.useMutation()
  const handleClear = useCallback(() => {
    setClearedAt(Date.now())
    buffer.reset()
    clearMutation.mutate(tags ? { tags } : {})
  }, [buffer, clearMutation, tags])

  const toggleRow = useCallback((rowKey: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(rowKey)) next.delete(rowKey)
      else next.add(rowKey)
      return next
    })
  }, [])

  // Tracks which row was just copied so the small per-row Copy
  // button can flash a Check for ~1s without dragging "Copied!"
  // text into the toolbar's `copied` state (that one is reserved
  // for Copy-All so the two indicators don't compete).
  const [copiedRowKey, setCopiedRowKey] = useState<string | null>(null)
  const copyOne = useCallback((log: LogEntry, key: string) => {
    const time = new Date(log.timestamp).toISOString()
    const tagsStr = log.tags
      ? ' ' +
        Object.entries(log.tags)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : ''
    const metaStr =
      log.meta && Object.keys(log.meta).length > 0 ? ` meta=${JSON.stringify(log.meta)}` : ''
    const text = `${time} [${log.level.toUpperCase()}]${log.scope ? ` [${log.scope}]` : ''}${tagsStr} ${log.message}${metaStr}`
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedRowKey(key)
      setTimeout(() => setCopiedRowKey((prev) => (prev === key ? null : prev)), 1200)
    })
  }, [])

  // Stable per-entry identity used for both the React row key AND the
  // expanded-rows lookup: the server-assigned id, else (older sources)
  // `timestamp + level + scope + message`, where a collision is harmless —
  // both rows would expand together.
  const rowKey = logEntryKey

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div
      className={cn('h-full min-h-0 flex flex-col', className)}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-hover/30 gap-2 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-foreground-subtle font-medium">
            {t('uiLibrary.logStream.logs', 'Logs')}
          </span>

          {/* Scope badges */}
          {agentId && (
            <ScopeBadge label={t('uiLibrary.logStream.scopeAgent', 'agent')} value={agentId} />
          )}
          {addonId && (
            <ScopeBadge label={t('uiLibrary.logStream.scopeAddon', 'addon')} value={addonId} />
          )}
          {deviceId !== undefined && (
            <ScopeBadge
              label={t('uiLibrary.logStream.scopeDevice', 'device')}
              value={`#${deviceId}`}
            />
          )}

          {/* Level filter */}
          <div className="flex rounded border border-border overflow-hidden text-[9px]">
            {LEVEL_OPTIONS.map((l, i) => (
              <button
                key={l}
                type="button"
                onClick={() => setLevelFilter(l)}
                className={cn(
                  'px-1.5 py-0.5 capitalize transition-colors',
                  levelFilter === l
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground-subtle hover:bg-surface-hover',
                  i > 0 && 'border-l border-border',
                )}
              >
                {l}+
              </button>
            ))}
          </div>

          {/* History source — only readable sources, and only when there is a
              choice (a control with one option is not rendered). While the
              list is unanswered nothing is claimed either way. */}
          {sourceSelectOn && readableSources.length > 1 && (
            <div className="w-36">
              <Select
                aria-label={t('uiLibrary.logStream.source', 'Log source')}
                className="h-5 text-[10px]"
                value={sourceChoice ?? readableSources.find((x) => x.isDefault)?.addonId ?? ''}
                onChange={(e) => setSourceChoice(e.target.value)}
                options={readableSources.map((x) => ({ value: x.addonId, label: x.addonId }))}
              />
            </div>
          )}
          {sourceSelectOn && readableSources.length <= 1 && history.source && (
            <span className="text-[9px] text-foreground-subtle">
              {t('uiLibrary.logStream.sourceName', 'Source: {{name}}', { name: history.source })}
            </span>
          )}

          {/* Action buttons */}
          <ToolbarButton
            icon={ArrowDownToLine}
            label={
              follow
                ? t('uiLibrary.logStream.following', 'Following')
                : t('uiLibrary.logStream.paused', 'Paused')
            }
            active={follow}
            onClick={() => {
              // Re-arming follow jumps to the newest line (shared
              // `resumeFollow` path); pausing just leaves the viewport
              // where it is.
              if (follow) setFollow(false)
              else resumeFollow()
            }}
          />
          <ToolbarButton
            icon={expandAll ? ChevronsDownUp : ChevronsUpDown}
            label={
              expandAll
                ? t('uiLibrary.logStream.collapse', 'Collapse')
                : t('uiLibrary.logStream.expand', 'Expand')
            }
            active={expandAll}
            onClick={toggleExpandAll}
            disabled={expandableKeys.length === 0}
          />
          <ToolbarButton
            icon={Copy}
            label={
              copied
                ? t('uiLibrary.logStream.copied', 'Copied!')
                : t('uiLibrary.logStream.copy', 'Copy')
            }
            onClick={handleCopyAll}
            disabled={allLogs.length === 0}
          />
          <ToolbarButton
            icon={Trash2}
            label={t('uiLibrary.logStream.clear', 'Clear')}
            onClick={handleClear}
          />

          {/* Free-text search — substring match across message, scope, tags, meta. */}
          <div className="relative">
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder={t('uiLibrary.logStream.searchPlaceholder', 'Search…')}
              className="w-32 pl-1.5 pr-5 py-0.5 rounded border border-border bg-background text-foreground text-[10px] focus:outline-none focus:border-primary/50"
            />
            {searchText && (
              <button
                type="button"
                onClick={() => setSearchText('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground"
                title={t('uiLibrary.logStream.clearSearch', 'Clear search')}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </div>

          {liveLogs.length > 0 && (
            <span className="text-[9px] text-emerald-400 font-medium">
              {t('uiLibrary.logStream.live', '+{{count}} live', { count: liveLogs.length })}
            </span>
          )}
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-foreground-subtle hover:text-foreground"
            aria-label={t('uiLibrary.logStream.close', 'Close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Inline scope selectors (only for unlocked levels) */}
      {showFilters && (!propsAddonId || !propsDeviceId) && (
        <div className="flex items-center gap-2 px-3 py-1 border-b border-border/50 bg-surface/50 text-[10px]">
          {!propsAddonId && (
            <label className="flex items-center gap-1">
              <span className="text-foreground-subtle">
                {t('uiLibrary.logStream.addon', 'Addon:')}
              </span>
              <input
                type="text"
                value={localAddonId}
                onChange={(e) => setLocalAddonId(e.target.value)}
                placeholder={t('uiLibrary.logStream.all', 'all')}
                className="w-28 px-1.5 py-0.5 rounded border border-border bg-background text-foreground text-[10px] focus:outline-none focus:border-primary/50"
              />
            </label>
          )}
          {!propsDeviceId && (
            <label className="flex items-center gap-1">
              <span className="text-foreground-subtle">
                {t('uiLibrary.logStream.device', 'Device:')}
              </span>
              <input
                type="text"
                inputMode="numeric"
                value={localDeviceId}
                onChange={(e) => setLocalDeviceId(e.target.value)}
                placeholder={t('uiLibrary.logStream.all', 'all')}
                className="w-16 px-1.5 py-0.5 rounded border border-border bg-background text-foreground text-[10px] focus:outline-none focus:border-primary/50"
              />
            </label>
          )}
        </div>
      )}

      {/* Log content — flex-1 fills the panel; max-h-* applied on the
          panel root drives the actual height bound. The relative wrapper
          anchors the floating "Jump to latest" affordance. */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        {/* Jump-to-latest: shown only when the operator has scrolled up
          (follow paused) AND new lines have streamed in below the fold.
          Single click re-pins to the tail via the shared resumeFollow. */}
        {!follow && hasNewWhilePaused && (
          <button
            type="button"
            onClick={resumeFollow}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1 px-2 py-1 rounded-full border border-primary/40 bg-primary/15 text-primary text-[10px] font-medium shadow-md backdrop-blur-sm hover:bg-primary/25 transition-colors"
            title={t(
              'uiLibrary.logStream.jumpTitle',
              'Jump to the newest log line and resume following',
            )}
          >
            <ArrowDownToLine className="h-3 w-3" />
            {t('uiLibrary.logStream.jumpToLatest', 'Jump to latest')}
          </button>
        )}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn('flex-1 min-h-0 overflow-auto font-mono text-[10px]', maxHeight)}
        >
          <HistoryEdge
            status={history.status}
            done={history.done}
            scannedBytes={history.scannedBytes}
            hasRows={allLogs.length > 0}
            error={history.error}
            onLoadOlder={requestOlder}
            onCancel={history.cancel}
          />
          {history.status === 'idle' && history.done && allLogs.length === 0 && (
            <div className="py-4 text-center text-foreground-subtle">
              {t('uiLibrary.logStream.noLogs', 'No logs found')}
            </div>
          )}
          {allLogs.length > 0 && (
            <table className="w-full">
              <tbody>
                {allLogs.map((log) => {
                  const style = LEVEL_STYLES[log.level] ?? LEVEL_STYLES['info']!
                  const Icon = style.icon
                  const key = rowKey(log)
                  const expanded = expandAll || expandedRows.has(key)
                  const hasTags = log.tags && Object.keys(log.tags).length > 0
                  const hasMeta = log.meta && Object.keys(log.meta).length > 0
                  const hasContext = hasTags || hasMeta

                  return (
                    <tr
                      key={key}
                      className={cn(
                        'hover:bg-surface-hover/30 border-b border-border/30',
                        hasContext && 'cursor-pointer',
                      )}
                      onClick={hasContext ? () => toggleRow(key) : undefined}
                    >
                      <td className="px-2 py-1 text-foreground-subtle whitespace-nowrap align-top w-[70px]">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </td>
                      <td className={cn('px-1 py-1 align-top w-5', style.color)}>
                        <Icon className="h-3 w-3" />
                      </td>
                      {showScope && (
                        <td
                          className="px-2 py-1 text-foreground-subtle align-top truncate max-w-[120px]"
                          title={log.scope}
                        >
                          {log.scope?.replace(/^addon:/, '') ?? ''}
                        </td>
                      )}
                      <td className="px-2 py-1 text-foreground break-all">
                        <div className="flex items-start gap-1">
                          {hasContext &&
                            (expanded ? (
                              <ChevronDown className="h-3 w-3 text-foreground-subtle shrink-0 mt-0.5" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-foreground-subtle shrink-0 mt-0.5" />
                            ))}
                          <div className="flex-1 min-w-0">
                            {showDeviceChip && log.tags?.deviceId !== undefined && (
                              <DeviceChip
                                deviceId={log.tags.deviceId}
                                deviceName={log.tags.deviceName}
                              />
                            )}
                            {log.message}
                            {expanded && hasContext && (
                              // key=value lines printed directly under the
                              // main line (no JSON block, no boxed card) so
                              // the metadata reads like a continuation of the
                              // log entry itself.
                              <div className="mt-0.5 pl-3 text-[9px] leading-snug">
                                {hasMeta &&
                                  Object.entries(log.meta!)
                                    .filter(([, v]) => v !== undefined && v !== '')
                                    .map(([k, v]) => (
                                      <div key={`m-${k}`} className="break-all">
                                        <span className="text-amber-400/80">{k}</span>
                                        <span className="text-foreground-subtle">=</span>
                                        <span className="text-foreground">
                                          {formatMetaValue(v)}
                                        </span>
                                      </div>
                                    ))}
                                {hasTags &&
                                  Object.entries(log.tags!)
                                    .filter(([, v]) => v !== undefined)
                                    .map(([k, v]) => (
                                      <div key={`t-${k}`} className="break-all">
                                        <span className="text-primary/70">{k}</span>
                                        <span className="text-foreground-subtle">=</span>
                                        <span className="text-foreground">{v}</span>
                                      </div>
                                    ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-1 py-1 align-top w-5">
                        <RowCopyButton
                          copied={copiedRowKey === key}
                          onCopy={() => copyOne(log, key)}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Floating variant
// ---------------------------------------------------------------------------

export interface FloatingLogStreamProps extends LogStreamProps {
  /** Position: 'bottom' anchors to parent bottom, 'overlay' is absolute positioned. */
  readonly position?: 'bottom' | 'overlay'
}

export function FloatingLogStream({
  position = 'bottom',
  className,
  ...props
}: FloatingLogStreamProps): JSX.Element {
  const posClass =
    position === 'bottom'
      ? 'absolute bottom-0 left-0 right-0 z-10 border-t border-border bg-surface/95 backdrop-blur-sm'
      : 'absolute inset-x-2 bottom-2 z-10 rounded-lg border border-border bg-surface/95 backdrop-blur-sm shadow-xl'

  return (
    <div className={cn(posClass, className)}>
      <LogStream maxHeight="max-h-48" {...props} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inline per-row device chip — rendered before the message when the
 * entry carries a `deviceId` tag and the stream opted in via
 * `showDeviceChip`. Prefers the human `deviceName` tag (with the id as
 * a suffix) and falls back to `#id`.
 */
function DeviceChip({
  deviceId,
  deviceName,
}: {
  readonly deviceId: string
  readonly deviceName?: string
}) {
  const t = useUiText()
  const label = deviceName ? `${deviceName} #${deviceId}` : `#${deviceId}`
  return (
    <span
      className="inline-block align-middle mr-1 px-1 py-0 rounded bg-primary/10 text-primary text-[9px] font-medium whitespace-nowrap"
      title={t('uiLibrary.logStream.deviceTitle', 'device {{id}}', { id: deviceId })}
    >
      {label}
    </span>
  )
}

/**
 * The top of the list: the state of the older-history scan. A scan that is
 * still looking (short page, source not done) says how much it has read and
 * can be cancelled; the end of the source is stated quietly.
 */
function HistoryEdge({
  status,
  done,
  scannedBytes,
  hasRows,
  error,
  onLoadOlder,
  onCancel,
}: {
  readonly status: 'idle' | 'loading'
  readonly done: boolean
  readonly scannedBytes: number
  readonly hasRows: boolean
  readonly error: string | null
  readonly onLoadOlder: () => void
  readonly onCancel: () => void
}) {
  const t = useUiText()
  if (status === 'loading') {
    const scanning = scannedBytes > 0
    return (
      <div className="flex items-center justify-center gap-2 py-2 text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {scanning
          ? t('uiLibrary.logStream.searching', 'Searching older logs… ({{mb}} MB scanned)', {
              mb: (scannedBytes / BYTES_PER_MB).toFixed(1),
            })
          : t('uiLibrary.logStream.loading', 'Loading logs...')}
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('uiLibrary.logStream.cancel', 'Cancel')}
        </Button>
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-center justify-center gap-2 py-2 text-danger">
        {error}
        <Button variant="outline" size="sm" onClick={onLoadOlder}>
          {t('uiLibrary.logStream.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  if (done) {
    return hasRows ? (
      <div className="py-2 text-center text-foreground-subtle">
        {t('uiLibrary.logStream.beginning', 'Beginning of logs')}
      </div>
    ) : null
  }
  return (
    <div className="flex justify-center py-1.5">
      <Button variant="outline" size="sm" onClick={onLoadOlder}>
        {t('uiLibrary.logStream.loadOlder', 'Load older')}
      </Button>
    </div>
  )
}

function ScopeBadge({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
      {label}: {value}
    </span>
  )
}

/**
 * Per-row Copy icon. Stops propagation so the click doesn't toggle
 * the row's expanded state. Shows a Check briefly after copy as a
 * "did it work" affordance — same UX language the toolbar Copy
 * button already uses for its `Copied!` label.
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
      title={t('uiLibrary.logStream.copyRow', 'Copy this row')}
      onClick={(e) => {
        e.stopPropagation()
        onCopy()
      }}
      className={cn(
        'rounded p-0.5 transition-colors',
        copied
          ? 'text-emerald-400'
          : 'text-foreground-subtle/60 hover:text-foreground hover:bg-surface-hover',
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  readonly icon: typeof Info
  readonly label: string
  readonly onClick: () => void
  readonly disabled?: boolean
  readonly active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded border transition-colors',
        active
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
          : 'border-border text-foreground-subtle hover:text-foreground',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {label}
    </button>
  )
}
