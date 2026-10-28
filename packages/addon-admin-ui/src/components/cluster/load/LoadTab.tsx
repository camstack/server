/**
 * Cluster → Node → Load tab.
 *
 * Two sections, and the line between them is the point of the tab:
 *
 *  1. **Per node, per function** — CPU (main threads vs V8 helper pool) and
 *     memory RSS, one small-multiple pair per addon, ordered heaviest first.
 *     Every number here is measured for the process it names.
 *
 *  2. **Per camera** — CPU and memory per camera, differenced from what each
 *     addon reports about its OWN children, plus a badge for the processes
 *     nobody claims. See `CameraLoadPanel.tsx`.
 *
 * There is no third section listing the classification, and no prose beneath
 * section 2 explaining it. `camera-load-attribution.ts` is still the gate that
 * decides what section 2 may draw; what was removed on 2026-08-28 is every
 * rendering of that reasoning, which the operator found actionless.
 *
 * The tab draws only from what the cluster already emits and already stores.
 * The per-addon window is served by `metricsProvider.getLoadSeries`, the one
 * reader over BOTH tiers: the node's in-memory ring for the hot part and the
 * hub's `metrics:node-load-samples` table for the cold one (D260).
 *
 * ## What the caption says, and why it is one line
 *
 * A paragraph used to sit here narrating that architecture to the reader. It
 * was removed on 2026-08-28 — it described how the data is fetched, which is
 * not a thing an operator can act on. Two facts inside it WERE load-bearing:
 * the window actually on screen, and that one point is a bucket MAXIMUM rather
 * than a mean. Without the second one every spike on the page is read wrong.
 *
 * The first of the two has since moved onto the charts themselves — the x axis
 * now carries wall-clock ticks, which state the window by POSITION and are
 * strictly better than a sentence that stated it in words. So
 * {@link WindowCaption} keeps only the fact no axis can express: what one
 * point covers. Printing "Since 14:32" beside an axis whose first tick reads
 * 14:32 is the same fact twice, in two formats, inviting the reader to look
 * for a difference that does not exist.
 */
import { useMemo, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Search, X } from 'lucide-react'
import { formatBytes } from '../../../lib/format-size'
import { SingleLineChart, StackedCpuChart } from './LoadChart'
import { gapThresholdMs, useSearchFieldHotkey } from '@camstack/ui-library'
import { ROOT_BUCKET_KEY, UNATTRIBUTED_BUCKET_KEY, type LoadSeries } from './load-series'
import {
  DEFAULT_LOAD_SORT,
  filterAndSortLoadCards,
  type LoadSortKey,
  type LoadSortState,
} from './load-card-filter'
import { useNodeLoadSeries } from './use-node-load-series'
import { CameraLoadPanel } from './CameraLoadPanel'

interface LoadTabProps {
  readonly nodeId: string
  /**
   * Is this node the hub? Needed because a contribution's node is read off its
   * registry key, and a hub-local provider registers under a BARE key — so
   * "no `@node` suffix" resolves to the hub and nowhere else.
   */
  readonly isHub: boolean
}

/** 256 MiB axis floor — below it a runner's memory line is noise, not a trend. */
const MEMORY_AXIS_FLOOR_BYTES = 256 * 1024 * 1024

/**
 * Fallback sampling interval when the server has not answered yet.
 *
 * The shipped cadence default. It is only ever used before `getLoadSeries`
 * returns — once it has, `bucketMs` is what one point genuinely covers and is
 * always preferred, because on a reduced window the spacing between points is
 * the BUCKET, not the cadence.
 */
const FALLBACK_SAMPLE_INTERVAL_MS = 10_000

