/**
 * The fields of a `repeat` step: what decides how many times it runs (a
 * count, a condition under a mandatory maximum, or a list of devices) and
 * the steps it runs each time. Its steps are plain steps, so the nesting
 * stops here.
 */
import {
  type AutomationRecipe,
  type AutomationRepeatStep,
  REPEAT_COUNT_MAX,
  REPEAT_DEVICES_MAX,
  REPEAT_ITEM_VAR,
  REPEAT_ITERATIONS_MAX,
  REPEAT_STEPS_MAX,
  WAIT_MAX_SECONDS,
} from '@camstack/types'
import {
  type DeviceListState,
  DeviceValuePicker,
  ErrorBox,
  Input,
  Select,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import type { ScopeVariable } from '../flow/ArgField'
import { ActionList } from './ActionList'
import type { AutomationDevice } from './automation-data'
import { BRANCH_KINDS, isBranchStep } from './choose-model'
import { PickerLabel } from './FieldPicker'
import {
  clampCount,
  clampIterations,
  isLoopBy,
  LOOP_FORMS,
  type LoopBy,
  loopFor,
  setLoopWait,
} from './repeat-model'
import { guardProblem } from './StepGuard'
import { WhenTree } from './WhenTree'

export interface RepeatFieldsProps {
  /** The step's position in its list, for the test ids. */
  readonly index: number
  readonly step: AutomationRepeatStep
  readonly devices: readonly AutomationDevice[]
  readonly devicesState?: DeviceListState
  readonly variables?: readonly ScopeVariable[]
  readonly onChange: (next: AutomationRepeatStep) => void
}

export function RepeatFields({
  index,
  step,
  devices,
  devicesState,
  variables,
  onChange,
}: RepeatFieldsProps) {
  const { t } = useTranslation()
  const { loop } = step
  const formLabel: Readonly<Record<LoopBy, string>> = {
    count: t('automation.repeat.byCount', 'A number of times'),
    while: t('automation.repeat.byWhile', 'While a condition is true'),
    until: t('automation.repeat.byUntil', 'Until a condition is true'),
    forEach: t('automation.repeat.byForEach', 'Once for each device'),
  }
  const onCondition = loop.by === 'while' || loop.by === 'until'
  const problem = onCondition ? guardProblem(loop.when) : null
  const item: ScopeVariable = {
    name: REPEAT_ITEM_VAR,
    hint: t('automation.repeat.itemHint', 'the device of this round'),
  }
  const bodyVariables = loop.by === 'forEach' ? [...(variables ?? []), item] : variables
  return (
    <div className="space-y-2">
      <div className="w-64">
        <Select
          data-testid={`repeat-by-${String(index)}`}
          aria-label={t('automation.repeat.by', 'Repeat')}
          value={loop.by}
          onChange={(e) => {
            const by = e.target.value
            if (isLoopBy(by) && by !== loop.by) onChange({ ...step, loop: loopFor(by) })
          }}
          options={LOOP_FORMS.map((by) => ({ value: by, label: formLabel[by] }))}
        />
      </div>

      {loop.by === 'count' && (
        <label className="block w-24">
          <PickerLabel>{t('automation.repeat.count', 'Times')}</PickerLabel>
          <Input
            type="number"
            min={1}
            max={REPEAT_COUNT_MAX}
            data-testid={`repeat-count-${String(index)}`}
            value={String(loop.count)}
            onChange={(e) =>
              onChange({ ...step, loop: { ...loop, count: clampCount(Number(e.target.value)) } })
            }
          />
        </label>
      )}

      {onCondition && (
        <>
          <p className="text-xs text-foreground-subtle">
            {loop.by === 'while'
              ? t(
                  'automation.repeat.whileHint',
                  'Read before each round: if it is not true at the start, nothing runs. A condition that cannot be read ends the loop.',
                )
              : t(
                  'automation.repeat.untilHint',
                  'Read after each round, so the steps run at least once. A condition that cannot be read ends the loop.',
                )}
          </p>
          <WhenTree
            hideRule
            context="guard"
            recipe={{ when: loop.when, actions: [] } satisfies AutomationRecipe}
            devices={devices}
            onChange={(next) => onChange({ ...step, loop: { ...loop, when: next.when } })}
          />
          {problem !== null && <ErrorBox variant="warning" message={problem} />}
          <div className="flex flex-wrap items-end gap-2">
            <label className="w-28">
              <PickerLabel>{t('automation.repeat.max', 'At most (rounds)')}</PickerLabel>
              <Input
                type="number"
                min={1}
                max={REPEAT_ITERATIONS_MAX}
                data-testid={`repeat-max-${String(index)}`}
                value={String(loop.maxIterations)}
                onChange={(e) =>
                  onChange({
                    ...step,
                    loop: { ...loop, maxIterations: clampIterations(Number(e.target.value)) },
                  })
                }
              />
            </label>
            <label className="w-40">
              <PickerLabel>{t('automation.repeat.wait', 'Pause between rounds (s)')}</PickerLabel>
              <Input
                type="number"
                min={1}
                max={WAIT_MAX_SECONDS}
                data-testid={`repeat-wait-${String(index)}`}
                value={loop.waitS === undefined ? '' : String(loop.waitS)}
                placeholder={t('automation.repeat.noWait', 'none')}
                onChange={(e) =>
                  onChange({
                    ...step,
                    loop: setLoopWait(loop, e.target.value === '' ? null : Number(e.target.value)),
                  })
                }
              />
            </label>
          </div>
          <p className="text-xs text-foreground-subtle">
            {t(
              'automation.repeat.maxHint',
              'A loop that reaches its maximum stops there, is marked in the run, and the run goes on.',
            )}
          </p>
        </>
      )}

      {loop.by === 'forEach' && (
        <div className="space-y-1">
          <DeviceValuePicker
            multiple
            pick="device"
            maxItems={REPEAT_DEVICES_MAX}
            value={loop.target.ids.map((deviceId) => ({ deviceId }))}
            onChange={(next) =>
              onChange({
                ...step,
                loop: { ...loop, target: { kind: 'devices', ids: next.map((v) => v.deviceId) } },
              })
            }
          />
          <p className="text-xs text-foreground-subtle">
            {t(
              'automation.repeat.forEachHint',
              'One round per device, in this order. In a round the steps read the device as the variable "item".',
            )}
          </p>
        </div>
      )}

      <PickerLabel>{t('automation.repeat.steps', 'Each time, run')}</PickerLabel>
      <div
        className="border-l-2 border-border-subtle pl-3"
        data-testid={`repeat-steps-${String(index)}`}
      >
        <ActionList
          nested
          flowControl
          actions={step.steps}
          devices={devices}
          allowedKinds={BRANCH_KINDS}
          maxSteps={REPEAT_STEPS_MAX}
          {...(devicesState === undefined ? {} : { devicesState })}
          {...(bodyVariables === undefined ? {} : { variables: bodyVariables })}
          onChange={(next) => onChange({ ...step, steps: next.filter(isBranchStep) })}
        />
      </div>
    </div>
  )
}
