/**
 * How a trigger that arrives while the automation is busy (or cooling down) is
 * handled — the recipe's `runMode`. Absent means `single`, and choosing
 * `single` removes the key, so a recipe nobody touched stays byte-identical.
 */

import type { AutomationRecipe, AutomationRunMode } from '@camstack/types'
import { useTranslation } from 'react-i18next'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import { FixedSelect } from '../flow/FixedSelect'

type ModeName = AutomationRunMode['mode']

const MODES: readonly ModeName[] = ['single', 'restart', 'queued', 'parallel', 'cooldown']
const DEFAULT_COUNT = 2
const DEFAULT_MINUTES = 30

/** The mode a recipe runs in. */
export function runModeOf(recipe: AutomationRecipe): AutomationRunMode {
  return recipe.runMode ?? { mode: 'single' }
}

/** The recipe with `runMode` set; `single` drops the key. */
export function withRunMode(recipe: AutomationRecipe, mode: AutomationRunMode): AutomationRecipe {
  const { runMode: _dropped, ...rest } = recipe
  return mode.mode === 'single' ? rest : { ...rest, runMode: mode }
}

/** A mode of this name with its own default amount. */
export function defaultRunMode(name: ModeName): AutomationRunMode {
  switch (name) {
    case 'queued':
      return { mode: 'queued', max: DEFAULT_COUNT }
    case 'parallel':
      return { mode: 'parallel', max: DEFAULT_COUNT }
    case 'cooldown':
      return { mode: 'cooldown', minutes: DEFAULT_MINUTES }
    case 'restart':
      return { mode: 'restart' }
    default:
      return { mode: 'single' }
  }
}

function modeName(value: string): ModeName {
  return MODES.find((m) => m === value) ?? 'single'
}

export interface RunModeSelectorProps {
  readonly value: AutomationRunMode
  readonly onChange: (next: AutomationRunMode) => void
}

export function RunModeSelector({ value, onChange }: RunModeSelectorProps) {
  const { t } = useTranslation()
  const labels: Readonly<Record<ModeName, string>> = {
    single: t('flow.runMode.single', 'Skip it'),
    restart: t('flow.runMode.restart', 'Restart the run'),
    queued: t('flow.runMode.queued', 'Queue it'),
    parallel: t('flow.runMode.parallel', 'Run at the same time'),
    cooldown: t('flow.runMode.cooldown', 'Wait after a run'),
  }
  const hints: Readonly<Record<ModeName, string>> = {
    single: t('flow.runMode.singleHint', 'A trigger that arrives during a run is dropped.'),
    restart: t('flow.runMode.restartHint', 'The run in progress stops and a new one starts.'),
    queued: t('flow.runMode.queuedHint', 'Triggers wait their turn, up to the limit.'),
    parallel: t('flow.runMode.parallelHint', 'Runs overlap, up to the limit.'),
    cooldown: t(
      'flow.runMode.cooldownHint',
      'No new run until this long after the last one began.',
    ),
  }
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="run-mode">
      <label className="space-y-1">
        <span className="block text-xs text-foreground-subtle">
          {t('flow.runMode.label', 'When it is already running')}
        </span>
        <FixedSelect
          widthClass="w-56"
          value={value.mode}
          options={MODES.map((m) => ({ value: m, label: labels[m] }))}
          onChange={(e) => onChange(defaultRunMode(modeName(e.target.value)))}
        />
      </label>
      {(value.mode === 'queued' || value.mode === 'parallel') && (
        <label className="space-y-1">
          <span className="block text-xs text-foreground-subtle">
            {t('flow.runMode.max', 'Up to')}
          </span>
          <DraftNumberInput
            className="w-20"
            aria-label={t('flow.runMode.max', 'Up to')}
            value={value.max}
            onValue={(max) => {
              if (max !== null) onChange({ mode: value.mode, max: Math.round(max) })
            }}
          />
        </label>
      )}
      {value.mode === 'cooldown' && (
        <label className="space-y-1">
          <span className="block text-xs text-foreground-subtle">
            {t('flow.runMode.minutes', 'Minutes')}
          </span>
          <DraftNumberInput
            className="w-20"
            aria-label={t('flow.runMode.minutes', 'Minutes')}
            value={value.minutes}
            onValue={(minutes) => {
              if (minutes !== null) onChange({ mode: 'cooldown', minutes: Math.round(minutes) })
            }}
          />
        </label>
      )}
      <p className="basis-full text-xs text-foreground-subtle">{hints[value.mode]}</p>
    </div>
  )
}
