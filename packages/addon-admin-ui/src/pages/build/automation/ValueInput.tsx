/**
 * The right-hand side of a comparison, typed by the field it is compared to.
 *
 * The control follows the field's kind because the VALUE has to: a boolean field
 * compared to the string `"true"` is a leaf that is false forever, and it looks
 * exactly like a leaf that is simply not met. A select for booleans and enums, a
 * number input for numbers, and a text box only where the field really is text
 * makes that shape impossible to author.
 *
 * When the field's kind is unknown — still loading, or a field the provider has
 * since dropped — the control falls back to text and keeps whatever the recipe
 * already held. Guessing a type here would rewrite a stored value on the next
 * save.
 */

import {
  isQuantityValue,
  isReadingQuantity,
  type DeviceDisplayOverride,
  type QuantityValue,
  type ReadingQuantity,
} from '@camstack/types'
import {
  Input,
  Select,
  resolveSensorDisplay,
  useUnitPreferences,
  useDeviceManagerGetDevice,
  type ResolvedSensorDisplay,
} from '@camstack/ui-library'
import type { WireableField } from './recipe-parts'
import { useTranslation } from 'react-i18next'

export type ScalarValue = string | number | boolean
/** The `{ value, unit }` write form is not shown here: the control reads its number. */
export type ConditionValue = ScalarValue | readonly (string | number)[] | QuantityValue

export interface ScalarValueInputProps {
  readonly value: ScalarValue
  readonly field: WireableField | undefined
  readonly deviceId?: number
  readonly cap?: string
  readonly onChange: (next: ScalarValue) => void
}

export function ScalarValueInput({ value, field, deviceId, cap, onChange }: ScalarValueInputProps) {
  const { t } = useTranslation()
  const bridge = useReadingBridge(field, deviceId, cap)
  if (field?.kind === 'boolean') {
    return (
      <Select
        value={value === true ? 'true' : 'false'}
        onChange={(e) => onChange(e.target.value === 'true')}
        options={[
          { value: 'true', label: t('common.true') },
          { value: 'false', label: t('common.false') },
        ]}
      />
    )
  }

  if (field?.kind === 'enum' && field.enumValues !== undefined && field.enumValues.length > 0) {
    return (
      <Select
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        options={field.enumValues.map((v) => ({ value: v, label: v }))}
      />
    )
  }

  if (field?.kind === 'number') {
    const shown = typeof value === 'number' && bridge ? bridge.toDisplayValue(value) : value
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          type="number"
          value={typeof shown === 'number' ? String(shown) : ''}
          placeholder="0"
          onChange={(e) => {
            // Mid-typing "" and "-" are not numbers. Keeping the last valid value
            // rather than writing NaN keeps the recipe serialisable at all times.
            const parsed = Number(e.target.value)
            if (e.target.value !== '' && !Number.isNaN(parsed)) {
              onChange(bridge ? bridge.fromDisplayValue(parsed) : parsed)
            }
          }}
        />
        {bridge !== undefined && bridge.unit.length > 0 ? (
          <span className="text-xs text-foreground-subtle">{bridge.unit}</span>
        ) : null}
      </span>
    )
  }

  return (
    <Input
      value={typeof value === 'boolean' ? String(value) : String(value)}
      placeholder={t('common.valueWord')}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export interface ListValueInputProps {
  readonly value: readonly (string | number)[]
  readonly field: WireableField | undefined
  readonly deviceId?: number
  readonly cap?: string
  readonly onChange: (next: readonly (string | number)[]) => void
}

/** `is one of` — a comma-separated list, parsed to the field's own type so a
 *  numeric field is not compared against strings that can never equal it. */
export function ListValueInput({ value, field, deviceId, cap, onChange }: ListValueInputProps) {
  const { t } = useTranslation()
  const bridge = useReadingBridge(field, deviceId, cap)
  const shown = bridge
    ? value.map((part) => (typeof part === 'number' ? bridge.toDisplayValue(part) : part))
    : value
  return (
    <Input
      value={shown.join(', ')}
      placeholder={t('automation.valueInput.oneTwoThree', 'one, two, three')}
      onChange={(e) => {
        const parts = e.target.value
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p !== '')
        onChange(
          field?.kind === 'number'
            ? parts
                .map((p) => Number(p))
                .filter((n) => !Number.isNaN(n))
                .map((n) => (bridge ? bridge.fromDisplayValue(n) : n))
            : parts,
        )
      }}
    />
  )
}

/** The union's only non-primitive member is the list, so `typeof` decides it.
 *  A hand-written guard rather than `Array.isArray`, whose declared narrowing is
 *  to a MUTABLE array and does not describe this union. */
function isList(value: ConditionValue): value is readonly (string | number)[] {
  return typeof value === 'object' && !isQuantityValue(value)
}

/** Narrow a stored value to a scalar for a control that cannot show a list —
 *  the first entry, because dropping to `''` would erase what is stored the
 *  moment an operator switches the operator back and forth. */
export function toScalar(value: ConditionValue): ScalarValue {
  if (isQuantityValue(value)) return value.value
  if (!isList(value)) return value
  return value[0] ?? ''
}

export function toList(value: ConditionValue): readonly (string | number)[] {
  if (isQuantityValue(value)) return [value.value]
  if (isList(value)) return value
  if (typeof value === 'boolean') return []
  return [value]
}

function concreteQuantity(
  declared: ReadingQuantity | undefined,
  deviceQuantity: ReadingQuantity | undefined,
): ReadingQuantity | undefined {
  if (declared === undefined || declared === 'none') return undefined
  if (declared !== 'device') return declared
  if (deviceQuantity === undefined || deviceQuantity === 'device' || deviceQuantity === 'none') {
    return undefined
  }
  return deviceQuantity
}

/** Display bridge for a numeric threshold. The recipe stores the base unit. */
function useReadingBridge(
  field: WireableField | undefined,
  deviceId: number | undefined,
  cap: string | undefined,
): ResolvedSensorDisplay | undefined {
  const unitPreferences = useUnitPreferences()
  const id = deviceId ?? 0
  const numeric = field?.kind === 'number' && field.quantity !== undefined
  const { data } = useDeviceManagerGetDevice({ deviceId: id }, { enabled: numeric && id > 0 })
  const raw = data?.sourceInfo?.quantity
  const deviceQuantity = isReadingQuantity(raw) ? raw : undefined
  const quantity = concreteQuantity(field?.quantity, deviceQuantity)
  if (quantity === undefined) return undefined
  const display: DeviceDisplayOverride | undefined = data?.display
  return resolveSensorDisplay({ quantity, display, capName: cap, unitPreferences })
}
