/**
 * The request the common source selector (#236) accepts for a helper (D944 §5).
 * The selector's layout is not specified here. Groups ask for one device type
 * and the catalog field; they do not opt into incompatible fields.
 */
import type { DeviceType } from '../../device/device-type.js'
import { HISTORY_CATALOG, historyFieldsFor } from '../../generated/history-catalog.js'
import type { CompositionSourceRef } from '../source-ref.js'
import type { GroupTemplate } from './catalog.js'
import { MAX_HELPER_MEMBERS } from './spec.js'

export interface SourcePickAccept {
  readonly cap: string
  readonly fieldPath: string
  readonly valueKind: 'number' | 'boolean' | 'state'
}

export interface SourcePickHistory {
  readonly required: boolean
  readonly minRetentionMs: number | null
}

export interface SourcePickRequest {
  readonly purpose: 'member' | 'reading' | 'historised'
  readonly multiple: boolean
  readonly max: number
  readonly deviceTypes: readonly DeviceType[]
  readonly accept: readonly SourcePickAccept[]
  readonly history: SourcePickHistory
  readonly mustBindCaps: readonly string[]
  readonly exclude: readonly CompositionSourceRef[]
}

export interface SourcePick {
  readonly source: CompositionSourceRef
  readonly deviceId: number
  readonly parentName: string | null
  readonly cap: string
  readonly fieldPath: string
  /** Current reading. `null` is unknown, never a stand-in 0. */
  readonly current: number | boolean | string | null
  readonly compatibility: 'direct' | 'convert' | 'incompatible'
  readonly history: 'recorded' | 'absent' | 'unknown'
}

/** What the member step asks the selector for this template. */
export function sourcePickForTemplate(template: GroupTemplate): SourcePickRequest {
  const valueKind: SourcePickAccept['valueKind'] =
    template.family === 'numeric'
      ? 'number'
      : template.activeWhen === undefined
        ? 'boolean'
        : 'state'
  return {
    purpose: 'member',
    multiple: true,
    max: MAX_HELPER_MEMBERS,
    deviceTypes: [...template.memberDeviceTypes],
    accept: template.accept.map((field) => ({ ...field, valueKind })),
    history: { required: false, minRetentionMs: null },
    mustBindCaps: template.family === 'actuator' ? template.accept.map((field) => field.cap) : [],
    exclude: [],
  }
}

/** A statistic or integral reads one field that declares history. */
export function sourcePickForHistory(kind: 'statistic' | 'integral'): SourcePickRequest {
  return {
    purpose: 'historised',
    multiple: false,
    max: 1,
    deviceTypes: [],
    accept: historyAccept(kind),
    history: { required: true, minRetentionMs: null },
    mustBindCaps: [],
    exclude: [],
  }
}

function historyAccept(kind: 'statistic' | 'integral'): readonly SourcePickAccept[] {
  const fields: SourcePickAccept[] = []
  for (const cap of Object.keys(HISTORY_CATALOG)) {
    for (const [fieldPath, field] of Object.entries(historyFieldsFor(cap))) {
      if (field.kind === 'enum') continue
      if (kind === 'integral' && field.kind !== 'gauge') continue
      fields.push({
        cap,
        fieldPath,
        valueKind: field.kind === 'boolean' ? 'boolean' : 'number',
      })
    }
  }
  return fields
}

export type MathSourceKind =
  | 'threshold'
  | 'sum'
  | 'difference'
  | 'ratio'
  | 'expression'
  | 'derivative'

/**
 * What the input step asks the selector for a math helper. A threshold reads
 * one number, a difference or a ratio two, a sum and an expression several.
 * A derivative reads one historised number.
 */
export function sourcePickForMath(kind: MathSourceKind): SourcePickRequest {
  if (kind === 'derivative') {
    return { ...sourcePickForHistory('statistic'), accept: numericAccept() }
  }
  const multiple = kind === 'sum' || kind === 'expression'
  const max = kind === 'difference' || kind === 'ratio' ? 2 : multiple ? MAX_HELPER_MEMBERS : 1
  return {
    purpose: 'reading',
    multiple: multiple || max > 1,
    max,
    deviceTypes: [],
    accept: numericAccept(),
    history: { required: false, minRetentionMs: null },
    mustBindCaps: [],
    exclude: [],
  }
}

function numericAccept(): readonly SourcePickAccept[] {
  return historyAccept('statistic').filter((field) => field.valueKind === 'number')
}