export function LoadTab({ nodeId, isHub }: LoadTabProps) {
  const searchFieldRef = useRef<HTMLInputElement>(null)
  useSearchFieldHotkey(searchFieldRef)
  const { t } = useTranslation()
  const { series, sampleCount, threadSplitAvailable, loadingRetained, bucketMs, cadenceMs } =
    useNodeLoadSeries(nodeId)

  const [search, setSearch] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set())
  const [sort, setSort] = useState<LoadSortState>(DEFAULT_LOAD_SORT)

  const labelFor = (s: LoadSeries): string => {
    if (s.key === ROOT_BUCKET_KEY) return t('clusterLoad.bucketRoot', 'Node supervisor')
    if (s.key === UNATTRIBUTED_BUCKET_KEY) {
      return t('clusterLoad.bucketUnattributed', 'Unattributed processes')
    }
    return s.key
  }

  /**
   * The spacing two adjacent points are EXPECTED to have. `bucketMs` first: on
   * a reduced window one point covers a bucket, so the cadence would declare a
   * gap between every pair of points.
   */
  const sampleIntervalMs = bucketMs ?? cadenceMs ?? FALLBACK_SAMPLE_INTERVAL_MS
  const gapMs = gapThresholdMs(sampleIntervalMs)

  const visible = useMemo(
    () => filterAndSortLoadCards(series, { search, selectedKeys, sort }, labelFor),
    // `labelFor` closes over `t` only, and re-deriving on every render would
    // defeat the memo; the i18n language change re-renders the whole tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, search, selectedKeys, sort],
  )

  const toggleKey = (key: string): void => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <WindowCaption bucketMs={bucketMs} cadenceMs={cadenceMs} />

      {!threadSplitAvailable && sampleCount > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-[11px] text-warning">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            {t(
              'clusterLoad.noThreadSplit',
              'No thread-level CPU split on this node — /proc/<pid>/task is Linux-only, and the first sample after a restart has no window to measure. CPU below falls back to the ps lifetime AVERAGE, which is not a rate.',
            )}
          </span>
        </div>
      )}

      {sampleCount === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[11px] text-foreground-subtle">
          {loadingRetained
            ? t('clusterLoad.loadingRetained', 'Reading the retained series from this node…')
            : t(
                'clusterLoad.waitingFirstSample',
                'No retained samples for this node — waiting for the next snapshot (up to 20s). The chart needs two to draw a rate.',
              )}
        </div>
      )}

      {series.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative flex-1 min-w-[160px]">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-foreground-subtle" />
              <input
                ref={searchFieldRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('clusterLoad.searchPlaceholder', 'Find a runner…')}
                aria-label={t('clusterLoad.searchLabel', 'Find a runner')}
                className="w-full rounded border border-border bg-background py-1 pl-7 pr-2 text-[11px] text-foreground placeholder:text-foreground-subtle"
              />
            </label>
            <SortControl sort={sort} onChange={setSort} />
          </div>

          {/* Multiselect. Toggle chips rather than a dropdown: the whole point
              is pinning two or three runners and SEEING which are pinned
              without opening anything. Empty selection means all — never
              none. */}
          <div className="flex flex-wrap items-center gap-1">
            {series.map((s) => {
              const on = selectedKeys.has(s.key)
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleKey(s.key)}
                  className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                    on
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-foreground-subtle hover:text-foreground'
                  }`}
                >
                  {labelFor(s)}
                </button>
              )
            })}
            {selectedKeys.size > 0 && (
              <button
                type="button"
                onClick={() => setSelectedKeys(new Set())}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-foreground-subtle hover:text-foreground"
              >
                <X className="h-2.5 w-2.5" />
                {t('clusterLoad.clearFilter', 'All runners')}
              </button>
            )}
          </div>
        </div>
      )}

      {series.length > 0 && visible.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[11px] text-foreground-subtle">
          {t(
            'clusterLoad.noMatches',
            'No runner matches this search on {{count}} present. The node is reporting — the filter is hiding them.',
            { count: series.length },
          )}
        </div>
      )}

      <div className="space-y-3">
        {visible.map((s) => (
          <div key={s.key} className="rounded-lg border border-border p-3">
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <span className="text-xs font-medium text-foreground">{labelFor(s)}</span>
              <span className="text-[10px] text-foreground-subtle">
                {t('clusterLoad.processCount', '{{count}} process(es)', {
                  count: s.points.at(-1)?.processCount ?? 0,
                })}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <StackedCpuChart
                title={
                  threadSplitAvailable
                    ? t('clusterLoad.cpuTitle', 'CPU % of one core')
                    : t('clusterLoad.cpuTitleLifetime', 'CPU % (ps lifetime average)')
                }
                mainLabel={t('clusterLoad.seriesMain', 'Main threads')}
                gcLabel={t('clusterLoad.seriesGc', 'GC / V8 helpers')}
                points={s.points.map((p) => ({
                  atMs: p.atMs,
                  // When the split is unknown the whole stack is unknown — the
                  // lifetime average is shown as the single readout instead of
                  // being drawn as if it were the main-thread series.
                  main: p.cpuMainPercent,
                  gc: p.cpuGcPercent,
                }))}
                formatValue={(v) => `${v.toFixed(0)}%`}
                gapMs={gapMs}
                emptyMessage={t(
                  'clusterLoad.cpuUnavailable',
                  'No thread split on this node. Lifetime average: {{avg}}%',
                  { avg: (s.points.at(-1)?.cpuLifetimePercent ?? 0).toFixed(1) },
                )}
              />
              <SingleLineChart
                title={t('clusterLoad.memoryTitle', 'Memory RSS')}
                points={s.points.map((p) => ({ atMs: p.atMs, value: p.memoryRssBytes }))}
                formatValue={formatBytes}
                axisFloor={MEMORY_AXIS_FLOOR_BYTES}
                // `formatBytes` is binary — a decimally-rounded axis top prints
                // as `4.7 GB`.
                axisScale="bytes"
                gapMs={gapMs}
                emptyMessage={t('clusterLoad.memoryUnavailable', 'No memory samples yet.')}
              />
            </div>
          </div>
        ))}
      </div>

      <CameraLoadPanel scope={{ nodeId, isHub }} cadenceMs={cadenceMs} />
    </div>
  )
}

/**
 * What ONE POINT covers, in one line.
 *
 * The only fact from the removed architecture paragraph that the charts cannot
 * show for themselves. A reduced point that a reader takes for an average
 * understates every spike the page exists to find.
 *
 * It no longer states the window: every chart's x axis carries wall-clock
 * ticks now, which say the same thing by position and say it per chart.
 */
function WindowCaption({
  bucketMs,
  cadenceMs,
}: {
  readonly bucketMs: number | null
  readonly cadenceMs: number | null
}) {
  const { t } = useTranslation()
  if (bucketMs === null) return null
  const reduced = cadenceMs !== null && bucketMs > cadenceMs
  return (
    <p className="text-[10px] text-foreground-subtle">
      {reduced
        ? t('clusterLoad.captionBucket', '1 point = {{bucket}}s (bucket MAXIMUM, not a mean)', {
            bucket: Math.round(bucketMs / 1000),
          })
        : t('clusterLoad.captionRaw', '1 point = 1 snapshot')}
    </p>
  )
}

/**
 * The sort control.
 *
 * Three keys and no more, because a card shows three things: its CPU readout,
 * its memory readout and its name. Offering a fourth would be an ordering the
 * operator cannot check against anything on screen — the same rule the
 * `DataTable` columns keep by omitting `sortValue`.
 */
function SortControl({
  sort,
  onChange,
}: {
  readonly sort: LoadSortState
  readonly onChange: (next: LoadSortState) => void
}) {
  const { t } = useTranslation()
  const options: readonly { readonly key: LoadSortKey; readonly label: string }[] = [
    { key: 'cpu', label: t('clusterLoad.sortCpu', 'CPU') },
    { key: 'memory', label: t('clusterLoad.sortMemory', 'Memory') },
    { key: 'name', label: t('clusterLoad.sortName', 'Name') },
  ]
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-foreground-subtle">
        {t('clusterLoad.sortBy', 'Sort by')}
      </span>
      {options.map((option) => {
        const active = sort.key === option.key
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            // Clicking the active key flips its direction; clicking another
            // switches to it at the direction that answers its question first
            // (biggest for a load, A→Z for a name).
            onClick={() =>
              onChange(
                active
                  ? { key: option.key, dir: sort.dir === 'desc' ? 'asc' : 'desc' }
                  : { key: option.key, dir: option.key === 'name' ? 'asc' : 'desc' },
              )
            }
            className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-foreground-subtle hover:text-foreground'
            }`}
          >
            {option.label}
            {active && (sort.dir === 'desc' ? ' ↓' : ' ↑')}
          </button>
        )
      })}
    </div>
  )
}
