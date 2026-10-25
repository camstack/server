/**
 * Adaptive field selection after a DevicePicker pick (plugin catalog Device overlay):
 * - one bindable leaf → auto-select
 * - several leaves (climate / Sensors-like) → operator picks which value
 * - container children are already a DevicePicker concern (pick the child)
 */
import type { OsdSourceOption } from '@camstack/types'

export type AdaptiveFieldMode = 'empty' | 'auto' | 'pick'

export interface AdaptiveFieldDecision {
  readonly mode: AdaptiveFieldMode
  /** Leaves for the chosen device, ordered as the catalog returned them. */
  readonly fields: readonly OsdSourceOption[]
  /** Set when `mode === 'auto'`. */
  readonly auto: OsdSourceOption | undefined
}

/** Filter the source catalog to one device and decide auto vs pick. */
export function resolveAdaptiveFields(
  sources: readonly OsdSourceOption[],
  deviceId: number,
): AdaptiveFieldDecision {
  const fields = sources.filter((s) => s.deviceId === deviceId)
  if (fields.length === 0) return { mode: 'empty', fields, auto: undefined }
  if (fields.length === 1) return { mode: 'auto', fields, auto: fields[0] }
  return { mode: 'pick', fields, auto: undefined }
}

/** Prefer the primary metric leaf when several share a device (climate / sensors). */
export function preferredField(fields: readonly OsdSourceOption[]): OsdSourceOption | undefined {
  if (fields.length === 0) return undefined
  const valueLeaf = fields.find((f) => f.valuePath === 'value' || f.valuePath.endsWith('.value'))
  if (valueLeaf !== undefined) return valueLeaf
  const primaryPaths = [
    'celsius',
    'percent',
    'currentTemp',
    'temperature',
    'percentage',
    'on',
    'entryOpen',
    'state',
  ] as const
  for (const path of primaryPaths) {
    const hit = fields.find((f) => f.valuePath === path)
    if (hit !== undefined) return hit
  }
  const numeric = fields.find((f) => f.valueType === 'number')
  return numeric ?? fields[0]
}
