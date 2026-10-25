import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  PlaceholderChipField,
  type PickerDevice,
  TabsContent,
  TabsList,
  TabsTrigger,
  useOsdManagerPreviewSlot,
  useOsdManagerSetSlotCameraEnabled,
} from '@camstack/ui-library'
import { Loader2, RefreshCw } from 'lucide-react'
import type {
  OsdNamedTemplate,
  OsdRenderResult,
  OsdSlotBinding,
  OsdSlotView,
  OsdSourceOption,
} from '@camstack/types'
import { useT } from '../i18n/index.js'
import { outcomeLabel, outcomeTone } from '../ui/osd-page-model.js'
import { SourceEditor } from './SourceEditor.js'
import { ValueMapEditor } from './ValueMapEditor.js'

/** Content tabs under the slot strip — Layer (incl. Preview) | Binding. */
export type SlotEditorPanel = 'layer' | 'binding'

interface SlotEditorProps {
  readonly deviceId: number
  readonly slot: OsdSlotView
  /** Controlled draft — parent owns Save for every layer. */
  readonly binding: OsdSlotBinding
  readonly onBindingChange: (next: OsdSlotBinding) => void
  readonly sources: readonly OsdSourceOption[]
  readonly pickerDevices: readonly PickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  readonly templates: readonly OsdNamedTemplate[]
  /** Re-probe overlays so `slot.cameraText` (current on-camera value) refreshes. */
  readonly onRefreshCurrent?: () => void | Promise<unknown>
  readonly refreshingCurrent?: boolean
}

/** Second header under the slot strip — parent Tabs must use `appearance="pills"`. */
export function SlotEditorTabList(): ReactNode {
  const { t } = useT()
  return (
    <TabsList data-testid="osd-slot-content-tabs">
      <TabsTrigger value="layer">{t('slot.tabLayer')}</TabsTrigger>
      <TabsTrigger value="binding">{t('slot.tabBinding')}</TabsTrigger>
    </TabsList>
  )
}

/**
 * One writable OSD layer: Layer (+ Preview) / Binding panels.
 * Persist is the parent ItemFormDialog footer. Tabs chrome is
 * {@link SlotEditorTabList} in the dialog `beforeBody`.
 */
export function SlotEditor({
  deviceId,
  slot,
  binding: draft,
  onBindingChange,
  sources,
  pickerDevices,
  listState,
  templates,
  onRefreshCurrent,
  refreshingCurrent = false,
}: SlotEditorProps) {
  const { t } = useT()
  const [preview, setPreview] = useState<OsdRenderResult | undefined>(undefined)
  const [cameraEnabled, setCameraEnabled] = useState(slot.cameraEnabled)
  const previewSlot = useOsdManagerPreviewSlot()
  const setSlotCameraEnabled = useOsdManagerSetSlotCameraEnabled()
  const busy = previewSlot.isPending || setSlotCameraEnabled.isPending
  const error = previewSlot.error ?? setSlotCameraEnabled.error

  useEffect(() => {
    if (!setSlotCameraEnabled.isPending) setCameraEnabled(slot.cameraEnabled)
  }, [slot.cameraEnabled, setSlotCameraEnabled.isPending])

  const templateChips = useMemo(
    () => [
      { id: 'value', label: '${value}', token: '${value}' },
      { id: 'unit', label: '${unit}', token: '${unit}' },
    ],
    [],
  )

  async function handlePreview() {
    const result = await previewSlot.mutateAsync({
      deviceId,
      slotId: slot.slotId,
      binding: draft,
    })
    setPreview(result)
  }

  // Named templates / None own formatting (or need none). Device-state
  // valueMap lives in DeviceStatePickBlock (shared with templates).
  const namedTemplate = draft.source.kind === 'template'
  const noneSource = draft.source.kind === 'none'
  const deviceStateSource = draft.source.kind === 'device-state'
  const showSlotFormatting = !namedTemplate && !noneSource
  const showSlotValueMap = showSlotFormatting && !deviceStateSource

  return (
    <>
      <TabsContent value="layer" className="space-y-3 pt-0" data-testid="osd-slot-section-layer">
        <p className="text-[11px] text-foreground-subtle">{t('slot.layerHint')}</p>

        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={cameraEnabled}
            disabled={busy}
            data-testid="osd-slot-camera-enabled"
            onChange={(e) => {
              const next = e.target.checked
              setCameraEnabled(next)
              void setSlotCameraEnabled
                .mutateAsync({ deviceId, slotId: slot.slotId, enabled: next })
                .then(() => onRefreshCurrent?.())
                .catch(() => setCameraEnabled(slot.cameraEnabled))
            }}
          />
          {t('slot.showOnCamera')}
        </label>

        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onBindingChange({ ...draft, enabled: e.target.checked })}
          />
          {t('slot.bindingEnabled')}
        </label>

        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface-raised px-3 py-2"
          data-testid="osd-slot-current-value"
        >
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-foreground-muted">
              {t('slot.currentOnCamera')}
            </p>
            <p className="truncate text-sm text-foreground">
              {slot.cameraText !== undefined && slot.cameraText !== ''
                ? `"${slot.cameraText}"`
                : t('slot.blankUnread')}
            </p>
          </div>
          {onRefreshCurrent !== undefined ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || refreshingCurrent}
              onClick={() => void onRefreshCurrent()}
              data-testid="osd-slot-refresh-current"
            >
              {refreshingCurrent ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t('slot.refresh')}
            </Button>
          ) : null}
        </div>

        <div
          className="space-y-3 border-t border-border pt-3"
          data-testid="osd-slot-section-preview"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-[11px] text-foreground-subtle">{t('slot.previewHint')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void handlePreview()}
            >
              {t('slot.preview')}
            </Button>
          </div>

          {error && (
            <p className="text-xs text-danger" role="alert">
              {error.message}
            </p>
          )}

          {preview ? (
            <div className="flex items-center gap-2 text-xs">
              <Badge variant={outcomeTone(preview.outcome)}>{outcomeLabel(preview.outcome)}</Badge>
              <span className="text-foreground-muted">
                {preview.text ? `"${preview.text}"` : t('slot.blank')}
              </span>
            </div>
          ) : (
            <p className="text-xs text-foreground-subtle">{t('slot.runPreview')}</p>
          )}
        </div>
      </TabsContent>

      <TabsContent
        value="binding"
        className="space-y-3 pt-0"
        data-testid="osd-slot-section-binding"
      >
        <p className="text-[11px] text-foreground-subtle">{t('slot.bindingHint')}</p>
        <SourceEditor
          source={draft.source}
          sources={sources}
          pickerDevices={pickerDevices}
          listState={listState}
          templates={templates}
          valueMap={draft.valueMap}
          maxDecimals={draft.maxDecimals}
          onChange={(source) => onBindingChange({ ...draft, source })}
          onValueMapChange={(valueMap) => onBindingChange({ ...draft, valueMap })}
          onMaxDecimalsChange={(maxDecimals) => onBindingChange({ ...draft, maxDecimals })}
        />

        {showSlotFormatting ? (
          <>
            <PlaceholderChipField
              label={t('slot.templateLabel')}
              value={draft.template}
              onChange={(template) => onBindingChange({ ...draft, template })}
              chips={templateChips}
              placeholder="${value} ${unit}"
              testId="osd-slot-template"
              maxLength={96}
            />

            {showSlotValueMap ? (
              <ValueMapEditor
                valueMap={draft.valueMap}
                onChange={(valueMap) => onBindingChange({ ...draft, valueMap })}
              />
            ) : null}
          </>
        ) : null}
      </TabsContent>
    </>
  )
}
