/**
 * System → History (`/system/history`, D899): any recorded series of any
 * device, node or storage location, overlaid on one window.
 *
 * Left: the series picker (search + room / source / unit chips). Right: one
 * overlay — lines with a value axis per unit, states as timelines, energy as
 * stacked bars. The selection and window live in the URL (`?s=` repeated,
 * `?window=`); a saved panel (name + selection + window) lives in the user's
 * ACCOUNT preferences (`admin.history-panels`, D894). Four built-in panels
 * are computed from what the hub records right now.
 *
 * device-history not installed, the catalogue not answered yet, and nothing
 * recorded are three different screens (D315). Series no longer linked to a
 * device are flagged on top, from an answered list only (D917).
 */
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { DeviceType, parseOccupancyScope, type DeviceHistorySeriesInfo } from '@camstack/types'
import {
  Button,
  EmptyState,
  ErrorBox,
  HistoryWindowBar,
  OCCUPANCY_KEY,
  SectionCard,
  Skeleton,
  decodeCustomWindow,
  decodeSeriesRef,
  encodeCustomWindow,
  encodeSeriesRef,
  isHistoryWindowId,
  normalizeSelection,
  resolveHistoryWindow,
  anchorNow,
  seriesRefId,
  useCapabilityPresence,
  useClusterNodes,
  useConfirm,
  useDeviceManagerListAll,
  useHistoryPanels,
  usePrompt,
  useStorageListLocations,
  useSystem,
  withPanel,
  withoutPanel,
  type HistorySeriesRef,
  type HistoryWindowId,
} from '@camstack/ui-library'
import { History as HistoryIcon, LineChart, Save, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AdminPage } from '../../components/AdminPage'
import { HistoryOverlay } from '../../components/history/HistoryOverlay'
import { OrphanSeriesNotice } from '../../components/history/OrphanSeriesNotice'
import {
  BUILT_IN_PANELS,
  buildCatalog,
  builtInSelection,
  splitOverlay,
  type BuiltInPanelId,
  type SeriesCandidate,
} from '../../components/history/history-page-model'
import { SeriesPicker } from '../../components/history/SeriesPicker'

const NOT_RECORDED: ReadonlySet<string> = new Set([DeviceType.Hub, DeviceType.Container])
const LIST_STALE_MS = 5 * 60_000

