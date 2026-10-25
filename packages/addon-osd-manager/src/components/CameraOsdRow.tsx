import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  ErrorBox,
  ItemFormDialog,
  Tabs,
  useOsdManagerGetDeviceOsd,
  useOsdManagerGetSourceCatalog,
  useOsdManagerRenderDevice,
  useOsdManagerSetSlotBinding,
} from '@camstack/ui-library'
import { Loader2, Monitor } from 'lucide-react'
import type {
  OsdNamedTemplate,
  OsdSlotBinding,
  OsdSlotView,
  OsdSourceOption,
} from '@camstack/types'
import type { PickerDevice } from '@camstack/ui-library'
import { useT } from '../i18n/index.js'
import { SlotEditor, SlotEditorTabList } from './SlotEditor.js'
import {
  activeSourceChips,
  cameraOsdStatus,
  cameraStatusLabel,
  cameraStatusTone,
  defaultActiveSlotId,
  dirtySlotBindings,
  draftForSlot,
  type OsdCameraRow,
  type SlotContentPanel,
  slotTabStatus,
  slotTabStatusLabel,
  sourceSummary,
  writableSlots,
} from '../ui/osd-page-model.js'

interface CameraOsdStatusCellProps {
  readonly cameraId: number
  readonly supportsOsd: boolean
  readonly onRefetchReady: (deviceId: number, refetch: () => void) => void
}

/** Collapsed Status column — same query key as the expanded detail. */
export function CameraOsdStatusCell({
  cameraId,
  supportsOsd,
  onRefetchReady,
}: CameraOsdStatusCellProps) {
  const osdQuery = useOsdManagerGetDeviceOsd({ deviceId: cameraId }, { enabled: supportsOsd })

  useEffect(() => {
    if (!supportsOsd) return
    onRefetchReady(cameraId, () => void osdQuery.refetch())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, supportsOsd, osdQuery.refetch])

  if (supportsOsd && osdQuery.isLoading) {
    return <Loader2 className="h-3 w-3 animate-spin text-foreground-subtle" />
  }

  const status = cameraOsdStatus(supportsOsd, osdQuery.data?.slots ?? [])
  return <Badge variant={cameraStatusTone(status)}>{cameraStatusLabel(status)}</Badge>
}

interface CameraOsdSourcesCellProps {
  readonly cameraId: number
  readonly supportsOsd: boolean
  readonly deviceNameById: ReadonlyMap<number, string>
  readonly templateNameById: ReadonlyMap<string, string>
}

/** Collapsed Active-sources column. */
export function CameraOsdSourcesCell({
  cameraId,
  supportsOsd,
  deviceNameById,
  templateNameById,
}: CameraOsdSourcesCellProps) {
  const { t } = useT()
  const osdQuery = useOsdManagerGetDeviceOsd({ deviceId: cameraId }, { enabled: supportsOsd })

  if (!supportsOsd) {
    return <span className="text-xs text-foreground-subtle">{t('row.noWritableOverlays')}</span>
  }

  if (osdQuery.isLoading) {
    return <span className="text-xs text-foreground-subtle">{t('row.loading')}</span>
  }

  const chips = activeSourceChips(osdQuery.data?.slots ?? [], deviceNameById, templateNameById)
  if (chips.length === 0) {
    return <span className="text-xs text-foreground-subtle">{t('row.noActiveSources')}</span>
  }

  // Up to two lines — wrapping Badges used to stretch every row to chip count.
  const label = chips.map((chip) => chip.label).join(' · ')
  return (
    <span
      className="block max-w-[16rem] break-words text-xs text-foreground line-clamp-2"
      title={label}
    >
      {label}
    </span>
  )
}

interface CameraRenderNowButtonProps {
  readonly cameraId: number
  readonly supportsOsd: boolean
  readonly onRendered: () => void
}

/** Table row action — re-render overlays for this camera. */
export function CameraRenderNowButton({
  cameraId,
  supportsOsd,
  onRendered,
}: CameraRenderNowButtonProps) {
  const { t } = useT()
  const renderDevice = useOsdManagerRenderDevice()
  if (!supportsOsd) return null
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      disabled={renderDevice.isPending}
      aria-label={t('row.renderNow')}
      onClick={(event) => {
        event.stopPropagation()
        renderDevice.mutate({ deviceId: cameraId }, { onSuccess: onRendered })
      }}
    >
      {renderDevice.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {t('row.renderNow')}
    </Button>
  )
}

interface CameraOsdDetailProps {
  readonly camera: OsdCameraRow
  readonly pickerDevices: readonly PickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  readonly templates: readonly OsdNamedTemplate[]
  readonly onRefetchReady: (deviceId: number, refetch: () => void) => void
  /** Active slot from the URL (`?slot=`), or null to use the default. */
  readonly activeSlotId: string | null
  readonly onActiveSlotIdChange: (slotId: string | null) => void
  /** Content panel from the URL (`?panel=`), persists across slot changes. */
  readonly contentPanel: SlotContentPanel
  readonly onContentPanelChange: (panel: SlotContentPanel) => void
  readonly onClose: () => void
}

