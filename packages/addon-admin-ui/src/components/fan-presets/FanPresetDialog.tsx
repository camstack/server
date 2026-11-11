/**
 * One fan preset: a name and the fan-control state it sets (D1034) — speed,
 * the fan's preset mode, direction, and each oscillation axis. A field left
 * empty is left as it is. "Use current values" asks the hub for the fan's
 * current state (a field linked in Customize reads its link) and fills the
 * form, naming every reading it could not take. Nothing is saved until Save.
 */
import type {
  FanCaptureOmission,
  FanOscillationAxisName,
  FanPreset,
  FanPresetAxis,
  FanPresetState,
} from '@camstack/types'
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorBox,
  FormField,
  Input,
  useFanPresetsCapturePreset,
} from '@camstack/ui-library'
import { Camera, Loader2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  checkPresetDraft,
  omissionText,
  PRESET_AXES,
  PRESET_AXIS_NUMBERS,
  type PresetCheck,
  parseOptionalNumber,
  withAxis,
} from './fan-presets-model'

export interface FanPresetDialogProps {
  readonly fanId: number
  readonly draft: FanPreset
  /** The other presets, for the duplicate-name check. */
  readonly others: readonly FanPreset[]
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (preset: FanPreset) => void
  readonly onClose: () => void
}

function useProblemText(): (check: PresetCheck) => string | null {
  const { t } = useTranslation()
  return (check) => {
    if (check.ok) return null
    switch (check.reason) {
      case 'no-name':
        return t('fanPresets.problem.name', 'Give the preset a name.')
      case 'no-fields':
        return t(
          'fanPresets.problem.noFields',
          'Set at least one value, or use the current values.',
        )
      case 'duplicate-name':
        return t('fanPresets.problem.duplicate', 'Another preset already has this name.')
    }
  }
}

interface ChoiceOption<T> {
  readonly value: T | undefined
  readonly label: string
}

interface ChoiceProps<T> {
  readonly options: readonly ChoiceOption<T>[]
  readonly value: T | undefined
  readonly onChange: (value: T | undefined) => void
  readonly testId: string
}

