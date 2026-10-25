/**
 * Frames tab — corpus-first curation surface.
 *
 * Layout (top → bottom): KPI → Collections → Filter bar + Export → Grid +
 * pagination. Thumbnail click opens the annotation overlay (RetrainWorkbench).
 *
 * The open frame lives in the URL (`?frame=<id>`, next to the filter keys): the
 * overlay opens from it, a reload keeps it, and ← / → walk the whole filtered
 * corpus — past the end of a page the next page is fetched and its first frame
 * opens.
 */
import type { RetrainCollection, RetrainCorpusFilter, RetrainFrame } from '@camstack/types'
import {
  deviceListStateOf,
  useDeviceManagerListAll,
  usePersistedPageSize,
  usePipelineAnalyticsCreateRetrainCollection,
  usePipelineAnalyticsDeleteRetrainCollection,
  usePipelineAnalyticsGetRetrainCorpusKpi,
  usePipelineAnalyticsListRetrainCollections,
  usePipelineAnalyticsListRetrainCorpusPage,
  usePipelineAnalyticsRenameRetrainCollection,
  type PickerItem,
} from '@camstack/ui-library'
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { CorpusAnnotateOverlay } from './CorpusAnnotateOverlay.js'
import { useT } from '../../i18n/index.js'
import { CorpusCollectionsSection, collectionRefusalText } from './CorpusCollectionsSection.js'
import { CorpusFilterBar } from './CorpusFilterBar.js'
import { CorpusFrameGrid } from './CorpusFrameGrid.js'
import { CorpusKpiBar } from './CorpusKpiBar.js'
import { readFrameParam, replaceFrameInUrl } from './frame-url.js'
import { edgeFrameId, lastPageOf, stepTarget } from './lib/retrain-frame-step.js'
import {
  corpusFilterFromSearchParams,
  replaceCorpusFilterInUrl,
  type CorpusUrlFilter,
} from './corpus-filter-url.js'

const CORPUS_PAGE_SIZES = [25, 50, 100] as const

function readUrlFilter(): CorpusUrlFilter {
  if (typeof window === 'undefined') {
    return {
      workState: undefined,
      deviceIds: [],
      collectionId: undefined,
      classes: [],
      page: 1,
    }
  }
  return corpusFilterFromSearchParams(new URLSearchParams(window.location.search))
}

function toListInput(filter: CorpusUrlFilter, pageSize: number): RetrainCorpusFilter {
  return {
    page: filter.page,
    pageSize,
    ...(filter.workState !== undefined ? { workState: filter.workState } : {}),
    ...(filter.deviceIds.length > 0 ? { deviceIds: [...filter.deviceIds] } : {}),
    ...(filter.collectionId !== undefined ? { collectionId: filter.collectionId } : {}),
    ...(filter.classes.length > 0 ? { classes: [...filter.classes] } : {}),
  }
}

