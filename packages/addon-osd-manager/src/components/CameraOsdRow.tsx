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

/** Camera OSD dialog — one section per layer. */
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

  const [drafts, setDrafts] = useState<Readonly<Record<string, OsdSlotBinding>>>({})
  const [baselines, setBaselines] = useState<Readonly<Record<string, OsdSlotBinding>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  const setBinding = useOsdManagerSetSlotBinding()
  const saving = setBinding.isPending

  const bindingSeed = useMemo(() => {
    if (osdQuery.data === undefined) return null
    const next: Record<string, OsdSlotBinding> = {}
    for (const slot of osdQuery.data.slots) {
      if (slot.readOnly) continue
      next[slot.slotId] = draftForSlot(slot)
    }
    return {
      key: `${camera.id}:${osdQuery.data.slots.map((slot) => `${slot.slotId}:${JSON.stringify(slot.binding)}`).join('|')}`,
      drafts: next,
    }
  }, [camera.id, osdQuery.data])

  const bindingSeedRef = useRef(bindingSeed)
  bindingSeedRef.current = bindingSeed

  useEffect(() => {
    const seed = bindingSeedRef.current
    if (!camera.supportsOsd || seed === null) {
      setDrafts({})
      setBaselines({})
      return
    }
    setDrafts(seed.drafts)
    setBaselines(seed.drafts)
    setSaveError(null)
  }, [camera.supportsOsd, bindingSeed?.key])

  useEffect(() => {
    if (!camera.supportsOsd) return
    onRefetchReady(camera.id, () => void osdQuery.refetch())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, camera.supportsOsd, osdQuery.refetch])

  const writableIds = useMemo(
    () => slots.filter((slot) => !slot.readOnly).map((slot) => slot.slotId),
    [slots],
  )
  const pendingWrites = useMemo(
    () => dirtySlotBindings(writableIds, drafts, baselines),
    [baselines, drafts, writableIds],
  )

  const save = useCallback(async (): Promise<void> => {
    setSaveError(null)
    try {
      for (const { slotId, binding } of pendingWrites) {
        await setBinding.mutateAsync({
          deviceId: camera.id,
          slotId,
          binding,
        })
      }
      setBaselines(drafts)
      void osdQuery.refetch()
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }, [camera.id, drafts, onClose, osdQuery, pendingWrites, setBinding])

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

    if (osdQuery.data?.supported && slots.length === 0) {
      return <p className="text-xs text-foreground-subtle">{t('row.noSlotsReported')}</p>
    }

    return (
      <div className="space-y-4" data-testid="osd-camera-layers">
        {slots.map((slot) => {
          const draft = drafts[slot.slotId]
          return (
            <section
              key={slot.slotId}
              className="space-y-2"
              data-testid={`osd-layer-${slot.slotId}`}
            >
              <h3 className="text-sm font-medium text-foreground">{slot.slotId}</h3>
              {slot.readOnly || draft === undefined ? (
                <div data-testid="osd-slot-readonly">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{slot.kind}</Badge>
                    <Badge variant="warning">{t('row.readOnly')}</Badge>
                  </div>
                  <p className="text-xs text-foreground-subtle">
                    {t('row.ownedByCamera')}
                    {slot.cameraText ? ` ${t('row.currently', { text: slot.cameraText })}` : ''}
                  </p>
                  <p className="text-xs text-foreground-subtle">
                    {sourceSummary(slot.binding, templateNameById)}
                  </p>
                </div>
              ) : (
                <OsdCameraSection
                  deviceId={camera.id}
                  slot={slot}
                  binding={draft}
                  onBindingChange={(next) =>
                    setDrafts((current) => ({ ...current, [slot.slotId]: next }))
                  }
                  templates={templates}
                  refreshingCurrent={osdQuery.isFetching}
                  onRefreshCurrent={() => osdQuery.refetch()}
                />
              )}
            </section>
          )
        })}
      </div>
    )
  })()

  const showSave =
    camera.supportsOsd && !osdQuery.isLoading && loadError === null && writableIds.length > 0

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
