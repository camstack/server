import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  ErrorBox,
  ItemFormDialog,
  useOsdManagerGetDeviceOsd,
  useOsdManagerRenderDevice,
  useOsdManagerSetSlotBinding,
} from '@camstack/ui-library'
import { Loader2, Monitor } from 'lucide-react'
import type { OsdNamedTemplate, OsdSlotBinding } from '@camstack/types'
import { useT } from '../i18n/index.js'
import { OsdCameraSection } from './OsdCameraSection.js'
import {
  activeSourceChips,
  cameraOsdStatus,
  cameraStatusLabel,
  cameraStatusTone,
  dirtySlotBindings,
  draftForSlot,
  type OsdCameraRow,
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
  readonly templateNameById: ReadonlyMap<string, string>
}

/** Collapsed Active-sources column. */
export function CameraOsdSourcesCell({
  cameraId,
  supportsOsd,
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

  const chips = activeSourceChips(osdQuery.data?.slots ?? [], templateNameById)
  if (chips.length === 0) {
    return <span className="text-xs text-foreground-subtle">{t('row.noActiveSources')}</span>
  }

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
  readonly templates: readonly OsdNamedTemplate[]
  readonly onRefetchReady: (deviceId: number, refetch: () => void) => void
  readonly onClose: () => void
}

/** Camera OSD dialog — first writable slot only. */
export function CameraOsdDetail({
  camera,
  templates,
  onRefetchReady,
  onClose,
}: CameraOsdDetailProps) {
  const { t } = useT()
  const osdQuery = useOsdManagerGetDeviceOsd(
    { deviceId: camera.id },
    { enabled: camera.supportsOsd },
  )
  const slots = osdQuery.data?.slots ?? []
  const editableSlots = useMemo(() => writableSlots(slots), [slots])
  const primarySlot = editableSlots[0]

  const [draft, setDraft] = useState<OsdSlotBinding | null>(null)
  const [baseline, setBaseline] = useState<OsdSlotBinding | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const setBinding = useOsdManagerSetSlotBinding()
  const saving = setBinding.isPending

  const bindingSeed = useMemo(() => {
    if (osdQuery.data === undefined || primarySlot === undefined) return null
    const nextDraft = draftForSlot(primarySlot)
    return {
      key: `${camera.id}:${primarySlot.slotId}:${JSON.stringify(primarySlot.binding)}`,
      draft: nextDraft,
    }
  }, [camera.id, osdQuery.data, primarySlot])

  const bindingSeedRef = useRef(bindingSeed)
  bindingSeedRef.current = bindingSeed

  useEffect(() => {
    const seed = bindingSeedRef.current
    if (!camera.supportsOsd || seed === null) {
      setDraft(null)
      setBaseline(null)
      return
    }
    setDraft(seed.draft)
    setBaseline(seed.draft)
    setSaveError(null)
  }, [camera.supportsOsd, bindingSeed?.key])

  useEffect(() => {
    if (!camera.supportsOsd) return
    onRefetchReady(camera.id, () => void osdQuery.refetch())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, camera.supportsOsd, osdQuery.refetch])

  const pendingWrites = useMemo(() => {
    if (primarySlot === undefined || draft === null || baseline === null) return []
    return dirtySlotBindings(
      [primarySlot.slotId],
      { [primarySlot.slotId]: draft },
      {
        [primarySlot.slotId]: baseline,
      },
    )
  }, [baseline, draft, primarySlot])

  const save = useCallback(async (): Promise<void> => {
    if (primarySlot === undefined || draft === null) return
    setSaveError(null)
    try {
      for (const { slotId, binding } of pendingWrites) {
        await setBinding.mutateAsync({
          deviceId: camera.id,
          slotId,
          binding,
        })
      }
      setBaseline(draft)
      void osdQuery.refetch()
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }, [camera.id, draft, onClose, osdQuery, pendingWrites, primarySlot, setBinding])

  const canSave = !saving && pendingWrites.length > 0
  const loadError = osdQuery.error
  const templateNameById = useMemo(
    () => new Map(templates.map((tpl) => [tpl.id, tpl.name])),
    [templates],
  )

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

    if (primarySlot === undefined || draft === null) return null

    if (primarySlot.readOnly) {
      return (
        <div data-testid="osd-slot-readonly">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{primarySlot.kind}</Badge>
            <Badge variant="warning">{t('row.readOnly')}</Badge>
            {!primarySlot.cameraEnabled ? (
              <Badge variant="default">{t('row.cameraOff')}</Badge>
            ) : null}
          </div>
          <p className="text-xs text-foreground-subtle">
            {t('row.ownedByCamera')}
            {primarySlot.cameraText
              ? ` ${t('row.currently', { text: primarySlot.cameraText })}`
              : ''}
          </p>
          <p className="text-xs text-foreground-subtle">
            {sourceSummary(primarySlot.binding, templateNameById)}
          </p>
        </div>
      )
    }

    return (
      <OsdCameraSection
        key={`${camera.id}-${primarySlot.slotId}`}
        deviceId={camera.id}
        slot={primarySlot}
        binding={draft}
        onBindingChange={setDraft}
        templates={templates}
        refreshingCurrent={osdQuery.isFetching}
        onRefreshCurrent={() => osdQuery.refetch()}
      />
    )
  })()

  const showSave =
    camera.supportsOsd && !osdQuery.isLoading && loadError === null && primarySlot !== undefined

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      title={camera.name}
      icon={Monitor}
      width="xl"
      testId="osd-camera-editor"
      error={saveError}
      footer={
        showSave ? (
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            data-testid="osd-camera-save"
            onClick={() => void save()}
          >
            {saving ? t('row.saving') : t('row.save')}
          </Button>
        ) : null
      }
    >
      {body}
    </ItemFormDialog>
  )
}
