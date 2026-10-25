/**
 * DeviceHistoryView — a device's recorded history (device-history, D850):
 * the device page's History tab, and — with `fixedWindow="24h"` — the last
 * day on a camera's Live Stats tab. One code path for both.
 *
 * Grouping mirrors the State panel: one collapsible section per capability
 * (catalog order), then per producer addon; inside, one chart per unit and
 * one timeline per state. Every chart shares one cursor. A chart's ⋯ menu
 * opens its series on the History page or hides it (remembered in the
 * user's account preferences).
 *
 * Absent and pending are different screens (D315): device-history not
 * installed, the list not answered yet, and "nothing recorded" each say so.
 */
import { useCallback, useMemo, useState, type JSX } from 'react'
import { EyeOff, History as HistoryIcon, LineChart } from 'lucide-react'
import type { DeviceHistoryQueryManyEntry, DeviceHistoryQueryManyItem } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import { useUrlQueryParam } from '../../hooks/use-url-query'
import { routerBasename } from '../../lib/hub-mount'
import { STACK_GAP } from '../../lib/responsive'
import { Button } from '../../primitives/button'
import { CollapsibleCard } from '../../primitives/collapsible-card'
import { Skeleton } from '../../primitives/skeleton'
import { EmptyState } from '../empty-state'
import { ErrorBox } from '../error-box'
import { KebabMenu } from '../kebab-menu'
import { HistoryChart } from './HistoryChart'
import {
  chartKeys,
  groupDeviceSeries,
  type HistoryChartSpec,
  type HistorySection,
} from './history-model'
import { historyPageHref, withHiddenChart, type HistorySeriesRef } from './history-selection'
import {
  decodeCustomWindow,
  encodeCustomWindow,
  isHistoryWindowId,
  resolveHistoryWindow,
  type HistoryWindowId,
} from './history-window'
import { HistoryWindowBar } from './HistoryWindowBar'
import { anchorNow, readItemId, useDeviceSeriesList, useHistoryReads } from './use-device-history'
import { useHistoryPanels } from './use-history-panels'

export interface DeviceHistoryViewProps {
  readonly deviceId: number
  /** A fixed window with no window controls (the Live Stats tab's last day). */
  readonly fixedWindow?: Exclude<HistoryWindowId, 'custom'>
  /** In-app navigation (react-router); default a page load under the mount. */
  readonly onNavigate?: (path: string) => void
}

/** `climate-control` → `Climate control`. */
export function humanizeName(name: string): string {
  const words = name.replace(/[-_]/g, ' ').trim()
  return words.length === 0 ? name : words.charAt(0).toUpperCase() + words.slice(1)
}

function refsOf(deviceId: number, spec: HistoryChartSpec): readonly HistorySeriesRef[] {
  const list = spec.type === 'lines' || spec.type === 'occupancy' ? spec.series : [spec.series]
  return list.map((s) => ({ subject: { kind: 'device', deviceId }, key: s.key, scope: s.scope }))
}

