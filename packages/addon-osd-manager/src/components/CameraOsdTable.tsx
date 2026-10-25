/**
 * Cameras section — DataTable + ItemFormDialog (managed-list contract).
 * Row click / Edit opens the slot editor; Save in the dialog footer writes
 * every layer. Render now / Duplicate into are table actions.
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  Button,
  DataTable,
  DataTableFilterBar,
  useDataTableFilter,
  useItemFormUrl,
  useUrlQueryParam,
  type DataColumn,
  type PickerDevice,
} from '@camstack/ui-library'
import type { OsdNamedTemplate } from '@camstack/types'
import {
  parseSlotContentPanel,
  type OsdCameraRow,
  type SlotContentPanel,
} from '../ui/osd-page-model.js'
import { useT } from '../i18n/index.js'
import { DuplicateIntoAction } from './DuplicateIntoAction.js'
import {
  CameraOsdDetail,
  CameraOsdSourcesCell,
  CameraOsdStatusCell,
  CameraRenderNowButton,
} from './CameraOsdRow.js'

interface CameraOsdTableProps {
  readonly cameras: readonly { readonly id: number; readonly name: string }[]
  readonly osdCapableIds: ReadonlySet<number>
  readonly allDevices: readonly { readonly id: number; readonly name: string }[]
  readonly pickerDevices: readonly PickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  readonly templates: readonly OsdNamedTemplate[]
}

export function CameraOsdTable({
  cameras,
  osdCapableIds,
  allDevices,
  pickerDevices,
  listState,
  templates,
}: CameraOsdTableProps) {
  const { t } = useT()
  const filterLabels = {
    searchPlaceholder: t('table.searchCameras'),
    searchLabel: t('table.searchCameras'),
    facetsLabel: t('table.capability'),
    clearLabel: t('table.clearFilters'),
  }
  const capableFacet = t('table.facetCapable')
  const formUrl = useItemFormUrl({ editKey: 'device' })
  const [slotParam, setSlotParam] = useUrlQueryParam('slot')
  const [panelParam, setPanelParam] = useUrlQueryParam('panel')
  const contentPanel = parseSlotContentPanel(panelParam)
  const setContentPanel = (next: SlotContentPanel): void => {
    setPanelParam(next === 'layer' ? null : next)
  }
  const refetchers = useRef(new Map<number, () => void>())
  const seededCapability = useRef(false)

  const deviceNameById = useMemo(
    () => new Map(allDevices.map((device) => [device.id, device.name])),
    [allDevices],
  )
  const templateNameById = useMemo(() => new Map(templates.map((t) => [t.id, t.name])), [templates])

  const items = useMemo(
    (): readonly OsdCameraRow[] =>
      cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        supportsOsd: osdCapableIds.has(camera.id),
      })),
    [cameras, osdCapableIds],
  )

  const filter = useDataTableFilter(items, {
    searchText: (row) => [row.name],
    facetValue: (row) => (row.supportsOsd ? capableFacet : t('table.facetUnsupported')),
  })

  useEffect(() => {
    if (seededCapability.current) return
    if (!filter.facets.some((facet) => facet.value === capableFacet)) return
    seededCapability.current = true
    if (!filter.state.facets.includes(capableFacet)) {
      filter.toggleFacet(capableFacet)
    }
  }, [filter.facets, filter.state.facets, filter.toggleFacet, capableFacet])

  function registerRefetch(deviceId: number, refetch: () => void) {
    refetchers.current.set(deviceId, refetch)
  }

  function refetchCamera(deviceId: number) {
    refetchers.current.get(deviceId)?.()
  }

  function closeEditor() {
    formUrl.close()
    setSlotParam(null)
    setPanelParam(null)
  }

  const editingId =
    formUrl.state.mode === 'edit' && /^\d+$/.test(formUrl.state.id)
      ? Number(formUrl.state.id)
      : undefined
  const editingCamera =
    editingId !== undefined ? (items.find((camera) => camera.id === editingId) ?? null) : null

  useEffect(() => {
    if (formUrl.state.mode !== 'edit') return
    if (editingCamera !== null) return
    closeEditor()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formUrl.state, editingCamera])

  const columns = useMemo(
    (): DataColumn<OsdCameraRow>[] => [
      {
        key: 'camera',
        header: t('table.camera'),
        sortValue: (camera) => camera.name,
        render: (camera) => <span className="font-medium text-foreground">{camera.name}</span>,
      },
      {
        key: 'status',
        header: t('table.status'),
        notSortableReason: t('table.liveProbe'),
        render: (camera) => (
          <CameraOsdStatusCell
            cameraId={camera.id}
            supportsOsd={camera.supportsOsd}
            onRefetchReady={registerRefetch}
          />
        ),
      },
      {
        key: 'sources',
        header: t('table.activeSources'),
        notSortableReason: t('table.liveProbe'),
        nowrap: true,
        render: (camera) => (
          <CameraOsdSourcesCell
            cameraId={camera.id}
            supportsOsd={camera.supportsOsd}
            deviceNameById={deviceNameById}
            templateNameById={templateNameById}
          />
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        notSortableReason: t('table.rowActions'),
        nowrap: true,
        render: (camera) => (
          <div className="flex justify-end gap-1">
            <CameraRenderNowButton
              cameraId={camera.id}
              supportsOsd={camera.supportsOsd}
              onRendered={() => refetchCamera(camera.id)}
            />
            {camera.supportsOsd ? (
              <DuplicateIntoAction
                source={camera}
                destinations={items.filter(
                  (candidate) => candidate.id !== camera.id && candidate.supportsOsd,
                )}
                onDuplicated={(destinationId) => refetchCamera(destinationId)}
              />
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={t('table.editAria', { name: camera.name })}
              onClick={(event) => {
                event.stopPropagation()
                formUrl.openEdit(String(camera.id))
              }}
            >
              {t('common.edit')}
            </Button>
          </div>
        ),
      },
    ],
    [deviceNameById, formUrl, items, templateNameById, t],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="osd-cameras">
      <div className="shrink-0">
        <DataTableFilterBar
          state={filter.state}
          facets={filter.facets}
          labels={filterLabels}
          onSearch={filter.setSearch}
          onToggleFacet={filter.toggleFacet}
          onClear={filter.clear}
        />
      </div>

      <DataTable
        columns={columns}
        rows={filter.rows}
        rowKey={(row) => row.id}
        pageSize={25}
        fill
        emptyMessage={filter.active ? t('table.noMatch') : t('table.noCameras')}
        onRowClick={(row) => formUrl.openEdit(String(row.id))}
        defaultSort={{ columnKey: 'camera', dir: 'asc' }}
      />

      {editingCamera !== null ? (
        <CameraOsdDetail
          camera={editingCamera}
          pickerDevices={pickerDevices}
          listState={listState}
          templates={templates}
          onRefetchReady={registerRefetch}
          activeSlotId={slotParam}
          onActiveSlotIdChange={setSlotParam}
          contentPanel={contentPanel}
          onContentPanelChange={setContentPanel}
          onClose={closeEditor}
        />
      ) : null}
    </div>
  )
}
