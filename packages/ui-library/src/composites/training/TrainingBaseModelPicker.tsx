/**
 * TrainingBaseModelPicker — select trainable base models for a new training
 * job. Each row lists every cluster placement where that model is the
 * effective root detector (`node · device`), or “Not in use on any node”.
 *
 * Default is multi-select: Select-all-roots picks the roots the cluster
 * actually runs; Clear empties. Pass `multiple={false}` for one model at a
 * time (radio-like); “Select cluster root” picks the first cluster root (or
 * a recommended root when present).
 */
import { useUiText } from '../../contexts/ui-text'
import type { JSX } from 'react'

import { cn } from '../../lib/cn'
import { TEXT_HINT } from '../../lib/responsive'
import { Button } from '../../primitives/button'
import { Checkbox } from '../../primitives/checkbox'
import {
  defaultSelectClusterRoots,
  type TrainingBaseModelPlacement,
} from './root-detector-placements'

export type { TrainingBaseModelPlacement }

export interface TrainingBaseModelRow {
  readonly modelId: string
  readonly label: string
  readonly recommended?: boolean
  readonly placements: readonly TrainingBaseModelPlacement[]
}

export interface TrainingBaseModelPickerProps {
  readonly models: readonly TrainingBaseModelRow[]
  /** Model ids that are an effective root detector on any node. */
  readonly clusterRootModelIds: readonly string[]
  readonly value: readonly string[]
  readonly onChange: (modelIds: readonly string[]) => void
  readonly disabled?: boolean
  /**
   * When false, at most one model is selected (clicking another replaces).
   * Default true.
   */
  readonly multiple?: boolean
}

const EMPTY_PLACEMENTS = 'Not in use on any node'

function placementLine(placement: TrainingBaseModelPlacement): string {
  return `${placement.nodeId} · ${placement.label}`
}

function toggleModel(
  selected: readonly string[],
  modelId: string,
  checked: boolean,
  multiple: boolean,
): readonly string[] {
  if (!multiple) {
    return checked ? [modelId] : []
  }
  if (checked) {
    if (selected.includes(modelId)) return selected
    return [...selected, modelId]
  }
  return selected.filter((id) => id !== modelId)
}

/** Prefer a recommended cluster root; else the first root in catalog order. */
export function defaultSingleClusterRoot(
  trainableModelIds: readonly string[],
  clusterRootModelIds: readonly string[],
  models: readonly TrainingBaseModelRow[],
): string | undefined {
  const roots = defaultSelectClusterRoots(trainableModelIds, clusterRootModelIds)
  const recommended = models.find((m) => roots.includes(m.modelId) && m.recommended === true)
  if (recommended !== undefined) return recommended.modelId
  if (roots[0] !== undefined) return roots[0]
  const anyRecommended = models.find((m) => m.recommended === true)
  return anyRecommended?.modelId ?? models[0]?.modelId
}

/**
 * Select trainable base models with full multi-placement listing.
 * Multi: Select-all-roots / Clear. Single: Select cluster root / Clear.
 */
export function TrainingBaseModelPicker({
  models,
  clusterRootModelIds,
  value,
  onChange,
  disabled = false,
  multiple = true,
}: TrainingBaseModelPickerProps): JSX.Element {
  const t = useUiText()
  const selected = new Set(value)

  return (
    <div className="space-y-2" data-testid="training-base-model-picker">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => {
            if (multiple) {
              onChange(
                defaultSelectClusterRoots(
                  models.map((m) => m.modelId),
                  clusterRootModelIds,
                ),
              )
              return
            }
            const one = defaultSingleClusterRoot(
              models.map((m) => m.modelId),
              clusterRootModelIds,
              models,
            )
            onChange(one === undefined ? [] : [one])
          }}
        >
          {multiple
            ? t('uiLibrary.trainingBaseModelPicker.selectAll', 'Select all roots')
            : t('uiLibrary.trainingBaseModelPicker.selectRoot', 'Select cluster root')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || value.length === 0}
          onClick={() => onChange([])}
        >
          {t('uiLibrary.trainingBaseModelPicker.clear', 'Clear')}
        </Button>
      </div>
      <ul className="divide-y divide-border-subtle rounded-md border border-border bg-surface">
        {models.map((model) => {
          const checked = selected.has(model.modelId)
          const label = model.recommended ? `${model.label} (recommended)` : model.label
          return (
            <li
              key={model.modelId}
              className="px-2 py-2 sm:px-3"
              data-testid={`training-base-model-${model.modelId}`}
            >
              <label className="flex min-w-0 cursor-pointer items-start gap-2">
                <Checkbox
                  className="mt-0.5"
                  checked={checked}
                  disabled={disabled}
                  aria-label={model.label}
                  onChange={(event) =>
                    onChange(toggleModel(value, model.modelId, event.target.checked, multiple))
                  }
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block text-sm text-foreground">{label}</span>
                  {model.placements.length === 0 ? (
                    <span className={cn(TEXT_HINT, 'block')}>{EMPTY_PLACEMENTS}</span>
                  ) : (
                    <span className={cn(TEXT_HINT, 'flex flex-wrap gap-x-2 gap-y-0.5')}>
                      {model.placements.map((p) => (
                        <span key={`${p.nodeId}:${p.deviceKey}`}>{placementLine(p)}</span>
                      ))}
                    </span>
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
