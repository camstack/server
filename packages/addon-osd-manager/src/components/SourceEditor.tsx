import { useMemo } from 'react'
import {
  Input,
  Label,
  Select,
  type PickerDevice,
  useDeviceStateGetSnapshot,
} from '@camstack/ui-library'
import type { OsdNamedTemplate, OsdSource, OsdSourceOption } from '@camstack/types'
import { useT } from '../i18n/index.js'
import { DeviceStatePickBlock } from './DeviceStatePickBlock.js'

interface SourceEditorProps {
  readonly source: OsdSource
  readonly sources: readonly OsdSourceOption[]
  readonly pickerDevices: readonly PickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  readonly templates: readonly OsdNamedTemplate[]
  /** Slot-level valueMap — owned by the binding, edited inside device-state pick. */
  readonly valueMap?: Record<string, string>
  /** Slot-level precision — edited next to unit source for device-state. */
  readonly maxDecimals?: number
  readonly onChange: (source: OsdSource) => void
  readonly onValueMapChange: (valueMap: Record<string, string> | undefined) => void
  readonly onMaxDecimalsChange?: (maxDecimals: number) => void
}

/** Editor for one `OsdSource` — the value a slot binding is fed by. */
export function SourceEditor({
  source,
  sources,
  pickerDevices,
  listState,
  templates,
  valueMap,
  maxDecimals,
  onChange,
  onValueMapChange,
  onMaxDecimalsChange,
}: SourceEditorProps) {
  const { t } = useT()
  const kindOptions = useMemo(
    () => [
      { value: 'none', label: t('source.kind.none') },
      { value: 'static', label: t('source.kind.static') },
      { value: 'clock', label: t('source.kind.clock') },
      { value: 'device-state', label: t('source.kind.deviceState') },
      { value: 'latest-recognition', label: t('source.kind.latestRecognition') },
      { value: 'template', label: t('source.kind.template') },
    ],
    [t],
  )
  const templateOptions = useMemo(
    () => templates.map((t) => ({ value: t.id, label: t.name || t.id })),
    [templates],
  )

  return (
    <div className="space-y-2">
      <div>
        <Label htmlFor="osd-source-kind">{t('source.label')}</Label>
        <Select
          id="osd-source-kind"
          value={source.kind}
          options={kindOptions}
          onChange={(e) => {
            const kind = e.target.value as OsdSource['kind']
            if (kind === 'none') {
              onChange({ kind: 'none' })
              onValueMapChange(undefined)
            } else if (kind === 'static') onChange({ kind: 'static', text: '' })
            else if (kind === 'clock') onChange({ kind: 'clock', pattern: 'HH:mm' })
            else if (kind === 'latest-recognition') {
              onChange({ kind: 'latest-recognition', recognition: 'person' })
            } else if (kind === 'template') {
              const first = templates[0]
              onChange(
                first
                  ? { kind: 'template', templateId: first.id }
                  : { kind: 'template', templateId: '' },
              )
            } else {
              onChange({ kind: 'device-state', capName: '', valuePath: '' })
            }
          }}
        />
      </div>

      {source.kind === 'none' ? (
        <p className="text-xs text-foreground-subtle" data-testid="osd-source-none-hint">
          {t('source.noneHint')}
        </p>
      ) : null}

      {source.kind === 'static' && (
        <div>
          <Label htmlFor="osd-source-static-text">{t('source.text')}</Label>
          <Input
            id="osd-source-static-text"
            value={source.text}
            maxLength={64}
            onChange={(e) => onChange({ kind: 'static', text: e.target.value })}
          />
        </div>
      )}

      {source.kind === 'clock' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label htmlFor="osd-source-clock-pattern">{t('source.pattern')}</Label>
            <Input
              id="osd-source-clock-pattern"
              value={source.pattern}
              placeholder="HH:mm"
              onChange={(e) => onChange({ ...source, kind: 'clock', pattern: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="osd-source-clock-timezone">{t('source.timezone')}</Label>
            <Input
              id="osd-source-clock-timezone"
              value={source.timezone ?? ''}
              placeholder={t('source.timezonePlaceholder')}
              onChange={(e) =>
                onChange({ ...source, kind: 'clock', timezone: e.target.value || undefined })
              }
            />
          </div>
        </div>
      )}

      {source.kind === 'device-state' && (
        <DeviceStateSourceFromPick
          source={source}
          sources={sources}
          pickerDevices={pickerDevices}
          listState={listState}
          valueMap={valueMap}
          maxDecimals={maxDecimals}
          onChange={onChange}
          onValueMapChange={onValueMapChange}
          onMaxDecimalsChange={onMaxDecimalsChange}
        />
      )}

      {source.kind === 'latest-recognition' && (
        <div>
          <Label htmlFor="osd-source-recognition">{t('source.recognition')}</Label>
          <Select
            id="osd-source-recognition"
            value={source.recognition}
            options={[
              { value: 'person', label: t('source.recognitionPerson') },
              { value: 'plate', label: t('source.recognitionPlate') },
            ]}
            onChange={(e) =>
              onChange({
                kind: 'latest-recognition',
                recognition: e.target.value === 'plate' ? 'plate' : 'person',
              })
            }
          />
        </div>
      )}

      {source.kind === 'template' && (
        <div>
          <Label htmlFor="osd-source-template">{t('source.namedTemplate')}</Label>
          {templateOptions.length === 0 ? (
            <p className="text-xs text-foreground-muted">{t('source.noTemplates')}</p>
          ) : (
            <Select
              id="osd-source-template"
              value={source.templateId}
              options={templateOptions}
              onChange={(e) => onChange({ kind: 'template', templateId: e.target.value })}
            />
          )}
        </div>
      )}
    </div>
  )
}

interface DeviceStateSourceFromPickProps {
  readonly source: Extract<OsdSource, { kind: 'device-state' }>
  readonly sources: readonly OsdSourceOption[]
  readonly pickerDevices: readonly PickerDevice[]
  readonly listState: 'answered' | 'pending' | 'failed'
  readonly valueMap: Record<string, string> | undefined
  readonly maxDecimals: number | undefined
  readonly onChange: (source: OsdSource) => void
  readonly onValueMapChange: (valueMap: Record<string, string> | undefined) => void
  readonly onMaxDecimalsChange: ((maxDecimals: number) => void) | undefined
}

/** Camera-layer adapter: same DeviceStatePickBlock as Named Templates. */
function DeviceStateSourceFromPick({
  source,
  sources,
  pickerDevices,
  listState,
  valueMap,
  maxDecimals,
  onChange,
  onValueMapChange,
  onMaxDecimalsChange,
}: DeviceStateSourceFromPickProps) {
  const leafId = source.deviceId
  const snapshot = useDeviceStateGetSnapshot(
    { deviceId: leafId ?? 0 },
    { enabled: leafId !== undefined },
  )
  const stateByDevice = useMemo(() => {
    const map = new Map<number, Readonly<Record<string, unknown>>>()
    if (leafId !== undefined && snapshot.data !== undefined) {
      map.set(leafId, snapshot.data)
    }
    return map
  }, [leafId, snapshot.data])

  return (
    <DeviceStatePickBlock
      value={{
        deviceId: leafId ?? 0,
        capName: source.capName,
        valuePath: source.valuePath,
        ...(source.displayUnit !== undefined ? { displayUnit: source.displayUnit } : {}),
        ...(valueMap !== undefined ? { valueMap } : {}),
      }}
      sources={sources}
      pickerDevices={pickerDevices}
      listState={listState}
      stateByDevice={stateByDevice}
      testIdPrefix="osd"
      maxDecimals={maxDecimals}
      onMaxDecimalsChange={onMaxDecimalsChange}
      onChange={(next) => {
        onValueMapChange(next.valueMap)
        if (next.deviceId <= 0) {
          onChange({
            kind: 'device-state',
            capName: '',
            valuePath: '',
            ...(next.displayUnit !== undefined ? { displayUnit: next.displayUnit } : {}),
          })
          return
        }
        onChange({
          kind: 'device-state',
          deviceId: next.deviceId,
          capName: next.capName,
          valuePath: next.valuePath,
          ...(next.displayUnit !== undefined ? { displayUnit: next.displayUnit } : {}),
        })
      }}
    />
  )
}
