/**
 * "Use the root model" — the step editor's control for a step the camera's
 * ROOT detection model can supply (D730).
 *
 * The flag (`useRootModel`, in the step's own settings) is an operator INTENT
 * kept beside the step's model: checking it never changes the model, and a
 * root that cannot supply the step leaves the step running its own model while
 * the flag waits, inactive, for a root that can. Whether it is in force is
 * `resolveRootSupply` — the same function the runner decides with.
 */
import type { JSX } from 'react'
import { defaultUiText, useUiText, type UiTextFn } from '../contexts/ui-text'
import {
  isRootSuppliableStepId,
  resolveRootSupply,
  type RootStepSupply,
  type RootSupplyState,
  USE_ROOT_MODEL_SETTING_KEY,
} from '@camstack/types'

/** The root model the edited column runs, and what it can supply. */
export interface RootModelInfo {
  readonly modelId: string
  readonly name: string
  readonly supplies: readonly RootStepSupply[]
}

/** The editor's view of the flag for one step, or `null` for a step no root can supply. */
export function rootSourceState(
  stepId: string,
  settings: Readonly<Record<string, unknown>> | undefined,
  rootModel: RootModelInfo | undefined,
): RootSupplyState | null {
  if (!isRootSuppliableStepId(stepId)) return null
  return resolveRootSupply(stepId, settings, rootModel?.supplies)
}

/** The settings bag with the flag set — every other key untouched. */
export function withUseRootModel(
  settings: Readonly<Record<string, unknown>> | undefined,
  value: boolean,
): Readonly<Record<string, unknown>> {
  return { ...settings, [USE_ROOT_MODEL_SETTING_KEY]: value }
}

/** What the operator must know about a supply, beyond "it is on". */
function supplyNotes(supply: RootStepSupply, t: UiTextFn = defaultUiText): readonly string[] {
  if (supply.kind === 'label') {
    const notes =
      supply.uncovered.length > 0
        ? [
            t('uiLibrary.rootModelSource.notProduced', 'Not produced by this model: {{classes}}.', {
              classes: supply.uncovered.join(', '),
            }),
          ]
        : []
    if (supply.stepId === 'package-detection') {
      return [
        ...notes,
        t(
          'uiLibrary.rootModelSource.packageNote',
          "The root model's own package boxes become the package result at this step's threshold; this step's zone-crop view is not used, so small parcels the full-frame model misses stay missed.",
        ),
      ]
    }
    return [
      ...notes,
      t(
        'uiLibrary.rootModelSource.labelNote',
        "This step's class list decides which of the root's labels become the fine class; a switched-off class stays at its macro.",
      ),
    ]
  }
  if (supply.kind === 'mask') {
    return [
      t(
        'uiLibrary.rootModelSource.maskNote',
        "Masks come from the root model: each detection carries the root's own instance mask, so this step's model does not run. A root mask follows the model's mask grid (a quarter of its input), coarser than this step's own per-crop mask.",
      ),
    ]
  }
  if (supply.stepId === 'face-detection') {
    return [
      t(
        'uiLibrary.rootModelSource.faceNote',
        "Face boxes come from the root model. Each is re-found by this step's face detector in a square around it before recognition, so only a face it finds is recognised; a box with no face in it is dropped.",
      ),
    ]
  }
  return [
    t(
      'uiLibrary.rootModelSource.plateNote',
      'Plate boxes come from the root model and the plate reader reads them. The crop margin around a root plate box has not been measured for this model yet.',
    ),
  ]
}

/** The reason an intended supply is not in force, in the operator's words. */
function inactiveText(state: RootSupplyState, rootModel: RootModelInfo, t: UiTextFn): string {
  switch (state.inactiveReason) {
    case 'root-input-too-small':
      return t(
        'uiLibrary.rootModelSource.inactiveTooSmall',
        'the current root model ({{name}}) sees the frame too small to find faces reliably (it needs an input of 640 px or more).',
        { name: rootModel.name },
      )
    case 'root-does-not-declare':
    case undefined:
      return t(
        'uiLibrary.rootModelSource.inactiveCannot',
        'the current root model ({{name}}) cannot supply this.',
        { name: rootModel.name },
      )
  }
}

export interface RootModelSourceControlProps {
  readonly stepId: string
  readonly settings: Readonly<Record<string, unknown>> | undefined
  readonly rootModel: RootModelInfo | undefined
  readonly disabled?: boolean
  readonly onChange: (useRootModel: boolean) => void
}

export function RootModelSourceControl({
  stepId,
  settings,
  rootModel,
  disabled,
  onChange,
}: RootModelSourceControlProps): JSX.Element | null {
  const t = useUiText()
  if (rootModel === undefined) return null
  const state = rootSourceState(stepId, settings, rootModel)
  if (state === null) return null
  const inactiveNote = state.inactive ? (
    <div
      className="rounded bg-muted/40 px-3 py-2 text-[11px] text-foreground-subtle"
      data-testid="root-model-inactive"
    >
      {t(
        'uiLibrary.rootModelSource.inactive',
        'Use the root model: inactive — {{reason}} The step runs its own model.',
        { reason: inactiveText(state, rootModel, t) },
      )}
    </div>
  ) : null
  // Nothing declared: no checkbox to offer, only the waiting intent (if any).
  if (state.supply === undefined) return inactiveNote
  const checked = state.intent
  return (
    <div className="space-y-1" data-testid="root-model-source">
      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {t('uiLibrary.rootModelSource.use', 'Use the root model ({{name}})', {
          name: rootModel.name,
        })}
      </label>
      {inactiveNote}
      {state.effective &&
        supplyNotes(state.supply, t).map((note) => (
          <p key={note} className="text-[10px] leading-snug text-foreground-subtle">
            {note}
          </p>
        ))}
    </div>
  )
}