export function FramesSection(): JSX.Element {
  const { t } = useT()
  const [filter, setFilterState] = useState<CorpusUrlFilter>(readUrlFilter)
  const [pageSize, setPageSize] = usePersistedPageSize({
    storageKey: 'training-corpus-page-size',
    options: CORPUS_PAGE_SIZES,
    defaultSize: 50,
  })
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : readFrameParam(window.location.search),
  )
  /** A step crossed a page boundary: open this edge frame once that page has loaded. */
  const [pendingEdge, setPendingEdge] = useState<{
    readonly page: number
    readonly edge: 'first' | 'last'
  } | null>(null)

  const setFilter = useCallback((next: CorpusUrlFilter) => {
    setFilterState(next)
    replaceCorpusFilterInUrl(next)
  }, [])

  const devices = useDeviceManagerListAll({ projection: 'slim', isCamera: true })
  const deviceNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of devices.data ?? []) map.set(d.id, d.name)
    return map
  }, [devices.data])

  const cameraItems = useMemo((): readonly PickerItem<number>[] => {
    return (devices.data ?? []).map(
      (d): PickerItem<number> => ({
        id: d.id,
        name: d.name,
        type: d.type,
        location: typeof d.location === 'string' ? d.location : null,
      }),
    )
  }, [devices.data])
  const camerasListState = deviceListStateOf(devices)

  const kpiQuery = usePipelineAnalyticsGetRetrainCorpusKpi({})
  const listQuery = usePipelineAnalyticsListRetrainCorpusPage(toListInput(filter, pageSize))
  const collectionsQuery = usePipelineAnalyticsListRetrainCollections({})
  const createCollection = usePipelineAnalyticsCreateRetrainCollection()
  const renameCollection = usePipelineAnalyticsRenameRetrainCollection()
  const deleteCollection = usePipelineAnalyticsDeleteRetrainCollection()

  // If the current page is past the last page after a filter change, clamp.
  useEffect(() => {
    const total = listQuery.data?.total
    if (total === undefined) return
    const lastPage = Math.max(1, Math.ceil(total / pageSize))
    if (filter.page > lastPage) {
      setFilter({ ...filter, page: lastPage })
    }
  }, [listQuery.data?.total, pageSize, filter, setFilter])

  const onSelectCameraFromKpi = useCallback(
    (deviceId: number) => {
      setFilter({ ...filter, deviceIds: [deviceId], page: 1 })
    },
    [filter, setFilter],
  )

  const onCreateCollection = useCallback(
    async (name: string): Promise<string | null> => {
      const result = await createCollection.mutateAsync({ name })
      await collectionsQuery.refetch()
      if (result.kind === 'refused') return collectionRefusalText(t, result.reason)
      setFilter({ ...filter, collectionId: result.collection.id, page: 1 })
      return null
    },
    [createCollection, collectionsQuery, filter, setFilter, t],
  )

  const onRenameCollection = useCallback(
    async (id: string, name: string): Promise<string | null> => {
      const result = await renameCollection.mutateAsync({ id, name })
      await collectionsQuery.refetch()
      if (result.kind === 'refused') return collectionRefusalText(t, result.reason)
      return null
    },
    [renameCollection, collectionsQuery, t],
  )

  const onDeleteCollection = useCallback(
    async (id: string): Promise<void> => {
      await deleteCollection.mutateAsync({ id })
      if (filter.collectionId === id) {
        setFilter({ ...filter, collectionId: undefined, page: 1 })
      }
      await collectionsQuery.refetch()
    },
    [deleteCollection, collectionsQuery, filter, setFilter],
  )

  const openFrame = useCallback((frameId: string | null) => {
    setSelectedFrameId(frameId)
    replaceFrameInUrl(frameId)
  }, [])

  const onOpenFrame = useCallback(
    (frameId: string) => {
      openFrame(frameId)
    },
    [openFrame],
  )

  const onCloseOverlay = useCallback(() => {
    setPendingEdge(null)
    openFrame(null)
  }, [openFrame])

  // Corpus page frames extend RetrainFrame with workState; the workbench only
  // needs the wire shape. Extra fields are fine at runtime.
  const workbenchFrames: readonly RetrainFrame[] = listQuery.data?.frames ?? []

  const refetchCorpus = useCallback(async () => {
    await Promise.all([listQuery.refetch(), kpiQuery.refetch()])
  }, [listQuery, kpiQuery])

  const frameIds = useMemo(() => workbenchFrames.map((f) => f.frameId), [workbenchFrames])
  const total = listQuery.data?.total
  const lastPage = lastPageOf(total ?? 0, pageSize)
  const targetOf = useCallback(
    (step: 1 | -1) =>
      selectedFrameId === null
        ? ({ kind: 'none' } as const)
        : stepTarget(frameIds, selectedFrameId, step, filter.page, lastPage),
    [frameIds, selectedFrameId, filter.page, lastPage],
  )
  const canStep = useCallback((step: 1 | -1) => targetOf(step).kind !== 'none', [targetOf])
  const onStep = useCallback(
    (step: 1 | -1) => {
      const target = targetOf(step)
      if (target.kind === 'frame') {
        openFrame(target.frameId)
      } else if (target.kind === 'page') {
        setPendingEdge({ page: target.page, edge: target.edge })
        setFilter({ ...filter, page: target.page })
      }
    },
    [targetOf, openFrame, setFilter, filter],
  )

  // The page a step asked for has landed: open its edge frame.
  useEffect(() => {
    if (pendingEdge === null || listQuery.isFetching || listQuery.data === undefined) return
    if (listQuery.data.page !== pendingEdge.page) return
    setPendingEdge(null)
    const id = edgeFrameId(
      listQuery.data.frames.map((f) => f.frameId),
      pendingEdge.edge,
    )
    openFrame(id ?? null)
  }, [pendingEdge, listQuery.isFetching, listQuery.data, openFrame])

  // The open frame is not in the answered list (a link to a frame on another
  // page, a filter that no longer holds it): close, rather than wait forever.
  useEffect(() => {
    if (selectedFrameId === null || pendingEdge !== null) return
    if (listQuery.isFetching || listQuery.data === undefined) return
    if (!frameIds.includes(selectedFrameId)) openFrame(null)
  }, [selectedFrameId, pendingEdge, listQuery.isFetching, listQuery.data, frameIds, openFrame])

  const framePosition = (() => {
    const at = selectedFrameId === null ? -1 : frameIds.indexOf(selectedFrameId)
    if (at < 0 || total === undefined) return '…'
    return t('frames.position', { index: (filter.page - 1) * pageSize + at + 1, total })
  })()

  return (
    <div className="space-y-4" data-testid="frames-section">
      <CorpusKpiBar
        kpi={kpiQuery.data}
        isLoading={kpiQuery.isLoading}
        isError={kpiQuery.isError}
        deviceNames={deviceNames}
        onSelectCamera={onSelectCameraFromKpi}
      />

      <CorpusCollectionsSection
        collections={collectionsQuery.data}
        isLoading={collectionsQuery.isLoading}
        selectedId={filter.collectionId ?? null}
        onSelect={(collection: RetrainCollection) => {
          setFilter({ ...filter, collectionId: collection.id, page: 1 })
        }}
        onCreate={onCreateCollection}
        onRename={onRenameCollection}
        onDelete={onDeleteCollection}
      />

      <CorpusFilterBar
        filter={filter}
        onChange={setFilter}
        cameraItems={cameraItems}
        camerasListState={camerasListState}
        collections={collectionsQuery.data}
        collectionsPending={collectionsQuery.isLoading && collectionsQuery.data === undefined}
      />

      <CorpusFrameGrid
        frames={listQuery.data?.frames}
        total={listQuery.data?.total}
        page={filter.page}
        pageSize={pageSize}
        isLoading={listQuery.isLoading}
        isError={listQuery.isError}
        deviceNames={deviceNames}
        onPageChange={(page) => {
          setFilter({ ...filter, page })
        }}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setFilter({ ...filter, page: 1 })
        }}
        onOpenFrame={onOpenFrame}
      />

      {selectedFrameId !== null ? (
        <CorpusAnnotateOverlay
          open
          frames={workbenchFrames}
          activeFrameId={selectedFrameId}
          framePosition={framePosition}
          canStep={canStep}
          onStep={onStep}
          onClose={onCloseOverlay}
          onFramesChanged={refetchCorpus}
          onSaved={refetchCorpus}
        />
      ) : null}
    </div>
  )
}
