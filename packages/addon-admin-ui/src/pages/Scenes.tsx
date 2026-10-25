/**
 * Scenes section of Library — every scene on every camera, ordered by urgency.
 *
 * Formerly the standalone `/scenes` page. Chrome lives on `Library.tsx`; this
 * file is the body only.
 *
 * ## Why this is not a camera tab any more
 *
 * Scene monitoring shipped as a `deviceConfig` widget: a "Scenes" tab inside one
 * camera's detail page. That is the wrong altitude for the thing. A scene is a
 * standing question about the PROPERTY — "is the bin still out", "is the gate
 * still shut" — and the operator's question is *"which of my scenes have
 * tripped"*, across every camera at once. Buried one camera deep, that question
 * could not be asked at all, and the feature could not even be found by someone
 * who had not been told where to look.
 *
 * So: a table of every scene on every camera, ordered by urgency
 * (`scenes.helpers.ts` owns that order and is tested), and the camera is chosen
 * INSIDE the create flow rather than being the way you got here.
 *
 * ## What is reused, and what is new
 *
 * The per-camera editor — still frame, rectangle, per-variant captures, reset,
 * coverage line — is `SceneMonitorEditor` from `@camstack/ui-library`, unchanged
 * apart from losing its panel chrome. It is now imported directly instead of
 * being resolved through `HOST_WIDGETS`, and the widget id was removed in the
 * same commit as the cap's `deviceConfig` so that
 * `scripts/check-host-widget-resolves.ts` stays green in both directions.
 *
 * New here is only the cross-camera part: the fan-out (`useScenesFeed`), the
 * ordering, and the table — plus the shared admin filter bar over that table.
 *
 * Create / open use `ItemFormDialog` + `useItemFormUrl` (`?new=1` for the
 * camera picker, `?edit=<deviceId>` for the editor). Create and edit share the
 * editor on purpose: it already owns the draw / name / create flow.
 */
import type { SceneMonitor } from '@camstack/types'
import {
  Badge,
  Button,
  badgeFor,
  Card,
  coverageLine,
  type DataColumn,
  DataTable,
  DataTableFilterBar,
  humanDuration,
  ItemFormDialog,
  SceneMonitorEditor,
  Select,
  statusLine,
  TABLE_SCROLL_MAX_H,
  useDataTableFilter,
  useDeviceManagerListAll,
  useItemFormUrl,
} from '@camstack/ui-library'
import { Camera, Plus } from 'lucide-react'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useScenesFeed } from '../hooks/use-scenes-feed.js'
import { buildSceneRows, lastTransitionAt, type SceneRow } from './scenes.helpers.js'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n/index'

const BADGE_VARIANT: Readonly<
  Record<'alarm' | 'ok' | 'unknown', 'danger' | 'success' | 'default'>
> = {
  alarm: 'danger',
  ok: 'success',
  unknown: 'default',
}

const STATE_FACET_LABEL: Readonly<Record<string, string>> = {
  alarm: 'Alarm',
  ok: 'OK',
  unknown: 'Unknown',
}

function transitionCell(monitor: SceneMonitor, now: number): string {
  const at = lastTransitionAt(monitor)
  return at === null
    ? '—'
    : i18n.t('scenes.transitionAgo', { duration: humanDuration(Math.max(0, now - at)) })
}

function sceneStateTone(row: SceneRow): string {
  return badgeFor(row.monitor).tone
}

