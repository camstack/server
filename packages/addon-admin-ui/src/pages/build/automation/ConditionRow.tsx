/**
 * One catalog leaf: a device field, a comparison, a value.
 *
 * The comparison list is DERIVED from the field's kind rather than listed, so a
 * boolean is never offered `>` and a number is never offered `contains`. When
 * the kind is not known yet the full list stands — see `operatorsForFieldKind`
 * for why narrowing on a guess would quietly rewrite a stored recipe.
 *
 * Changing the operator to or from `is one of` reshapes the value between a
 * scalar and a list, and both directions keep what was already there. An
 * operator toggled by accident must not cost the operator the value they typed.
 */

import type { AutomationCondition, AutomationConditionLeaf } from '@camstack/types'
import { baseUnitForQuantity } from '@camstack/types'
import { QuantityValueInput, Select, typedToStored } from '@camstack/ui-library'
import type { AutomationDevice } from './automation-data'
import { FieldPicker, type FieldSelection, PickerLabel, useFieldDescriptor } from './FieldPicker'
import { type OperatorChoice, operatorChoices } from './recipe-parts'
import { declaredQuantity, ListValueInput, ScalarValueInput, toList, toScalar } from './ValueInput'
import { useTranslation } from 'react-i18next'

export interface ConditionLeafRowProps {
  readonly leaf: AutomationConditionLeaf
  readonly devices: readonly AutomationDevice[]
  readonly onChange: (next: AutomationCondition) => void
}

export function ConditionLeafRow({ leaf, devices, onChange }: ConditionLeafRowProps) {
  const { t } = useTranslation()
  const selection: FieldSelection = {
    deviceId: leaf.deviceId,
    cap: leaf.cap,
    fieldPath: leaf.fieldPath,
  }
  const descriptor = useFieldDescriptor(selection)
  const choices = operatorChoices(descriptor?.kind)
  const isList = leaf.operator === 'in'
  const quantity = declaredQuantity(descriptor)
  const base = quantity === undefined ? undefined : baseUnitForQuantity(quantity)

  const withSelection = (next: FieldSelection): void => {
    // The picked unit belongs to the field it was picked for.
    const { unit: _unit, ...rest } = leaf
    onChange({ ...rest, deviceId: next.deviceId, cap: next.cap, fieldPath: next.fieldPath })
  }

  const withOperator = (raw: string): void => {
    const operator = asOperator(raw, choices)
    const { unit: _unit, ...withoutUnit } = leaf
    onChange({
      ...(operator === 'in' ? withoutUnit : leaf),
      operator,
      value: operator === 'in' ? toList(leaf.value) : toScalar(leaf.value),
    })
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <FieldPicker value={selection} devices={devices} onChange={withSelection} />

      <label className="min-w-[8rem]">
        <PickerLabel>{t('automation.conditionRow.comparison', 'Comparison')}</PickerLabel>
        <Select
          value={leaf.operator}
          onChange={(e) => withOperator(e.target.value)}
          options={choices.map((c) => ({ value: c.value, label: c.label }))}
        />
      </label>

      <label className="min-w-[9rem] flex-1">
        <PickerLabel>{t('automation.conditionRow.value', 'Value')}</PickerLabel>
        {isList ? (
          <ListValueInput
            value={toList(leaf.value)}
            field={descriptor}
            deviceId={leaf.deviceId}
            cap={leaf.cap}
            onChange={(value) => onChange({ ...leaf, value })}
          />
        ) : quantity !== undefined && base !== undefined ? (
          <QuantityValueInput
            quantity={quantity}
            storedUnit={base}
            value={typeof leaf.value === 'number' ? leaf.value : undefined}
            unit={leaf.unit}
            aria-label={t('automation.conditionRow.value', 'Value')}
            onChange={(typed) => {
              const stored = typedToStored(typed, base)
              onChange({ ...leaf, value: stored.value, unit: stored.unit })
            }}
          />
        ) : (
          <ScalarValueInput
            value={toScalar(leaf.value)}
            field={descriptor}
            deviceId={leaf.deviceId}
            cap={leaf.cap}
            onChange={(value) => onChange({ ...leaf, value })}
          />
        )}
      </label>
    </div>
  )
}

/** Keep the stored operator when the incoming string is not one this field
 *  offers — a select that has just been re-populated can emit a stale value,
 *  and writing it back would put an illegal operator in the recipe. */
function asOperator(
  raw: string,
  choices: readonly OperatorChoice[],
): AutomationConditionLeaf['operator'] {
  const hit = choices.find((c) => c.value === raw)
  return hit?.value ?? 'eq'
}
