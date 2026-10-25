/**
 * Transform controls generated from the declaration: invert, threshold
 * with named watt defaults, or linear scale.
 */
import type { ScalarTransformDraft } from './scalar-form'
import { Checkbox, Input, Select } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ScalarControl } from './scalar-form'
import { defaultThreshold } from './scalar-form'
import type { ScalarTransformKind } from './scalar-fit'

export interface ScalarTransformControlsProps {
  readonly control: ScalarControl
  readonly transforms: readonly ScalarTransformKind[]
  readonly unit: string | null
  readonly value: ScalarTransformDraft
  readonly onChange: (next: ScalarTransformDraft) => void
}

export function ScalarTransformControls({
  control,
  transforms,
  unit,
  value,
  onChange,
}: ScalarTransformControlsProps): ReactNode {
  const { t } = useTranslation()
  if (control === 'none') return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] font-medium text-foreground-muted">
        {t('customize.scalar.stepTransform')}
      </h3>
      {control === 'choice' && (
        <Select
          aria-label={t('customize.scalar.stepTransform')}
          value={value.kind}
          options={transforms.map((kind) => ({
            value: kind,
            label: t(`customize.scalar.transform.${kind}`),
          }))}
          onChange={(event) => onChange(transformOfKind(event.target.value, unit))}
        />
      )}
      {value.kind === 'invert' || (control === 'invert' && value.kind !== 'threshold') ? (
        <label className="flex items-center gap-2 text-[11px] text-foreground">
          <Checkbox
            checked={value.kind === 'invert'}
            onChange={(event) =>
              onChange(event.target.checked ? { kind: 'invert' } : { kind: 'identity' })
            }
          />
          {t('customize.scalar.invert')}
        </label>
      ) : null}
      {value.kind === 'threshold' && (
        <ThresholdFields unit={unit} value={value} onChange={onChange} />
      )}
      {value.kind === 'linear' && <LinearFields value={value} onChange={onChange} />}
    </div>
  )
}

function transformOfKind(kind: string, unit: string | null): ScalarTransformDraft {
  if (kind === 'invert') return { kind: 'invert' }
  if (kind === 'threshold') return defaultThreshold(unit)
  if (kind === 'linear') return { kind: 'linear', scale: 1, offset: 0 }
  return { kind: 'identity' }
}

interface ThresholdFieldsProps {
  readonly unit: string | null
  readonly value: Extract<ScalarTransformDraft, { kind: 'threshold' }>
  readonly onChange: (next: ScalarTransformDraft) => void
}

function ThresholdFields({ unit, value, onChange }: ThresholdFieldsProps): ReactNode {
  const { t } = useTranslation()
  const suffix = unit ?? ''
  return (
    <div className="flex flex-col gap-2 text-[11px] text-foreground">
      <NumberField
        label={t('customize.scalar.threshold', { unit: suffix })}
        value={value.threshold}
        onChange={(threshold) => onChange({ ...value, threshold })}
      />
      <NumberField
        label={t('customize.scalar.startDwell')}
        value={value.startDwellMs / 1000}
        onChange={(seconds) => onChange({ ...value, startDwellMs: seconds * 1000 })}
      />
      <NumberField
        label={t('customize.scalar.stopDwell')}
        value={value.stopDwellMs / 1000}
        onChange={(seconds) => onChange({ ...value, stopDwellMs: seconds * 1000 })}
      />
    </div>
  )
}

interface LinearFieldsProps {
  readonly value: Extract<ScalarTransformDraft, { kind: 'linear' }>
  readonly onChange: (next: ScalarTransformDraft) => void
}

function LinearFields({ value, onChange }: LinearFieldsProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2 text-[11px] text-foreground">
      <NumberField
        label={t('customize.scalar.scale')}
        value={value.scale}
        onChange={(scale) => onChange({ ...value, scale })}
      />
      <NumberField
        label={t('customize.scalar.offset')}
        value={value.offset}
        onChange={(offset) => onChange({ ...value, offset })}
      />
    </div>
  )
}

interface NumberFieldProps {
  readonly label: string
  readonly value: number
  readonly onChange: (value: number) => void
}

function NumberField({ label, value, onChange }: NumberFieldProps): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      {label}
      <Input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
      />
    </label>
  )
}
