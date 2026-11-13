import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Badge,
  Button,
  Checkbox,
  DEVICE_TEMPLATE_DOCS_URL,
  DeviceTemplateField,
  IconButton,
  Label,
  Select,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useOsdManagerPreviewSlot,
  useOsdManagerSetSlotCameraEnabled,
} from '@camstack/ui-library'
import type {
  OsdNamedTemplate,
  OsdRenderResult,
  OsdSlotBinding,
  OsdSlotView,
} from '@camstack/types'
import { Info, Loader2, RefreshCw } from 'lucide-react'
import { useT } from '../i18n/index.js'
import {
  choiceOfSource,
  outcomeLabel,
  outcomeTone,
  sourceOfChoice,
  type OsdSourceChoice,
} from '../ui/osd-page-model.js'

function isSourceChoice(value: string): value is OsdSourceChoice {
  return value === 'none' || value === 'namedTemplate' || value === 'value'
}

interface OsdCameraSectionProps {
  readonly deviceId: number
  readonly slot: OsdSlotView
  readonly binding: OsdSlotBinding
  readonly onBindingChange: (next: OsdSlotBinding) => void
  readonly templates: readonly OsdNamedTemplate[]
  readonly onRefreshCurrent?: () => void | Promise<unknown>
  readonly refreshingCurrent?: boolean
}

/** One camera overlay section — first writable slot only; no slot or layer tabs. */
export function OsdCameraSection({
  deviceId,
  slot,
  binding: draft,
  onBindingChange,
  templates,
  onRefreshCurrent,
  refreshingCurrent = false,
}: OsdCameraSectionProps): ReactNode {
  const { t } = useT()
  const [preview, setPreview] = useState<OsdRenderResult | undefined>(undefined)
  const [cameraEnabled, setCameraEnabled] = useState(slot.cameraEnabled)
  const previewSlot = useOsdManagerPreviewSlot()
  const setSlotCameraEnabled = useOsdManagerSetSlotCameraEnabled()
  const busy = previewSlot.isPending || setSlotCameraEnabled.isPending
  const error = previewSlot.error ?? setSlotCameraEnabled.error
  const source = draft.source
  const choice = choiceOfSource(source)

  const choiceOptions = useMemo(
    () => [
      { value: 'none', label: t('source.choice.none') },
      { value: 'namedTemplate', label: t('source.choice.namedTemplate') },
      { value: 'value', label: t('source.choice.value') },
    ],
    [t],
  )

  const templateOptions = useMemo(
    () => templates.map((tpl) => ({ value: tpl.id, label: tpl.name || tpl.id })),
    [templates],
  )

  useEffect(() => {
    if (!setSlotCameraEnabled.isPending) setCameraEnabled(slot.cameraEnabled)
  }, [slot.cameraEnabled, setSlotCameraEnabled.isPending])

  async function handlePreview(): Promise<void> {
    const result = await previewSlot.mutateAsync({
      deviceId,
      slotId: slot.slotId,
      binding: draft,
    })
    setPreview(result)
  }

  return (
    <div className="space-y-4" data-testid="osd-camera-section">
      <div className="space-y-2">
        <Label htmlFor="osd-source-choice">{t('source.label')}</Label>
        <Select
          id="osd-source-choice"
          value={choice}
          options={choiceOptions}
          onChange={(e) => {
            const next = e.target.value
            if (!isSourceChoice(next)) return
            onBindingChange({
              ...draft,
              source: sourceOfChoice(next, source, templates),
            })
          }}
        />

        {choice === 'none' ? (
          <p className="text-xs text-foreground-subtle" data-testid="osd-source-none-hint">
            {t('source.noneHint')}
          </p>
        ) : null}

        {choice === 'namedTemplate' ? (
          <div>
            <Label htmlFor="osd-source-template">{t('source.namedTemplate')}</Label>
            {templateOptions.length === 0 ? (
              <p className="text-xs text-foreground-muted">{t('source.noTemplates')}</p>
            ) : (
              <Select
                id="osd-source-template"
                value={source.kind === 'template' ? source.templateId : ''}
                options={templateOptions}
                onChange={(e) =>
                  onBindingChange({
                    ...draft,
                    source: { kind: 'template', templateId: e.target.value },
                  })
                }
              />
            )}
          </div>
        ) : null}

        {choice === 'value' ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium text-foreground">
                {t('source.choice.value')}
              </span>
              <Tooltip>
                <TooltipTrigger>
                  <IconButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={Info}
                    aria-label={t('camera.valueHelpTitle')}
                    data-testid="osd-value-help"
                  />
                </TooltipTrigger>
                <TooltipContent className="max-w-[16rem] whitespace-normal text-left">
                  <span className="block">{t('camera.valueHelp.line1')}</span>
                  <span className="mt-1 block">{t('camera.valueHelp.line2')}</span>
                  <a
                    href={DEVICE_TEMPLATE_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block text-primary underline"
                  >
                    {t('camera.valueHelp.docsLink')}
                  </a>
                </TooltipContent>
              </Tooltip>
            </div>
            <DeviceTemplateField
              label={t('source.text')}
              value={source.kind === 'static' ? source.text : ''}
              onChange={(text) => onBindingChange({ ...draft, source: { kind: 'static', text } })}
              accepts="any"
              multiline
              thisDevice={{ deviceId }}
              testId="osd-value-field"
            />
            <p className="text-[11px] text-foreground-subtle">{t('camera.valueFieldHint')}</p>
          </div>
        ) : null}
      </div>

      <p className="text-[11px] text-foreground-subtle">{t('slot.layerHint')}</p>

      <label className="flex items-center gap-2 text-xs text-foreground">
        <Checkbox
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
        <Checkbox
          checked={draft.enabled}
          onChange={(e) => onBindingChange({ ...draft, enabled: e.target.checked })}
        />
        {t('slot.bindingEnabled')}
      </label>

      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface px-3 py-2"
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

      <div className="space-y-3 border-t border-border pt-3" data-testid="osd-slot-section-preview">
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

        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error.message}
          </p>
        ) : null}

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
    </div>
  )
}