function Choice<T>({ options, value, onChange, testId }: ChoiceProps<T>): ReactNode {
  return (
    <div className="flex flex-wrap gap-1" data-testid={testId}>
      {options.map((option) => (
        <Button
          key={option.label}
          size="sm"
          variant={option.value === value ? 'primary' : 'outline'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

interface NumberFieldProps {
  readonly label: string
  readonly value: number | undefined
  readonly onChange: (value: number | undefined) => void
  readonly testId: string
}

function NumberField({ label, value, onChange, testId }: NumberFieldProps): ReactNode {
  const { t } = useTranslation()
  return (
    <FormField label={label}>
      <Input
        type="number"
        value={value === undefined ? '' : String(value)}
        placeholder={t('fanPresets.dialog.unchanged', 'Unchanged')}
        onChange={(e) => onChange(parseOptionalNumber(e.target.value))}
        data-testid={testId}
      />
    </FormField>
  )
}

interface AxisEditorProps {
  readonly axis: FanOscillationAxisName
  readonly want: FanPresetAxis
  readonly onChange: (want: FanPresetAxis) => void
}

function AxisEditor({ axis, want, onChange }: AxisEditorProps): ReactNode {
  const { t } = useTranslation()
  const title =
    axis === 'horizontal'
      ? t('fanPresets.axis.horizontal', 'Horizontal axis')
      : t('fanPresets.axis.vertical', 'Vertical axis')
  const numberLabel = {
    angle: t('fanPresets.axis.angle', 'Angle (°)'),
    sweepFrom: t('fanPresets.axis.sweepFrom', 'Sweep from (°)'),
    sweepTo: t('fanPresets.axis.sweepTo', 'Sweep to (°)'),
  }
  return (
    <div
      className="space-y-2 rounded border border-border p-3"
      data-testid={`fan-preset-axis-${axis}`}
    >
      <p className="text-xs font-medium text-foreground">{title}</p>
      <FormField label={t('fanPresets.axis.oscillating', 'Oscillation')}>
        <Choice<boolean>
          testId={`fan-preset-axis-${axis}-oscillating`}
          value={want.oscillating}
          onChange={(oscillating) => onChange({ ...want, oscillating })}
          options={[
            { value: undefined, label: t('fanPresets.dialog.unchanged', 'Unchanged') },
            { value: true, label: t('fanPresets.axis.on', 'On') },
            { value: false, label: t('fanPresets.axis.off', 'Off') },
          ]}
        />
      </FormField>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {PRESET_AXIS_NUMBERS.map((field) => (
          <NumberField
            key={field}
            label={numberLabel[field]}
            value={want[field]}
            onChange={(value) => onChange({ ...want, [field]: value })}
            testId={`fan-preset-axis-${axis}-${field}`}
          />
        ))}
      </div>
    </div>
  )
}

export function FanPresetDialog({
  fanId,
  draft: initial,
  others,
  saving,
  error,
  onSave,
  onClose,
}: FanPresetDialogProps): ReactNode {
  const { t } = useTranslation()
  const problemText = useProblemText()
  const [draft, setDraft] = useState<FanPreset>(initial)
  const [omitted, setOmitted] = useState<readonly FanCaptureOmission[]>([])
  const capture = useFanPresetsCapturePreset(
    { deviceId: fanId },
    { enabled: false, gcTime: 0, retry: false },
  )
  const check = checkPresetDraft(others, draft)
  const problem = problemText(check)
  const setState = (state: FanPresetState): void => setDraft((d) => ({ ...d, state }))
  const state = draft.state

  const useCurrent = (): void => {
    void capture.refetch().then((result) => {
      if (result.data === undefined) return
      setState(result.data.state)
      setOmitted(result.data.omitted)
    })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="xl" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>{t('fanPresets.dialog.title', 'Fan preset')}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-3" data-testid="fan-preset-editor">
            <FormField label={t('fanPresets.dialog.name', 'Name')}>
              <Input
                value={draft.name}
                maxLength={40}
                placeholder={t('fanPresets.dialog.namePlaceholder', 'Night, Boost, Away…')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </FormField>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-foreground-muted">
                {t(
                  'fanPresets.dialog.stateHint',
                  'Set only what this preset should change. An empty value is left as it is.',
                )}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={capture.isFetching}
                onClick={useCurrent}
                data-testid="fan-preset-use-current"
              >
                {capture.isFetching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}{' '}
                {t('fanPresets.dialog.useCurrent', 'Use current values')}
              </Button>
            </div>
            {capture.isError && (
              <ErrorBox
                message={
                  capture.error?.message ??
                  t('fanPresets.dialog.captureFailed', 'The current values could not be read.')
                }
              />
            )}
            {omitted.length > 0 && (
              <div
                role="status"
                className="rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
                data-testid="fan-preset-omitted"
              >
                <p>
                  {t(
                    'fanPresets.dialog.omitted',
                    'These values could not be read, so they were left out:',
                  )}
                </p>
                <ul className="mt-1 list-disc pl-4">
                  {omitted.map((o) => (
                    <li key={`${o.what}:${o.reason}`}>{omissionText(o)}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <NumberField
                label={t('fanPresets.field.speed', 'Speed (%)')}
                value={state.speed}
                onChange={(speed) => {
                  const { speed: _old, ...rest } = state
                  setState(speed === undefined ? rest : { ...rest, speed })
                }}
                testId="fan-preset-speed"
              />
              <FormField label={t('fanPresets.field.preset', 'Fan preset mode')}>
                <Input
                  value={state.preset ?? ''}
                  placeholder={t('fanPresets.dialog.unchanged', 'Unchanged')}
                  onChange={(e) => {
                    const { preset: _old, ...rest } = state
                    const preset = e.target.value
                    setState(preset === '' ? rest : { ...rest, preset })
                  }}
                  data-testid="fan-preset-mode"
                />
              </FormField>
            </div>
            <FormField label={t('fanPresets.field.direction', 'Direction')}>
              <Choice<'forward' | 'reverse'>
                testId="fan-preset-direction"
                value={state.direction}
                onChange={(direction) => {
                  const { direction: _old, ...rest } = state
                  setState(direction === undefined ? rest : { ...rest, direction })
                }}
                options={[
                  { value: undefined, label: t('fanPresets.dialog.unchanged', 'Unchanged') },
                  { value: 'forward', label: t('fanPresets.field.forward', 'Forward') },
                  { value: 'reverse', label: t('fanPresets.field.reverse', 'Reverse') },
                ]}
              />
            </FormField>
            {PRESET_AXES.map((axis) => (
              <AxisEditor
                key={axis}
                axis={axis}
                want={state.oscillationAxes?.[axis] ?? {}}
                onChange={(want) => setState(withAxis(state, axis, want))}
              />
            ))}
            {problem !== null && draft.name !== '' && (
              <p className="text-xs text-warning">{problem}</p>
            )}
            {error !== null && <ErrorBox message={error} />}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={saving || !check.ok}
            onClick={() => onSave({ ...draft, name: draft.name.trim() })}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