export function DeviceHistoryView({
  deviceId,
  fixedWindow,
  onNavigate,
}: DeviceHistoryViewProps): JSX.Element {
  const t = useUiText()
  const [windowParam, setWindowParam] = useUrlQueryParam('hw')
  const [customParam, setCustomParam] = useUrlQueryParam('hr')
  const [compareParam, setCompareParam] = useUrlQueryParam('hc')
  const windowId: HistoryWindowId =
    fixedWindow ?? (isHistoryWindowId(windowParam) ? windowParam : '24h')
  const custom = fixedWindow ? null : decodeCustomWindow(customParam)
  const compare = fixedWindow === undefined && compareParam === '1'
  const spanGuess = resolveHistoryWindow(windowId, Date.now(), custom)
  const now = anchorNow(Date.now(), spanGuess.to - spanGuess.from)
  const range = resolveHistoryWindow(windowId, now, custom)

  const { presence, list } = useDeviceSeriesList(deviceId)
  const panels = useHistoryPanels()
  const hidden = useMemo(
    () => new Set(panels.value.hidden[String(deviceId)] ?? []),
    [panels.value.hidden, deviceId],
  )
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const sections = useMemo<readonly HistorySection[]>(
    () => (list.status === 'ok' ? groupDeviceSeries(list.data, humanizeName) : []),
    [list],
  )
  const visible = useMemo(
    () =>
      sections
        .map((s) => ({ ...s, charts: s.charts.filter((c) => !hidden.has(c.id)) }))
        .filter((s) => s.charts.length > 0),
    [sections, hidden],
  )
  const hiddenCount = sections.reduce(
    (n, s) => n + s.charts.filter((c) => hidden.has(c.id)).length,
    0,
  )
  const items = useMemo<readonly DeviceHistoryQueryManyItem[]>(
    () => chartKeys(visible.flatMap((s) => s.charts)).map((key) => ({ deviceId, key })),
    [visible, deviceId],
  )
  const reads = useHistoryReads(items, range, compare, list.status === 'ok')
  const readsData = reads.status === 'ok' ? reads.data : null
  const entryFor = useCallback(
    (key: string, previous: boolean): DeviceHistoryQueryManyEntry | undefined => {
      const id = readItemId({ deviceId, key })
      if (reads.status === 'error') return { ok: false, error: reads.error }
      const map = previous ? readsData?.previous : readsData?.current
      return map?.get(id)
    },
    [deviceId, reads, readsData],
  )

  const navigate = useCallback(
    (path: string) => {
      if (onNavigate) onNavigate(path)
      else globalThis.location.assign(`${routerBasename()}${path}`)
    },
    [onNavigate],
  )
  const setHidden = (chartId: string, hide: boolean): void => {
    if (!panels.writable) return
    void panels.update((v) => withHiddenChart(v, deviceId, chartId, hide))
  }
  const showAllHidden = (): void => {
    if (!panels.writable) return
    void panels.update((v) => {
      let next = v
      for (const id of hidden) next = withHiddenChart(next, deviceId, id, false)
      return next
    })
  }

  if (presence === 'pending') return <HistorySkeleton />
  if (presence === 'unknown') {
    return (
      <ErrorBox
        title={t('uiLibrary.history.presenceUnknownTitle', 'Could not reach the hub')}
        message={t(
          'uiLibrary.history.presenceUnknown',
          'The hub did not say whether device history is installed. Try again in a moment.',
        )}
      />
    )
  }
  if (presence === 'absent') {
    return (
      <EmptyState
        icon={HistoryIcon}
        title={t('uiLibrary.history.absentTitle', 'Device history is not running on this hub')}
        description={t(
          'uiLibrary.history.absent',
          'Nothing is recorded until the device-history system addon is enabled.',
        )}
      />
    )
  }
  if (list.status === 'pending') return <HistorySkeleton />
  if (list.status === 'error') {
    return (
      <ErrorBox
        title={t('uiLibrary.history.listFailedTitle', 'History could not be read')}
        message={list.error}
      />
    )
  }
  if (sections.length === 0) {
    return (
      <EmptyState
        icon={LineChart}
        title={t('uiLibrary.history.emptyTitle', 'Nothing recorded for this device yet')}
        description={t(
          'uiLibrary.history.empty',
          'A value appears here once it changes, or at the next five-minute check.',
        )}
      />
    )
  }

  const syncKey = `device-history:${String(deviceId)}`
  return (
    <div className={STACK_GAP}>
      {fixedWindow === undefined && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <HistoryWindowBar
            value={windowId}
            onChange={(id) => setWindowParam(id === '24h' ? null : id)}
            custom={custom}
            onCustomChange={(w) => setCustomParam(encodeCustomWindow(w))}
            compare={compare}
            onCompareChange={(on) => setCompareParam(on ? '1' : null)}
          />
          {hiddenCount > 0 && (
            <Button variant="ghost" size="sm" onClick={showAllHidden} disabled={!panels.writable}>
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              {t(
                'uiLibrary.history.showHidden',
                { one: 'Show {{count}} hidden chart', other: 'Show {{count}} hidden charts' },
                { count: hiddenCount },
              )}
            </Button>
          )}
        </div>
      )}
      {visible.map((section) => {
        const open = !collapsed.has(section.id)
        return (
          <CollapsibleCard
            key={section.id}
            expanded={open}
            onExpandedChange={(next) =>
              setCollapsed((prev) => {
                const s = new Set(prev)
                if (next) s.delete(section.id)
                else s.add(section.id)
                return s
              })
            }
            header={
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-semibold text-foreground truncate">
                  {humanizeName(section.name)}
                </span>
                <span className="text-[10px] text-foreground-subtle shrink-0">
                  {t(
                    'uiLibrary.history.chartCount',
                    { one: '{{count}} chart', other: '{{count}} charts' },
                    { count: section.charts.length },
                  )}
                </span>
              </div>
            }
          >
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
              {section.charts.map((spec) => (
                <HistoryChart
                  key={spec.id}
                  spec={spec}
                  entryFor={entryFor}
                  reads={readsData}
                  window={range}
                  compare={compare}
                  syncKey={syncKey}
                  actions={
                    <KebabMenu
                      title={t('uiLibrary.history.chartMenu', 'Chart actions')}
                      items={[
                        {
                          id: 'open',
                          label: t('uiLibrary.history.openInHistory', 'Open in History'),
                          icon: LineChart,
                          onClick: () =>
                            navigate(historyPageHref(refsOf(deviceId, spec), windowId)),
                        },
                        {
                          id: 'hide',
                          label: t('uiLibrary.history.hide', 'Hide'),
                          icon: EyeOff,
                          hidden: fixedWindow !== undefined,
                          disabled: !panels.writable,
                          onClick: () => setHidden(spec.id, true),
                        },
                      ]}
                    />
                  }
                />
              ))}
            </div>
          </CollapsibleCard>
        )
      })}
    </div>
  )
}

function HistorySkeleton(): JSX.Element {
  return (
    <div className={STACK_GAP} aria-busy="true">
      <Skeleton className="h-7 w-72" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}