/**
 * Camera OSD dialog: slot strip + Layer/Binding tabs in beforeBody
 * (NC Edit Allarme chrome). Save writes every layer.
 */
export function CameraOsdDetail({
  camera,
  pickerDevices,
  listState,
  templates,
  onRefetchReady,
  activeSlotId: slotFromUrl,
  onActiveSlotIdChange,
  contentPanel,
  onContentPanelChange,
  onClose,
}: CameraOsdDetailProps) {
  const { t } = useT()
  const osdQuery = useOsdManagerGetDeviceOsd(
    { deviceId: camera.id },
    { enabled: camera.supportsOsd },
  )
  const slots = osdQuery.data?.slots ?? []
  const editableSlots = useMemo(() => writableSlots(slots), [slots])
  const activeSlotId = useMemo(() => {
    if (slotFromUrl !== null && editableSlots.some((slot) => slot.slotId === slotFromUrl)) {
      return slotFromUrl
    }
    return defaultActiveSlotId(editableSlots)
  }, [slotFromUrl, editableSlots])
  const activeSlot = editableSlots.find((slot) => slot.slotId === activeSlotId)

  const [drafts, setDrafts] = useState<Readonly<Record<string, OsdSlotBinding>>>({})
  /** Drafts as loaded from the server — Save only writes slots that differ. */
  const [baselineDrafts, setBaselineDrafts] = useState<Readonly<Record<string, OsdSlotBinding>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  const setBinding = useOsdManagerSetSlotBinding()
  const saving = setBinding.isPending

  // Fingerprint server bindings only — never re-seed on a fresh probe object
  // with the same bindings (hooks may return a new `data` every render).
  const bindingSeed = useMemo(() => {
    if (osdQuery.data === undefined) return null
    const writable = writableSlots(osdQuery.data.slots)
    const nextDrafts: Record<string, OsdSlotBinding> = {}
    for (const slot of writable) {
      nextDrafts[slot.slotId] = draftForSlot(slot)
    }
    return {
      key: `${camera.id}:${writable
        .map((slot) => `${slot.slotId}:${JSON.stringify(slot.binding)}`)
        .join('|')}`,
      drafts: nextDrafts,
    }
  }, [camera.id, osdQuery.data])
  const bindingSeedRef = useRef(bindingSeed)
  bindingSeedRef.current = bindingSeed

  useEffect(() => {
    const seed = bindingSeedRef.current
    if (!camera.supportsOsd || seed === null) {
      setDrafts((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      setBaselineDrafts((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      return
    }
    setDrafts(seed.drafts)
    setBaselineDrafts(seed.drafts)
    setSaveError(null)
  }, [camera.supportsOsd, bindingSeed?.key])

  const sourcesQuery = useOsdManagerGetSourceCatalog(
    { deviceId: camera.id },
    { enabled: camera.supportsOsd && activeSlot !== undefined },
  )

  useEffect(() => {
    if (!camera.supportsOsd) return
    onRefetchReady(camera.id, () => void osdQuery.refetch())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, camera.supportsOsd, osdQuery.refetch])

  const pendingWrites = useMemo(
    () =>
      dirtySlotBindings(
        editableSlots.map((slot) => slot.slotId),
        drafts,
        baselineDrafts,
      ),
    [baselineDrafts, drafts, editableSlots],
  )

  const saveAll = useCallback(async (): Promise<void> => {
    setSaveError(null)
    try {
      // Only dirty slots — unbound layers open as `{ kind: 'none' }` drafts;
      // writing those on every Save wiped firmware-only static text.
      for (const { slotId, binding } of pendingWrites) {
        await setBinding.mutateAsync({
          deviceId: camera.id,
          slotId,
          binding,
        })
      }
      setBaselineDrafts(drafts)
      void osdQuery.refetch()
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }, [camera.id, drafts, onClose, osdQuery, pendingWrites, setBinding])

  const canSave = !saving && pendingWrites.length > 0
  const loadError = osdQuery.error ?? sourcesQuery.error

  const body = ((): ReactNode => {
    if (!camera.supportsOsd) {
      return <p className="text-xs text-foreground-subtle">{t('row.noSlotsSupport')}</p>
    }

    if (osdQuery.isLoading) {
      return (
        <div className="flex items-center gap-2 text-xs text-foreground-subtle">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('row.loadingSlots')}
        </div>
      )
    }

    if (loadError) {
      return (
        <ErrorBox message={loadError.message} title={t('row.loadFailed', { name: camera.name })} />
      )
    }

    if (osdQuery.data?.supported && editableSlots.length === 0) {
      return (
        <p className="text-xs text-foreground-subtle">
          {slots.length === 0 ? t('row.noSlotsReported') : t('row.noWritableLayers')}
        </p>
      )
    }

    if (activeSlotId === undefined || activeSlot === undefined) return null

    const activeDraft = drafts[activeSlot.slotId]
    if (activeDraft === undefined) return null

    return (
      <ActiveSlotPanel
        cameraId={camera.id}
        slot={activeSlot}
        binding={activeDraft}
        onBindingChange={(next) =>
          setDrafts((prev) => ({
            ...prev,
            [activeSlot.slotId]: next,
          }))
        }
        sources={sourcesQuery.data?.sources ?? []}
        pickerDevices={pickerDevices}
        listState={listState}
        templates={templates}
        refreshingCurrent={osdQuery.isFetching}
        onRefreshCurrent={() => osdQuery.refetch()}
      />
    )
  })()

  const showSlotStrip =
    camera.supportsOsd && !osdQuery.isLoading && loadError === null && editableSlots.length > 0
  const showContentTabs = showSlotStrip && activeSlot !== undefined && !activeSlot.readOnly

  // Content Tabs (pills) sit under the slot strip — second header when both show.
  // Slot strip is a separate control (cannot nest Tabs contexts).
  return (
    <Tabs
      appearance="pills"
      value={contentPanel}
      onValueChange={(next) => {
        if (next === 'layer' || next === 'binding') onContentPanelChange(next)
      }}
    >
      <ItemFormDialog
        open
        onClose={onClose}
        title={camera.name}
        icon={Monitor}
        width="xl"
        testId="osd-camera-editor"
        error={saveError}
        beforeBody={
          showSlotStrip ? (
            <div className="space-y-2">
              <div
                data-testid="osd-slot-tabs"
                role="tablist"
                className="flex flex-row overflow-x-auto overflow-y-hidden border-b border-border-subtle"
              >
                {editableSlots.map((slot) => {
                  const selected = slot.slotId === activeSlotId
                  const status = slotTabStatus(slot)
                  return (
                    // ui-check-ok: slot tab — Matches TabsTrigger underline chrome; not a toolbar Button
                    <button
                      key={slot.slotId}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      data-testid={`osd-slot-tab-${slot.slotId}`}
                      className={
                        selected
                          ? 'h-7 shrink-0 whitespace-nowrap border-b-2 border-primary px-3 text-xs font-medium text-foreground'
                          : 'h-7 shrink-0 whitespace-nowrap px-3 text-xs text-foreground-muted hover:text-foreground'
                      }
                      onClick={() => onActiveSlotIdChange(slot.slotId)}
                    >
                      {slot.slotId}
                      <span className="ml-1.5 text-[10px] text-foreground-subtle">
                        {slotTabStatusLabel(status)}
                      </span>
                    </button>
                  )
                })}
              </div>
              {showContentTabs ? <SlotEditorTabList /> : null}
            </div>
          ) : null
        }
        footer={
          showContentTabs ? (
            <Button
              type="button"
              size="sm"
              disabled={!canSave}
              data-testid="osd-camera-save"
              onClick={() => void saveAll()}
            >
              {saving ? t('row.saving') : t('row.save')}
            </Button>
          ) : null
        }
      >
        {body}
      </ItemFormDialog>
    </Tabs>
  )
}

interface ActiveSlotPanelProps {
  readonly cameraId: number
  readonly slot: OsdSlotView
  readonly binding: OsdSlotBinding
  readonly onBindingChange: (next: OsdSlotBinding) => void
  readonly sources: readonly OsdSourceOption[]
  readonly pickerDevices: readonly PickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  readonly templates: readonly OsdNamedTemplate[]
  readonly onRefreshCurrent: () => void | Promise<unknown>
  readonly refreshingCurrent: boolean
}

function ActiveSlotPanel({
  cameraId,
  slot,
  binding,
  onBindingChange,
  sources,
  pickerDevices,
  listState,
  templates,
  onRefreshCurrent,
  refreshingCurrent,
}: ActiveSlotPanelProps) {
  const { t } = useT()
  const templateNameById = useMemo(() => new Map(templates.map((t) => [t.id, t.name])), [templates])

  if (slot.readOnly) {
    return (
      <div data-testid="osd-slot-readonly">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{slot.kind}</Badge>
          <Badge variant="warning">{t('row.readOnly')}</Badge>
          {!slot.cameraEnabled ? <Badge variant="default">{t('row.cameraOff')}</Badge> : null}
        </div>
        <p className="text-xs text-foreground-subtle">
          {t('row.ownedByCamera')}
          {slot.cameraText ? ` ${t('row.currently', { text: slot.cameraText })}` : ''}
        </p>
        <p className="text-xs text-foreground-subtle">
          {sourceSummary(slot.binding, templateNameById)}
        </p>
      </div>
    )
  }

  return (
    <SlotEditor
      key={`${cameraId}-${slot.slotId}`}
      deviceId={cameraId}
      slot={slot}
      binding={binding}
      onBindingChange={onBindingChange}
      sources={sources}
      pickerDevices={pickerDevices}
      listState={listState}
      templates={templates}
      onRefreshCurrent={onRefreshCurrent}
      refreshingCurrent={refreshingCurrent}
    />
  )
}
