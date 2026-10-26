/**
 * Transform controls generated from the declaration: invert, threshold
 * with named watt defaults, or linear scale.
 */
import type { CustomizeCatalogTransform } from '@camstack/types'
import { Checkbox, Input, Select } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ScalarTransformKind } from './scalar-fit'
import {
  type ScalarControl,
  type ScalarTransformDraft,
  declaredOf,
  draftFromDeclared,
} from './scalar-form'

export interface ScalarTransformControlsProps {
  readonly control: ScalarControl
  readonly transforms: readonly ScalarTransformKind[]
  readonly declared: readonly CustomizeCatalogTransform[]
  readonly unit: string | null
  readonly value: ScalarTransformDraft
  readonly onChange: (next: ScalarTransformDraft) => void
}

export function ScalarTransformControls({
  control,
  transforms,
  declared,
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
          onChange={(event) => onChange(transformOfKind(event.target.value, declared))}
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
        <ThresholdFields declared={declared} unit={unit} value={value} onChange={onChange} />
      )}
      {value.kind === 'linear' && (
        <LinearFields declared={declared} value={value} onChange={onChange} />
      )}
    </div>
  )
}

function transformOfKind(
  kind: string,
  declared: readonly CustomizeCatalogTransform[],
): ScalarTransformDraft {
  const match = declaredOf(declared, kindOf(kind))
  if (match !== null) return draftFromDeclared(match)
  if (kind === 'invert') return { kind: 'invert' }
  return { kind: 'identity' }
}

function kindOf(kind: string): CustomizeCatalogTransform['kind'] {
  if (kind === 'invert' || kind === 'threshold' || kind === 'linear' || kind === 'enum-map') {
    return kind
  }
  return 'identity'
}

interface ThresholdFieldsProps {
  readonly declared: readonly CustomizeCatalogTransform[]
  readonly unit: string | null
  readonly value: Extract<ScalarTransformDraft, { kind: 'threshold' }>
  readonly onChange: (next: ScalarTransformDraft) => void
}

function ThresholdFields({ declared, unit, value, onChange }: ThresholdFieldsProps): ReactNode {
  const { t } = useTranslation()
  const suffix = unit ?? ''
  const spec = declaredOf(declared, 'threshold')
  const comparisons = spec?.kind === 'threshold' ? spec.comparisons : []
  return (
    <div className="flex flex-col gap-2 text-[11px] text-foreground">
      {comparisons.length > 0 && (
        <label className="flex flex-col gap-1">
          {t('customize.scalar.comparison')}
          <Select
            aria-label={t('customize.scalar.comparison')}
            value={value.comparison}
            options={comparisons.map((comparison) => ({
              value: comparison,
              label: t(`customize.scalar.comparisonValue.${comparison}`),
            }))}
            onChange={(event) => {
              const comparison = comparisons.find((item) => item === event.target.value)
              if (comparison === undefined) return
              onChange({ ...value, comparison })
            }}
          />
        </label>
      )}
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
  readonly declared: readonly CustomizeCatalogTransform[]
  readonly value: Extract<ScalarTransformDraft, { kind: 'linear' }>
  readonly onChange: (next: ScalarTransformDraft) => void
}

interface ClampBounds {
  readonly min: number
  readonly max: number
}

function clampBounds(spec: CustomizeCatalogTransform | null): ClampBounds | null {
  if (spec === null || spec.kind !== 'linear') return null
  if (spec.clampMin === undefined || spec.clampMax === undefined) return null
  return { min: spec.clampMin, max: spec.clampMax }
}

function LinearFields({ declared, value, onChange }: LinearFieldsProps): ReactNode {
  const { t } = useTranslation()
  const bounds = clampBounds(declaredOf(declared, 'linear'))
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
      {bounds !== null && (
        <NumberField
          label={t('customize.scalar.clampMin')}
          value={value.clampMin ?? bounds.min}
          onChange={(clampMin) =>
            onChange({ ...value, clampMin, clampMax: value.clampMax ?? bounds.max })
          }
        />
      )}
      {bounds !== null && (
        <NumberField
          label={t('customize.scalar.clampMax')}
          value={value.clampMax ?? bounds.max}
          onChange={(clampMax) =>
            onChange({ ...value, clampMin: value.clampMin ?? bounds.min, clampMax })
          }
        />
      )}
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