export function HistoryPage() {
  const { t } = useTranslation()
  const presence = useCapabilityPresence('device-history')
  const [params, setParams] = useSearchParams()
  const selection = useMemo(
    () =>
      normalizeSelection(
        params.getAll('s').flatMap((raw) => {
          const r = decodeSeriesRef(raw)
          return r === null ? [] : [r]
        }),
      ),
    [params],
  )
  const windowParam = params.get('window')
  const windowId: HistoryWindowId = isHistoryWindowId(windowParam) ? windowParam : '7d'
  const custom = decodeCustomWindow(params.get('range'))

  const write = (
    refs: readonly HistorySeriesRef[],
    win: HistoryWindowId,
    range?: string | null,
  ) => {
    const next = new URLSearchParams()
    for (const r of normalizeSelection(refs)) next.append('s', encodeSeriesRef(r))
    if (win !== '7d') next.set('window', win)
    const rangeValue = range === undefined ? params.get('range') : range
    if (win === 'custom' && rangeValue) next.set('range', rangeValue)
    setParams(next, { replace: true })
  }

  const catalog = useHistoryCatalog(presence === 'present')
  const spanGuess = resolveHistoryWindow(windowId, Date.now(), custom)
  const range = resolveHistoryWindow(
    windowId,
    anchorNow(Date.now(), spanGuess.to - spanGuess.from),
    custom,
  )
  const part = useMemo(
    () => splitOverlay(selection, catalog.candidates),
    [selection, catalog.candidates],
  )
  const selectedIds = useMemo(() => new Set(selection.map(seriesRefId)), [selection])

  const panels = useHistoryPanels()
  const prompt = usePrompt()
  const confirm = useConfirm()
  const savePanel = async (): Promise<void> => {
    const name = await prompt({
      title: t('history.page.saveTitle', 'Save as panel'),
      label: t('history.page.saveName', 'Panel name'),
      confirmLabel: t('history.page.save', 'Save'),
    })
    if (name === null || name.trim() === '') return
    await panels.update((v) =>
      withPanel(v, {
        id: `panel-${Date.now().toString(36)}`,
        name: name.trim().slice(0, 80),
        window: windowId,
        selection: [...selection],
      }),
    )
  }
  const deletePanel = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: t('history.page.deleteTitle', 'Delete panel'),
      message: t(
        'history.page.deleteMessage',
        'The panel "{{name}}" is removed from your account.',
        { name },
      ),
      confirmLabel: t('history.page.delete', 'Delete'),
      variant: 'danger',
    })
    if (ok) await panels.update((v) => withoutPanel(v, id))
  }

  const builtInLabel = (id: BuiltInPanelId): string =>
    id === 'energy'
      ? t('history.panels.energy', 'Total energy')
      : id === 'temperatures'
        ? t('history.panels.temperatures', 'Temperatures by room')
        : id === 'nodes'
          ? t('history.panels.nodes', 'Cluster nodes')
          : t('history.panels.storage', 'Storage locations')

  return (
    <AdminPage
      icon={LineChart}
      title={t('history.page.title', 'History')}
      subtitle={t(
        'history.page.subtitle',
        'What devices, nodes and storage recorded over time, side by side.',
      )}
      actions={
        presence === 'present' ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void savePanel()}
            disabled={selection.length === 0 || !panels.writable}
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            {t('history.page.saveTitle', 'Save as panel')}
          </Button>
        ) : undefined
      }
    >
      {presence === 'pending' ? (
        <Skeleton className="h-64 w-full" />
      ) : presence === 'unknown' ? (
        <ErrorBox
          title={t('history.page.presenceUnknownTitle', 'Could not reach the hub')}
          message={t(
            'history.page.presenceUnknown',
            'The hub did not say whether device history is installed. Try again in a moment.',
          )}
        />
      ) : presence === 'absent' ? (
        <EmptyState
          icon={HistoryIcon}
          title={t('history.page.absentTitle', 'Device history is not running on this hub')}
          description={t(
            'history.page.absent',
            'Nothing is recorded until the device-history system addon is enabled.',
          )}
        />
      ) : (
        <div className="space-y-3 sm:space-y-4">
          <OrphanSeriesNotice enabled={presence === 'present'} />
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label={t('history.page.panels', 'Panels')}
          >
            {BUILT_IN_PANELS.map((id) => (
              <Button
                key={id}
                size="sm"
                variant="outline"
                disabled={catalog.status !== 'ok'}
                onClick={() => write(builtInSelection(id, catalog.candidates), windowId)}
              >
                {builtInLabel(id)}
              </Button>
            ))}
            {panels.value.panels.map((p) => (
              <span key={p.id} className="inline-flex items-center">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => write(p.selection, p.window, null)}
                >
                  {p.name}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('history.page.deleteNamed', 'Delete panel {{name}}', {
                    name: p.name,
                  })}
                  onClick={() => void deletePanel(p.id, p.name)}
                  disabled={!panels.writable}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </span>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-5">
            <div className="min-w-0 xl:col-span-2">
              <SectionCard headingId="history-picker" title={t('history.picker.title', 'Series')}>
                <div className="p-2 sm:p-3">
                  {catalog.status === 'error' ? (
                    <ErrorBox message={catalog.error} />
                  ) : (
                    <SeriesPicker
                      catalog={catalog.candidates}
                      loading={catalog.status === 'pending'}
                      selected={selectedIds}
                      onChange={(next) => {
                        const kept = selection.filter((r) => next.has(seriesRefId(r)))
                        const added = catalog.candidates
                          .filter((c) => next.has(c.id) && !selectedIds.has(c.id))
                          .map((c) => c.ref)
                        write([...kept, ...added], windowId)
                      }}
                    />
                  )}
                </div>
              </SectionCard>
            </div>
            <div className="min-w-0 xl:col-span-3">
              <SectionCard
                headingId="history-overlay"
                title={t('history.page.overlay', 'Overlay')}
                actions={
                  selection.length > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => write([], windowId)}>
                      {t('history.page.clear', 'Clear')}
                    </Button>
                  ) : undefined
                }
              >
                <div className="p-2 sm:p-3 space-y-3 min-w-0">
                  <HistoryWindowBar
                    value={windowId}
                    onChange={(id) => write(selection, id)}
                    custom={custom}
                    onCustomChange={(w) => write(selection, 'custom', encodeCustomWindow(w))}
                  />
                  {catalog.status === 'pending' && selection.length > 0 ? (
                    <Skeleton className="h-64 w-full" />
                  ) : (
                    <HistoryOverlay part={part} window={range} />
                  )}
                  {part.missing.length > 0 && catalog.status === 'ok' && (
                    <p className="text-[11px] text-foreground-subtle">
                      {t('history.page.missing', {
                        count: part.missing.length,
                        defaultValue_one: '{{count}} selected series is no longer recorded.',
                        defaultValue_other: '{{count}} selected series are no longer recorded.',
                      })}
                    </p>
                  )}
                </div>
              </SectionCard>
            </div>
          </div>
        </div>
      )}
    </AdminPage>
  )
}