function parseDeviceId(raw: string): number | null {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function ScenesPage() {
  const { t } = useTranslation()
  // Same input as the other camera-roster reads (Retrain.tsx,
  // detection-intelligence, recordings) — one shared cache entry. The window
  // that makes the sharing real is registered on the query client, not here:
  // staleTime is per-OBSERVER, so 26 call sites owning it meant 26 chances to
  // disagree (D274).
  const camerasQuery = useDeviceManagerListAll({
    isCamera: true,
    projection: 'slim',
  })
  const cameras = useMemo(
    () =>
      (camerasQuery.data ?? [])
        .map((d) => ({ deviceId: d.id, deviceName: d.name }))
        .sort((a, b) => a.deviceName.localeCompare(b.deviceName)),
    [camerasQuery.data],
  )
  const deviceIds = useMemo(() => cameras.map((c) => c.deviceId), [cameras])

  const feed = useScenesFeed(deviceIds)
  const rows = useMemo(() => buildSceneRows(cameras, feed.results), [cameras, feed.results])
  const filter = useDataTableFilter(rows, {
    searchText: (row) => [row.monitor.label, row.deviceName],
    facetValue: sceneStateTone,
  })

  const { state: formUrl, openNew, openEdit, close: closeForm } = useItemFormUrl()
  // Local pick while `?new=1` is open — the URL only needs to know "creating"
  // until Continue promotes the choice to `?edit=<deviceId>`.
  const [pickerCamera, setPickerCamera] = useState<number | null>(null)

  useEffect(() => {
    if (formUrl.mode === 'new') {
      setPickerCamera((prev) => prev ?? deviceIds[0] ?? null)
      return
    }
    setPickerCamera(null)
  }, [formUrl.mode, deviceIds])

  const editing = formUrl.mode === 'edit' ? parseDeviceId(formUrl.id) : null
  const editingName =
    editing === null
      ? ''
      : (cameras.find((c) => c.deviceId === editing)?.deviceName ?? `#${editing}`)

  const now = Date.now()

  const columns: readonly DataColumn<SceneRow>[] = [
    {
      key: 'label',
      header: t('scenes.scene', 'Scene'),
      sortValue: (row) => row.monitor.label,
      render: (row) => <span className="font-medium">{row.monitor.label}</span>,
    },
    {
      key: 'camera',
      header: t('scenes.camera', 'Camera'),
      nowrap: true,
      sortValue: (row) => row.deviceName,
      render: (row) => row.deviceName,
    },
    {
      key: 'state',
      header: t('scenes.state', 'State'),
      nowrap: true,
      sortValue: (row) => sceneStateTone(row),
      render: (row) => {
        const badge = badgeFor(row.monitor)
        return <Badge variant={BADGE_VARIANT[badge.tone]}>{badge.text}</Badge>
      },
    },
    {
      key: 'status',
      header: t('scenes.whatItSays', 'What it says'),
      notSortableReason: 'Status is a live sentence, not a comparable value',
      render: (row) => (
        <span className="text-xs text-foreground-muted">{statusLine(row.monitor, now)}</span>
      ),
    },
    {
      key: 'coverage',
      header: t('scenes.variants', 'Variants'),
      notSortableReason: 'Coverage is a summary string',
      render: (row) => (
        <span className="text-xs text-foreground-muted">{coverageLine(row.monitor)}</span>
      ),
    },
    {
      key: 'transition',
      header: t('scenes.lastChange', 'Last change'),
      align: 'right',
      nowrap: true,
      sortValue: (row) => lastTransitionAt(row.monitor) ?? 0,
      render: (row) => (
        <span className="text-xs tabular-nums text-foreground-muted">
          {transitionCell(row.monitor, now)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      nowrap: true,
      notSortableReason: 'Actions',
      render: (row) => (
        <Button variant="ghost" onClick={() => openEdit(String(row.deviceId))}>
          {t('scenes.open', 'Open')}
        </Button>
      ),
    },
  ]

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <p className="text-xs text-foreground-subtle">
          {t(
            'scenes.aSceneWatchesOneRegion',
            'A scene watches one region of one camera and tells you when it stops looking like the picture you captured — a wheelie bin, a gate, a parking space.',
          )}
        </p>
        <Button onClick={openNew} disabled={cameras.length === 0} className="shrink-0">
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('scenes.newScene', 'New scene')}
        </Button>
      </div>

      {feed.unreachableCount > 0 ? (
        <p className="text-xs text-warning">
          {t('scenes.unreachable', { count: feed.unreachableCount })}
        </p>
      ) : null}

      {(rows.length > 0 || filter.active) && (
        <DataTableFilterBar
          state={filter.state}
          facets={filter.facets}
          labels={{
            searchPlaceholder: 'Search scenes…',
            searchLabel: 'Search scenes',
            facetsLabel: 'State',
            clearLabel: 'Clear',
          }}
          facetLabel={(value) => STATE_FACET_LABEL[value] ?? value}
          onSearch={filter.setSearch}
          onToggleFacet={filter.toggleFacet}
          onClear={filter.clear}
        />
      )}

      <Card variant="flat" className="p-0">
        <DataTable<SceneRow>
          columns={columns}
          rows={filter.rows}
          rowKey={(r) => `${r.deviceId}:${r.monitor.id}`}
          minWidthPx={880}
          bordered={false}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={
            feed.isLoading
              ? t('scenes.loadingScenes', 'Loading scenes…')
              : filter.active
                ? t('scenes.nothingMatchesTheFilter', 'Nothing matches the filter')
                : t(
                    'scenes.noScenesYetPressNew',
                    'No scenes yet. Press “New scene”, pick a camera, then draw a box around the thing you want watched.',
                  )
          }
        />
      </Card>

      {/* Camera picker — the step that used to be implicit in "which camera page
          am I on". It is its own tiny dialog rather than a field inside the
          editor, because the editor needs a deviceId to fetch a snapshot at all. */}
      {formUrl.mode === 'new' ? (
        <ItemFormDialog
          open
          onClose={closeForm}
          title={t('scenes.whichCamera', 'Which camera?')}
          icon={Camera}
          width="sm"
          testId="scenes-camera-picker"
          footer={
            <Button
              onClick={() => {
                if (pickerCamera === null) return
                openEdit(String(pickerCamera))
              }}
              disabled={pickerCamera === null}
            >
              {t('scenes.continue', 'Continue')}
            </Button>
          }
        >
          <p className="mb-3 text-xs text-foreground-subtle">
            {t(
              'scenes.aSceneLivesOnOne',
              'A scene lives on one camera. Pick the one that can see the thing.',
            )}
          </p>
          <Select
            value={pickerCamera === null ? '' : String(pickerCamera)}
            onChange={(e) => setPickerCamera(Number(e.target.value))}
            aria-label={t('scenes.camera', 'Camera')}
            options={cameras.map((c) => ({
              value: String(c.deviceId),
              label: c.deviceName,
            }))}
          />
        </ItemFormDialog>
      ) : null}

      {editing !== null ? (
        <ItemFormDialog
          open
          onClose={closeForm}
          title={t('scenes.scenes', 'Scenes — {{editingName}}', { editingName })}
          icon={Camera}
          width="lg"
          testId="scenes-editor"
        >
          <p className="mb-3 text-xs text-foreground-subtle">
            {t(
              'scenes.drawABoxNameIt',
              'Draw a box, name it, then capture what “normal” looks like. Daylight is enough — the night reference is optional, and “Settings” on each scene tunes how fussy and how often it checks.',
            )}
          </p>
          <Suspense
            fallback={
              <p className="text-xs text-foreground-muted">
                {t('scenes.loadingTheEditor', 'Loading the editor…')}
              </p>
            }
          >
            <SceneMonitorEditor deviceId={editing} />
          </Suspense>
        </ItemFormDialog>
      ) : null}
    </section>
  )
}
