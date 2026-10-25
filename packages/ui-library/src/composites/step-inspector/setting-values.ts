/**
 * How the step inspector names a stored setting value, and what a field falls
 * back to when no layer stores it. Pure, so the provenance line and its tests
 * agree on one spelling.
 */
import { type ConfigField, isModelScopedStepSettingKey } from '@camstack/types'

/** A field that stores a value (not a separator, an info block or a group). */
export type ValueField = Exclude<ConfigField, { readonly type: 'separator' | 'info' | 'group' }>

export function isValueField(field: ConfigField): field is ValueField {
  return field.type !== 'separator' && field.type !== 'info' && field.type !== 'group'
}

/**
 * A field only the accelerator that runs the model may set (D927): a model id,
 * a `<key>ModelId` binding, a `minConfidence*` floor, or any field the schema
 * marks as bound to its model. A camera never renders one as an input.
 */
export function isModelScopedField(field: ConfigField): boolean {
  if ('bindsToModel' in field && field.bindsToModel === true) return true
  return 'key' in field && isModelScopedStepSettingKey(field.key)
}

/** The fields a CAMERA may edit: every model-scoped field removed, groups recursed. */
export function withoutModelScopedFields(fields: readonly ConfigField[]): readonly ConfigField[] {
  return fields.flatMap((field): ConfigField[] => {
    if (field.type === 'group') {
      const inner = withoutModelScopedFields(field.fields)
      return inner.length > 0 ? [{ ...field, fields: [...inner] }] : []
    }
    return isModelScopedField(field) ? [] : [field]
  })
}

/** True for a D738 field whose value is stored with the model it was made for. */
export function bindsToModel(field: ConfigField): boolean {
  return (field.type === 'slider' || field.type === 'number') && field.bindsToModel === true
}

/**
 * What runs when no layer stores the field: the running model's default for a
 * model-bound field that the model declares one for (D738), else the field's
 * own default. `fromModel` says which.
 */
export function defaultOfField(
  field: ValueField,
  modelId: string,
): { readonly value: unknown; readonly fromModel: boolean } {
  const byModel =
    'modelApplicability' in field ? field.modelApplicability?.defaultByModel?.[modelId] : undefined
  if (byModel !== undefined) return { value: byModel, fromModel: true }
  return { value: 'default' in field ? field.default : undefined, fromModel: false }
}

function trimNumber(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '')
}

/** One stored value as the operator reads it (`0.65`, `on`, `Person, Vehicle`, `—`). */
export function formatSettingValue(field: ValueField, value: unknown): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (typeof value === 'number') {
    const scale = field.type === 'slider' ? field.displayScale : undefined
    const unit = 'unit' in field && typeof field.unit === 'string' ? ` ${field.unit}` : ''
    return `${trimNumber(scale !== undefined ? value / scale : value)}${unit}`
  }
  const options = 'options' in field && Array.isArray(field.options) ? field.options : []
  const labelOf = (v: unknown): string => {
    const hit = options.find((o) => o.value === v)
    return hit ? hit.label : String(v)
  }
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(labelOf).join(', ')
  if (typeof value === 'string') return labelOf(value)
  return JSON.stringify(value)
}