interface HistoryCatalog {
  readonly status: 'pending' | 'error' | 'ok'
  readonly error: string
  readonly candidates: readonly SeriesCandidate[]
}

/**
 * Every real device's and every node's series. One `listSeries` per device
 * (a registry read on the hub), cached five minutes; a device whose read
 * failed is left out and the failure is reported, never an empty device.
 */
function useHistoryCatalog(enabled: boolean): HistoryCatalog {
  const { t } = useTranslation()
  const wholeFrame = t('history.picker.wholeFrame', 'Whole frame')
  const client = useSystem().trpcClient
  // The fleet-list window is the query client's (ui-library fleet-query-defaults).
  const devicesQ = useDeviceManagerListAll({ projection: 'slim' }, { enabled })
  const { nodes } = useClusterNodes()
  const devices = useMemo(
    () => (devicesQ.data ?? []).filter((d) => !NOT_RECORDED.has(String(d.type))),
    [devicesQ.data],
  )
  const deviceQs = useQueries({
    queries: devices.map((d) => ({
      queryKey: ['device-history', 'listSeries', d.id],
      queryFn: () => client.deviceHistory.listSeries.query({ deviceId: d.id }),
      enabled,
      staleTime: LIST_STALE_MS,
    })),
  })
  const nodeQs = useQueries({
    queries: nodes.map((n) => ({
      queryKey: ['device-history', 'listNodeSeries', n.id],
      queryFn: () => client.deviceHistory.listNodeSeries.query({ forNodeId: n.id }),
      enabled,
      staleTime: LIST_STALE_MS,
    })),
  })
  const locationsQ = useStorageListLocations({}, { enabled, staleTime: LIST_STALE_MS })
  const locationNames = useMemo(
    () => new Map((locationsQ?.data ?? []).map((l) => [l.id, l.displayName] as const)),
    [locationsQ?.data],
  )
  const deviceData = deviceQs.map((q) => q.data)
  const nodeData = nodeQs.map((q) => q.data)
  const answeredAt = [...deviceQs, ...nodeQs].map((q) => q.dataUpdatedAt).join(',')
  const candidates = useMemo(() => {
    const ds = devices.flatMap((d, i) => {
      const series: readonly DeviceHistorySeriesInfo[] | undefined = deviceData[i]
      return series === undefined
        ? []
        : [{ device: { id: d.id, name: d.name, location: d.location ?? null }, series }]
    })
    const ns = nodes.flatMap((n, i) => {
      const series: readonly DeviceHistorySeriesInfo[] | undefined = nodeData[i]
      return series === undefined ? [] : [{ node: { id: n.id, name: n.name }, series }]
    })
    return buildCatalog(ds, ns, (info) => {
      if (info.key !== OCCUPANCY_KEY) return locationNames.get(info.scope) ?? info.scope
      const { zoneId, className } = parseOccupancyScope(info.scope)
      const zone = zoneId === '' ? wholeFrame : zoneId
      return className === undefined ? zone : `${zone} · ${className}`
    })
    // `deviceData` / `nodeData` are fresh arrays per render; `answeredAt`
    // changes exactly when one of React Query's answers does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, nodes, locationNames, answeredAt, wholeFrame])
  if (devicesQ.status === 'error')
    return { status: 'error', error: devicesQ.error.message, candidates: [] }
  const pending =
    devicesQ.status === 'pending' ||
    deviceQs.some((q) => q.isPending) ||
    nodeQs.some((q) => q.isPending)
  return { status: pending ? 'pending' : 'ok', error: '', candidates }
}
